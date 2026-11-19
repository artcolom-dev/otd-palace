"""The activity store (advisor/activity.py): what the page may report, what is kept per device and per member, the
bounds, the retention and "Delete my data"."""

import json

import pytest

from advisor.activity import ActivityLog, Batch, PageEvent, parse_batch
from advisor.rules import (
    ACTIVITY_BATCH_MAX,
    ACTIVITY_TIME_MAX_S,
    ANON_ACTIVITY_KEEP_DAYS,
    MEMBER_ACTIVITY_KEEP_DAYS,
)

T0 = 1_795_000_000  # 2026-11-18 (UTC), in seconds
DEV = "A" * 22
OTHER = "B" * 22
UID = "111122223333444455"
UID2 = "999988887777666655"


class Clock:
    def __init__(self, at=T0):
        self.at = at

    def __call__(self):
        return self.at


def store(clock=None, **kw):
    return ActivityLog(None, clock=clock or Clock(), **kw)


def batch(*events, device=DEV, cls="phone"):
    return Batch(device, cls, False, tuple(PageEvent(*e) for e in events))


def rows(log, sql, *args):
    return log.read(sql, args)


# --- what the page may send -----------------------------------------------------------------------------------------


def test_a_report_is_read_event_by_event():
    found = parse_batch({"d": DEV, "k": "desktop", "a": True,
                         "e": [["session"], ["sport", "nba"], ["time", None, 42], ["lookup", "kingcards"],
                               ["deal", "123456789"], ["year", "kingcards", 12000]]})
    assert found == Batch(DEV, "desktop", True, (
        PageEvent("session"), PageEvent("sport", "nba"), PageEvent("time", None, 42), PageEvent("lookup", "kingcards"),
        PageEvent("deal", "123456789"), PageEvent("year", "kingcards", 12000)))


@pytest.mark.parametrize("data", [
    None, [], {"d": DEV, "k": "phone", "a": False},  # no events
    {"d": DEV, "k": "phone", "a": False, "e": []},
    {"d": "short", "k": "phone", "a": False, "e": [["session"]]},
    {"d": DEV, "k": "watch", "a": False, "e": [["session"]]},
    {"d": DEV, "k": "phone", "a": 0, "e": [["session"]]},
    {"d": DEV, "k": "phone", "a": False, "e": [["session"]], "ip": "1.2.3.4"},  # a field the page never sends
    {"d": DEV, "k": "phone", "a": False, "e": [["keylog", "x"]]},  # no such event
    {"d": DEV, "k": "phone", "a": False, "e": [["session", "x"]]},  # an argument where none goes
    {"d": DEV, "k": "phone", "a": False, "e": [["sport", "NBA <b>"]]},  # not a plain word
    {"d": DEV, "k": "phone", "a": False, "e": [["deal", "12a"]]},
    {"d": DEV, "k": "phone", "a": False, "e": [["lookup", "has space"]]},
    {"d": DEV, "k": "phone", "a": False, "e": [["time", None, 0]]},
    {"d": DEV, "k": "phone", "a": False, "e": [["time", None, ACTIVITY_TIME_MAX_S + 1]]},
    {"d": DEV, "k": "phone", "a": False, "e": [["time", None, 1.5]]},
    {"d": DEV, "k": "phone", "a": False, "e": [["year", "kingcards", -1]]},
    {"d": DEV, "k": "phone", "a": False, "e": [["sport", "nba", 3]]},  # a number where none goes
    {"d": DEV, "k": "phone", "a": False, "e": [["session"]] * (ACTIVITY_BATCH_MAX + 1)},
    {"d": DEV, "k": "phone", "a": False, "e": [["session"], "refresh"]},
])
def test_anything_the_page_does_not_send_refuses_the_report_whole(data):
    assert parse_batch(data) is None


# --- what is kept ---------------------------------------------------------------------------------------------------


def test_an_anonymous_devices_events_are_kept_under_its_id_only():
    log = store()
    assert log.add_visit(DEV, "load", "deals", "phone", False, "?tiktok", "anon", None) is True
    assert log.add_page(batch(("session",), ("sport", "nba")), "anon", None) == 2
    assert log.flush() == 3
    assert rows(log, "SELECT id, first, source, cls, member FROM devices") == [(DEV, T0, "?tiktok", "phone", None)]
    assert rows(log, "SELECT kind, arg, member, state FROM events ORDER BY rowid") == [
        ("load", "deals", None, "anon"), ("session", None, None, "anon"), ("sport", "nba", None, "anon")]
    assert rows(log, "SELECT COUNT(*) FROM members") == [(0,)]


def test_the_first_source_stays_the_devices_first():
    clock = Clock()
    log = store(clock)
    log.add_visit(DEV, "load", "deals", "phone", False, "google.com", "anon", None)
    clock.at += 3600
    log.add_visit(DEV, "load", "deals", "phone", False, "?launch", "anon", None)
    log.flush()
    assert rows(log, "SELECT source, first, last FROM devices") == [("google.com", T0, T0 + 3600)]


def test_a_device_older_than_the_log_keeps_its_first_day_and_never_a_later_source():
    log = store()
    log.add_visit(DEV, "tab", "plan", "phone", False, None, "anon", None, first=T0 - 10 * 86400)
    log.flush()
    assert rows(log, "SELECT first, source FROM devices") == [(T0 - 10 * 86400, "")]


def test_signing_in_brings_the_devices_history_to_the_member():
    clock = Clock()
    log = store(clock)
    log.add_visit(DEV, "load", "today", "phone", False, "reddit.com", "anon", None)
    log.add_page(batch(("lookup", "kingcards"),), "anon", None)
    log.flush()
    clock.at += 600
    log.note_auth(UID, "Deal Hunter")
    log.add_page(batch(("link", "kingcards"),), "in", UID, name="Deal Hunter", iat=T0 + 600)
    log.flush()
    assert rows(log, "SELECT member FROM devices") == [(UID,)]
    assert rows(log, "SELECT COUNT(*) FROM events WHERE member = ?", UID) == [(4,)]  # load, lookup, auth, link
    assert rows(log, "SELECT name, first, last, state FROM members") == [("Deal Hunter", T0 + 600, T0 + 600, "in")]


def test_a_member_out_of_our_server_is_still_followed_as_them():
    log = store()
    log.add_page(batch(("session",)), "out", UID, name="Deal Hunter", iat=T0)
    log.flush()
    assert rows(log, "SELECT member, state FROM events") == [(UID, "out")]


def test_names_are_cleaned_and_short():
    log = store()
    log.add_page(batch(("session",)), "in", UID, name="  Deal\u0000 Hunter" + "x" * 200, iat=T0)
    log.flush()
    (name,), = rows(log, "SELECT name FROM members")
    assert name.startswith("Deal Hunter") and len(name) == 64


def test_a_lookup_is_kept_with_the_accounts_size_and_counted_once_in_ten_minutes():
    clock = Clock()
    log = store(clock)
    assert log.note_lookup("KingCards", UID, "ok", 340) is True
    assert log.note_lookup("kingcards", UID, "ok", 340) is False  # the page asking again
    assert log.note_lookup("kingcards", None, "ok", 340) is True  # someone else
    assert log.note_lookup("nobody", UID, "not_found", None) is True
    assert log.note_lookup("busyone", UID, "busy", None) is False  # no answer yet: nothing to count
    clock.at += 601
    assert log.note_lookup("kingcards", UID, "ok", 341) is True
    log.add_page(batch(("year", "kingcards", 12000),), "in", UID, iat=T0)
    log.flush()
    assert rows(log, "SELECT COUNT(*) FROM lookups") == [(4,)]
    assert rows(log, "SELECT username, passes, year FROM accounts") == [("kingcards", 341, 12000)]


def test_link_and_unlink_seen_by_the_server_are_the_members():
    log = store()
    log.note_link(UID, "kingcards", 340)
    log.note_link(UID, "kingcards", None, linked=False)
    log.note_link(None, "kingcards", 3)  # nobody signed in: nothing
    log.flush()
    assert rows(log, "SELECT kind, arg, n, member FROM events ORDER BY rowid") == [
        ("linked", "kingcards", 340, UID), ("unlinked", None, None, UID)]


# --- bounds ---------------------------------------------------------------------------------------------------------


def test_one_device_cannot_fill_a_day():
    log = store(per_device=5)
    assert log.add_page(batch(*[("refresh",)] * 4), "anon", None) == 4
    assert log.add_page(batch(*[("refresh",)] * 4), "anon", None) == 1
    assert log.add_page(batch(("refresh",), device=OTHER), "anon", None) == 1
    log.flush()
    assert rows(log, "SELECT COUNT(*) FROM events") == [(6,)]
    assert rows(log, "SELECT n FROM dropped") == [(3,)]


def test_a_new_day_gives_each_device_room_again():
    clock = Clock()
    log = store(clock, per_device=2)
    log.add_page(batch(("refresh",), ("refresh",), ("refresh",)), "anon", None)
    clock.at += 86400
    assert log.add_page(batch(("refresh",), ("refresh",)), "anon", None) == 2


def test_everyone_together_cannot_pass_the_days_bound():
    log = store(per_day=3)
    for i in range(5):
        log.add_page(batch(("refresh",), device=f"{i:022d}"), "anon", None)
    log.flush()
    assert rows(log, "SELECT COUNT(*) FROM events") == [(3,)]


def test_the_queue_is_bounded_while_the_writer_is_late():
    log = store(queue_max=3)
    assert log.add_page(batch(*[("refresh",)] * 5), "anon", None) == 3
    assert log.pending() == 3


def test_a_full_device_table_keeps_the_known_ones_only():
    log = store(max_devices=1)
    log.add_page(batch(("refresh",)), "anon", None)
    log.add_page(batch(("refresh",), device=OTHER), "anon", None)
    log.flush()
    assert rows(log, "SELECT id FROM devices") == [(DEV,)]
    assert rows(log, "SELECT COUNT(*) FROM events") == [(1,)]


def test_a_full_member_table_keeps_a_new_member_anonymous():
    log = store(max_members=1)
    log.add_page(batch(("refresh",)), "in", UID, iat=T0)
    log.add_page(batch(("refresh",), device=OTHER), "in", UID2, iat=T0)
    log.flush()
    assert rows(log, "SELECT uid FROM members") == [(UID,)]
    assert rows(log, "SELECT member FROM devices ORDER BY id") == [(UID,), (None,)]


def test_the_oldest_events_go_first_past_the_bound():
    clock = Clock()
    log = store(clock, max_events=3)
    for i in range(5):
        clock.at = T0 + i
        log.add_page(batch(("sheet", f"s{i}"),), "anon", None)
    log.flush()
    log.prune(force=True)
    assert rows(log, "SELECT arg FROM events ORDER BY ts") == [("s2",), ("s3",), ("s4",)]


def test_anonymous_activity_goes_after_90_days_and_a_members_after_180():
    clock = Clock()
    log = store(clock)
    log.add_page(batch(("refresh",)), "anon", None)
    log.add_page(batch(("refresh",), device=OTHER), "in", UID, iat=T0)
    log.note_lookup("kingcards", None, "ok", 3)
    log.note_lookup("kingcards", UID, "ok", 3)
    log.flush()
    clock.at = T0 + (ANON_ACTIVITY_KEEP_DAYS + 1) * 86400
    log.prune(force=True)
    assert rows(log, "SELECT id FROM devices") == [(OTHER,)]
    assert rows(log, "SELECT member FROM events") == [(UID,)]
    assert rows(log, "SELECT member FROM lookups") == [(UID,)]
    clock.at = T0 + (MEMBER_ACTIVITY_KEEP_DAYS + 1) * 86400
    log.prune(force=True)
    for table in ("devices", "events", "members", "lookups", "accounts"):
        assert rows(log, f"SELECT COUNT(*) FROM {table}") == [(0,)], table


# --- "Delete my data" ----------------------------------------------------------------------------------------------


def seeded():
    clock = Clock()
    log = store(clock)
    log.add_visit(DEV, "load", "deals", "phone", False, "?tiktok", "anon", None)  # before signing in
    log.flush()
    log.note_auth(UID, "Deal Hunter")
    log.add_page(batch(("session",)), "in", UID, iat=T0)
    log.add_page(batch(("refresh",), device="C" * 22), "anon", None)  # a phone used signed out only
    log.add_page(batch(("refresh",), device=OTHER), "in", UID2, iat=T0)  # someone else
    log.note_lookup("kingcards", UID, "ok", 340)
    log.note_lookup("othercards", UID2, "ok", 12)
    log.flush()
    log.note_person(UID, name="Deal Hunter", roles=["Linked"], present=True)
    log.note_person(UID, roles=["Linked", "NBA"], present=True)
    log.note_messages({(20409, "market-talk", UID): 3, (20409, "market-talk", UID2): 1})
    return clock, log


def test_delete_my_data_removes_everything_recorded_under_the_member():
    clock, log = seeded()
    assert log.erase_member(UID, device="C" * 22) > 0
    assert rows(log, "SELECT id FROM devices") == [(OTHER,)]
    assert rows(log, "SELECT DISTINCT member FROM events") == [(UID2,)]
    assert rows(log, "SELECT member FROM lookups") == [(UID2,)]
    assert rows(log, "SELECT username FROM accounts") == [("othercards",)]
    assert rows(log, "SELECT uid FROM members") == [(UID2,)]
    for table in ("d_people", "d_events"):
        assert rows(log, f"SELECT COUNT(*) FROM {table}") == [(0,)], table
    assert rows(log, "SELECT uid FROM d_msgs") == [(UID2,)]
    assert rows(log, "SELECT n FROM d_chan") == [(4,)]  # the channel's count names nobody


def test_after_delete_nothing_is_recorded_under_them_until_a_new_login():
    clock, log = seeded()
    log.add_page(batch(("refresh",), device="D" * 22), "in", UID, iat=T0)  # queued before the erase
    log.erase_member(UID)
    clock.at += 60
    log.add_page(batch(("refresh",), device="E" * 22), "in", UID, iat=T0)  # another device, still signed in
    log.note_person(UID, name="Deal Hunter", present=True)
    log.note_messages({(20409, "general", UID): 2})
    log.flush()
    assert rows(log, "SELECT COUNT(*) FROM events WHERE member = ?", UID) == [(0,)]
    assert rows(log, "SELECT COUNT(*) FROM d_people") == [(0,)]
    assert rows(log, "SELECT COUNT(*) FROM d_msgs WHERE uid = ?", UID) == [(0,)]
    assert log.blocked(UID)
    log.note_auth(UID, "Deal Hunter")  # they log in again, on purpose
    log.add_page(batch(("session",), device="E" * 22), "in", UID, iat=T0 + 61)
    log.flush()
    assert not log.blocked(UID)
    assert rows(log, "SELECT COUNT(*) FROM events WHERE member = ?", UID) == [(3,)]  # E's refresh comes with it


def test_the_pause_survives_a_restart(tmp_path):
    log = ActivityLog(tmp_path / "activity.db", clock=Clock())
    log.erase_member(UID)
    log.close()
    again = ActivityLog(tmp_path / "activity.db", clock=Clock())
    assert again.blocked(UID)


def test_erase_device_drops_one_device_and_what_it_did():
    clock, log = seeded()
    assert log.erase_device("C" * 22) == 2
    assert log.erase_device("not an id") == 0
    assert rows(log, "SELECT COUNT(*) FROM devices WHERE id = ?", "C" * 22) == [(0,)]


# --- Discord rows ---------------------------------------------------------------------------------------------------


def test_a_persons_changes_in_our_server_are_recorded():
    log = store()
    assert log.note_person(UID, name="Deal Hunter", roles=["Linked"], present=True, joined=T0) == []
    assert log.note_person(UID, roles=["NBA"], present=True) == [("role+", "NBA"), ("role-", "Linked")]
    assert log.note_person(UID, present=False) == [("leave", None)]
    assert log.note_person(UID, present=True) == [("join", None)]
    assert rows(log, "SELECT kind, arg FROM d_events ORDER BY rowid") == [
        ("role+", "NBA"), ("role-", "Linked"), ("leave", None), ("join", None)]
    assert rows(log, "SELECT name, roles, present FROM d_people") == [("Deal Hunter", json.dumps(["NBA"]), 1)]


def test_message_counts_add_up_and_a_day_has_room_for_so_many_authors(monkeypatch):
    import advisor.activity as activity

    monkeypatch.setattr(activity, "DISCORD_ACTIVITY_MSG_ROWS_PER_DAY", 1)
    log = store()
    log.note_messages({(1, "general", UID): 2, (1, "general", None): 5})
    log.note_messages({(1, "general", UID): 1, (1, "general", UID2): 4})
    assert rows(log, "SELECT uid, n FROM d_msgs") == [(UID, 3)]
    assert rows(log, "SELECT n FROM d_chan") == [(12,)]


def test_a_corrupt_file_is_set_aside(tmp_path):
    path = tmp_path / "activity.db"
    path.write_bytes(b"this is not a database" * 100)
    log = ActivityLog(path, clock=Clock())
    log.add_page(batch(("refresh",)), "anon", None)
    assert log.flush() == 1
    assert (tmp_path / "activity.db.corrupt").exists()


def test_it_survives_a_restart(tmp_path):
    log = ActivityLog(tmp_path / "activity.db", clock=Clock())
    log.add_page(batch(("refresh",)), "in", UID, name="Deal Hunter", iat=T0)
    log.flush()
    log.close()
    again = ActivityLog(tmp_path / "activity.db", clock=Clock())
    assert again.read("SELECT name FROM members") == [("Deal Hunter",)]


def test_a_yearly_figure_from_the_page_only_sizes_an_account_the_server_looked_up():
    """Anyone can send any figure for any name: it may size an account already looked up, never add one."""
    log = store()
    log.add_page(batch(*[("year", f"made{i}", 5) for i in range(30)]), "anon", None)
    log.note_lookup("kingcards", None, "ok", 340)
    log.flush()
    log.add_page(batch(("year", "KingCards", 12000)), "anon", None)
    log.flush()
    assert rows(log, "SELECT username, year FROM accounts") == [("kingcards", 12000)]


def test_the_accounts_table_is_bounded(monkeypatch):
    import advisor.activity as activity

    monkeypatch.setattr(activity, "ACTIVITY_MAX_ACCOUNTS", 2)
    clock = Clock()
    log = store(clock)
    for i in range(4):
        clock.at = T0 + i
        log.note_lookup(f"acct{i}", None, "ok", i)
    log.flush()
    log.prune(force=True)
    assert rows(log, "SELECT username FROM accounts ORDER BY at") == [("acct2",), ("acct3",)]
