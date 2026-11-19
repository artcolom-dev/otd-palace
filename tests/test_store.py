import gzip
import json

from advisor.store import SnapshotStore


def test_publish_then_serve_with_etag():
    store = SnapshotStore(clock=lambda: 100.0)
    store.publish({"version": 3, "x": 1})
    assert store.current() == (b'{"version":3,"x":1}', '"3"')


def test_health_goes_stale_after_the_limit():
    t = [100.0]
    store = SnapshotStore(clock=lambda: t[0])
    store.publish({"version": 1})
    t[0] = 125.0
    assert store.health()["ok"] is True
    t[0] = 131.0
    assert store.health() == {"version": 1, "age_s": 31.0, "ok": False, "last_error": None, "ready": True}


def test_nothing_is_served_and_health_is_not_ok_before_the_first_publish():
    store = SnapshotStore()
    assert store.current() is None
    assert store.health() == {"version": None, "age_s": None, "ok": False, "last_error": None, "ready": False}


def test_an_error_is_reported_while_the_last_snapshot_stays_served_until_the_next_publish():
    store = SnapshotStore(clock=lambda: 100.0)
    store.publish({"version": 1})
    store.record_error("RuntimeError")
    assert store.current() == (b'{"version":1}', '"1"')
    assert store.health()["last_error"] == "RuntimeError"
    store.publish({"version": 2})
    assert store.health()["last_error"] is None


def test_each_version_is_compressed_once_and_served_both_ways():
    store = SnapshotStore(clock=lambda: 100.0)
    store.publish({"version": 5, "otd": {"markets": ["x"] * 200}})
    plain, etag = store.current()
    packed, packed_etag = store.current(gzipped=True)
    # A strong validator differs by content coding: the gzipped body has its own.
    assert (etag, packed_etag) == ('"5"', '"5-gz"')
    assert gzip.decompress(packed) == plain and len(packed) < len(plain)
    # Compressed at publish, not per request: the same bytes come back each time.
    assert store.current(gzipped=True)[0] is packed
    store.publish({"version": 6})
    assert gzip.decompress(store.current(gzipped=True)[0]) == b'{"version":6}'


def test_nothing_compressed_is_served_before_the_first_publish():
    assert SnapshotStore().current(gzipped=True) is None
    assert SnapshotStore().current(otd="abc") is None


PASSES = {"version": 5, "otd_version": "0123456789ab", "deals": [1, 2], "otd": {"markets": ["x"] * 200}}


def test_a_client_holding_the_current_passes_gets_the_snapshot_without_them():
    store = SnapshotStore(clock=lambda: 100.0)
    store.publish(PASSES)
    full, etag = store.current()
    lean, lean_etag = store.current(otd="0123456789ab")
    assert json.loads(full) == PASSES
    assert json.loads(lean) == {"version": 5, "otd_version": "0123456789ab", "deals": [1, 2]}
    # The ETag still names the whole document's version, whichever part of it goes out.
    assert etag == lean_etag == '"5"'
    packed, packed_etag = store.current(gzipped=True, otd="0123456789ab")
    assert gzip.decompress(packed) == lean and packed_etag == '"5-gz"'
    # Both variants are compressed once, at publish.
    assert store.current(gzipped=True, otd="0123456789ab")[0] is packed
    assert store.current(gzipped=True)[0] is store.current(gzipped=True)[0]


def test_stale_or_junk_pass_versions_get_the_whole_snapshot():
    store = SnapshotStore(clock=lambda: 100.0)
    store.publish(PASSES)
    full = store.current()[0]
    for given in (None, "", "ffffffffffff", "0123456789AB", "0123456789ab ", "x" * 5000, "<script>"):
        assert store.current(otd=given)[0] == full, given
        assert gzip.decompress(store.current(gzipped=True, otd=given)[0]) == full, given


def test_a_snapshot_without_a_pass_version_is_always_served_whole():
    store = SnapshotStore(clock=lambda: 100.0)
    store.publish({"version": 2, "otd": {"markets": []}})
    for given in (None, "None", "null", ""):
        assert json.loads(store.current(otd=given)[0]) == {"version": 2, "otd": {"markets": []}}, given


def gone_row(listing_id, kind="target"):
    return {"listing_id": listing_id, "kind": kind, "player_name": "A", "reason": "ended"}


def test_deals_that_went_away_are_remembered_after_the_snapshot_forgets_them():
    store = SnapshotStore()
    assert store.ended(7) is None
    store.publish({"version": 1, "gone": [gone_row(7)]})
    store.publish({"version": 2, "gone": []})
    assert store.ended(7) == gone_row(7)
    assert store.ended(8) is None


def test_the_newest_row_of_a_listing_is_the_one_remembered():
    store = SnapshotStore()
    store.publish({"version": 1, "gone": [{**gone_row(7), "reason": "outbid"}]})
    store.publish({"version": 2, "gone": [{**gone_row(7), "reason": "ended"}]})
    assert store.ended(7)["reason"] == "ended"


def test_only_the_newest_ended_deals_are_kept(monkeypatch):
    monkeypatch.setattr("advisor.store.ENDED_KEEP", 3)
    store = SnapshotStore()
    for i in range(1, 6):
        store.publish({"version": i, "gone": [gone_row(i)]})
    assert [store.ended(i) is not None for i in range(1, 6)] == [False, False, True, True, True]


def test_a_snapshot_without_gone_rows_or_with_odd_ones_is_still_published():
    store = SnapshotStore()
    store.publish({"version": 1})
    store.publish({"version": 2, "gone": [None, {"kind": "target"}, {"listing_id": "7"}, gone_row(9)]})
    assert store.ended(9) == gone_row(9) and store.ended(7) is None


def test_health_counts_the_age_from_the_moment_the_data_describes_when_it_says():
    from datetime import datetime, timezone

    built = datetime(2026, 11, 15, 10, 0, 0, tzinfo=timezone.utc).timestamp()
    wall = [built + 12]
    store = SnapshotStore(clock=lambda: 500.0, wall=lambda: wall[0])
    store.publish({"version": 4, "as_of": "2026-11-15T10:00:00Z"})  # published now, its data 12 s old already
    assert store.health() == {"version": 4, "age_s": 12.0, "ok": True, "last_error": None, "ready": True}
    wall[0] = built + 45
    assert store.health()["age_s"] == 45.0 and store.health()["ok"] is False
    wall[0] = built - 3  # a clock a little behind the producer's: never a negative age
    assert store.health()["age_s"] == 0.0


def test_health_falls_back_to_the_publication_when_the_data_names_no_moment():
    t = [100.0]
    store = SnapshotStore(clock=lambda: t[0], wall=lambda: 0.0)
    store.publish({"version": 1, "as_of": "not a time"})
    t[0] = 110.0
    assert store.health()["age_s"] == 10.0
