"""The visit beacon (POST /api/visit), the login counts, the admin panel (/admin, /api/admin/stats) and "Delete my
data" for the visit log, seen from the web."""

import json
from datetime import datetime, timezone

import pytest

from advisor import discord_gate as dg
from advisor.members import MemberLinks
from advisor.rules import VISIT_NEW_DEVICES_PER_HOUR, VISIT_PER_MIN
from advisor.visits import VisitLog, day_number
from tests.test_discord_gate import USER
from tests.test_gate_web import as_member, log_in, make

T0 = datetime(2026, 11, 18, 12, 0, tzinfo=timezone.utc)
KEY = b"k" * 32
DEV = "A" * 22
PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1"
SAME = {"Sec-Fetch-Site": "same-origin", "User-Agent": PHONE}
OWNER = USER["id"]


def visits_log(tmp_path):
    return VisitLog(tmp_path / "visits.json", clock=lambda: T0, member_key=KEY)


def app(tmp_path, admins=(OWNER,), **kw):
    visits = kw.pop("visits", None) or visits_log(tmp_path)
    c, gate, fake = make(tmp_path, visits=visits, admin_ids=frozenset(admins), **kw)
    return c, visits


def beacon(c, headers=None, **fields):
    body = {"d": DEV, "e": "load", "t": "deals", "k": "phone", "a": False, **fields}
    return c.post("/api/visit", data=json.dumps(body), content_type="text/plain;charset=UTF-8",
                  headers=SAME if headers is None else headers)


# --- the beacon ----------------------------------------------------------------------------------------------------


def test_a_visitors_beacon_is_counted_and_answered_with_nothing(tmp_path):
    c, visits = app(tmp_path)
    r = beacon(c, r="google.com")
    assert r.status_code == 204 and r.get_data() == b"" and "no-store" in r.headers["Cache-Control"]
    row = visits.data()["devices"][DEV]
    assert row["s"] == "google.com" and row["x"] == 0 and "m" not in row


def test_a_members_beacon_carries_their_session_as_a_hash(tmp_path):
    c, visits = app(tmp_path)
    session = log_in(c)
    assert beacon(c, headers={**SAME, **as_member(session)}).status_code == 204
    row = visits.data()["devices"][DEV]
    assert row["m"] == visits.member_hash(OWNER) and row["x"] & 6 == 6


def test_our_own_host_is_no_referrer(tmp_path):
    c, visits = app(tmp_path)
    beacon(c, headers={**SAME, "Host": "otdpalace.com"}, d="B" * 22, r="www.otdpalace.com")
    assert visits.data()["devices"]["B" * 22]["s"] == ""


@pytest.mark.parametrize("ua", ["", "curl/8.4", "python-requests/2.32",
                                "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
                                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/120.0 Safari/537.36",
                                "Mozilla/5.0 (Macintosh) Discordbot/2.0", "facebookexternalhit/1.1"])
def test_bots_are_answered_but_never_counted(tmp_path, ua):
    c, visits = app(tmp_path)
    assert beacon(c, headers={"Sec-Fetch-Site": "same-origin", "User-Agent": ua}).status_code == 204
    assert visits.data()["devices"] == {} and visits.data()["days"] == {}


def test_another_site_cannot_send_one(tmp_path):
    c, visits = app(tmp_path)
    assert beacon(c, headers={**SAME, "Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert visits.data()["devices"] == {}


@pytest.mark.parametrize("raw, status", [
    (b"{nope", 400), (b"[]", 400), (json.dumps({"d": DEV}).encode(), 400), (b"x" * 600, 413),
    (json.dumps({"d": DEV, "e": "load", "t": "deals", "k": "phone", "a": False, "ip": "1.2.3.4"}).encode(), 400),
])
def test_a_report_that_is_not_what_the_page_sends_is_refused(tmp_path, raw, status):
    c, visits = app(tmp_path)
    assert c.post("/api/visit", data=raw, headers=SAME).status_code == status
    assert visits.data()["devices"] == {}


def test_one_address_is_limited_quietly(tmp_path):
    """Past the limit a beacon is dropped with the same 204: a 429 would be a console error on every page of a busy
    shared address (a carrier's NAT), for a count that does not matter to the visitor."""
    c, visits = app(tmp_path)
    codes = [beacon(c, e="view").status_code for _ in range(VISIT_PER_MIN + 1)]
    assert codes == [204] * (VISIT_PER_MIN + 1)
    assert visits.data()["days"]["2026-11-18"]["views"]["deals"] == VISIT_PER_MIN


def test_one_address_cannot_mint_devices_without_end(tmp_path):
    c, visits = app(tmp_path)
    for i in range(VISIT_NEW_DEVICES_PER_HOUR + 3):
        assert beacon(c, d=f"{i:022d}").status_code == 204
    assert len(visits.data()["devices"]) == VISIT_NEW_DEVICES_PER_HOUR
    assert beacon(c, d=f"{0:022d}", e="view").status_code == 204  # a device it knows still counts
    assert visits.data()["days"]["2026-11-18"]["views"]["deals"] == VISIT_NEW_DEVICES_PER_HOUR + 1


def test_without_a_visit_log_the_beacon_is_a_no_op(tmp_path):
    c, _, _ = make(tmp_path)
    assert beacon(c).status_code == 204


def test_logins_started_and_finished_are_counted(tmp_path):
    c, visits = app(tmp_path)
    log_in(c)
    day = visits.data()["days"]["2026-11-18"]
    assert day["auth_start"] == 1 and day["auth_ok"] == 1


# --- the admin panel -----------------------------------------------------------------------------------------------


def test_the_admin_routes_do_not_exist_without_admin_ids(tmp_path):
    c, _ = app(tmp_path, admins=())
    h = as_member(log_in(c))
    assert c.get("/admin", headers=h).status_code == 404
    assert c.get("/api/admin/stats", headers=h).status_code == 404


def test_the_admin_routes_do_not_exist_with_the_gate_off(tmp_path):
    c, _ = app(tmp_path, gate=False)
    assert c.get("/admin").status_code == 404 and c.get("/api/admin/stats").status_code == 404


def test_someone_not_signed_in_is_asked_to_sign_in(tmp_path):
    c, _ = app(tmp_path)
    page = c.get("/admin")
    assert page.status_code == 401 and "/auth/discord?next=%2Fadmin" in page.get_data(as_text=True)
    assert "no-store" in page.headers["Cache-Control"]
    api = c.get("/api/admin/stats")
    assert api.status_code == 401 and api.get_json() == {"error": "discord_required"}


def test_a_signed_in_member_who_is_not_an_admin_is_refused(tmp_path):
    c, _ = app(tmp_path, admins=("999988887777666655",))
    h = as_member(log_in(c))
    assert c.get("/admin", headers=h).status_code == 403
    r = c.get("/api/admin/stats", headers=h)
    assert r.status_code == 403 and r.get_json() == {"error": "forbidden"}
    assert "no-store" in r.headers["Cache-Control"]


def test_a_forged_cookie_is_nobody(tmp_path):
    c, _ = app(tmp_path)
    forged = {"Cookie": f"{dg.SESSION_COOKIE}=" + json.dumps({"uid": OWNER})}
    assert c.get("/api/admin/stats", headers=forged).status_code == 401


def test_an_admin_gets_the_panel_and_its_figures_kept_private(tmp_path):
    links = MemberLinks(tmp_path / "member-links.json")
    c, visits = app(tmp_path, links=links)
    h = as_member(log_in(c))
    beacon(c, headers={**SAME, **h})
    page = c.get("/admin", headers=h)
    assert page.status_code == 200 and page.headers["Cache-Control"] == "private, no-store"
    assert page.headers["X-Robots-Tag"] == "noindex" and 'id="snapshot"' not in page.get_data(as_text=True)
    r = c.get("/api/admin/stats", headers=h)
    assert r.status_code == 200 and r.headers["Cache-Control"] == "private, no-store"
    stats = r.get_json()
    assert stats["active"]["dau"] == 1 and stats["today"] == "2026-11-18"
    assert stats["funnel"][2] == {"key": "signed_in", "count": 1}
    text = r.get_data(as_text=True)
    assert OWNER not in text and USER["global_name"] not in text and DEV not in text
    assert visits.member_hash(OWNER) not in text


def test_the_admin_figures_count_the_members_stores(tmp_path):
    links = MemberLinks(tmp_path / "member-links.json")
    c, visits = app(tmp_path, links=links)
    h = as_member(log_in(c))
    beacon(c, headers={**SAME, **h})
    links.claim(OWNER, "kept", (), now=1.0)
    links.update(OWNER, pings=True)
    stats = c.get("/api/admin/stats", headers=h).get_json()
    assert stats["totals"]["linked"] == 1 and stats["totals"]["pings"] == 1
    assert [s["count"] for s in stats["funnel"]][4:] == [1, 1]


# --- "Delete my data" ----------------------------------------------------------------------------------------------


def test_delete_my_data_drops_the_members_visits_and_the_device_it_names(tmp_path):
    links = MemberLinks(tmp_path / "member-links.json")
    c, visits = app(tmp_path, links=links)
    h = {**SAME, **as_member(log_in(c))}
    beacon(c, headers=h)
    bare = c.application.test_client(use_cookies=False)
    beacon(bare, d="B" * 22)  # this phone, before it signed in: nothing ties it to them but its own id
    beacon(bare, d="C" * 22)  # someone else
    r = c.delete("/api/me", data=json.dumps({"device": "B" * 22}), content_type="application/json", headers=h)
    assert r.status_code == 204
    data = visits.data()
    assert set(data["devices"]) == {"C" * 22} and data["members"] == {}
    assert day_number(T0) > 0


def test_delete_my_data_still_works_without_a_body(tmp_path):
    links = MemberLinks(tmp_path / "member-links.json")
    c, visits = app(tmp_path, links=links)
    h = {**SAME, **as_member(log_in(c))}
    beacon(c, headers=h)
    assert c.delete("/api/me", headers=h).status_code == 204
    assert visits.data()["devices"] == {}


def test_one_ipv6_network_counts_as_one_address_for_new_devices(tmp_path):
    c, visits = app(tmp_path)
    for i in range(VISIT_NEW_DEVICES_PER_HOUR + 5):  # a new address of the same /64 each time
        beacon(c, headers={**SAME, "X-Real-IP": f"2001:db8:1:2::{i + 1:x}"}, d=f"{i:022d}")
    assert len(visits.data()["devices"]) == VISIT_NEW_DEVICES_PER_HOUR
    beacon(c, headers={**SAME, "X-Real-IP": "2001:db8:9:9::1"}, d="Z" * 22)  # another network
    assert "Z" * 22 in visits.data()["devices"]
