"""The data the advisor works on: one immutable snapshot of what Real is showing right now.

Every datetime is timezone-aware UTC.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class Listing:
    """A card up for auction."""

    id: int
    card_id: int
    sport: str
    season: int
    player_id: int
    player_name: str
    card_label: str
    rarity: int
    rating: float
    mint: int | None
    min_bid: int
    current_bid: int | None
    num_bids: int
    # Real's buyNowPrice: bidding it starts a 10-minute countdown, there is no instant buy.
    target_price: int | None
    ends_at: datetime
    created_at: datetime | None
    # Listed by Real itself, a fresh mint at a fixed price; never a seller's mistake, so never a deal.
    minted_by_real: bool = False
    # When the source last read this listing, if earlier than the data's own moment (a feed that reads player by
    # player); None = read at that moment. Its bids may have moved since.
    seen_at: datetime | None = None


@dataclass(frozen=True)
class Sale:
    """A completed sale of a card."""

    card_id: int
    player_id: int
    player_name: str
    sport: str
    season: int
    bucket: str
    price: int
    sold_at: datetime


@dataclass(frozen=True)
class Fmv:
    """Real's fair market value for a card."""

    card_id: int
    median: int | None
    tier: str | None
    sale_count: int


@dataclass(frozen=True)
class PassMarket:
    """One daily-pay pass of one season: a player's, a fighter's or a team's, with what its rarities are built from
    and what its season earned.

    The pass pays, on each anniversary of a day its player earned in that season, that day's 1x earnings times its
    rarity's multiplier, until it has paid its lifetime limit. Its rarity follows the total rating of the cards held
    for that player-season (advisor/rules.py OTD_LADDERS).
    """

    key: str  # "sport:season:kind:player_id", unique
    sport: str
    season: int
    season_label: str  # the season as Real shows it, such as "2024-25"
    season_state: str  # "past" (its figures are final) or "current" (still being played)
    player_id: int  # a team pass carries its team's id here
    player_name: str
    team_id: int | None
    position: str | None
    kind: str  # its ladder: "player", "fighter" or "team"
    base_1x: float  # what the season earned at 1x; for a current season, what it has earned so far
    season_progress: float  # share of the season played; 1.0 for a past season
    game_days: int | None  # the player's earning days in the whole season (a current season's are projected)
    game_days_measured: bool  # counted from the earnings log, rather than taken from the sport's table
    month_share: tuple[float, ...]  # the season's earnings by calendar month, January first: 12 shares adding to 1
    rate_traded: float | None  # median rax per rating point the player-season's cards traded at; None if unknown
    rate_sales: int  # how many trades that rate comes from
    shelf: tuple[tuple[float, int], ...]  # the player-season's cards on sale now: (rating, ask in rax)
    shelf_count: int  # how many of its cards are on sale (the shelf may hold fewer)
    mint_cost: int | None  # what minting the pass costs; None when the market does not say
    mintable: bool  # whether the pass can be minted today
    # The feed's five optional fields (advisor/pass_rates.py checks them; None when the row does not carry one, or
    # carried one that did not fit). Shapes as the feed sends them: `rates_by_bucket` {bucket: {rate, sales, span_d,
    # by_rarity: {rarity: [rate, sales]}, offers: {...}}}, `rate_build_from` {bucket, rarity, sales}, `shelf_auctions`
    # {read_at, listings: [[rating, pay, min_bid, target, bids, ends_in_s, house, rarity], ...]}.
    rate_bucket: str | None = None  # the bucket `rate_traded` comes from
    rates_by_bucket: Mapping | None = None  # listing sales and accepted offers by bucket and rarity
    rate_build: float | None = None  # the cheapest (bucket, rarity) cell with 5 listing sales: what a rating point costs
    rate_build_from: Mapping | None = None  # that cell
    shelf_auctions: Mapping | None = None  # the shelf page with each auction's state

    @property
    def measured(self) -> bool:
        """Whether the feed measured this pass by bucket and rarity: a null `rate_build` then means no cell has enough
        sales (the rate is thin), not that the row predates the fields."""
        return self.rates_by_bucket is not None

    @property
    def month_share_estimated(self) -> bool:
        """Whether `month_share` cannot be used (missing, all zero or not 12 of them), so the payback walk spreads the
        season evenly over its sport's months instead (over the whole year for a sport whose months are unknown)."""
        return len(self.month_share) != 12 or sum(max(0.0, share) for share in self.month_share) <= 0


@dataclass(frozen=True)
class Challenge:
    """A challenge Real runs right now that pays rax or packs (watch a game's plays, fill a profile...)."""

    key: str
    title: str
    reward: str | None  # what it pays, in Real's words, when known
    ends_at: datetime | None  # None when it says no end


@dataclass(frozen=True)
class RawData:
    """Everything one fetch from a source returned.

    `fetched_at` is the moment the data describes: the fetch itself for the demo sources, the time the document was
    built for the live feed (which may be a few seconds before the fetch). `coverage` is what the source says it
    covers (see `advisor.sources.feed`), or None for a source that does not say."""

    fetched_at: datetime
    listings: tuple[Listing, ...]
    fmv: Mapping[int, Fmv]
    sales: tuple[Sale, ...]
    otd: tuple[PassMarket, ...]
    coverage: Mapping[str, object] | None = None
    challenges: tuple[Challenge, ...] = ()
