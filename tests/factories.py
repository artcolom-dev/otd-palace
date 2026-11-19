"""Builders for model objects with sensible defaults; override any field by keyword."""

from datetime import datetime, timedelta, timezone

from advisor.model import Fmv, Listing, PassMarket, RawData, Sale

NOW = datetime(2026, 11, 12, 18, 0, tzinfo=timezone.utc)

# The fields a deal is served with, no more and no fewer.
DEAL_KEYS = {
    "listing_id", "card_id", "sport", "season", "player_id", "player_name", "card_label", "rarity", "rating",
    "bucket", "mint", "kind", "price", "reference", "ref_source", "ref_tier", "ref_sample", "confidence",
    "discount", "gap", "flip_margin", "num_bids", "ends_at", "url", "per_point", "ref_per_point", "listed_at", "seen_at", "real_estimate", "recent_sales",
    "falling",
}


def make_listing(**kw) -> Listing:
    fields = dict(
        id=1, card_id=100, sport="nba", season=2026, player_id=10,
        player_name="Test Player", card_label="Test Player 2026", rarity=3, rating=4.2,
        mint=12, min_bid=100, current_bid=None, num_bids=0, target_price=None,
        ends_at=NOW + timedelta(hours=1), created_at=NOW - timedelta(hours=1),
    )
    return Listing(**{**fields, **kw})


def make_sale(**kw) -> Sale:
    fields = dict(
        card_id=100, player_id=10, player_name="Test Player", sport="nba", season=2026,
        bucket="3-5", price=400, sold_at=NOW - timedelta(days=1),
    )
    return Sale(**{**fields, **kw})


def make_fmv(**kw) -> Fmv:
    fields = dict(card_id=100, median=None, tier=None, sale_count=0)
    return Fmv(**{**fields, **kw})


FLAT_MONTHS = (1 / 12,) * 12  # a season that pays the same every month of the year


def make_pass(**kw) -> PassMarket:
    """A past-season player pass paying 300 a season at 1x, evenly over the year; cards at 10 rax a rating point.

    Its key follows its sport, season, kind and player id unless one is given.
    """
    fields = dict(
        sport="nba", season=2025, season_label="2024-25", season_state="past", player_id=10,
        player_name="Test Player", team_id=1, position="PG", kind="player", base_1x=300.0, season_progress=1.0,
        game_days=80, game_days_measured=True, month_share=FLAT_MONTHS, rate_traded=10.0, rate_sales=20,
        shelf=(), shelf_count=0, mint_cost=200, mintable=True,
    )
    fields.update(kw)
    fields.setdefault("key", f"{fields['sport']}:{fields['season']}:{fields['kind']}:{fields['player_id']}")
    return PassMarket(**fields)


def make_raw(**kw) -> RawData:
    fields = dict(fetched_at=NOW, listings=(), fmv={}, sales=(), otd=())
    fields.update(kw)
    for name in ("listings", "sales", "otd"):
        fields[name] = tuple(fields[name])
    return RawData(**fields)


def five_sales(prices=(400, 420, 500, 380, 450), **kw) -> list[Sale]:
    """One sale per price; extra keywords apply to every sale."""
    return [make_sale(price=price, **kw) for price in prices]
