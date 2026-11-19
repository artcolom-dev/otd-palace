"""The reference price of a listing: what comparable cards really sold for."""

import statistics
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

from advisor.model import Fmv, Listing, Sale
from advisor.parsing import bucket_of
from advisor.rules import MIN_FMV_SALES, MIN_SALES_HIGH, SALES_WINDOW_DAYS

# Cards compare when they share a player, sport, season and value bucket.
MarketKey = tuple[int, str, int, str]


@dataclass(frozen=True)
class Reference:
    """The price a listing is judged against, and how far to trust it."""

    price: int
    source: str  # "sales" or "fmv"
    sample: int  # how many sales stand behind the price
    confidence: str  # "high" or "medium"
    tier: str | None  # Real's fair-market-value tier when source is "fmv", otherwise None


def listing_key(listing: Listing) -> MarketKey:
    return (listing.player_id, listing.sport, listing.season, bucket_of(listing.rating))


def sale_key(sale: Sale) -> MarketKey:
    return (sale.player_id, sale.sport, sale.season, sale.bucket)


def index_sales(sales: Iterable[Sale]) -> dict[MarketKey, list[Sale]]:
    """Group sales by market, so each listing finds its comparable sales without scanning them all."""
    index: dict[MarketKey, list[Sale]] = defaultdict(list)
    for sale in sales:
        index[sale_key(sale)].append(sale)
    return dict(index)


def reference_for(listing: Listing, sales: Sequence[Sale], fmv: Mapping[int, Fmv], now: datetime) -> Reference | None:
    """The reference for a listing, or None when there is not enough evidence.

    Enough recent comparable sales give a high-confidence median. Failing that, Real's
    fair market value for the card, when it rests on enough sales, gives a medium-confidence one.
    """
    key = listing_key(listing)
    since = now - timedelta(days=SALES_WINDOW_DAYS)
    prices = [s.price for s in sales if sale_key(s) == key and since <= s.sold_at <= now]
    if len(prices) >= MIN_SALES_HIGH:
        return Reference(round(statistics.median(prices)), "sales", len(prices), "high", None)

    value = fmv.get(listing.card_id)
    if value is not None and value.median is not None and value.sale_count >= MIN_FMV_SALES:
        return Reference(value.median, "fmv", value.sale_count, "medium", value.tier)
    return None
