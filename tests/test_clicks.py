import json
import os
import threading
from datetime import datetime, timedelta, timezone

import pytest

from advisor.clicks import ClickLog
from advisor.rules import (
    CLICK_FLUSH_S,
    CLICK_KEEP_DAYS,
    CLICK_MAX_KEYS_PER_DAY,
    CLICK_MAX_POS,
    CLICK_PANELS,
    CLICK_SPORT_FILTERS,
    CLICK_TARGETS,
    LEVELS,
)

T0 = datetime(2026, 11, 12, 18, 0, tzinfo=timezone.utc)
BEFORE_MIDNIGHT = datetime(2026, 11, 12, 23, 59, 50, tzinfo=timezone.utc)
ROW_KEYS = {"panel", "target", "level", "sport", "pos", "count"}
GOOD = dict(panel="deals", target="listing", level="regular", sport="nba", pos=3)
SPORTS = ("nba", "soccer")  # the sports the current snapshot serves, in these tests


class Clock:
    """A clock the test moves by hand."""

    def __init__(self, at: datetime = T0):
        self.at = at

    def __call__(self) -> datetime:
        return self.at

    def tick(self, seconds: float) -> None:
        self.at += timedelta(seconds=seconds)


def on_disk(path):
    return json.loads(path.read_text())


def test_rules_values():
    assert CLICK_PANELS == ["hero", "deals", "moves", "otd", "community", "alert", "share", "routine"]
    assert CLICK_TARGETS == ["listing", "card", "community", "app"]
    assert CLICK_SPORT_FILTERS == ["all", "mine"]
    assert (CLICK_MAX_POS, CLICK_FLUSH_S) == (50, 10)
    assert (CLICK_MAX_KEYS_PER_DAY, CLICK_KEEP_DAYS) == (5000, 90)


def test_a_sport_the_snapshot_does_not_serve_is_refused(tmp_path):
    log = ClickLog(tmp_path / "clicks.json", Clock())
    # Well formed, but not a sport of the current snapshot: refused, so nobody can mint new keys at will.
    assert log.record(**{**GOOD, "sport": "nhl"}, known_sports=SPORTS) is False
    assert log.record(**{**GOOD, "sport": "zzzzzz"}, known_sports=SPORTS) is False
    assert log.record(**{**GOOD, "sport": "nba"}, known_sports=()) is False
    assert log.totals() == {"days": {}}
    assert log.record(**{**GOOD, "sport": "nhl"}, known_sports=["nhl"]) is True


def test_all_and_mine_are_accepted_with_no_snapshot(tmp_path):
    log = ClickLog(tmp_path / "clicks.json", Clock())
    assert log.record(**{**GOOD, "sport": "all"}, known_sports=()) is True
    assert log.record(**{**GOOD, "sport": "mine"}, known_sports=()) is True  # the "My players" filter
    assert [row["sport"] for row in log.totals()["days"]["2026-11-12"]] == ["all", "mine"]
    # And they survive a reload.
    log.flush()
    assert ClickLog(tmp_path / "clicks.json", Clock()).totals() == log.totals()


def every_key(sports):
    """Distinct valid clicks, as many as the sports allow."""
    for sport in sports:
        for level in LEVELS:
            for panel in CLICK_PANELS:
                for target in CLICK_TARGETS:
                    for pos in range(CLICK_MAX_POS + 1):
                        yield dict(panel=panel, target=target, level=level, sport=sport, pos=pos)


def test_a_day_holds_at_most_5000_distinct_keys(tmp_path):
    sports = ("aa", "bb", "cc")
    keys = list(every_key(sports))
    assert len(keys) > CLICK_MAX_KEYS_PER_DAY
    clock = Clock()
    log = ClickLog(tmp_path / "clicks.json", clock)
    for key in keys[:CLICK_MAX_KEYS_PER_DAY]:
        assert log.record(**key, known_sports=sports) is True
    # Key 5001 is refused ...
    assert log.record(**keys[CLICK_MAX_KEYS_PER_DAY], known_sports=sports) is False
    # ... but a key the day already holds still counts.
    assert log.record(**keys[0], known_sports=sports) is True
    day = log.totals()["days"]["2026-11-12"]
    assert len(day) == CLICK_MAX_KEYS_PER_DAY
    assert {**keys[0], "count": 2} in day
    # The cap holds across a reload, and the next day starts afresh.
    log.flush()
    restored = ClickLog(tmp_path / "clicks.json", clock)
    assert restored.record(**keys[CLICK_MAX_KEYS_PER_DAY], known_sports=sports) is False
    clock.tick(24 * 3600)
    assert restored.record(**keys[CLICK_MAX_KEYS_PER_DAY], known_sports=sports) is True


def test_days_older_than_90_are_pruned_on_load(tmp_path):
    path = tmp_path / "clicks.json"
    row = {**GOOD, "count": 1}
    # T0 is 2026-11-12: 2026-08-14 is 90 days old and kept; 2026-08-13 is 91 days old and dropped.
    path.write_text(json.dumps({"days": {"2026-08-13": [row], "2026-08-14": [row], "2026-11-12": [row]}}))
    assert list(ClickLog(path, Clock()).totals()["days"]) == ["2026-08-14", "2026-11-12"]


def test_days_older_than_90_are_pruned_on_flush(tmp_path):
    path = tmp_path / "clicks.json"
    clock = Clock(T0 - timedelta(days=CLICK_KEEP_DAYS))  # 2026-08-14
    log = ClickLog(path, clock)
    log.record(**GOOD, known_sports=SPORTS)
    clock.at = T0  # 90 days on: still kept
    log.record(**GOOD, known_sports=SPORTS)
    log.flush()
    assert list(on_disk(path)["days"]) == ["2026-08-14", "2026-11-12"]
    clock.tick(24 * 3600)  # 91 days on
    log.record(**GOOD, known_sports=SPORTS)
    log.flush()
    assert list(on_disk(path)["days"]) == ["2026-11-12", "2026-11-13"]
    assert list(log.totals()["days"]) == ["2026-11-12", "2026-11-13"]


def test_record_counts_valid_click(tmp_path):
    log = ClickLog(tmp_path / "clicks.json", Clock())
    assert log.record(**GOOD, known_sports=SPORTS) is True
    assert log.record(**GOOD, known_sports=SPORTS) is True
    community = dict(panel="community", target="community", level="new", sport="all", pos=0)
    assert log.record(**community, known_sports=SPORTS) is True
    deepest = dict(panel="otd", target="card", level="pro", sport="soccer", pos=CLICK_MAX_POS)
    assert log.record(**deepest, known_sports=SPORTS) is True
    assert log.totals() == {
        "days": {
            "2026-11-12": [
                {"panel": "community", "target": "community", "level": "new", "sport": "all", "pos": 0, "count": 1},
                {"panel": "deals", "target": "listing", "level": "regular", "sport": "nba", "pos": 3, "count": 2},
                {"panel": "otd", "target": "card", "level": "pro", "sport": "soccer", "pos": 50, "count": 1},
            ]
        }
    }


BAD_FIELDS = [
    ("panel", "sidebar"), ("panel", ""), ("panel", None), ("panel", 1), ("panel", ["deals"]),
    ("target", "profile"), ("target", "LISTING"), ("target", None), ("target", {"x": 1}),
    ("level", "expert"), ("level", ""), ("level", None), ("level", ["pro"]), ("level", {"pro": 1}),
    ("sport", "NBA"), ("sport", "n"), ("sport", "a" * 13), ("sport", "nba1"), ("sport", "n-b"), ("sport", "nba\n"),
    ("sport", ""), ("sport", None), ("sport", 7), ("sport", "nhl"), ("sport", "ALL"), ("sport", ["nba"]),
    ("pos", -1), ("pos", CLICK_MAX_POS + 1), ("pos", 1.0), ("pos", "3"), ("pos", True), ("pos", None),
]


@pytest.mark.parametrize(("field", "value"), BAD_FIELDS)
def test_record_rejects_each_bad_field(tmp_path, field, value):
    log = ClickLog(tmp_path / "clicks.json", Clock())
    assert log.record(**{**GOOD, field: value}, known_sports=SPORTS) is False
    assert log.totals() == {"days": {}}
    assert not (tmp_path / "clicks.json").exists()


def test_every_level_panel_and_target_is_accepted(tmp_path):
    log = ClickLog(tmp_path / "clicks.json", Clock())
    for level in LEVELS:
        for panel in CLICK_PANELS:
            for target in CLICK_TARGETS:
                click = dict(panel=panel, target=target, level=level, sport="all", pos=0)
                assert log.record(**click, known_sports=SPORTS), (level, panel, target)


def test_totals_grouped_by_day(tmp_path):
    clock = Clock(BEFORE_MIDNIGHT)
    log = ClickLog(tmp_path / "clicks.json", clock)
    log.record(**GOOD, known_sports=SPORTS)
    clock.tick(5)  # 23:59:55 UTC, still the 12th
    log.record(**GOOD, known_sports=SPORTS)
    clock.tick(10)  # 00:00:05 UTC, the 13th
    log.record(**GOOD, known_sports=SPORTS)
    log.record(**{**GOOD, "panel": "hero", "pos": 0}, known_sports=SPORTS)
    assert log.totals() == {
        "days": {
            "2026-11-12": [{**GOOD, "count": 2}],
            "2026-11-13": [{**GOOD, "count": 1}, {**GOOD, "panel": "hero", "pos": 0, "count": 1}],
        }
    }
    assert list(log.totals()["days"]) == ["2026-11-12", "2026-11-13"]


def test_the_day_is_the_utc_day_whatever_the_clock_offset(tmp_path):
    paris = timezone(timedelta(hours=1))
    log = ClickLog(tmp_path / "clicks.json", Clock(datetime(2026, 11, 13, 0, 30, tzinfo=paris)))
    log.record(**GOOD, known_sports=SPORTS)
    assert list(log.totals()["days"]) == ["2026-11-12"]


def test_flush_writes_atomically_and_reload_restores(tmp_path, monkeypatch):
    path = tmp_path / "data" / "clicks.json"
    clock = Clock()
    log = ClickLog(path, clock)
    log.record(**GOOD, known_sports=SPORTS)  # the first count is written at once: there was no write before it
    assert on_disk(path) == log.totals()
    clock.tick(CLICK_FLUSH_S - 1)
    log.record(**GOOD, known_sports=SPORTS)  # too soon after the last write: kept in memory
    assert on_disk(path)["days"]["2026-11-12"][0]["count"] == 1
    clock.tick(1)
    log.record(**GOOD, known_sports=SPORTS)  # CLICK_FLUSH_S after the last write: written
    assert on_disk(path)["days"]["2026-11-12"][0]["count"] == 3
    log.record(**GOOD, known_sports=SPORTS)
    log.flush()  # on demand, whatever the time
    assert on_disk(path)["days"]["2026-11-12"][0]["count"] == 4

    # Every write goes to a temporary file in the same directory, then renames it over the file.
    renames = []
    real_replace = os.replace

    def spy(src, dst):
        renames.append((os.fspath(src), os.fspath(dst)))
        real_replace(src, dst)

    monkeypatch.setattr("advisor.clicks.os.replace", spy)
    log.record(**GOOD, known_sports=SPORTS)
    log.flush()
    [(src, dst)] = renames
    assert (os.path.dirname(src), dst) == (str(path.parent), str(path)) and src != dst
    assert sorted(p.name for p in path.parent.iterdir()) == ["clicks.json"]

    # A write that fails leaves the last good file as it was, and no temporary file behind.
    def broken(src, dst):
        raise OSError("disk full")

    monkeypatch.setattr("advisor.clicks.os.replace", broken)
    log.record(**GOOD, known_sports=SPORTS)
    log.flush()
    assert on_disk(path)["days"]["2026-11-12"][0]["count"] == 5
    assert sorted(p.name for p in path.parent.iterdir()) == ["clicks.json"]
    monkeypatch.setattr("advisor.clicks.os.replace", real_replace)
    log.flush()  # the counts it could not write are still there for the next write
    assert on_disk(path)["days"]["2026-11-12"][0]["count"] == 6

    restored = ClickLog(path, Clock())
    assert restored.totals() == log.totals()
    restored.record(**GOOD, known_sports=SPORTS)
    assert restored.totals()["days"]["2026-11-12"][0]["count"] == 7


@pytest.mark.parametrize(
    "content",
    [
        "{not json",
        "",
        "[]",
        '{"days": []}',
        "\x00\x01",
    ],
)
def test_corrupt_file_is_set_aside_and_the_log_starts_empty(tmp_path, content):
    path = tmp_path / "clicks.json"
    aside = tmp_path / "clicks.json.corrupt"
    aside.write_text("an older corrupt file")
    path.write_text(content)
    log = ClickLog(path, Clock())
    assert log.totals() == {"days": {}}
    # The unreadable file is kept for a look, in place of any older one, before anything is written over it.
    assert aside.read_text() == content
    assert not path.exists()
    assert log.record(**GOOD, known_sports=SPORTS)
    assert log.totals()["days"]["2026-11-12"][0]["count"] == 1
    assert on_disk(path) == log.totals() and aside.read_text() == content


def test_a_file_in_shape_with_no_usable_rows_is_not_set_aside(tmp_path):
    path = tmp_path / "clicks.json"
    path.write_text('{"days": {"2026-11-12": "x"}}')
    assert ClickLog(path, Clock()).totals() == {"days": {}}
    assert not (tmp_path / "clicks.json.corrupt").exists()


def test_a_file_with_bad_rows_keeps_only_the_good_ones(tmp_path):
    path = tmp_path / "clicks.json"
    good = {**GOOD, "count": 4}
    path.write_text(json.dumps({"days": {
        "2026-11-12": [good, {**GOOD, "panel": "sidebar", "count": 2}, {**GOOD, "count": -1}, {**GOOD, "count": "9"},
                       {**GOOD, "ip": "1.2.3.4", "count": 1}, "row"],
        "yesterday": [good],
    }}))
    assert ClickLog(path, Clock()).totals() == {"days": {"2026-11-12": [good]}}


def test_missing_file_starts_empty(tmp_path):
    assert ClickLog(tmp_path / "nowhere" / "clicks.json", Clock()).totals() == {"days": {}}


def test_nothing_personal_is_stored(tmp_path):
    path = tmp_path / "clicks.json"
    clock = Clock()
    log = ClickLog(path, clock)
    log.record(**GOOD, known_sports=SPORTS)
    clock.tick(CLICK_FLUSH_S)
    log.record(**{**GOOD, "sport": "all", "pos": 0}, known_sports=SPORTS)
    log.flush()
    data = on_disk(path)
    assert set(data) == {"days"}
    assert list(data["days"]) == ["2026-11-12"]  # the day, nothing finer: no time of day
    for row in data["days"]["2026-11-12"]:
        assert set(row) == ROW_KEYS
    text = path.read_text()
    assert "18:00" not in text and "T18" not in text


def test_record_is_thread_safe(tmp_path):
    log = ClickLog(tmp_path / "clicks.json", Clock())
    def click_500_times():
        for _ in range(500):
            log.record(**GOOD, known_sports=SPORTS)

    threads = [threading.Thread(target=click_500_times) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    log.flush()
    assert log.totals()["days"]["2026-11-12"][0]["count"] == 4000
    assert on_disk(tmp_path / "clicks.json") == log.totals()
