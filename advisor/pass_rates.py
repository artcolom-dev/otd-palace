"""A pass's build rate, its rates by bucket and rarity, and its shelf's auctions: the feed's five optional pass fields.

The feed adds them at the end of every pass row once its switch is on (see the pass-deals code for how they are used):
- `rate_bucket`: the value bucket `rate_traded` comes from;
- `rates_by_bucket`: for each of the four buckets, the listing sales' median rax a rating point, their count and age,
  the same by rarity, and the same for accepted offers;
- `rate_build` and `rate_build_from`: the cheapest (bucket, rarity) cell with at least 5 listing sales, the rax a point a
  rarity is built at, and that cell;
- `shelf_auctions`: the shelf page with each listing's auction state, `pay` (the current bid, else the opening price)
  in place of the old shelf's target.

`clean_extra` checks them strictly, by type and range and against the contract's caps: a field that does not fit is
left out alone (the caller logs it), never the row nor the document. A row without them reads exactly as before.

What the site does with them:
- `build_rate`: a rung's rating is priced at `rate_build`; without one, at `rate_traded` as before, flagged thin when
  the feed did measure the pass by bucket and rarity and found no cell with enough sales (no bucket median stands in:
  one rarity can carry it far above what a build buys, as Mystic sales did for one pass's over-7 bucket).
- `live_auctions`: the shelf's auctions still open at a moment, each at its `pay`, and whether that pay is a price yet
  (advisor/rules.py OTD_SHELF_*, card deals' own caution) or only an opening.
- `offer_cells`: the accepted-offer rates measured on enough offers, with the listing rate of the same cell, for the
  offer hint (frontend/src/lib/offers.ts).
"""

import json
import math
import re
from dataclasses import dataclass
from datetime import datetime

from advisor.rules import (
    FEED_ENDS_IN_MAX_S,
    FEED_PASS_EXTRA_MAX_BYTES,
    FEED_RATE_MAX,
    FEED_RATING_MAX,
    FEED_SALES_MAX,
    FEED_SHELF_AUCTIONS_MAX,
    FEED_SPAN_D_MAX,
    OTD_BUILD_MIN_SALES,
    OTD_OFFER_MIN_SALES,
    OTD_SHELF_FIRM_LEFT_MIN,
    OTD_SHELF_FIRM_READ_S,
    OTD_SHELF_OPENING_BELOW,
    PASS_BUCKETS,
    PASS_RARITIES,
)

EXTRA_FIELDS = ("rate_bucket", "rates_by_bucket", "rate_build", "rate_build_from", "shelf_auctions")
_PART_KEYS = frozenset({"rate", "sales", "span_d", "by_rarity"})
_BUCKET_KEYS = _PART_KEYS | {"offers"}
_READ_AT = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")


def _real(value: object, high: float, *, low: float = 0.0, low_open: bool = True) -> bool:
    """A finite JSON number (never a bool) in (low, high], or [low, high] without `low_open`."""
    if type(value) not in (int, float) or not math.isfinite(value):
        return False
    return (low < value if low_open else low <= value) and value <= high


def _whole(value: object, low: int, high: float) -> bool:
    return type(value) is int and low <= value <= high


def _cells(value: object) -> dict | None:
    """`{rarity: [rate, sales]}`, each a known rarity, a rate in (0, max] and at least one sale; else None."""
    if not isinstance(value, dict) or len(value) > len(PASS_RARITIES):
        return None
    out = {}
    for rarity, cell in value.items():
        if rarity not in PASS_RARITIES or not isinstance(cell, list) or len(cell) != 2:
            return None
        rate, sales = cell
        if not _real(rate, FEED_RATE_MAX) or not _whole(sales, 1, FEED_SALES_MAX):
            return None
        out[rarity] = [rate, sales]
    return out


def _part(value: object, keys: frozenset) -> dict | None:
    """One bucket's listing (or offer) figures: a rate and an age exactly when something sold, the rarities' counts
    adding up to no more than the whole's (a sale of unknown rarity counts in the whole only)."""
    if not isinstance(value, dict) or set(value) != keys:
        return None
    rate, sales, span, by = value["rate"], value["sales"], value["span_d"], _cells(value["by_rarity"])
    if not _whole(sales, 0, FEED_SALES_MAX) or by is None or sum(n for _r, n in by.values()) > sales:
        return None
    if sales == 0:
        return {"rate": None, "sales": 0, "span_d": None, "by_rarity": {}} if rate is None and span is None and not by else None
    if not _real(rate, FEED_RATE_MAX) or not _real(span, FEED_SPAN_D_MAX, low_open=False):
        return None
    return {"rate": rate, "sales": sales, "span_d": span, "by_rarity": by}


def _rates(value: object) -> dict | None:
    """`rates_by_bucket`: exactly the four buckets, each with its listing figures and its offers'."""
    if not isinstance(value, dict) or set(value) != set(PASS_BUCKETS):
        return None
    out = {}
    for bucket in PASS_BUCKETS:
        entry = value[bucket]
        if not isinstance(entry, dict) or set(entry) != _BUCKET_KEYS:
            return None
        listing, offers = _part({k: entry[k] for k in _PART_KEYS}, _PART_KEYS), _part(entry["offers"], _PART_KEYS)
        if listing is None or offers is None:
            return None
        out[bucket] = {**listing, "offers": offers}
    return out


def _build(rate: object, origin: object, rates: dict | None) -> tuple[float | None, dict | None] | None:
    """(`rate_build`, `rate_build_from`), both null or both set: a rate in (0, max] from a known cell with at least
    OTD_BUILD_MIN_SALES listing sales, the very cell `rates_by_bucket` holds when it came too; else None (a misfit)."""
    if rate is None and origin is None:
        return None, None
    if not _real(rate, FEED_RATE_MAX) or not isinstance(origin, dict) or set(origin) != {"bucket", "rarity", "sales"}:
        return None
    bucket, rarity, sales = origin["bucket"], origin["rarity"], origin["sales"]
    if bucket not in PASS_BUCKETS or rarity not in PASS_RARITIES or not _whole(sales, OTD_BUILD_MIN_SALES, FEED_SALES_MAX):
        return None
    if rates is not None and rates[bucket]["by_rarity"].get(rarity) != [rate, sales]:
        return None
    return float(rate), {"bucket": bucket, "rarity": rarity, "sales": sales}


def _listing(entry: object) -> list | None:
    """One shelf listing, `[rating, pay, min_bid, target, bids, ends_in_s, house, rarity]`, each by its type."""
    if not isinstance(entry, list) or len(entry) != 8:
        return None
    rating, pay, min_bid, target, bids, ends_in, house, rarity = entry
    if not _real(rating, FEED_RATING_MAX) or not _whole(pay, 1, FEED_RATE_MAX):
        return None
    if any(p is not None and not _whole(p, 1, FEED_RATE_MAX) for p in (min_bid, target)):
        return None
    if not _whole(bids, 0, FEED_SALES_MAX) or type(house) is not bool or (rarity is not None and rarity not in PASS_RARITIES):
        return None
    if ends_in is not None and not _whole(ends_in, 0, FEED_ENDS_IN_MAX_S):
        return None
    return [float(rating), pay, min_bid, target, bids, ends_in, house, rarity]


def _read_at(value: object) -> datetime | None:
    if not isinstance(value, str) or not _READ_AT.fullmatch(value):
        return None
    try:
        return datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return None


def _auctions(value: object) -> dict | None:
    """`shelf_auctions`: when the page was read (ISO, UTC, whole seconds, `Z`) and at most
    FEED_SHELF_AUCTIONS_MAX listings; one listing that does not fit and the whole reading is left out (a sum over
    part of a page would mislead)."""
    if not isinstance(value, dict) or set(value) != {"read_at", "listings"}:
        return None
    listings = value["listings"]
    if _read_at(value["read_at"]) is None or not isinstance(listings, list) or len(listings) > FEED_SHELF_AUCTIONS_MAX:
        return None
    out = [_listing(entry) for entry in listings]
    if any(entry is None for entry in out):
        return None
    return {"read_at": value["read_at"], "listings": out}


def clean_extra(row: dict) -> tuple[dict, list[str]]:
    """The five fields of a pass row that fit the contract, by name (a field the row leaves out is left out here
    too), and the names of those that did not fit, which are left out alone. A rate_bucket without a rate_traded
    names nothing; `rate_build` and `rate_build_from` stand or fall together. Past FEED_PASS_EXTRA_MAX_BYTES in all,
    the shelf's auctions go first, then the rates by bucket (the build rate itself stays)."""
    sent = {name: row[name] for name in EXTRA_FIELDS if name in row}
    if not sent:
        return {}, []
    out: dict = {}
    dropped: list[str] = []

    def keep(name: str, ok: bool, value: object) -> None:
        if name not in sent:
            return
        if ok:
            out[name] = value
        else:
            dropped.append(name)

    raw = sent.get("rate_bucket")
    keep("rate_bucket", raw is None or (raw in PASS_BUCKETS and row.get("rate_traded") is not None), raw)
    rates = None if sent.get("rates_by_bucket") is None else _rates(sent["rates_by_bucket"])
    keep("rates_by_bucket", rates is not None or sent.get("rates_by_bucket") is None, rates)
    build = _build(sent.get("rate_build"), sent.get("rate_build_from"), rates)  # half a pair is a misfit
    for name, value in zip(("rate_build", "rate_build_from"), build or (None, None), strict=True):
        keep(name, build is not None, value)
    shelf = None if sent.get("shelf_auctions") is None else _auctions(sent["shelf_auctions"])
    keep("shelf_auctions", shelf is not None or sent.get("shelf_auctions") is None, shelf)
    for name in ("shelf_auctions", "rates_by_bucket"):
        if len(json.dumps({k: sent[k] for k in sent if k in out}, separators=(",", ":"))) <= FEED_PASS_EXTRA_MAX_BYTES:
            break
        if out.pop(name, None) is not None:
            dropped.append(name)
    return out, dropped


# --- what the site makes of them -------------------------------------------------------------------------------------

@dataclass(frozen=True)
class BuildRate:
    """The rax a rating point a rung is priced at, and where it comes from."""

    rate: float | None  # None: the pass cannot be priced
    thin: bool  # the feed measured the pass by bucket and rarity and no cell had enough sales: `rate_traded` stands in
    bucket: str | None  # the cell's bucket (or `rate_traded`'s, when thin or older), when known
    rarity: str | None  # the cell's rarity; None without a build cell
    sales: int  # the sales behind the rate: the cell's, else `rate_traded`'s


def build_rate(rate_traded: float | None, rate_sales: int, rate_build: float | None, rate_build_from, measured: bool,
               rate_bucket: str | None = None) -> BuildRate:
    """The build rate of a pass: `rate_build` when the feed found a cell, else `rate_traded` as before (thin when the
    pass was measured by bucket and rarity, so a null `rate_build` means "no cell with enough sales")."""
    if rate_build is not None:
        origin = rate_build_from if isinstance(rate_build_from, dict) else {}
        return BuildRate(rate_build, False, origin.get("bucket"), origin.get("rarity"), origin.get("sales") or 0)
    return BuildRate(rate_traded, measured and rate_traded is not None, rate_bucket, None, rate_sales)


def market_build_rate(market) -> BuildRate:
    """`build_rate` of a PassMarket."""
    return build_rate(market.rate_traded, market.rate_sales, market.rate_build, market.rate_build_from, market.measured,
                      market.rate_bucket)


def served_build_rate(market: dict) -> BuildRate:
    """`build_rate` of a pass as the snapshot serves it: `rate_build` is there (maybe null) exactly when the feed
    measured the pass by bucket and rarity, or found a build cell."""
    traded = market.get("rate_traded")
    traded = float(traded) if type(traded) in (int, float) and math.isfinite(traded) else None
    sales = market.get("rate_sales") if type(market.get("rate_sales")) is int else 0
    build = market.get("rate_build")
    build = float(build) if type(build) in (int, float) and math.isfinite(build) and build > 0 else None
    return build_rate(traded, sales, build, market.get("rate_build_from"), "rate_build" in market, market.get("rate_bucket"))


def bucket_of(rating: float) -> str | None:
    """The feed's value bucket of a rating, by its size: (0, 3], (3, 5], (5, 7], over 7; None for 0."""
    r = abs(rating)
    if r == 0:
        return None
    return "0-3" if r <= 3 else "3-5" if r <= 5 else "5-7" if r <= 7 else "7+"


def cell_rate(rates: dict | None, bucket: str | None, rarity: str | None) -> float | None:
    """A listing's own cell's rate a point: its rarity's in its bucket from OTD_BUILD_MIN_SALES sales, else its
    bucket's from as many; None when neither has enough."""
    entry = (rates or {}).get(bucket) if bucket else None
    if entry is None:
        return None
    cell = entry["by_rarity"].get(rarity) if rarity else None
    if cell is not None and cell[1] >= OTD_BUILD_MIN_SALES:
        return cell[0]
    return entry["rate"] if entry["sales"] >= OTD_BUILD_MIN_SALES else None


def live_auctions(market, now: datetime) -> tuple[tuple[float, int, bool], ...] | None:
    """The shelf's auctions still open at `now`, as (rating, pay, firm), in the feed's order (cheapest a point first);
    None without `shelf_auctions`.

    `firm`: its pay is a price a buyer can count on now, on card deals' own caution (advisor/deals.py): it ends within
    OTD_SHELF_FIRM_LEFT_MIN minutes, the page was read at most OTD_SHELF_FIRM_READ_S ago, it is no house listing (the
    platform's floor supply, never a deal) and its pay is not under OTD_SHELF_OPENING_BELOW of its own cell's rate a
    point (an opening that is usually bid up). Anything else still open is an auction opening at its pay. An auction
    whose end has passed is dropped; one whose end is unknown is an opening."""
    shelf = market.shelf_auctions
    if shelf is None:
        return None
    read_at = _read_at(shelf["read_at"])
    age_s = (now - read_at).total_seconds()
    out = []
    for rating, pay, _min_bid, _target, _bids, ends_in, house, rarity in shelf["listings"]:
        left_s = None if ends_in is None else ends_in - age_s
        if left_s is not None and left_s <= 0:
            continue
        cell = cell_rate(market.rates_by_bucket, bucket_of(rating), rarity) or market_build_rate(market).rate
        opening = (
            house
            or left_s is None
            or left_s > OTD_SHELF_FIRM_LEFT_MIN * 60
            or age_s > OTD_SHELF_FIRM_READ_S
            or (cell is not None and pay / rating < OTD_SHELF_OPENING_BELOW * cell)
        )
        out.append((rating, pay, not opening))
    return tuple(out)


def offer_cells(rates: dict | None) -> list[list] | None:
    """The accepted-offer rates measured on at least OTD_OFFER_MIN_SALES offers, as served: `[bucket, rarity (None:
    the whole bucket), rate a point, offers, the listing rate a point of the same cell (None under
    OTD_BUILD_MIN_SALES sales)]`, buckets and rarities in order; None when the pass was not measured."""
    if rates is None:
        return None
    out = []
    for bucket in PASS_BUCKETS:
        entry = rates[bucket]
        offers = entry["offers"]
        if offers["rate"] is not None and offers["sales"] >= OTD_OFFER_MIN_SALES:
            out.append([bucket, None, offers["rate"], offers["sales"],
                        entry["rate"] if entry["sales"] >= OTD_BUILD_MIN_SALES else None])
        for rarity in PASS_RARITIES:
            cell = offers["by_rarity"].get(rarity)
            if cell is None or cell[1] < OTD_OFFER_MIN_SALES:
                continue
            listing = entry["by_rarity"].get(rarity)
            out.append([bucket, rarity, cell[0], cell[1],
                        listing[0] if listing is not None and listing[1] >= OTD_BUILD_MIN_SALES else None])
    return out
