"""Market moves: players whose realised sale prices rose or fell today versus the week before."""

import statistics
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

from advisor.model import Sale
from advisor.rules import (
    FALLING_AT,
    MIN_ABS_CHANGE,
    MOVE_MIN_PRICE,
    MIN_SALES_BASE,
    MIN_SALES_RECENT,
    MOVES_BASE_DAYS,
    MOVES_RECENT_H,
    TOP_MOVES,
)

# A market: (sport, season, player_id, bucket).
MoveKey = tuple[str, int, int, str]


@dataclass(frozen=True)
class Move:
    """How the realised price of one player's cards in one value bucket changed."""

    sport: str
    season: int
    player_id: int
    player_name: str
    bucket: str
    median_recent: int
    median_base: int
    change: float  # median_recent / median_base - 1, to 3 decimals
    sales_recent: int


def _measured_moves(sales: Sequence[Sale], now: datetime) -> list[Move]:
    """How every market with enough evidence moved, however little.

    Sales are grouped by sport, season, player and value bucket. The recent window is the
    last MOVES_RECENT_H hours up to now; the base window is the MOVES_BASE_DAYS before that.
    A market needs MIN_SALES_RECENT recent sales, MIN_SALES_BASE base sales and a positive base median.
    """
    # Recent is (recent_from, now]; base is (base_from, recent_from].
    recent_from = now - timedelta(hours=MOVES_RECENT_H)
    base_from = recent_from - timedelta(days=MOVES_BASE_DAYS)

    recent: dict[tuple, list[Sale]] = defaultdict(list)
    base: dict[tuple, list[Sale]] = defaultdict(list)
    for sale in sales:
        key = (sale.sport, sale.season, sale.player_id, sale.bucket)
        if recent_from < sale.sold_at <= now:
            recent[key].append(sale)
        elif base_from < sale.sold_at <= recent_from:
            base[key].append(sale)

    moves = []
    for key, recent_sales in recent.items():
        base_sales = base.get(key, [])
        if len(recent_sales) < MIN_SALES_RECENT or len(base_sales) < MIN_SALES_BASE:
            continue
        median_recent = round(statistics.median(s.price for s in recent_sales))
        median_base = round(statistics.median(s.price for s in base_sales))
        if median_base <= 0:
            continue
        sport, season, player_id, bucket = key
        player_name = max(recent_sales, key=lambda s: s.sold_at).player_name
        change = round(median_recent / median_base - 1, 3)
        moves.append(
            Move(sport, season, player_id, player_name, bucket, median_recent, median_base, change, len(recent_sales))
        )
    return moves


def market_moves(sales: Sequence[Sale], now: datetime) -> dict[str, list[Move]]:
    """The biggest risers and fallers, best first: the TOP_MOVES of each that moved at least MIN_ABS_CHANGE."""
    moves = [
        m
        for m in _measured_moves(sales, now)
        if abs(m.change) >= MIN_ABS_CHANGE and max(m.median_recent, m.median_base) >= MOVE_MIN_PRICE
    ]
    risers = sorted((m for m in moves if m.change > 0), key=lambda m: m.change, reverse=True)
    fallers = sorted((m for m in moves if m.change < 0), key=lambda m: m.change)
    return {"risers": risers[:TOP_MOVES], "fallers": fallers[:TOP_MOVES]}


def falling_markets(sales: Sequence[Sale], now: datetime) -> frozenset[MoveKey]:
    """Every market, as (sport, season, player_id, bucket), that fell FALLING_AT or more today; not capped."""
    return frozenset(
        (m.sport, m.season, m.player_id, m.bucket) for m in _measured_moves(sales, now) if m.change <= FALLING_AT
    )
