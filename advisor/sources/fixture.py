"""Demo sources: a fixture file served as it stands, and a replay of it that keeps moving.

A fixture file is one JSON object with the lists `listings`, `sales`, `fmv` and `otd`. Their rows
carry the fields of the matching model class, except that times are offsets from the moment of
the fetch, so a fixture is never out of date: listings carry `ends_in_s` and `created_ago_s`
(null when unknown) instead of `ends_at` and `created_at`, sales carry `sold_ago_s` instead of
`sold_at`, and pass markets (`otd`, the fields of `PassMarket`) carry no times; their `month_share` and `shelf` are
JSON lists. A listing row may leave out `minted_by_real`, which is then false.
"""

import json
import math
import random
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path

from advisor.deals import is_target_deal
from advisor.model import Fmv, Listing, PassMarket, RawData, Sale
from advisor.pass_rates import EXTRA_FIELDS, clean_extra
from advisor.reference import MarketKey, Reference, index_sales, listing_key, reference_for
from advisor.rules import (
    REPLAY_BID_CEILING,
    REPLAY_BID_SHARE,
    REPLAY_BID_STEP,
    REPLAY_DEAL_SHARE,
    REPLAY_DEAL_START,
    REPLAY_DEAL_TARGET,
    REPLAY_FAIR_START,
    REPLAY_FAIR_TARGET,
    REPLAY_NEW_LISTING_MINUTES,
    REPLAY_NEW_LISTINGS,
    REPLAY_TAKE_CHANCE,
    REPLAY_TARGET_CEILING,
    REPLAY_TARGET_SHARE,
)

COUNTDOWN = timedelta(minutes=10)  # Real's rule: once the target price is bid, the auction ends within this


def parse_listing(row: dict, now: datetime) -> Listing:
    """A listing row, its times counted from `now`. An optional `seen_ago_s` (whole seconds, or null) says how long
    before `now` the row was last read."""
    fields = {name: value for name, value in row.items() if name not in ("ends_in_s", "created_ago_s", "seen_ago_s")}
    created_ago_s = row["created_ago_s"]
    seen_ago_s = row.get("seen_ago_s")
    if seen_ago_s is not None and (type(seen_ago_s) is not int or seen_ago_s < 0):
        raise ValueError("seen_ago_s is not a whole number of seconds")
    return Listing(
        **fields,
        ends_at=now + timedelta(seconds=row["ends_in_s"]),
        created_at=None if created_ago_s is None else now - timedelta(seconds=created_ago_s),
        seen_at=None if seen_ago_s is None else now - timedelta(seconds=seen_ago_s),
    )


def parse_sale(row: dict, now: datetime) -> Sale:
    """A sale row, its time counted back from `now`."""
    fields = {name: value for name, value in row.items() if name != "sold_ago_s"}
    return Sale(**fields, sold_at=now - timedelta(seconds=row["sold_ago_s"]))


def parse_pass_market(row: dict, dropped: list[str] | None = None) -> PassMarket:
    """A pass row, whose JSON lists become the model's tuples. The feed's five optional fields
    (advisor/pass_rates.py EXTRA_FIELDS) are checked: one that does not fit the contract is left out alone and its
    name added to `dropped`, so the row and the document stand. Any other field the model does not know refuses the
    row, as does a missing one."""
    fields, misfits = clean_extra(row)
    if dropped is not None:
        dropped.extend(misfits)
    return PassMarket(**{
        **{name: value for name, value in row.items() if name not in EXTRA_FIELDS},
        "month_share": tuple(row["month_share"]),
        "shelf": tuple((rating, ask) for rating, ask in row["shelf"]),
        **fields,
    })


def parse_fmv(rows: list[dict]) -> dict[int, Fmv]:
    """The fair-value rows by card id."""
    return {row["card_id"]: Fmv(**row) for row in rows}


def _under_target(target_price: int) -> int:
    """The highest bid a listing with this target price takes: bidding the target itself starts a countdown."""
    return math.floor(target_price * REPLAY_TARGET_CEILING)


class _Fixture:
    """The rows of a fixture file, which become model objects relative to whichever moment is asked."""

    def __init__(self, path: Path):
        data = json.loads(path.read_text(encoding="utf-8"))
        self._listing_rows = data["listings"]
        self._sale_rows = data["sales"]
        self.fmv = parse_fmv(data["fmv"])
        self.otd = tuple(parse_pass_market(row) for row in data["otd"])

    def listings(self, now: datetime) -> tuple[Listing, ...]:
        return tuple(parse_listing(row, now) for row in self._listing_rows)

    def sales(self, now: datetime) -> tuple[Sale, ...]:
        return tuple(parse_sale(row, now) for row in self._sale_rows)


def load_fixture(path: Path, now: datetime) -> RawData:
    """The fixture in `path` as it looks at `now`."""
    return FixtureSource(path).fetch(now)


class FixtureSource:
    """Serves the same market every time; its times are counted from the moment it is asked."""

    def __init__(self, path: Path):
        self._fixture = _Fixture(path)

    def fetch(self, now: datetime) -> RawData:
        fixture = self._fixture
        return RawData(
            fetched_at=now, listings=fixture.listings(now), fmv=fixture.fmv, sales=fixture.sales(now), otd=fixture.otd
        )


class ReplaySource:
    """Starts from the fixture, then moves the market on with every fetch so a demo looks live.

    Each fetch after the first drops the listings that have ended, now and then has someone take a
    target deal by bidding its target price, raises some bids and lists a few new cards, some of
    them priced as deals. Ordinary bids stay under the target price; the taker is the only one who
    bids it, which starts the auction's 10-minute countdown. Sales keep their age: they are counted
    back from each fetch, so the references the deals are judged against never go stale. What happens is
    drawn from the seeded generator the source owns, so a given seed and a given series of fetch
    times always give the same series of markets.
    """

    def __init__(self, path: Path, seed: int = 7):
        self._fixture = _Fixture(path)
        self._rng = random.Random(seed)
        self._listings: list[Listing] | None = None  # None until the first fetch
        self._templates: list[Listing] = []  # the cards new listings are copied from
        self._next_id = 1
        self._next_card_id = 1

    def fetch(self, now: datetime) -> RawData:
        sales = self._fixture.sales(now)
        market = index_sales(sales)
        if self._listings is None:
            self._open(now, market)
        else:
            self._listings = [listing for listing in self._listings if listing.ends_at > now]
            self._take_a_target_deal(now, market)
            self._raise_bids(now, market)  # a taken listing gets no ordinary raise: it is already past the ceiling
            self._add_listings(now, market)
        return RawData(
            fetched_at=now, listings=tuple(self._listings), fmv=self._fixture.fmv, sales=sales, otd=self._fixture.otd
        )

    def _reference(self, listing: Listing, market: dict[MarketKey, list[Sale]], now: datetime) -> Reference | None:
        ref = reference_for(listing, market.get(listing_key(listing), ()), self._fixture.fmv, now)
        return ref if ref is not None and ref.price > 0 else None

    def _open(self, now: datetime, market: dict[MarketKey, list[Sale]]) -> None:
        first = self._fixture.listings(now)
        self._next_id = max((listing.id for listing in first), default=0) + 1
        self._next_card_id = max((listing.card_id for listing in first), default=0) + 1
        self._listings = [listing for listing in first if listing.ends_at > now]
        self._templates = [listing for listing in self._listings if self._reference(listing, market, now) is not None]

    def _raise_bids(self, now: datetime, market: dict[MarketKey, list[Sale]]) -> None:
        """Bid on a few listings: the opening bid if nobody has bid yet, else a small raise up to the ceiling."""
        count = min(len(self._listings), max(1, round(len(self._listings) * REPLAY_BID_SHARE)))
        for index in self._rng.sample(range(len(self._listings)), count):
            listing = self._listings[index]
            ref = self._reference(listing, market, now)
            if ref is None:
                continue
            if listing.current_bid is None:
                bid = listing.min_bid
            else:
                step = 1 + self._rng.uniform(*REPLAY_BID_STEP)
                bid = max(listing.current_bid + 1, round(listing.current_bid * step))
            ceiling = ref.price * REPLAY_BID_CEILING
            if listing.target_price is not None:
                ceiling = min(ceiling, _under_target(listing.target_price))
            if bid <= ceiling:
                self._listings[index] = replace(listing, current_bid=bid, num_bids=listing.num_bids + 1)

    def _take_a_target_deal(self, now: datetime, market: dict[MarketKey, list[Sale]]) -> None:
        """Now and then, someone bids the target price of one target deal, and its 10-minute countdown starts."""
        if self._rng.random() >= REPLAY_TAKE_CHANCE:
            return
        deals = [
            index
            for index, listing in enumerate(self._listings)
            if not listing.minted_by_real
            and (ref := self._reference(listing, market, now)) is not None
            and is_target_deal(listing, ref)
        ]
        if not deals:
            return
        index = self._rng.choice(deals)
        listing = self._listings[index]
        self._listings[index] = replace(
            listing,
            current_bid=listing.target_price,
            num_bids=listing.num_bids + 1,
            ends_at=min(listing.ends_at, now + COUNTDOWN),
        )

    def _add_listings(self, now: datetime, market: dict[MarketKey, list[Sale]]) -> None:
        if not self._templates:
            return
        for _ in range(self._rng.randint(*REPLAY_NEW_LISTINGS)):
            template = self._rng.choice(self._templates)
            ref = self._reference(template, market, now)
            if ref is not None:
                self._listings.append(self._new_listing(template, ref, now))

    def _new_listing(self, template: Listing, ref: Reference, now: datetime) -> Listing:
        """A card like `template`, listed just now: a deal (cheap target and opening bid) or fairly priced."""
        rng = self._rng
        if rng.random() < REPLAY_DEAL_SHARE:
            target = ref.price * rng.uniform(*REPLAY_DEAL_TARGET)
            start = ref.price * rng.uniform(*REPLAY_DEAL_START)
        else:
            target = ref.price * rng.uniform(*REPLAY_FAIR_TARGET) if rng.random() < REPLAY_TARGET_SHARE else None
            start = ref.price * rng.uniform(*REPLAY_FAIR_START)
        # A target price is at least 2, so there is room under it for an opening bid of 1.
        target_price = None if target is None else max(2, round(target))
        min_bid = max(1, round(start))
        if target_price is not None:
            min_bid = min(min_bid, _under_target(target_price))
        shortest, longest = REPLAY_NEW_LISTING_MINUTES
        listing = replace(
            template,
            id=self._next_id,
            card_id=self._next_card_id,
            mint=None if template.mint is None else rng.randint(1, 2 * template.mint),
            min_bid=min_bid,
            current_bid=None,
            num_bids=0,
            target_price=target_price,
            ends_at=now + timedelta(seconds=rng.randint(shortest * 60, longest * 60)),
            created_at=now,
            minted_by_real=False,  # a player lists it, even when the template was one of Real's own mints
        )
        self._next_id += 1
        self._next_card_id += 1
        return listing
