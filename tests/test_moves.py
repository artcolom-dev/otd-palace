from datetime import timedelta

import pytest

from advisor.moves import Move, falling_markets, market_moves
from advisor.rules import (
    FALLING_AT,
    MIN_ABS_CHANGE,
    MIN_SALES_BASE,
    MIN_SALES_RECENT,
    MOVES_BASE_DAYS,
    MOVES_RECENT_H,
    TOP_MOVES,
)
from tests.factories import NOW, make_sale

EMPTY = {"risers": [], "fallers": []}
RECENT_EDGE = NOW - timedelta(hours=MOVES_RECENT_H)  # the last instant of the base window
BASE_EDGE = RECENT_EDGE - timedelta(days=MOVES_BASE_DAYS)  # the first instant before the base window
N = MIN_SALES_RECENT  # just enough recent sales for a move


def player_sales(pid, base_price, recent_prices, **kw):
    base = [make_sale(player_id=pid, price=base_price, sold_at=NOW - timedelta(days=3), **kw) for _ in range(5)]
    recent = [make_sale(player_id=pid, price=p, sold_at=NOW - timedelta(hours=2), **kw) for p in recent_prices]
    return base + recent


def test_risers_and_fallers():
    sales = player_sales(1, 100, [130] * N) + player_sales(2, 100, [80] * N) + player_sales(3, 100, [105] * N)
    moves = market_moves(sales, NOW)
    assert [(m.player_id, m.change) for m in moves["risers"]] == [(1, 0.3)]
    assert [(m.player_id, m.change) for m in moves["fallers"]] == [(2, -0.2)]


def test_too_few_recent_sales_is_ignored():
    assert market_moves(player_sales(1, 100, [200] * (N - 1)), NOW) == {"risers": [], "fallers": []}


def test_too_few_base_sales_is_ignored():
    sales = player_sales(1, 100, [200] * N)[1:]  # one base sale short
    assert len([s for s in sales if s.sold_at < RECENT_EDGE]) == MIN_SALES_BASE - 1
    assert market_moves(sales, NOW) == EMPTY


def test_no_sales_gives_empty_moves():
    assert market_moves([], NOW) == EMPTY


def test_a_move_carries_everything_the_site_shows():
    sales = player_sales(7, 100, [120, 130, 135, 140, 150], sport="mlb", season=2025, bucket="6-8", player_name="Jo Doe")
    [move] = market_moves(sales, NOW)["risers"]
    assert move == Move(
        sport="mlb", season=2025, player_id=7, player_name="Jo Doe", bucket="6-8",
        median_recent=135, median_base=100, change=0.35, sales_recent=5,
    )
    assert type(move.median_recent) is int and type(move.median_base) is int


def test_medians_are_whole_numbers():
    base = [make_sale(price=p, sold_at=NOW - timedelta(days=2)) for p in (100, 101, 102, 103, 104, 105)]  # median 102.5
    recent = [make_sale(price=p, sold_at=NOW - timedelta(hours=1)) for p in (150, 155, 160, 165, 171)]
    [move] = market_moves(base + recent, NOW)["risers"]
    assert (move.median_base, move.median_recent) == (102, 160)
    assert move.change == round(160 / 102 - 1, 3)


def test_change_is_rounded_to_three_decimals():
    [move] = market_moves(player_sales(1, 300, [400] * N), NOW)["risers"]
    assert move.change == 0.333


def test_a_move_of_exactly_the_minimum_is_kept_either_way():
    assert MIN_ABS_CHANGE == 0.20  # the prices below are built for a 20 % threshold
    sales = player_sales(1, 100, [120] * N) + player_sales(2, 100, [80] * N)
    moves = market_moves(sales, NOW)
    assert [(m.player_id, m.change) for m in moves["risers"]] == [(1, 0.2)]
    assert [(m.player_id, m.change) for m in moves["fallers"]] == [(2, -0.2)]


def test_a_move_just_under_the_minimum_is_dropped():
    sales = player_sales(1, 1000, [1199] * N) + player_sales(2, 1000, [801] * N)
    assert market_moves(sales, NOW) == EMPTY


def test_risers_are_best_first_and_fallers_worst_first():
    sales = (
        player_sales(1, 100, [120] * N) + player_sales(2, 100, [150] * N) + player_sales(3, 100, [130] * N)
        + player_sales(4, 100, [80] * N) + player_sales(5, 100, [50] * N) + player_sales(6, 100, [70] * N)
    )
    moves = market_moves(sales, NOW)
    assert [m.player_id for m in moves["risers"]] == [2, 3, 1]
    assert [m.player_id for m in moves["fallers"]] == [5, 6, 4]


def test_each_list_stops_at_the_top_moves():
    extra = 2
    sales = []
    for i in range(TOP_MOVES + extra):
        sales += player_sales(100 + i, 100, [120 + 5 * i] * N)  # riser: +20 %, +25 %, ...
        sales += player_sales(200 + i, 1000, [800 - 20 * i] * N)  # faller: -20 %, -22 %, ...
    moves = market_moves(sales, NOW)
    assert [m.player_id for m in moves["risers"]] == [100 + i for i in reversed(range(extra, TOP_MOVES + extra))]
    assert [m.player_id for m in moves["fallers"]] == [200 + i for i in reversed(range(extra, TOP_MOVES + extra))]
    assert len(moves["risers"]) == len(moves["fallers"]) == TOP_MOVES


def test_sport_season_and_bucket_are_separate_markets():
    base = {"sold_at": NOW - timedelta(days=3)}
    recent = {"sold_at": NOW - timedelta(hours=2)}
    sales = (
        # The same player in two buckets: only the 3-5 bucket moved.
        [make_sale(bucket="3-5", price=100, **base) for _ in range(5)]
        + [make_sale(bucket="3-5", price=150, **recent) for _ in range(N)]
        + [make_sale(bucket="6-8", price=100, **base) for _ in range(5)]
        + [make_sale(bucket="6-8", price=100, **recent) for _ in range(N)]
        # Recent sales of another sport and season must not pad the 3-5 group.
        + [make_sale(sport="mlb", price=500, **recent) for _ in range(N)]
        + [make_sale(season=2025, price=500, **recent) for _ in range(N)]
    )
    moves = market_moves(sales, NOW)
    assert [(m.sport, m.season, m.bucket, m.sales_recent) for m in moves["risers"]] == [("nba", 2026, "3-5", N)]
    assert moves["fallers"] == []


@pytest.mark.parametrize(
    "extra_base_at, qualifies",
    [
        (RECENT_EDGE, True),  # exactly 24 h old: base, so the base has its fifth sale
        (RECENT_EDGE + timedelta(seconds=1), False),  # just inside the last 24 h: recent, base stays at four
        (BASE_EDGE, False),  # exactly 24 h + 7 d old: outside the base window
        (BASE_EDGE + timedelta(seconds=1), True),  # just inside the base window
    ],
)
def test_base_window_edges(extra_base_at, qualifies):
    sales = player_sales(1, 100, [130] * N)[1:]  # N recent sales but only four base sales, one short
    sales.append(make_sale(player_id=1, price=100, sold_at=extra_base_at))
    risers = market_moves(sales, NOW)["risers"]
    assert [m.player_id for m in risers] == ([1] if qualifies else [])


@pytest.mark.parametrize(
    "last_sale_at, qualifies",
    [
        (NOW, True),  # a sale this very instant is recent
        (NOW + timedelta(seconds=1), False),  # a sale from the future is not
        (RECENT_EDGE, False),  # exactly 24 h old is base, not recent
        (RECENT_EDGE + timedelta(seconds=1), True),  # just inside the last 24 h
    ],
)
def test_recent_window_edges(last_sale_at, qualifies):
    sales = player_sales(1, 100, [130] * (N - 1))
    sales.append(make_sale(player_id=1, price=130, sold_at=last_sale_at))
    risers = market_moves(sales, NOW)["risers"]
    assert [m.player_id for m in risers] == ([1] if qualifies else [])


def test_sales_older_than_the_base_window_do_not_count():
    sales = player_sales(1, 100, [130] * N) + [make_sale(price=1, sold_at=NOW - timedelta(days=30)) for _ in range(20)]
    [move] = market_moves(sales, NOW)["risers"]
    assert move.median_base == 100


def test_a_zero_priced_base_is_skipped_not_divided_by():
    assert market_moves(player_sales(1, 0, [130] * N), NOW) == EMPTY


def test_the_name_comes_from_the_latest_sale_whatever_the_input_order():
    sales = player_sales(1, 100, [130] * (N - 1))
    sales.append(make_sale(player_id=1, price=130, player_name="New Name", sold_at=NOW - timedelta(minutes=5)))
    for ordered in (sales, sales[::-1]):
        [move] = market_moves(ordered, NOW)["risers"]
        assert move.player_name == "New Name"


def test_moves_need_20pct_and_5_recent_sales():
    assert (MIN_ABS_CHANGE, MIN_SALES_RECENT) == (0.20, 5)
    sales = (
        player_sales(1, 100, [120] * 5)  # +20 % on five sales: a riser
        + player_sales(2, 100, [150] * 4)  # +50 % but only four sales today
        + player_sales(3, 1000, [1199] * 5)  # +19.9 %: too small
        + player_sales(4, 100, [80] * 5)  # -20 % on five sales: a faller
        + player_sales(5, 1000, [801] * 5)  # -19.9 %: too small
    )
    moves = market_moves(sales, NOW)
    assert [m.player_id for m in moves["risers"]] == [1]
    assert [m.player_id for m in moves["fallers"]] == [4]


def test_falling_markets_are_the_keys_down_at_least_the_falling_threshold():
    assert FALLING_AT == -0.20
    sales = (
        player_sales(1, 100, [80] * N)  # -20 %: falling
        + player_sales(2, 1000, [801] * N)  # -19.9 %: not falling
        + player_sales(3, 100, [130] * N)  # rising
        + player_sales(4, 100, [50] * (N - 1))  # -50 % on too few sales: no evidence
        + player_sales(5, 100, [60] * N, sport="mlb", season=2025, bucket="7-9")  # -40 %: falling
    )
    assert falling_markets(sales, NOW) == frozenset({("nba", 2026, 1, "3-5"), ("mlb", 2025, 5, "7-9")})
    assert falling_markets([], NOW) == frozenset()


def test_falling_markets_not_capped_by_top_moves():
    count = TOP_MOVES + 3
    sales = []
    for i in range(count):
        sales += player_sales(100 + i, 1000, [800 - 20 * i] * N)  # -20 %, -22 %, ...
    assert len(market_moves(sales, NOW)["fallers"]) == TOP_MOVES
    assert falling_markets(sales, NOW) == frozenset(("nba", 2026, 100 + i, "3-5") for i in range(count))


def test_moves_on_prices_near_the_floor_are_noise_and_are_not_shown():
    """20 -> 60 Rax is +200% but one tick of a floor-priced card: only markets that reach MOVE_MIN_PRICE count."""
    from advisor.rules import MOVE_MIN_PRICE

    floor = player_sales(1, 20, [60] * N)
    real = player_sales(2, 400, [650] * N)
    edge = player_sales(3, MOVE_MIN_PRICE // 2, [MOVE_MIN_PRICE] * N)  # reaches the bar: shown
    moves = market_moves(floor + real + edge, NOW)
    assert sorted(m.player_id for m in moves["risers"]) == [2, 3]
    falling = market_moves(player_sales(4, 60, [20] * N), NOW)
    assert falling["fallers"] == []
