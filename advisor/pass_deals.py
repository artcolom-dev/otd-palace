"""The locked "Pass deals" teaser: what the free site may say about a members-only block, as two numbers per level.

"Pass deals", at the top of Deals, is for members of our Discord server: the passes whose cards on sale right now
reach a paying rarity for less than the usual rate (frontend/src/lib/passDeals.ts draws it). A visitor gets only how
many passes that is and the best saving, counted here from the whole snapshot's passes (the past seasons and this
season's passes served for Deals), so that no pass, name, price or offer of the block reaches them (advisor/public.py
puts it in `locked`).

The two numbers never say more than the block would show a member. For each level (rules.LEVELS), they are what the
block shows a member of that level with the level's default pass budget, holding no pass, over every sport tab:
- the passes: for each sport, the first min(OTD_CLAIMS_PER_SPORT_DAY, PASS_DEALS_SHOWN) deals of that sport by a
  year's pay per Rax at the cost on sale (the browser's order: then the cheaper, then the key), as the block on that
  sport's tab lists them;
- the best saving: the deepest saving of the first PASS_DEALS_SHOWN of those passes in that order, the ones the block
  lists on every sport ("all", where a member lands), so the pass it is said of is one the member sees on unlocking.
  It is in percent of the rarity's usual cost, rounded down to PASS_DEALS_PCT_STEP and never above PASS_DEALS_PCT_MAX.
  The shelf it rests on can be a day old and the cheapest asks go first, so the page says "at least" that much; a
  member sees the asks themselves, and the cards' own rate a point is at least that far under the usual one (the mint,
  in the rarity's cost, is not on sale). The page says it only from PASS_DEALS_PCT_MIN up; under it, the count alone
  (components/PassDeals.tsx lockedWords).
The page reads the visitor's own level; the top-level pair is the New level's (the first visit's), for a page that
does not read the levels yet.

It is the browser's rule. For each pass: not a team pass, its usual rate is its build rate (advisor/pass_rates.py:
the feed's cheapest bucket-and-rarity cell with 5 listing sales, else the traded rate) resting on at least
OTD_IGNORE_ASK_MIN_SALES sales and not thin (a rate from fewer, or measured with no cell, is too thin to call anything
cheaper than usual), it can be built, some cards are on sale (with the shelf's live auctions, at a firm pay: an auction
only opening at its pay is never a deal), its pay is not mostly months away (lib/passes.ts paysLater); for each rarity
built with cards that pays back, pays something and does more than break even (lib/budget.ts routeRungOk; at New also
no projection and paid back within 12 months), the cards on sale (advisor/otd.py on_sale on the served shelf, or on
the firm auctions at their pay) plus the mint must cost less than the rarity at the usual rate, and no more than the
budget. The browser then walks the payback again at
that lower cost; a cost that already pays back pays back sooner, so that walk changes nothing here. The pass's deal is
its rarity paying the most a year per Rax at the cost on sale, as the block ranks it.
"""

import calendar
import math
from collections import defaultdict
from datetime import date
from types import SimpleNamespace

from advisor.otd import _month_weights, on_sale
from advisor.pass_rates import served_build_rate
from advisor.rules import (
    LEVELS,
    OTD_CLAIMS_PER_SPORT_DAY,
    OTD_IGNORE_ASK_MIN_SALES,
    OTD_LATER_SHARE_BELOW,
    OTD_LATER_START_SHARE,
    OTD_LATER_WINDOW_MONTHS,
    PASS_DEALS_PCT_MAX,
    PASS_DEALS_PCT_STEP,
    PASS_DEALS_ON,
    PASS_DEALS_SAY_PCT,
    PASS_DEALS_SHOWN,
)

_ROUNDING = 1e-9
NOTHING = {"passes": 0, "best_pct": None}
FIRST_VISIT = "new"  # the level whose two numbers are also the top-level pair


def _num(value: object) -> float | None:
    return float(value) if type(value) in (int, float) and math.isfinite(value) else None


def _shelf(value: object) -> list[tuple[float, float]]:
    if not isinstance(value, list):
        return []
    return [(float(card[0]), float(card[1])) for card in value
            if isinstance(card, list) and len(card) == 2 and all(_num(v) is not None for v in card)]


def _auctions(value: object) -> list[tuple[float, float, bool]] | None:
    """The served live auctions, [rating, pay, firm], or None when the pass has none served (the old shelf then)."""
    if not isinstance(value, list):
        return None
    return [(float(a[0]), float(a[1]), a[2] == 1) for a in value
            if isinstance(a, list) and len(a) == 3 and _num(a[0]) is not None and _num(a[1]) is not None and a[2] in (0, 1)]


def _pays_later(market: dict, today: date) -> bool:
    """lib/passes.ts paysLater: the next OTD_LATER_WINDOW_MONTHS months from today (today's month from today on) hold
    under OTD_LATER_SHARE_BELOW of its next 12 months' pay, and a month of real pay comes after a quiet one."""
    base = _num(market.get("base_1x"))
    shares = market.get("month_share")
    if base is None or not base > 0 or not isinstance(shares, list) or any(_num(s) is None for s in shares):
        return False
    weights = _month_weights(SimpleNamespace(
        month_share=shares, sport=market.get("sport"),
        month_share_estimated=len(shares) != 12 or sum(max(0.0, s) for s in shares) <= 0))
    days = calendar.monthrange(today.year, today.month)[1]
    soon = year = elapsed = 0.0
    length = (days - today.day + 1) / days
    i = 0
    while elapsed < 12 - _ROUNDING:
        length = min(length, 12 - elapsed)
        weight = weights[(today.month - 1 + i) % 12]
        year += weight * length
        if elapsed < OTD_LATER_WINDOW_MONTHS:
            soon += weight * min(length, OTD_LATER_WINDOW_MONTHS - elapsed)
        elapsed += length
        length = 1
        i += 1
    if year <= 0 or soon >= OTD_LATER_SHARE_BELOW * year:
        return False
    quiet = False
    for i in range(12):
        real = weights[(today.month - 1 + i) % 12] >= OTD_LATER_START_SHARE
        if real and quiet:
            return True
        if not real:
            quiet = True
    return False


def _rung_ok(rung: dict, level: str = "regular") -> bool:
    """lib/budget.ts routeRungOk at `level`, for a rarity built with cards."""
    cost, year, life, add = (_num(rung.get(k)) for k in ("cost", "year_rax", "lifetime_per_rax", "rating_to_add"))
    if level == "new":
        months = _num(rung.get("payback_months"))
        if rung.get("projected") is True or months is None or months > 12:
            return False
    return (rung.get("route") != "mint" and add is not None and add > 0 and rung.get("pays_back") is True
            and cost is not None and cost > 0 and year is not None and year > 0 and not (life is not None and life <= 1))


def _deal(market: dict, today: date, level: str, budget: float | None) -> tuple[float, float, str, str, float] | None:
    """(a year's pay per Rax at the cost on sale, that cost, the key, the sport, the saving as a share of the usual
    cost) of the pass's deal at `level` within `budget`, or None when it has none."""
    build = served_build_rate(market)
    usual = build.rate
    sales = market.get("rate_sales") if type(market.get("rate_sales")) is int else 0
    count = market.get("shelf_count") if type(market.get("shelf_count")) is int else 0
    shelf = _shelf(market.get("shelf"))
    auctions = _auctions(market.get("auctions"))
    key, sport = market.get("key"), market.get("sport")
    if not isinstance(key, str) or not isinstance(sport, str):
        return None
    if market.get("kind") == "team" or usual is None or not usual > 0 or not (sales > 0 or count > 0):
        return None
    if not (shelf if auctions is None else any(firm for _r, _p, firm in auctions)):
        return None  # nothing on sale, or (with the auctions) nothing at a firm pay: an opening is never a deal
    # The usual rate must rest on enough sales: a build cell has them; a thin rate (no cell) never calls a card cheap.
    if build.thin or build.sales < OTD_IGNORE_ASK_MIN_SALES or _pays_later(market, today):
        return None
    basis = SimpleNamespace(rate_traded=_num(market.get("rate_traded")), rate_sales=sales,
                            rate_build=_num(market.get("rate_build")), rate_build_from=market.get("rate_build_from"),
                            rate_bucket=market.get("rate_bucket"), measured="rate_build" in market, shelf=shelf)
    best: tuple[float, float, str, str, float] | None = None
    rungs = market.get("rungs") if isinstance(market.get("rungs"), list) else []
    for rung in rungs:
        if not isinstance(rung, dict) or not _rung_ok(rung, level):
            continue
        sale = on_sale(basis, rung["rating_to_add"], auctions, firm_only=True)
        if not sale.enough or not sale.on_sale_rating > 0:
            continue
        mint = rung["cost"] - rung["rating_to_add"] * usual if rung["route"] == "mint+cards" else 0
        cost = mint + sale.on_sale_cost
        if not cost < rung["cost"] - 1e-9 or not cost > 0 or (budget is not None and cost > budget):
            continue
        found = (rung["year_rax"] / cost, cost, key, sport, (rung["cost"] - cost) / rung["cost"])
        if best is None or found[0] > best[0]:
            best = found
    return best


def _shown(markets: list[dict], today: date, level: str) -> list[tuple[float, float, str, str, float]]:
    """The deals the block shows a member of `level` on some sport tab: per sport, its first few by `_deal`'s order."""
    deals = [d for d in (_deal(m, today, level, LEVELS[level]["otd_default_budget"]) for m in markets) if d]
    deals.sort(key=lambda d: (-d[0], d[1], d[2]))
    room = min(OTD_CLAIMS_PER_SPORT_DAY, PASS_DEALS_SHOWN)
    taken: dict[str, int] = defaultdict(int)
    shown = []
    for d in deals:
        if taken[d[3]] < room:
            taken[d[3]] += 1
            shown.append(d)
    return shown


def best_pct(saving: float) -> int:
    """A saving (a share of the usual cost) as the teaser says it: whole percent rounded down to PASS_DEALS_PCT_STEP,
    at most PASS_DEALS_PCT_MAX."""
    whole = math.floor(saving * 100 / PASS_DEALS_PCT_STEP + 1e-9) * PASS_DEALS_PCT_STEP
    return max(0, min(PASS_DEALS_PCT_MAX, whole))


def _pair(shown: list) -> dict:
    """How many passes `shown` holds, and the deepest saving of the first PASS_DEALS_SHOWN (the block on "all")."""
    if not shown:
        return dict(NOTHING)
    return {"passes": len(shown), "best_pct": best_pct(max(d[4] for d in shown[:PASS_DEALS_SHOWN]))}


def said(counted: dict) -> dict:
    """The teaser as the free site is told it: the counts always, the best saving only while PASS_DEALS_SAY_PCT is
    on (advisor/rules.py says why it is off). The page reads a missing percent as "lead with the count". With the
    block off (PASS_DEALS_ON), nothing: zero passes at every level."""
    if not PASS_DEALS_ON:
        levels = counted.get("levels") if isinstance(counted.get("levels"), dict) else {}
        return {**NOTHING, "levels": {level: dict(NOTHING) for level in levels}}
    if PASS_DEALS_SAY_PCT:
        return counted
    levels = counted.get("levels") if isinstance(counted.get("levels"), dict) else {}
    return {**counted, "best_pct": None,
            "levels": {level: {**pair, "best_pct": None} for level, pair in levels.items()}}


def teaser(otd: object) -> dict:
    """{"passes", "best_pct" (None without a deal), "levels": {level: {"passes", "best_pct"}}}; the top-level pair is
    the New level's."""
    nothing = {**NOTHING, "levels": {level: dict(NOTHING) for level in LEVELS}}
    if not isinstance(otd, dict) or not isinstance(otd.get("markets"), list):
        return nothing
    try:
        today = date.fromisoformat(str(otd.get("as_of", ""))[:10])
    except ValueError:
        return nothing
    # The past seasons, and this season's passes the feed sends for Deals (served apart: advisor/snapshot.py _otd_json).
    current = otd.get("current_markets") if isinstance(otd.get("current_markets"), list) else []
    markets = [m for m in [*otd["markets"], *current] if isinstance(m, dict)]
    levels = {level: _pair(_shown(markets, today, level)) for level in LEVELS}
    return {**levels[FIRST_VISIT], "levels": levels}
