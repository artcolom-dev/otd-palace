"""Visits (advisor/visits.py): the anonymous device ids the page reports, checked, counted per UTC day, bounded and
pruned, written atomically; a signed-in member only as a keyed hash of their Discord id."""

import json
from datetime import datetime, timedelta, timezone

import pytest

from advisor.rules import (
    DISCORD_COUNT_KEEP_DAYS,
    VISIT_NEW_DEVICES_PER_HOUR,
    VISIT_PER_MIN,
    VISIT_CLASSES,
    VISIT_EVENTS,
    VISIT_KEEP_DAYS,
    VISIT_MAX_SOURCES_PER_DAY,
    VISIT_TABS,
)
from advisor.visits import Visit, VisitLog, day_number, parse_visit

T0 = datetime(2026, 11, 18, 12, 0, tzinfo=timezone.utc)
KEY = b"k" * 32
UID = "111122223333444455"
DEV = "A" * 22
OWN = "otdpalace.com"


class Clock:
    def __init__(self, at: datetime = T0):
        self.at = at

    def __call__(self) -> datetime:
        return self.at

    def days(self, n: float) -> None:
        self.at += timedelta(days=n)


def visit(**kw) -> Visit:
    base = dict(device=DEV, event="load", tab="today", cls="phone", app=False, ref=None, tag=None)
    return Visit(**{**base, **kw})


def payload(**kw) -> dict:
    return {"d": DEV, "e": "load", "t": "deals", "k": "phone", "a": False, **kw}


def make(tmp_path, clock=None, **kw):
    return VisitLog(tmp_path / "visits.json", clock=clock or Clock(), member_key=KEY, **kw)


def test_rules_values():
    assert VISIT_TABS == ["today", "deals", "prices", "passes", "plan"]
    assert VISIT_EVENTS == ["load", "view", "signin"]
    assert VISIT_CLASSES == ["phone", "tablet", "desktop"]
    assert VISIT_KEEP_DAYS == 90
    assert (VISIT_PER_MIN, VISIT_NEW_DEVICES_PER_HOUR) == (120, 30)  # room for a carrier's NAT shared by many phones


# --- what a report may say -----------------------------------------------------------------------------------------


def test_a_well_formed_report_is_read():
    v = parse_visit(payload(r="news.example.com", s="spring_launch"), OWN)
    assert v == Visit(device=DEV, event="load", tab="deals", cls="phone", app=False, ref="news.example.com",
                      tag="spring_launch")


@pytest.mark.parametrize("bad", [
    None, [], "x", 3,
    payload(d="short"), payload(d="A" * 23), payload(d="A" * 21 + "!"), payload(d=7),
    payload(e="click"), payload(e=None),
    payload(t="admin"), payload(t=None),  # a page load or a tab names its tab
    payload(k="watch"), payload(k=None),
    payload(a=1), payload(a="yes"),  # a bool, not a number or a word
    payload(r=5), payload(s=["x"]),
    {**payload(), "ua": "Mozilla"},  # nothing more than the listed fields
])
def test_anything_else_is_refused(bad):
    assert parse_visit(bad, OWN) is None


def test_the_sign_in_press_needs_no_tab():
    assert parse_visit({"d": DEV, "e": "signin", "k": "desktop", "a": True}, OWN).tab is None


@pytest.mark.parametrize("given, kept", [
    ("WWW.Google.COM", "google.com"),  # one spelling per host
    ("com.discord", "com.discord"),  # the Discord app on Android
    ("otdpalace.com", None), ("www.otdpalace.com", None),  # our own pages are no source
    ("not a host", None), ("x" * 120 + ".com", None), ("-bad.com", None), ("localhost", None), ("", None),
    ("1.2.3.4", None),  # an address is no site name, and is never kept
])
def test_the_referrer_is_a_host_name_or_nothing(given, kept):
    assert parse_visit(payload(r=given), OWN).ref == kept


@pytest.mark.parametrize("given, kept", [
    ("Spring_Launch", "spring_launch"), ("tiktok", "tiktok"), ("a.b-c", "a.b-c"),
    ("", None), ("x" * 33, None), ("bad tag", None), ("<script>", None), ("_x", None),
])
def test_a_campaign_tag_is_short_plain_and_lower_case_or_nothing(given, kept):
    assert parse_visit(payload(s=given), OWN).tag == kept


# --- what is counted -----------------------------------------------------------------------------------------------


def test_a_first_visit_starts_a_device_with_its_first_day_class_and_source(tmp_path):
    log = make(tmp_path)
    assert log.knows(DEV) is False
    assert log.record(visit(cls="tablet", app=True, ref="google.com")) is True
    assert log.knows(DEV) is True
    row = log.data()["devices"][DEV]
    today = day_number(T0)
    assert row == {"f": today, "d": [today], "x": 0, "k": "tablet", "a": 1, "s": "google.com"}


def test_a_campaign_tag_beats_the_referrer_as_the_source(tmp_path):
    log = make(tmp_path)
    log.record(visit(ref="google.com", tag="launch"))
    assert log.data()["devices"][DEV]["s"] == "?launch"


def test_each_active_day_is_kept_once(tmp_path):
    clock = Clock()
    log = make(tmp_path, clock)
    log.record(visit())
    log.record(visit(event="view", tab="deals"))
    clock.days(1)
    log.record(visit())
    clock.days(6)
    log.record(visit(cls="desktop"))
    today = day_number(T0)
    row = log.data()["devices"][DEV]
    assert row["d"] == [today, today + 1, today + 7] and row["f"] == today
    assert row["k"] == "desktop"  # the latest class


def test_the_day_counts_hold_loads_tab_views_sources_and_sign_in_presses(tmp_path):
    log = make(tmp_path)
    log.record(visit(tab="today", ref="google.com"))
    log.record(visit(event="view", tab="deals"))
    log.record(visit(event="view", tab="deals"))
    log.record(visit(device="B" * 22, tab="deals", tag="launch"))
    log.record(visit(device="C" * 22, tab="plan"))
    log.record(visit(event="signin", tab=None))
    log.count("auth_start")
    log.count("auth_ok")
    day = log.data()["days"]["2026-11-18"]
    assert day["loads"] == 3
    assert day["views"] == {"today": 1, "deals": 3, "plan": 1}
    assert day["ref"] == {"google.com": 1, "direct": 2}
    assert day["tag"] == {"launch": 1}
    assert (day["signin"], day["auth_start"], day["auth_ok"]) == (1, 1, 1)
    assert log.data()["devices"][DEV]["x"] & 1  # this device pressed "Continue with Discord"


def test_sources_past_the_days_limit_count_as_other(tmp_path):
    log = make(tmp_path)
    for i in range(VISIT_MAX_SOURCES_PER_DAY + 5):
        log.record(visit(ref=f"site{i}.com"))
    refs = log.data()["days"]["2026-11-18"]["ref"]
    assert len(refs) == VISIT_MAX_SOURCES_PER_DAY + 1 and refs["other"] == 5


def test_a_signed_in_member_is_kept_as_a_keyed_hash_never_their_id(tmp_path):
    log = make(tmp_path)
    log.record(visit(), state="in", uid=UID)
    data = log.data()
    mark = log.member_hash(UID)
    assert mark and mark != UID and len(mark) == 20
    assert data["devices"][DEV]["m"] == mark and data["devices"][DEV]["x"] & 6 == 6  # signed in, in the server
    assert data["members"][mark] == {"f": day_number(T0), "d": [day_number(T0)]}
    log.flush()
    assert UID not in (tmp_path / "visits.json").read_text()


def test_signed_in_but_not_in_the_server_is_told_apart(tmp_path):
    log = make(tmp_path)
    log.record(visit(), state="out", uid=UID)
    assert log.data()["devices"][DEV]["x"] & 6 == 2


def test_without_a_key_no_member_is_ever_followed(tmp_path):
    log = VisitLog(tmp_path / "visits.json", clock=Clock(), member_key=None)
    log.record(visit(), state="in", uid=UID)
    assert log.member_hash(UID) is None and log.data()["members"] == {} and "m" not in log.data()["devices"][DEV]


def test_past_the_device_limit_a_new_device_counts_in_the_day_only(tmp_path):
    log = make(tmp_path, max_devices=2)
    for name in ("A", "B", "C"):
        log.record(visit(device=name * 22))
    data = log.data()
    assert set(data["devices"]) == {"A" * 22, "B" * 22}
    assert data["days"]["2026-11-18"]["loads"] == 3 and data["days"]["2026-11-18"]["over"] == 1


def test_past_the_member_limit_a_new_member_is_not_followed(tmp_path):
    log = make(tmp_path, max_members=1)
    log.record(visit(), state="in", uid=UID)
    log.record(visit(device="B" * 22), state="in", uid="999988887777666655")
    assert len(log.data()["members"]) == 1


# --- bounds over time ----------------------------------------------------------------------------------------------


def test_old_days_and_devices_gone_quiet_are_dropped(tmp_path):
    clock = Clock()
    log = make(tmp_path, clock)
    log.record(visit(), state="in", uid=UID)  # seen once, never again
    log.record(visit(device="B" * 22))
    log.note_discord_members(120)
    clock.days(VISIT_KEEP_DAYS - 1)
    log.record(visit(device="B" * 22))  # still around
    clock.days(2)
    log.record(visit(device="B" * 22))
    data = log.data()
    assert set(data["devices"]) == {"B" * 22} and data["members"] == {}
    row = data["devices"]["B" * 22]
    assert row["f"] == day_number(T0)  # its first day is kept even once its active days age out
    assert min(row["d"]) >= day_number(clock()) - VISIT_KEEP_DAYS
    assert "2026-11-18" not in data["days"]
    assert data["discord"] == {"2026-11-18": 120}  # member counts are kept far longer
    clock.days(DISCORD_COUNT_KEEP_DAYS)
    log.record(visit(device="B" * 22))
    assert log.data()["discord"] == {}


def test_the_discord_count_keeps_one_point_a_day_the_last(tmp_path):
    log = make(tmp_path)
    log.note_discord_members(100)
    log.note_discord_members(104)
    assert log.data()["discord"] == {"2026-11-18": 104}
    log.note_discord_members(-1)
    log.note_discord_members(True)
    assert log.data()["discord"] == {"2026-11-18": 104}


def test_an_unknown_counter_is_ignored(tmp_path):
    log = make(tmp_path)
    log.count("anything")
    assert log.data()["days"] == {}


# --- on disk -------------------------------------------------------------------------------------------------------


def test_flush_writes_atomically_and_a_new_log_reads_it_back(tmp_path):
    log = make(tmp_path)
    log.record(visit(ref="google.com"), state="in", uid=UID)
    log.note_discord_members(50)
    log.flush()
    assert [p.name for p in tmp_path.iterdir()] == ["visits.json"]  # no temporary file left behind
    again = make(tmp_path)
    assert again.data() == log.data()


def test_flush_writes_nothing_when_nothing_changed(tmp_path):
    log = make(tmp_path)
    log.flush()
    assert not (tmp_path / "visits.json").exists()


def test_an_unreadable_file_is_set_aside_and_the_log_starts_empty(tmp_path):
    (tmp_path / "visits.json").write_text("{nope")
    log = make(tmp_path)
    assert log.data()["devices"] == {}
    assert (tmp_path / "visits.json.corrupt").exists()


def test_rows_that_do_not_check_out_are_dropped_on_load(tmp_path):
    today = day_number(T0)
    good = {"f": today, "d": [today], "x": 0, "k": "phone", "a": 0, "s": ""}
    (tmp_path / "visits.json").write_text(json.dumps({
        "devices": {DEV: good, "bad": good, "B" * 22: {**good, "k": "fridge"}, "C" * 22: {**good, "d": "x"},
                    "D" * 22: {**good, "s": "<b>"}},
        "members": {"0" * 20: {"f": today, "d": [today]}, "nothex": {"f": today, "d": [today]}},
        "days": {"2026-11-18": {"loads": 2, "views": {"deals": 1, "admin": 4}}, "nope": {}},
        "discord": {"2026-11-18": 9, "2026-11-17": "x"},
    }))
    data = make(tmp_path).data()
    assert set(data["devices"]) == {DEV}
    assert set(data["members"]) == {"0" * 20}
    assert data["days"] == {"2026-11-18": {"loads": 2, "views": {"deals": 1}}}
    assert data["discord"] == {"2026-11-18": 9}


# --- "Delete my data" ----------------------------------------------------------------------------------------------


def test_erasing_a_member_drops_their_hash_and_every_device_they_used_signed_in(tmp_path):
    log = make(tmp_path)
    log.record(visit(), state="in", uid=UID)
    log.record(visit(device="B" * 22), state="in", uid=UID)
    log.record(visit(device="C" * 22))  # never signed in: nothing ties it to them
    assert log.erase_member(UID) == 2
    data = log.data()
    assert set(data["devices"]) == {"C" * 22} and data["members"] == {}
    log.flush()
    assert log.member_hash(UID) not in (tmp_path / "visits.json").read_text()


def test_erasing_a_device_drops_its_row(tmp_path):
    log = make(tmp_path)
    log.record(visit())
    assert log.erase_device(DEV) is True and log.erase_device(DEV) is False
    assert log.data()["devices"] == {}


def test_the_discord_counter_notes_each_count_until_stopped(tmp_path):
    import threading

    from advisor.visits import run_discord_counter

    log = make(tmp_path)
    stop = threading.Event()
    answers = iter([None, 42])

    def read():
        value = next(answers)
        if value == 42:
            stop.set()
        return value

    run_discord_counter(log, read, stop, every_s=0)
    assert log.data()["discord"] == {"2026-11-18": 42}


def test_a_failing_discord_read_never_ends_the_counter(tmp_path):
    import threading

    from advisor.visits import run_discord_counter

    log = make(tmp_path)
    stop = threading.Event()
    calls = []

    def read():
        calls.append(1)
        if len(calls) == 2:
            stop.set()
        raise RuntimeError("down")

    run_discord_counter(log, read, stop, every_s=0)
    assert len(calls) == 2 and log.data()["discord"] == {}


# --- found in review -----------------------------------------------------------------------------------------------


@pytest.mark.parametrize("days", [[], [5, 3], [3, 3], "x"])
def test_a_saved_device_whose_days_are_empty_or_out_of_order_is_dropped_not_a_crash(tmp_path, days):
    today = day_number(T0)
    good = {"f": today, "d": [today], "x": 0, "k": "phone", "a": 0, "s": ""}
    (tmp_path / "visits.json").write_text(json.dumps({
        "devices": {DEV: good, "B" * 22: {**good, "f": 1, "d": days}},
        "members": {"0" * 20: {"f": today, "d": days}}, "days": {}, "discord": {}}))
    data = make(tmp_path).data()
    assert set(data["devices"]) == {DEV} and data["members"] == {}


def test_a_clock_that_steps_back_never_puts_days_out_of_order(tmp_path):
    clock = Clock()
    log = make(tmp_path, clock)
    log.record(visit(), state="in", uid=UID)
    clock.days(-1)
    log.record(visit(), state="in", uid=UID)
    today = day_number(T0)
    assert log.data()["devices"][DEV]["d"] == [today]
    assert log.data()["members"][log.member_hash(UID)]["d"] == [today]
