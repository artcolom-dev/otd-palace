"""The admin panel's deep tabs (advisor/activity_report.py), from a small activity store."""

import csv
import io
from datetime import datetime, timezone

from advisor.activity import ActivityLog, Batch, PageEvent
from advisor.activity_report import (
    accounts_report,
    avatar_url,
    discord_report,
    features_report,
    member_timeline,
    members_csv,
    members_report,
    sources_report,
)
from advisor.members import MemberLinks

T0 = 1_795_000_000 - 1_795_000_000 % 86400 + 12 * 3600  # noon UTC
DEV, DEV2, DEV3 = "A" * 22, "B" * 22, "C" * 22
UID, UID2 = "111122223333444455", "999988887777666655"
AVATAR = "b" * 32


class Clock:
    def __init__(self, at=T0):
        self.at = at

    def __call__(self):
        return self.at


def batch(*events, device=DEV, cls="phone"):
    return Batch(device, cls, False, tuple(PageEvent(*e) for e in events))


def seeded(tmp_path):
    """Ten days ago a phone came from TikTok, looked around, signed in, linked; it came back today. A computer came
    direct and stayed anonymous. Someone else signed in once."""
    clock = Clock(T0 - 10 * 86400)
    log = ActivityLog(None, clock=clock)
    log.add_visit(DEV, "load", "deals", "phone", False, "?tiktok", "anon", None)
    log.add_page(batch(("session",), ("sport", "nba"), ("lookup", "kingcards"), ("time", None, 120)), "anon", None)
    log.note_lookup("kingcards", None, "ok", 340)
    log.flush()
    clock.at += 300
    log.note_auth(UID, "Deal Hunter")
    log.add_page(batch(("link", "kingcards"), ("pings", "on")), "in", UID, name="Deal Hunter", iat=clock.at)
    log.note_link(UID, "kingcards", 340)
    log.add_page(batch(("year", "kingcards", 12000),), "in", UID, iat=clock.at)
    log.add_visit(DEV2, "load", "today", "desktop", False, None, "anon", None)
    log.add_page(batch(("session",), ("sort", "discount"), ("time", None, 30), device=DEV2, cls="desktop"), "anon", None)
    log.flush()
    clock.at = T0
    log.add_page(batch(("session",), ("deal", "123"), ("time", None, 60)), "in", UID, iat=T0 - 10 * 86400 + 300)
    log.note_lookup("bigwhale", UID, "ok", 2400)
    log.note_lookup("nobody", UID, "not_found", None)
    log.add_page(batch(("session",), device=DEV3), "out", UID2, name="Other One", iat=T0)
    log.flush()
    log.note_person(UID, name="Deal Hunter", avatar=AVATAR, roles=["Linked"], present=True)
    log.note_person(UID, roles=["Linked", "NBA"], present=True)
    log.note_messages({(T0 // 86400, "market-talk", UID): 5, (T0 // 86400, "general", UID2): 1,
                       (T0 // 86400, "live-deals", None): 3})
    log.note_join_message(UID2, T0 - 3600, "Other One")
    log.note_post("400000000000000001", "live-deals", T0 - 7200, "LeBron · 40% under", 6, "🔥 4 · 👍 2")
    links = MemberLinks(tmp_path / "member-links.json")
    links.claim(UID, "kingcards", (), now=1.0, year=12000)
    return clock, log, links


def test_one_row_per_member_with_everything_known_about_them(tmp_path):
    _, log, links = seeded(tmp_path)
    report = members_report(log, links, {UID}, T0)
    assert {r["uid"] for r in report["members"]} == {UID, UID2}
    me = next(r for r in report["members"] if r["uid"] == UID)
    assert me["name"] == "Deal Hunter" and me["avatar"] == avatar_url(UID, AVATAR)
    assert me["first"] == T0 - 10 * 86400 and me["last"] == T0  # history from before the sign-in counts
    assert me["days"] == 2 and me["sessions"] == 2 and me["time_s"] == 180 and me["devices"] == 1
    assert me["source"] == "?tiktok" and me["in_server"] is True and me["linked"] == "kingcards"
    assert me["type"] and me["year"] == 12000 and me["push"] is True and me["pings"] is True
    assert me["roles"] == ["Linked", "NBA"] and me["messages"] == 5 and me["lookups"] == 2 and me["active_7d"]
    other = next(r for r in report["members"] if r["uid"] == UID2)
    assert other["in_server"] is False and other["source"] == "direct" and other["linked"] is None


def test_the_csv_has_a_row_per_member_and_never_runs_a_formula(tmp_path):
    _, log, links = seeded(tmp_path)
    report = members_report(log, links, set(), T0)
    report["members"][0]["name"] = "=HYPERLINK(\"http://x\")"
    rows = list(csv.reader(io.StringIO(members_csv(report))))
    assert rows[0][:3] == ["uid", "name", "first_seen"] and len(rows) == 3
    assert rows[1][1].startswith("'=")


def test_a_members_timeline_has_their_site_lookups_and_discord(tmp_path):
    _, log, links = seeded(tmp_path)
    found = member_timeline(log, UID, links, set(), T0)
    kinds = {(i["from"], i["kind"]) for i in found["items"]}
    assert {("site", "load"), ("site", "sport"), ("site", "auth"), ("site", "linked"), ("lookup", "ok"),
            ("lookup", "not_found"), ("discord", "role+"), ("messages", "messages")} <= kinds
    assert all(i.get("device") in (None, 1) for i in found["items"])
    assert DEV not in str(found)  # devices are numbered, never shown by id
    assert [i["ts"] for i in found["items"]] == sorted((i["ts"] for i in found["items"]), reverse=True)
    assert member_timeline(log, "123456789012345678", links, set(), T0) is None


def test_accounts_looked_up_with_their_size_and_who_looked(tmp_path):
    _, log, links = seeded(tmp_path)
    report = accounts_report(log, links, T0)
    by = {a["username"]: a for a in report["accounts"]}
    assert by["kingcards"]["passes"] == 340 and by["kingcards"]["year"] == 12000 and by["kingcards"]["anon"] == 1
    assert by["kingcards"]["devices"] == 1 and by["kingcards"]["linked_by"] == "Deal Hunter"
    assert by["bigwhale"]["passes"] == 2400 and by["bigwhale"]["members"] == 1 and by["bigwhale"]["type"]
    assert by["nobody"]["status"] == "not_found" and by["nobody"]["passes"] is None
    assert report["power"] == [{"uid": UID, "name": "Deal Hunter", "lookups": 2, "accounts": 2}]
    assert report["totals"] == {"lookups": 3, "by_members": 2, "accounts": 3}


def test_features_by_day_state_and_class(tmp_path):
    _, log, _ = seeded(tmp_path)
    report = features_report(log, T0)
    by = {f["kind"]: f for f in report["features"]}
    assert by["sport"]["events"] == 1 and by["sport"]["by_state"]["anon"] == 1 and by["sport"]["top"] == [
        {"arg": "nba", "n": 1}]
    assert by["sort"]["by_cls"] == {"desktop": 1}
    assert by["deal"]["by_state"]["in"] == 1 and by["deal"]["top"] == []  # listing ids are not ranked
    assert by["link"]["by_cls"] == {"phone": 1} and "linked" not in by  # the press, not the server's own record
    assert "session" not in by and "time" not in by
    assert report["sessions"]["count"] == 4 and report["sessions"]["time_s"] == 210
    assert report["sessions"]["by_state"] == {"anon": 2, "out": 1, "in": 1}
    assert sum(report["hours"]) == 4 and report["hours"][12] == 4  # all at noon UTC
    assert report["days"][-1] == datetime.fromtimestamp(T0, timezone.utc).date().isoformat()
    assert len(report["sessions"]["daily"]) == report["window_days"] == 30


def test_sources_from_first_touch_to_still_there_at_d7(tmp_path):
    _, log, links = seeded(tmp_path)
    report = sources_report(log, links, T0)
    by = {s["key"]: s for s in report["sources"]}
    assert by["?tiktok"] == {"key": "?tiktok", "devices": 1, "signed_in": 1, "linked": 1, "d7_ready": 1, "d7": 1,
                             "members": 1}
    assert by["direct"]["devices"] == 2 and by["direct"]["d7"] == 0 and by["direct"]["d7_ready"] == 1


def test_discord_tab(tmp_path):
    _, log, links = seeded(tmp_path)
    report = discord_report(log, {"2026-11-17": 40, "2026-11-18": 42}, links, T0)
    assert report["count"][-1] == {"day": "2026-11-18", "members": 42}
    assert sum(m["joins"] for m in report["moves"]) == 1
    assert [c["channel"] for c in report["channels"]] == ["market-talk", "live-deals", "general"]
    assert report["people"][0] == {"uid": UID, "name": "Deal Hunter", "avatar": avatar_url(UID, AVATAR),
                                   "messages": 5, "site": True, "linked": True}
    assert report["posts"][0]["reactions"] == 6 and report["post_channels"][0]["channel"] == "live-deals"
    assert report["roles"][0]["role"] == "NBA"


def test_an_avatar_is_only_ever_discords_own_address():
    assert avatar_url(UID, "javascript:alert(1)") is None and avatar_url(UID, None) is None
    assert avatar_url(UID, "a_" + "c" * 32).startswith("https://cdn.discordapp.com/avatars/")


def test_the_accounts_tab_stays_quick_with_many_accounts(tmp_path):
    """The last answer of each account is found in one pass, never one query per lookup (that was quadratic)."""
    import time

    log = ActivityLog(None, clock=Clock())
    for i in range(4000):
        log.note_lookup(f"acct{i}", None, "ok" if i % 3 else "not_found", i)
    log.flush()
    started = time.perf_counter()
    report = accounts_report(log, None, T0)
    assert time.perf_counter() - started < 1.0
    assert len(report["accounts"]) == 300 and report["totals"]["accounts"] == 4000
