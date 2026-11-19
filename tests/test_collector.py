import json
import logging
import threading
from datetime import timedelta, timezone
from pathlib import Path

from advisor import collector
from advisor.collector import run_collector, utc_now
from advisor.rules import BACKOFF_CAP_S
from advisor.sources.fixture import ReplaySource
from advisor.store import SnapshotStore
from tests.factories import NOW, make_raw

DEMO = Path(__file__).resolve().parent.parent / "advisor" / "fixtures" / "demo_raw.json"


class Scripted:
    """A source that answers each fetch with the next item: raw data, or an exception to raise."""

    def __init__(self, *items):
        self._items = iter(items)

    def fetch(self, now):
        item = next(self._items)
        if isinstance(item, Exception):
            raise item
        return item


def waiting_until(stop, after):
    """A wait function that records every delay and sets `stop` on the `after`-th one."""
    waits = []

    def wait(seconds):
        waits.append(seconds)
        if len(waits) == after:
            stop.set()
        return stop.is_set()

    return wait, waits


def test_failures_keep_the_last_snapshot_and_back_off():
    source = Scripted(make_raw(), RuntimeError("boom"), RuntimeError("boom"), make_raw())
    stop, store = threading.Event(), SnapshotStore()
    wait, waits = waiting_until(stop, after=4)
    run_collector(source, store, stop, interval_s=10, now=lambda: NOW, wait=wait, first_version=1)
    assert waits == [10, 20, 40, 10]
    assert json.loads(store.current()[0])["version"] == 2 and store.health()["last_error"] is None


def test_a_first_failure_is_recorded_and_nothing_is_served():
    stop, store = threading.Event(), SnapshotStore()
    wait, _ = waiting_until(stop, after=1)
    run_collector(Scripted(RuntimeError("boom")), store, stop, interval_s=10, now=lambda: NOW, wait=wait)
    assert store.current() is None
    assert store.health()["last_error"] == "RuntimeError"


LEAKY = ConnectionError(
    "HTTPSConnectionPool(host='private-export.internal', port=443): Max retries exceeded with url: "
    "/export?token=abc123"
)


def test_a_failure_keeps_only_the_error_class_and_logs_the_detail_server_side(caplog):
    stop, store = threading.Event(), SnapshotStore()
    wait, _ = waiting_until(stop, after=1)
    with caplog.at_level(logging.WARNING, logger="advisor.collector"):
        run_collector(Scripted(LEAKY), store, stop, interval_s=10, now=lambda: NOW, wait=wait)
    assert store.health()["last_error"] == "ConnectionError"
    assert "private-export.internal" in caplog.text and "token=abc123" in caplog.text


def test_versions_start_at_the_start_time_so_a_restart_never_goes_back(monkeypatch):
    def run(started_at, rounds):
        monkeypatch.setattr(collector.time, "time", lambda: started_at)
        stop, store = threading.Event(), RecordingStore()
        wait, _ = waiting_until(stop, after=rounds)
        run_collector(Scripted(*[make_raw()] * rounds), store, stop, interval_s=1, now=lambda: NOW, wait=wait)
        return [snapshot["version"] for snapshot in store.published]

    before = run(1_763_000_000.25, rounds=900)  # 15 minutes of one-second rounds
    assert before[:2] == [1_763_000_000_250, 1_763_000_000_251]  # the start time in milliseconds, then on
    after = run(1_763_000_000.25 + 60, rounds=2)  # restarted a minute after the first start
    assert after[0] > before[-1]


def test_the_backoff_stops_growing_at_the_cap():
    source = Scripted(*[RuntimeError("boom")] * 6)
    stop, store = threading.Event(), SnapshotStore()
    wait, waits = waiting_until(stop, after=6)
    run_collector(source, store, stop, interval_s=100, now=lambda: NOW, wait=wait)
    assert waits == [200] + [BACKOFF_CAP_S] * 5


def test_the_snapshot_is_built_as_of_the_time_the_source_was_asked_about():
    asked = []

    class Source:
        def fetch(self, now):
            asked.append(now)
            return make_raw()

    stop, store = threading.Event(), SnapshotStore()
    wait, _ = waiting_until(stop, after=1)
    run_collector(Source(), store, stop, interval_s=10, now=lambda: NOW, wait=wait)
    assert asked == [NOW]
    assert json.loads(store.current()[0])["generated_at"] == "2026-11-12T18:00:00Z"


def test_the_collector_says_whether_the_data_is_a_demo():
    for demo in (False, True):
        stop, store = threading.Event(), SnapshotStore()
        wait, _ = waiting_until(stop, after=1)
        run_collector(Scripted(make_raw()), store, stop, interval_s=10, now=lambda: NOW, wait=wait, demo=demo)
        assert json.loads(store.current()[0])["rules"]["demo"] is demo


def test_a_stopped_collector_does_not_fetch():
    stop, store = threading.Event(), SnapshotStore()
    stop.set()
    run_collector(Scripted(), store, stop)  # an empty script raises if it is asked for anything
    assert store.current() is None and store.health()["last_error"] is None


def test_utc_now_is_aware_utc():
    assert utc_now().tzinfo is timezone.utc


class RecordingStore(SnapshotStore):
    """A store that also keeps every snapshot it was given."""

    def __init__(self):
        super().__init__()
        self.published = []

    def publish(self, snapshot):
        self.published.append(snapshot)
        super().publish(snapshot)


def test_collector_publishes_gone():
    # The demo replay over two rounds ten minutes apart: the fixture's first deal ends in between.
    times = iter([NOW, NOW + timedelta(minutes=10)])
    stop, store = threading.Event(), RecordingStore()
    wait, _ = waiting_until(stop, after=2)
    run_collector(ReplaySource(DEMO), store, stop, interval_s=10, now=lambda: next(times), wait=wait)
    first, second = store.published
    assert (first["gone"], first["taken_10m"]) == ([], 0)
    assert second["gone"], "a deal of the first round should have ended by the second"
    first_ids = {deal["listing_id"] for deal in first["deals"]}
    second_ids = {deal["listing_id"] for deal in second["deals"]}
    assert {row["listing_id"] for row in second["gone"]} <= first_ids - second_ids
    assert {(row["reason"], row["gone_at"]) for row in second["gone"]} == {("ended", "2026-11-12T18:10:00Z")}
    assert second["taken_10m"] == len(second["gone"])
    # What the store serves is that same second snapshot.
    assert json.loads(store.current()[0]) == second


class RecordingDispatcher:
    """Stands in for the push dispatcher: its link, and every snapshot it is handed."""

    link = {"public_key": "BPublicKey", "check_s": 10}

    def __init__(self, fail=False):
        self.fail = fail
        self.handed = []

    def notify(self, snapshot, now):
        self.handed.append((snapshot, now))
        if self.fail:
            raise RuntimeError("the dispatcher broke")


def test_the_collector_hands_each_snapshot_to_the_push_dispatcher():
    raw = make_raw()
    stop, store = threading.Event(), SnapshotStore()
    wait, _ = waiting_until(stop, after=2)
    dispatcher = RecordingDispatcher()
    run_collector(Scripted(raw, raw), store, stop, interval_s=10, now=lambda: NOW, wait=wait, dispatcher=dispatcher,
                  first_version=1)
    published = json.loads(store.current()[0])
    assert published["links"]["push"] == RecordingDispatcher.link
    assert [(snap["version"], now) for snap, now in dispatcher.handed] == [(1, NOW), (2, NOW)]
    assert "gone" in dispatcher.handed[0][0]


def test_a_dispatcher_that_breaks_never_stops_the_collector():
    raw = make_raw()
    stop, store = threading.Event(), SnapshotStore()
    wait, waits = waiting_until(stop, after=2)
    run_collector(Scripted(raw, raw), store, stop, interval_s=10, now=lambda: NOW, wait=wait,
                  dispatcher=RecordingDispatcher(fail=True), first_version=1)
    assert store.health()["version"] == 2
    assert store.health()["last_error"] is None
    assert waits == [10, 10]  # no backoff: the round itself went fine


def test_without_a_dispatcher_the_snapshot_says_push_is_off():
    stop, store = threading.Event(), SnapshotStore()
    wait, _ = waiting_until(stop, after=1)
    run_collector(Scripted(make_raw()), store, stop, interval_s=10, now=lambda: NOW, wait=wait)
    assert json.loads(store.current()[0])["links"]["push"] is None


def test_sample_data_links_every_deal_and_gone_row_to_reals_home():
    times = iter([NOW, NOW + timedelta(minutes=10)])
    stop, store = threading.Event(), RecordingStore()
    wait, _ = waiting_until(stop, after=2)
    run_collector(ReplaySource(DEMO), store, stop, interval_s=10, now=lambda: next(times), wait=wait, demo=True)
    second = store.published[1]
    assert second["deals"] and second["gone"]
    assert {row["url"] for row in second["deals"] + second["gone"]} == {"https://www.realapp.com/"}


def test_a_snapshot_is_made_as_of_the_moment_its_data_describes_and_alerts_get_the_clock():
    # The live feed's document is a few seconds old when fetched: the snapshot says so, and push alerts, which judge
    # an auction's last call against the clock, still get the moment of the round.
    made = NOW - timedelta(seconds=14)
    stop, store, dispatcher = threading.Event(), SnapshotStore(), RecordingDispatcher()
    wait, _ = waiting_until(stop, after=1)
    run_collector(Scripted(make_raw(fetched_at=made)), store, stop, interval_s=10, now=lambda: NOW, wait=wait,
                  dispatcher=dispatcher)
    snap = json.loads(store.current()[0])
    assert snap["generated_at"] == "2026-11-12T17:59:46Z" and snap["rules"]["otd"] is not None
    assert [now for _, now in dispatcher.handed] == [NOW]


def test_a_stale_feed_or_a_network_failure_is_retried_within_thirty_seconds():
    from advisor.rules import BACKOFF_TRANSIENT_CAP_S
    from advisor.sources.feed import FeedError, FeedStale

    assert BACKOFF_TRANSIENT_CAP_S == 30
    for error in (FeedStale("old"), FeedError("the feed could not be reached (URLError)"), ConnectionError("x"),
                  TimeoutError("slow")):
        stop, store = threading.Event(), SnapshotStore()
        wait, waits = waiting_until(stop, after=5)
        run_collector(Scripted(*[error] * 5), store, stop, interval_s=10, now=lambda: NOW, wait=wait)
        assert waits == [20, 30, 30, 30, 30], error


def test_the_collector_logs_a_round_on_each_change_and_otherwise_once_a_minute(caplog, monkeypatch):
    t = [0.0]
    monkeypatch.setattr(collector, "_monotonic", lambda: t[0])

    def ticking(stop, after):
        wait, waits = waiting_until(stop, after)

        def tick(seconds):
            t[0] += 1
            return wait(seconds)
        return tick, waits

    items = [make_raw()] * 5 + [RuntimeError("boom")] * 3 + [make_raw()] * 2
    stop, store = threading.Event(), SnapshotStore()
    wait, _ = ticking(stop, after=len(items))
    with caplog.at_level(logging.INFO, logger="advisor.collector"):
        run_collector(Scripted(*items), store, stop, interval_s=10, now=lambda: NOW, wait=wait, first_version=1)
    rounds = [r.getMessage() for r in caplog.records if r.levelno == logging.INFO]
    assert len(rounds) == 3, rounds  # the first round, the first failure, the recovery
    assert "ok" in rounds[0] and "version 1" in rounds[0]
    assert "failed" in rounds[1] and "RuntimeError" in rounds[1]
    assert "ok" in rounds[2] and "version 6" in rounds[2]

    caplog.clear()
    t[0] = 0.0
    stop, store = threading.Event(), SnapshotStore()
    wait, _ = waiting_until(stop, after=130)

    def slow(seconds):  # one round a second for 130 s, all fine: the first, then one a minute
        t[0] += 1
        return wait(seconds)
    with caplog.at_level(logging.INFO, logger="advisor.collector"):
        run_collector(Scripted(*[make_raw()] * 130), store, stop, interval_s=1, now=lambda: NOW, wait=slow)
    assert len([r for r in caplog.records if r.levelno == logging.INFO]) == 3


def test_every_snapshot_carries_the_injury_notes_of_the_view_the_collector_was_given():
    from tests.factories import five_sales, make_listing

    class Hurt:
        def of(self, sport, player_id, name):
            return {"status": "out", "part": "Knee", "back": None}

        def sports(self):
            return ["nba"]

    raw = make_raw(listings=[make_listing(target_price=300)], sales=five_sales())
    stop, store = threading.Event(), SnapshotStore()
    wait, _ = waiting_until(stop, after=1)
    run_collector(Scripted(raw), store, stop, interval_s=10, now=lambda: NOW, wait=wait, first_version=1, injuries=Hurt())
    snap = json.loads(store.current()[0])
    assert snap["deals"][0]["injury"] == {"status": "out", "part": "Knee", "back": None}
    assert snap["rules"]["injury_sports"] == ["nba"]


def test_every_snapshot_carries_the_resale_counts_of_the_view_the_collector_was_given():
    from tests.factories import five_sales, make_listing

    class Resold:
        def of(self, sport, player_id, name, rating):
            return {"listed": 20, "sold": 15}

        def available(self):
            return True

    raw = make_raw(listings=[make_listing(target_price=300)], sales=five_sales())
    stop, store = threading.Event(), SnapshotStore()
    wait, _ = waiting_until(stop, after=1)
    run_collector(Scripted(raw), store, stop, interval_s=10, now=lambda: NOW, wait=wait, first_version=1, resale=Resold())
    snap = json.loads(store.current()[0])
    assert snap["deals"][0]["resale"] == {"listed": 20, "sold": 15}
    assert snap["rules"]["resale"] is True
