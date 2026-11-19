"""Which marketplace listings are deals, judged against what comparable cards really sold for."""

import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal

from advisor.links import card_url, listing_url
from advisor.model import Listing, RawData
from advisor.moves import falling_markets
from advisor.parsing import bucket_of
from advisor.reference import Reference, index_sales, listing_key, reference_for
from advisor.rules import (
    BID_DEAL_MAX_LEFT_MIN,
    BID_READ_MAX_AGE_S,
    DEAL_LINK,
    LISTING_FEE,
    MAX_DEALS,
    MAX_DEALS_PER_PLAYER,
    RECENT_SALES_SHOWN,
    SALES_WINDOW_DAYS,
    MIN_DISCOUNT,
    REAL_ESTIMATE_GAP,
    SELLER_FEE,
    TARGET_READ_MAX_AGE_S,
)


@dataclass(frozen=True)
class Deal:
    """A listing worth a look: what to pay, what it is worth, and why we think so."""

    listing_id: int
    card_id: int
    sport: str
    season: int
    player_id: int
    player_name: str
    card_label: str
    rarity: int
    rating: float
    bucket: str
    mint: int | None
    kind: str  # "target": the listing's target price; "bid": the bid needed to win an auction ending soon
    price: int
    reference: int
    ref_source: str
    ref_tier: str | None
    ref_sample: int
    confidence: str
    discount: float  # gap as a share of the reference, to 3 decimals
    gap: int  # reference minus price
    # What reselling at the reference pays after Real's fee and the listing fee, minus price; thin, or a loss,
    # under AFTER_FEES_MIN_REF, where the fees eat most of any resale. The deals are ordered by it.
    flip_margin: int
    num_bids: int
    ends_at: datetime
    url: str
    per_point: float | None  # price per rating point, to 1 decimal; None for a card rated 0
    ref_per_point: float | None  # reference per rating point, to 1 decimal; None for a card rated 0
    listed_at: datetime | None  # when the listing went up, when known
    falling: bool  # its market fell FALLING_AT or more today, so the reference may be behind the market
    seen_at: datetime | None = None  # when the listing was last read, if before the snapshot's moment (bids may have moved)
    # Real's own estimate for the card when the usual price comes from sales and the two differ by REAL_ESTIMATE_GAP
    # or more; None otherwise.
    real_estimate: int | None = None
    # The newest sales behind a usual price taken from sales, as (price, seconds ago), newest first; () otherwise.
    recent_sales: tuple[tuple[int, int], ...] = ()


def _meets_threshold(price: int, ref: Reference) -> bool:
    return price > 0 and (ref.price - price) / ref.price >= MIN_DISCOUNT[ref.confidence]


def is_target_deal(listing: Listing, ref: Reference) -> bool:
    """Whether buying at the listing's target price is a deal: it has one, it is cheap enough, and nobody has bid
    it yet. A bid at the target starts the auction's 10-minute countdown, and the target price is gone with it."""
    target = listing.target_price
    if target is None or (listing.current_bid is not None and listing.current_bid >= target):
        return False
    return _meets_threshold(target, ref)


def _kind_and_price(listing: Listing, ref: Reference, now: datetime) -> tuple[str, int] | None:
    """How a listing is a deal, if it is: at its target price, or by bidding when the auction is nearly over.

    Once the target price is bid, only the bid to beat is left, inside the bid window like any other auction.
    """
    read_ago_s = 0.0 if listing.seen_at is None else (now - listing.seen_at).total_seconds()
    if is_target_deal(listing, ref) and read_ago_s <= TARGET_READ_MAX_AGE_S:
        return "target", listing.target_price
    minutes_left = (listing.ends_at - now).total_seconds() / 60
    if minutes_left <= BID_DEAL_MAX_LEFT_MIN and read_ago_s <= BID_READ_MAX_AGE_S:
        bid = max(listing.min_bid, listing.current_bid or 0)
        if _meets_threshold(bid, ref):
            return "bid", bid
    return None


def _per_point(amount: int, rating: float) -> float | None:
    """An amount per rating point, to 1 decimal rounded half up; None when the card has no rating."""
    if rating <= 0:
        return None
    return float((Decimal(amount) / Decimal(str(rating))).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))


def _flip_margin(price: int, reference: int) -> int:
    """What reselling at the reference pays after Real's fee and the listing fee, minus price; negative for a loss."""
    return math.floor(reference * (1 - SELLER_FEE)) - LISTING_FEE - price


def _real_estimate(listing: Listing, ref: Reference, fmv) -> int | None:
    """Real's own estimate when it is far from the sales the usual price rests on, else None."""
    value = fmv.get(listing.card_id)
    median = getattr(value, "median", None)
    if ref.source != "sales" or not median or median <= 0:
        return None
    return int(median) if abs(median - ref.price) / ref.price >= REAL_ESTIMATE_GAP else None


def _recent_sales(ref: Reference, market_sales, now: datetime) -> tuple[tuple[int, int], ...]:
    """The newest sales of the window behind a usual price taken from sales; none for one priced otherwise."""
    if ref.source != "sales":
        return ()
    since = now - timedelta(days=SALES_WINDOW_DAYS)
    newest = sorted((s for s in market_sales if since <= s.sold_at <= now), key=lambda s: s.sold_at, reverse=True)
    return tuple((s.price, int((now - s.sold_at).total_seconds())) for s in newest[:RECENT_SALES_SHOWN])


def _deal(listing: Listing, kind: str, price: int, ref: Reference, falling: bool, real_estimate: int | None = None,
          recent_sales: tuple[tuple[int, int], ...] = ()) -> Deal:
    gap = ref.price - price
    link = card_url(listing.card_id) if DEAL_LINK == "card" else listing_url(listing.id)
    return Deal(
        listing_id=listing.id, card_id=listing.card_id, sport=listing.sport, season=listing.season,
        player_id=listing.player_id, player_name=listing.player_name, card_label=listing.card_label,
        rarity=listing.rarity, rating=listing.rating, bucket=bucket_of(listing.rating), mint=listing.mint,
        kind=kind, price=price, reference=ref.price, ref_source=ref.source, ref_tier=ref.tier,
        ref_sample=ref.sample, confidence=ref.confidence, discount=round(gap / ref.price, 3), gap=gap,
        flip_margin=_flip_margin(price, ref.price), num_bids=listing.num_bids, ends_at=listing.ends_at, url=link,
        per_point=_per_point(price, listing.rating), ref_per_point=_per_point(ref.price, listing.rating),
        listed_at=listing.created_at, falling=falling, seen_at=listing.seen_at, real_estimate=real_estimate,
        recent_sales=recent_sales,
    )


def _order(deal: Deal) -> tuple:
    """Most left after fees if resold at the usual price first (a cheap card under its usual price can still lose:
    the internal research notes, 3), then the biggest discount, then the newest listing (unknown age
    last), then the soonest to end, then by id. A deal that loses after fees stays: some buyers want the card."""
    newest_first = (0, -deal.listed_at.timestamp()) if deal.listed_at is not None else (1, 0.0)
    return (-deal.flip_margin, -deal.discount, newest_first, deal.ends_at, deal.listing_id)


def judge(listing: Listing, market_sales, fmv, now: datetime) -> tuple[str, int, Reference] | None:
    """How a listing is a deal at `now`, before the list's caps (MAX_DEALS, MAX_DEALS_PER_PLAYER): its kind, price and
    reference, or None. `market_sales` are the sales of its market (see `index_sales`). A card Real minted and listed
    itself is never a deal: its fixed price says nothing about the market."""
    if listing.ends_at <= now or listing.minted_by_real:
        return None
    ref = reference_for(listing, market_sales, fmv, now)
    if ref is None or ref.price <= 0:
        return None
    found = _kind_and_price(listing, ref, now)
    return None if found is None else (*found, ref)


def find_deals(raw: RawData, now: datetime) -> list[Deal]:
    """The deals among the open listings (see `judge`), in the order of `_order`."""
    sales_by_market = index_sales(raw.sales)
    falling = falling_markets(raw.sales, now)
    deals = []
    for listing in raw.listings:
        market_sales = sales_by_market.get(listing_key(listing), ())
        judged = judge(listing, market_sales, raw.fmv, now)
        if judged is not None:
            kind, price, ref = judged
            market = (listing.sport, listing.season, listing.player_id, bucket_of(listing.rating))
            deals.append(_deal(listing, kind, price, ref, market in falling, _real_estimate(listing, ref, raw.fmv),
                               _recent_sales(ref, market_sales, now)))
    deals.sort(key=_order)  # past MAX_DEALS, the deals that leave least after fees are the ones left out
    per_player: dict[tuple[str, int], int] = {}
    kept = []
    for deal in deals:  # best first: a player's first MAX_DEALS_PER_PLAYER deals stay
        who = (deal.sport, deal.player_id)
        per_player[who] = per_player.get(who, 0) + 1
        if per_player[who] <= MAX_DEALS_PER_PLAYER:
            kept.append(deal)
    return kept[:MAX_DEALS]
