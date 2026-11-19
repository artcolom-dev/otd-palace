"""The page's activity reports (POST /api/events), what the server itself records (visits, logins, lookups, links),
the admin's deep routes (/api/admin/members, members.csv, member/<id>, accounts, features, sources, discord) and
"Delete my data" for the activity store, seen from the web."""

import json

import pytest

from advisor.activity import ActivityLog
from advisor.members import MemberLinks
from advisor.ratelimit import TokenBuckets
from advisor.rules import ACTIVITY_EVENTS_PER_MIN
from tests.test_discord_gate import USER
from tests.test_gate_web import as_member, log_in, make
from advisor.importer import Imported
from tests.test_import_web import FakeImporter as _Fake
from tests.test_visits_web import DEV, SAME, beacon, visits_log

OWNER = USER["id"]
T0 = 1_795_000_000


def FakeImporter():  # noqa: N802 - reads as the class it makes
    return _Fake(Imported("ok", "kingcards", ({"key": "nba:2026:player:1", "rating": 5.0},), False))


DEEP = ("/api/admin/members", "/api/admin/members.csv", f"/api/admin/member/{OWNER}", "/api/admin/accounts",
        "/api/admin/features", "/api/admin/sources", "/api/admin/discord")


def app(tmp_path, admins=(OWNER,), **kw):
    activity = kw.pop("activity", None) or ActivityLog(None, clock=lambda: T0)
    visits = kw.pop("visits", None) or visits_log(tmp_path)
    c, gate, fake = make(tmp_path, visits=visits, activity=activity, admin_ids=frozenset(admins), **kw)
    return c, activity


def events(c, items, headers=None, device=DEV, **extra):
    body = {"d": device, "k": "phone", "a": False, "e": items, **extra}
    return c.post("/api/events", data=json.dumps(body), content_type="text/plain;charset=UTF-8",
                  headers=SAME if headers is None else headers)


def kept(activity, sql, *args):
    activity.flush()
    return activity.read(sql, args)


# --- the page's reports ---------------------------------------------------------------------------------------------


def test_an_anonymous_devices_events_are_kept(tmp_path):
    c, activity = app(tmp_path)
    beacon(c, s="tiktok")
    r = events(c, [["session"], ["sport", "nba"], ["time", None, 30]])
    assert r.status_code == 204 and r.get_data() == b"" and "no-store" in r.headers["Cache-Control"]
    assert kept(activity, "SELECT kind, arg, n, member, state FROM events ORDER BY rowid") == [
        ("load", "deals", None, None, "anon"), ("session", None, None, None, "anon"),
        ("sport", "nba", None, None, "anon"), ("time", None, 30, None, "anon")]
    assert activity.read("SELECT source FROM devices") == [("?tiktok",)]


def test_a_members_events_are_kept_under_their_discord_id_with_the_devices_history(tmp_path):
    c, activity = app(tmp_path)
    beacon(c)
    events(c, [["lookup", "kingcards"]])
    h = {**SAME, **as_member(log_in(c))}
    events(c, [["pings", "on"]], headers=h)
    rows = kept(activity, "SELECT kind, member FROM events ORDER BY rowid")
    assert rows == [("load", OWNER), ("lookup", OWNER), ("auth", OWNER), ("pings", OWNER)]
    assert activity.read("SELECT name FROM members") == [(USER["global_name"],)]


@pytest.mark.parametrize("raw, status", [
    (b"{nope", 400), (b"[]", 400), (json.dumps({"d": DEV, "k": "phone", "a": False, "e": [["nope"]]}).encode(), 400),
    (b"x" * 5000, 413),
])
def test_a_report_that_is_not_what_the_page_sends_is_refused(tmp_path, raw, status):
    c, activity = app(tmp_path)
    assert c.post("/api/events", data=raw, headers=SAME).status_code == status
    assert kept(activity, "SELECT COUNT(*) FROM events") == [(0,)]


def test_another_site_cannot_send_one(tmp_path):
    c, activity = app(tmp_path)
    assert events(c, [["session"]], headers={**SAME, "Sec-Fetch-Site": "cross-site"}).status_code == 403


def test_a_bot_is_answered_and_dropped(tmp_path):
    c, activity = app(tmp_path)
    assert events(c, [["session"]], headers={"Sec-Fetch-Site": "same-origin", "User-Agent": "curl/8"}).status_code == 204
    assert kept(activity, "SELECT COUNT(*) FROM events") == [(0,)]


def test_one_address_is_limited_by_the_events_it_sends(tmp_path):
    c, activity = app(tmp_path)
    sent = 0
    while sent < ACTIVITY_EVENTS_PER_MIN + 80:
        assert events(c, [["refresh"]] * 40, device=("A" if sent % 80 else "B") * 22).status_code == 204
        sent += 40
    assert kept(activity, "SELECT COUNT(*) FROM events WHERE kind = 'refresh'") == [(ACTIVITY_EVENTS_PER_MIN,)]


def test_a_device_the_visit_log_never_saw_counts_against_new_devices(tmp_path):
    c, activity = app(tmp_path)
    for i in range(40):
        events(c, [["session"]], device=f"{i:022d}")
    assert kept(activity, "SELECT COUNT(*) FROM devices")[0][0] == 30


def test_without_the_store_it_is_a_no_op(tmp_path):
    c, _, _ = make(tmp_path)
    assert events(c, [["session"]]).status_code == 204


def test_the_bucket_takes_a_cost_whole_or_not_at_all():
    buckets = TokenBuckets(10, 1, 10, lambda: 0.0)
    assert buckets.take("a", 8) and not buckets.take("a", 3) and buckets.take("a", 2)


# --- what the server records itself --------------------------------------------------------------------------------


def test_a_lookup_and_a_link_are_recorded_for_the_member(tmp_path):
    links = MemberLinks(tmp_path / "member-links.json")
    c, activity = app(tmp_path, links=links, importer=FakeImporter())
    h = {**SAME, **as_member(log_in(c))}
    assert c.get("/api/passes/import?u=kingcards", headers=h).status_code == 200
    assert c.get("/api/passes/import?u=kingcards", headers=h).status_code == 200  # again: counted once
    r = c.post("/api/me/link", data=json.dumps({"username": "kingcards"}), content_type="application/json", headers=h)
    assert r.status_code == 200
    assert c.delete("/api/me/link", headers=h).status_code == 204
    assert kept(activity, "SELECT username, member, status FROM lookups") == [("kingcards", OWNER, "ok")]
    assert activity.read("SELECT kind, arg FROM events WHERE kind IN ('linked', 'unlinked') ORDER BY rowid") == [
        ("linked", "kingcards"), ("unlinked", None)]
    assert activity.read("SELECT username, passes FROM accounts")[0][0] == "kingcards"


# --- the admin's deep routes --------------------------------------------------------------------------------------


@pytest.mark.parametrize("path", DEEP)
def test_every_deep_route_is_for_the_admin_alone(tmp_path, path):
    c, _ = app(tmp_path, admins=("999988887777666655",))
    assert c.get(path).status_code == 401
    h = as_member(log_in(c))
    r = c.get(path, headers=h)
    assert r.status_code == 403 and "no-store" in r.headers["Cache-Control"]
    assert USER["global_name"] not in r.get_data(as_text=True)


@pytest.mark.parametrize("path", DEEP)
def test_every_deep_route_is_gone_without_admins_or_the_store(tmp_path, path):
    c, _ = app(tmp_path, admins=())
    assert c.get(path, headers=as_member(log_in(c))).status_code == 404
    (tmp_path / "x").mkdir()
    c2, _, _ = make(tmp_path / "x", visits=visits_log(tmp_path), admin_ids=frozenset({OWNER}))
    assert c2.get(path, headers=as_member(log_in(c2))).status_code == 404


def test_the_admin_sees_each_member_and_their_timeline(tmp_path):
    links = MemberLinks(tmp_path / "member-links.json")
    c, activity = app(tmp_path, links=links)
    h = {**SAME, **as_member(log_in(c))}
    beacon(c, headers=h)
    events(c, [["session"], ["sheet", "how"]], headers=h)
    activity.flush()
    r = c.get("/api/admin/members", headers=h)
    assert r.status_code == 200 and r.headers["Cache-Control"] == "private, no-store"
    assert r.headers["X-Robots-Tag"] == "noindex"
    (row,) = r.get_json()["members"]
    assert row["uid"] == OWNER and row["name"] == USER["global_name"] and row["sessions"] == 1
    t = c.get(f"/api/admin/member/{OWNER}", headers=h)
    assert t.status_code == 200 and {i["kind"] for i in t.get_json()["items"]} >= {"auth", "load", "sheet"}
    assert c.get("/api/admin/member/123456789012345678", headers=h).status_code == 404
    assert c.get("/api/admin/member/not-an-id", headers=h).status_code == 404


def test_the_csv_is_a_download_for_the_admin(tmp_path):
    c, activity = app(tmp_path)
    h = {**SAME, **as_member(log_in(c))}
    activity.flush()
    r = c.get("/api/admin/members.csv", headers=h)
    assert r.status_code == 200 and r.mimetype == "text/csv" and r.headers["Cache-Control"] == "private, no-store"
    assert r.headers["Content-Disposition"].startswith("attachment; filename=")
    assert r.get_data(as_text=True).splitlines()[1].startswith(OWNER)


@pytest.mark.parametrize("path", DEEP[3:])
def test_each_tab_answers_the_admin(tmp_path, path):
    c, activity = app(tmp_path)
    h = {**SAME, **as_member(log_in(c))}
    r = c.get(path, headers=h)
    assert r.status_code == 200 and r.headers["Cache-Control"] == "private, no-store"


def test_the_admin_page_may_show_discord_avatars_and_no_other_page_may(tmp_path):
    c, _ = app(tmp_path)
    h = as_member(log_in(c))
    admin = c.get("/admin", headers=h).headers["Content-Security-Policy"]
    home = c.get("/", headers=h).headers["Content-Security-Policy"]
    assert "img-src 'self' https://cdn.discordapp.com" in admin
    assert "cdn.discordapp.com" not in home


# --- "Delete my data" ----------------------------------------------------------------------------------------------


def test_delete_my_data_erases_the_members_activity_and_this_device(tmp_path):
    links = MemberLinks(tmp_path / "member-links.json")
    c, activity = app(tmp_path, links=links, importer=FakeImporter())
    bare = c.application.test_client(use_cookies=False)
    events(bare, [["session"]], device="B" * 22)  # this phone before signing in
    events(bare, [["session"]], device="C" * 22)  # someone else
    h = {**SAME, **as_member(log_in(c))}
    events(c, [["session"]], headers=h)
    c.get("/api/passes/import?u=kingcards", headers=h)
    activity.flush()
    r = c.delete("/api/me", data=json.dumps({"device": "B" * 22}), content_type="application/json", headers=h)
    assert r.status_code == 204
    assert kept(activity, "SELECT id FROM devices") == [("C" * 22,)]
    for table in ("members", "lookups"):
        assert activity.read(f"SELECT COUNT(*) FROM {table}") == [(0,)], table
    assert activity.read("SELECT COUNT(*) FROM events WHERE member IS NOT NULL") == [(0,)]
    events(c, [["session"]], headers=h)  # an old cookie elsewhere: nothing is recorded under them
    assert kept(activity, "SELECT COUNT(*) FROM events WHERE member IS NOT NULL") == [(0,)]
