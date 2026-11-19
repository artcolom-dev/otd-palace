"""advisor/price_history.py: one figure a finished day and market (the day's middle sale, how many sales), kept for
PRICE_CURVE_DAYS days, bounded, written to disk and read back; never a day it did not see."""

import json
import threading
from datetime import datetime, timedelta, timezone

import pytest

from advisor import snapshot as snapshot_module
from advisor.collector import run_collector
from advisor.model import Sale
from advisor.price_history import FILE_VERSION, PriceHistory
from advisor.public import public_snapshot
from advisor.rules import PRICE_CURVE_DAYS, PRICE_CURVE_MIN_SALES
from advisor.snapshot import build_snapshot
from advisor.store import SnapshotStore
from tests.factories import NOW as T0
from tests.factories import make_raw, make_sale
from tests.test_snapshot import MOVE_KEYS

NOW = datetime(2026, 11, 19, 15, 0, tzinfo=timezone.utc)
KEY = ("nba", 2025, 7, "3-5")


def sale(price: int, days_ago: int, *, hour: int = 12, key=KEY, card_id: int = 1) -> Sale:
    sport, season, player_id, bucket = key
    day = (NOW - timedelta(days=days_ago)).replace(hour=hour, minute=0)
    return Sale(card_id=card_id, player_id=player_id, player_name="P", sport=sport, season=season, bucket=bucket,
                price=price, sold_at=day)


def day_of(prices, days_ago, **kw):
    return [sale(p, days_ago, **kw) for p in prices]


def test_a_finished_day_gives_its_middle_sale_and_its_count():
    history = PriceHistory(None)
    history.learn(day_of([100, 120, 500], 1) + day_of([90, 110, 95, 105], 2), NOW)
    assert history.series(KEY, NOW) == [[2, 100, 4], [1, 120, 3]]  # oldest first: [days ago, middle sale, sales]


def test_a_day_with_too_few_sales_is_a_gap_never_a_point():
    history = PriceHistory(None)
    few = day_of([100] * (PRICE_CURVE_MIN_SALES - 1), 2)
    history.learn(day_of([100, 110, 120], 3) + few + day_of([130, 140, 150], 1), NOW)
    assert [point[0] for point in history.series(KEY, NOW)] == [3, 1]


def test_today_is_never_learned_it_is_not_finished():
    history = PriceHistory(None)
    history.learn(day_of([100, 110, 120], 0, hour=3), NOW)
    assert history.series(KEY, NOW) == []
    history.learn(day_of([100, 110, 120], 0, hour=3), NOW + timedelta(days=1))  # the next day it is
    assert history.series(KEY, NOW + timedelta(days=1)) == [[1, 110, 3]]


def test_a_sale_after_now_is_not_counted():
    history = PriceHistory(None)
    early = NOW.replace(hour=0, minute=30)  # yesterday's sales seen from just after midnight
    history.learn(day_of([100, 110, 120], 1) + [sale(900, 0, hour=5)], early)
    assert history.series(KEY, early) == [[1, 110, 3]]


def test_markets_are_kept_apart():
    other = ("nba", 2025, 7, "5-7")
    history = PriceHistory(None)
    history.learn(day_of([100, 110, 120], 1) + day_of([300, 310, 320], 1, key=other), NOW)
    assert history.series(KEY, NOW) == [[1, 110, 3]]
    assert history.series(other, NOW) == [[1, 310, 3]]
    assert history.series(("nfl", 2025, 7, "3-5"), NOW) == []


def test_a_day_stays_after_the_tape_forgets_it():
    history = PriceHistory(None)
    history.learn(day_of([100, 110, 120], 7), NOW)
    later = NOW + timedelta(days=5)
    history.learn(day_of([200, 210, 220], 1), later)  # the tape now holds one newer day only
    assert history.series(KEY, later) == [[12, 110, 3], [6, 210, 3]]


def test_the_reading_with_more_sales_wins_and_a_thinned_tape_never_weakens_a_day():
    history = PriceHistory(None)
    history.learn(day_of([100, 110, 120, 130, 140], 1), NOW)
    history.learn(day_of([100, 110, 300], 1), NOW + timedelta(minutes=1))  # the tape was thinned: fewer sales
    assert history.series(KEY, NOW) == [[1, 120, 5]]
    history.learn(day_of([100, 110, 120, 130, 140, 150, 160], 1), NOW + timedelta(minutes=2))  # late sales arrived
    assert history.series(KEY, NOW) == [[1, 130, 7]]


def test_days_older_than_the_window_are_dropped():
    history = PriceHistory(None)
    history.learn(day_of([100, 110, 120], 1), NOW)
    at_edge = NOW + timedelta(days=PRICE_CURVE_DAYS - 1)
    assert history.series(KEY, at_edge) == [[PRICE_CURVE_DAYS, 110, 3]]
    past = NOW + timedelta(days=PRICE_CURVE_DAYS)
    history.learn([], past)
    assert history.series(KEY, past) == []
    assert history.rows == 0


def test_the_rows_are_capped_oldest_days_first():
    history = PriceHistory(None, max_rows=4)
    sales = []
    for player in range(3):  # 3 markets x 2 days = 6 rows
        key = ("nba", 2025, player, "3-5")
        sales += day_of([100, 110, 120], 1, key=key) + day_of([100, 110, 120], 2, key=key)
    history.learn(sales, NOW)
    assert history.rows <= 4
    for player in range(3):  # yesterday is whole; the older day gave way
        assert [1, 110, 3] in history.series(("nba", 2025, player, "3-5"), NOW)


def test_it_is_written_and_read_back(tmp_path):
    path = tmp_path / "price-history.json"
    history = PriceHistory(path)
    history.learn(day_of([100, 110, 120], 1) + day_of([90, 95, 99], 3), NOW)
    history.flush()
    again = PriceHistory(path)
    assert again.series(KEY, NOW) == [[3, 95, 3], [1, 110, 3]]
    assert json.loads(path.read_text())["version"] == FILE_VERSION


def test_it_saves_at_most_every_so_often_and_flush_writes_the_rest(tmp_path):
    path = tmp_path / "price-history.json"
    history = PriceHistory(path, save_every=timedelta(minutes=5))
    history.learn(day_of([100, 110, 120], 2), NOW)  # the first learning is written at once
    assert PriceHistory(path).series(KEY, NOW) == [[2, 110, 3]]
    history.learn(day_of([100, 110, 120], 2) + day_of([200, 210, 220], 1), NOW + timedelta(minutes=1))
    assert PriceHistory(path).series(KEY, NOW) == [[2, 110, 3]]  # too soon
    history.flush()
    assert PriceHistory(path).series(KEY, NOW) == [[2, 110, 3], [1, 210, 3]]


def test_an_unreadable_file_is_set_aside_and_the_history_starts_empty(tmp_path):
    path = tmp_path / "price-history.json"
    path.write_text("{not json")
    history = PriceHistory(path)
    assert history.rows == 0
    assert (tmp_path / "price-history.json.corrupt").exists()
    history.learn(day_of([100, 110, 120], 1), NOW)
    history.flush()
    assert PriceHistory(path).series(KEY, NOW) == [[1, 110, 3]]


def test_rows_that_no_longer_fit_are_dropped_not_served(tmp_path):
    path = tmp_path / "price-history.json"
    day = NOW.date().toordinal() - 1
    path.write_text(json.dumps({"version": FILE_VERSION, "markets": [
        ["nba", 2025, 7, "3-5", [[day, 110, 3], [day - 1, -5, 3], [day - 2, 100, 0], ["x", 1, 3], [day - 3, 1e400, 3]]],
        ["nba", "2025", 7, "3-5", [[day, 110, 3]]],
        "junk",
    ]}))
    history = PriceHistory(path)
    assert history.series(KEY, NOW) == [[1, 110, 3]]
    assert history.rows == 1


def test_a_missing_file_is_an_empty_history(tmp_path):
    assert PriceHistory(tmp_path / "nope.json").rows == 0


def test_a_write_that_fails_is_only_a_warning(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("x")
    history = PriceHistory(blocker / "price-history.json")  # its folder cannot be made
    history.learn(day_of([100, 110, 120], 1), NOW)
    history.flush()
    assert history.series(KEY, NOW) == [[1, 110, 3]]


# --- served on the moves, and learned by the collector -----------------------------------------------------------

def mover_sales(recent_price=150):
    """A riser (100 -> 150) whose base week has two days with 3 sales and one day with 2."""
    days = {3: [100, 100, 100], 2: [90, 110, 130], 5: [100, 100]}
    base = [make_sale(price=p, sold_at=T0 - timedelta(days=d, hours=1)) for d, prices in days.items() for p in prices]
    recent = [make_sale(price=recent_price, sold_at=T0 - timedelta(hours=i + 1)) for i in range(5)]
    return base + recent


def learned(sales, now=T0) -> PriceHistory:
    history = PriceHistory(None)
    history.learn(sales, now)
    return history


def test_a_move_carries_its_markets_finished_days():
    sales = mover_sales()
    [riser] = build_snapshot(make_raw(sales=sales), T0, 1, history=learned(sales))["moves"]["risers"]
    assert riser["curve"] == [[3, 100, 3], [2, 110, 3]]  # the day with 2 sales is a gap
    assert set(riser) == MOVE_KEYS | {"curve"}


def test_without_a_history_a_move_is_served_as_before():
    sales = mover_sales()
    [riser] = build_snapshot(make_raw(sales=sales), T0, 1)["moves"]["risers"]
    assert "curve" not in riser


def test_a_market_with_no_finished_day_carries_no_curve():
    sales = mover_sales()
    [riser] = build_snapshot(make_raw(sales=sales), T0, 1, history=PriceHistory(None))["moves"]["risers"]
    assert "curve" not in riser


def test_the_switch_off_serves_no_curve(monkeypatch):
    monkeypatch.setattr(snapshot_module, "PRICE_CURVE_ON", False)
    sales = mover_sales()
    [riser] = build_snapshot(make_raw(sales=sales), T0, 1, history=learned(sales))["moves"]["risers"]
    assert "curve" not in riser


def test_the_free_snapshot_never_carries_a_curve():
    sales = mover_sales()
    snap = build_snapshot(make_raw(sales=sales), T0, 1, history=learned(sales))
    [riser] = public_snapshot(snap)["moves"]["risers"]
    assert "curve" not in riser


def test_a_history_that_breaks_costs_the_curve_not_the_move():
    class Broken:
        def series(self, key, now):
            raise RuntimeError("boom")

    sales = mover_sales()
    [riser] = build_snapshot(make_raw(sales=sales), T0, 1, history=Broken())["moves"]["risers"]
    assert "curve" not in riser and riser["median_recent"] == 150


class Once:
    def __init__(self, raw):
        self.raw = raw

    def fetch(self, now):
        return self.raw


def one_round(raw, **kw):
    stop, store = threading.Event(), SnapshotStore()

    def wait(_seconds):
        stop.set()
        return True

    run_collector(Once(raw), store, stop, interval_s=10, now=lambda: T0, wait=wait, first_version=1, **kw)
    return json.loads(store.current()[0])


def test_the_collector_learns_each_round_then_serves_the_curve():
    history = PriceHistory(None)
    snap = one_round(make_raw(sales=mover_sales()), history=history)
    assert snap["moves"]["risers"][0]["curve"] == [[3, 100, 3], [2, 110, 3]]
    assert history.rows == 2


def test_a_history_that_cannot_learn_never_costs_a_round():
    class Deaf(PriceHistory):
        def learn(self, sales, now):
            raise RuntimeError("boom")

    snap = one_round(make_raw(sales=mover_sales()), history=Deaf(None))
    assert snap["version"] == 1 and "curve" not in snap["moves"]["risers"][0]


@pytest.mark.parametrize("name", ["feed", "replay"])
def test_the_server_keeps_the_history_in_the_data_dir_for_the_live_feed_only(name, tmp_path):
    import server

    history = server.make_history(name, tmp_path)
    assert history.path == (tmp_path / "price-history.json" if name == "feed" else None)
