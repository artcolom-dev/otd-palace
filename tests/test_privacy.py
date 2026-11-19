"""The privacy notice (GET /privacy) and "Delete my data" (DELETE /api/me).

Discord is the scripted fake of test_discord_gate and the perks' guild the fake of test_discord_perks: nothing here
reaches the network."""

import json

import pytest

from advisor import discord_gate as dg
from advisor import privacy
from advisor.members import MemberLinks
from advisor.push import Dispatcher, PushStore
from advisor.rules import (
    ANON_ACTIVITY_KEEP_DAYS,
    CLICK_KEEP_DAYS,
    MEMBER_ACTIVITY_KEEP_DAYS,
    PUSH_ROW_TTL_DAYS,
    VISIT_KEEP_DAYS,
)
from tests.test_discord_gate import USER
from tests.test_discord_perks import FakeGuild, bot_for
from tests.test_gate_web import as_member, log_in, make
from tests.test_push import FakeSender, body, rules, subscription

OTHER = "999999999999999999"
PASSES = tuple({"key": f"nba:2026:player:{i}", "rating": 15.0} for i in range(30))
SAME = {"Sec-Fetch-Site": "same-origin"}
FCM = "https://fcm.googleapis.com/fcm/send/"


class Perks:
    def __init__(self, error=None):
        self.synced = []
        self.error = error

    def request_sync(self, uid):
        if self.error is not None:
            raise self.error
        self.synced.append(uid)


def on_disk(path):
    return json.loads(path.read_text(encoding="utf-8"))


def fill(links, uid, name="Shaedon"):
    """A member with everything the store can hold: a link, follows, a ping setting, DM state, pings sent."""
    links.claim(uid, name, PASSES, now=1.0, year=4000)
    links.update(uid, pings=True, follows=["nba:7", "nfl:9"])
    links.note_dm(uid, channel="123456789012345678")
    links.note_ping(uid, 4521, 5.0)


# --- the stores ------------------------------------------------------------------------------------------------------


def test_erasing_a_member_removes_their_row_and_their_tombstone_from_memory_and_disk(tmp_path):
    path = tmp_path / "member-links.json"
    links = MemberLinks(path)
    fill(links, USER["id"])
    fill(links, OTHER, "Other")
    assert links.erase(USER["id"]) is True
    assert links.get(USER["id"]) is None and links.unlinked_at(USER["id"]) is not None  # the tombstone
    assert "Shaedon" not in path.read_text()
    assert on_disk(path)["links"].get(USER["id"]) is None and set(on_disk(path)["unlinked"]) == {USER["id"]}
    assert links.get(OTHER)["follows"] == ["nba:7", "nfl:9"]
    assert MemberLinks(path).get(OTHER)["username"] == "Other"


def test_a_tombstone_stops_other_devices_until_the_member_links_again_on_purpose(tmp_path):
    path = tmp_path / "member-links.json"
    links = MemberLinks(path)
    fill(links, USER["id"])
    assert links.erase(USER["id"]) is True
    at = links.unlinked_at(USER["id"])
    assert isinstance(at, float) and MemberLinks(path).unlinked_at(USER["id"]) == at
    assert links.erase(USER["id"]) is False and links.unlinked_at(USER["id"]) == at  # the mark stays as it was
    assert links.claim(USER["id"], "Shaedon", PASSES, 5.0) == "ok"
    assert links.unlinked_at(USER["id"]) is None


def test_erasing_keeps_an_unlink_tombstone_as_the_erase_tombstone(tmp_path):
    path = tmp_path / "member-links.json"
    links = MemberLinks(path)
    fill(links, USER["id"])
    links.unlink(USER["id"])
    assert links.unlinked_at(USER["id"]) is not None and USER["id"] in path.read_text()
    at = links.unlinked_at(USER["id"])
    assert links.erase(USER["id"]) is False
    assert links.unlinked_at(USER["id"]) == at and MemberLinks(path).unlinked_at(USER["id"]) == at


def test_erasing_twice_or_a_stranger_changes_nothing(tmp_path):
    path = tmp_path / "member-links.json"
    links = MemberLinks(path)
    assert links.erase(USER["id"]) is False and not path.exists()  # nothing held, nothing written
    fill(links, OTHER, "Other")
    before = path.read_bytes()
    assert links.erase(USER["id"]) is False and path.read_bytes() == before
    assert links.erase(OTHER) is True and links.erase(OTHER) is False


def test_push_subscriptions_made_by_a_member_go_with_them_and_others_stay(tmp_path):
    path = tmp_path / "push.json"
    store = PushStore(path)
    mine = [FCM + "a", FCM + "b"]
    for endpoint in mine:
        store.upsert(subscription(endpoint), rules(), member={"uid": USER["id"], "iat": 1})
    store.upsert(subscription(FCM + "other"), rules(), member={"uid": OTHER, "iat": 1})
    store.upsert(subscription(FCM + "anon"), rules())
    assert store.delete_member(USER["id"]) == 2
    assert all(store.get(e) is None for e in mine)
    assert store.get(FCM + "other") is not None and store.get(FCM + "anon") is not None
    assert USER["id"] not in path.read_text()
    assert store.delete_member(USER["id"]) == 0


# --- DELETE /api/me --------------------------------------------------------------------------------------------------


def setup(tmp_path, perks=None, gate=True):
    links = MemberLinks(tmp_path / "member-links.json")
    push = Dispatcher(PushStore(tmp_path / "push.json"), FakeSender(201), public_key="BKey", check_s=10)
    perks = Perks() if perks is None else perks
    c, _, fake = make(tmp_path, gate=gate, links=links, perks=perks, push=push)
    return c, links, push, perks, fake


def member(c):
    return {**as_member(log_in(c)), **SAME}


def erase(c, headers):
    """DELETE /api/me from a browser with no cookie jar of its own: a repeat carries the cookie it still holds."""
    return c.application.test_client(use_cookies=False).delete("/api/me", headers=headers)


def subscribe(c, headers, endpoint):
    r = c.put("/api/push/subscription", data=body(subscription(endpoint)), content_type="application/json",
              headers=headers)
    assert r.status_code == 204


def test_delete_my_data_removes_everything_held_under_the_members_id(tmp_path):
    c, links, push, perks, _ = setup(tmp_path)
    h = member(c)
    fill(links, USER["id"])
    links.unlink(USER["id"])  # leaves a tombstone ...
    fill(links, USER["id"])  # ... and a link again on top of it
    links.unlink(USER["id"])
    fill(links, USER["id"])
    subscribe(c, h, FCM + "mine")
    fill(links, OTHER, "Other")
    subscribe(c, h, FCM + "mine2")
    r = c.delete("/api/me", headers=h)
    assert r.status_code == 204 and r.get_data() == b"" and r.headers["Cache-Control"] == "no-store"
    assert links.get(USER["id"]) is None and links.unlinked_at(USER["id"]) is not None
    assert links.unlinked_at(USER["id"]) > 0
    assert c.get("/api/me/link", headers=h).status_code in (200, 401)
    assert push.store.get(FCM + "mine") is None and push.store.get(FCM + "mine2") is None
    assert perks.synced == [USER["id"]]
    assert USER["id"] not in (tmp_path / "push.json").read_text()
    assert set(on_disk(tmp_path / "member-links.json")["unlinked"]) == {USER["id"]}
    assert on_disk(tmp_path / "member-links.json")["links"].get(USER["id"]) is None
    assert links.get(OTHER)["username"] == "Other"
    cleared = [x for x in r.headers.getlist("Set-Cookie") if x.startswith(dg.SESSION_COOKIE + "=;")]
    assert cleared and "Max-Age=0" in cleared[0] and "Secure" in cleared[0] and "HttpOnly" in cleared[0]


def test_it_leaves_other_members_rows_and_subscriptions_alone(tmp_path):
    c, links, push, _, _ = setup(tmp_path)
    h = member(c)
    fill(links, OTHER, "Other")
    push.store.upsert(subscription(FCM + "other"), rules(), member={"uid": OTHER, "iat": 1})
    assert c.delete("/api/me", headers=h).status_code == 204
    assert links.get(OTHER)["follows"] == ["nba:7", "nfl:9"]
    assert push.store.get(FCM + "other") is not None
    assert OTHER in (tmp_path / "member-links.json").read_text()


def test_it_is_idempotent_and_a_member_with_nothing_kept_still_gets_204(tmp_path):
    c, links, _, perks, _ = setup(tmp_path)
    h = member(c)
    assert erase(c, h).status_code == 204
    fill(links, USER["id"])
    assert erase(c, h).status_code == 204
    assert erase(c, h).status_code == 204
    assert links.get(USER["id"]) is None
    assert perks.synced == [USER["id"]] * 3  # roles are always asked to be set again: a retry finishes a failed one


def test_it_works_when_the_worker_is_broken(tmp_path):
    c, links, _, _, _ = setup(tmp_path, perks=Perks(error=RuntimeError("queue gone")))
    h = member(c)
    fill(links, USER["id"])
    r = c.delete("/api/me", headers=h)
    assert r.status_code == 204 and links.get(USER["id"]) is None


def test_it_works_while_discord_is_down_and_the_roles_are_taken_back_once_it_is_up(tmp_path):
    """The real worker on a guild that answers nothing, then everything: the erase never waits for Discord."""
    from advisor.discord_perks import PerkWorker

    guild = FakeGuild()
    down = {"on": True}

    def transport(method, url, headers, data):
        if down["on"]:
            raise TimeoutError("discord is down")
        return guild(method, url, headers, data)

    links = MemberLinks(tmp_path / "member-links.json")
    worker = PerkWorker(bot_for(transport), links)
    c, _, _ = make(tmp_path, links=links, perks=worker)
    h = member(c)
    fill(links, USER["id"])
    assert c.delete("/api/me", headers=h).status_code == 204
    assert links.get(USER["id"]) is None
    worker.drain()  # Discord does not answer: nothing breaks, nothing is lost from the queue for good
    down["on"] = False
    worker.bot._wait_until = 0.0
    guild.members[USER["id"]] = []
    worker.request_sync(USER["id"])
    worker.drain()
    assert guild.role_names(USER["id"]) == []


def test_it_works_without_a_perks_worker_or_a_push_dispatcher(tmp_path):
    links = MemberLinks(tmp_path / "member-links.json")
    c, _, _ = make(tmp_path, links=links)
    h = member(c)
    fill(links, USER["id"])
    assert c.delete("/api/me", headers=h).status_code == 204
    assert links.get(USER["id"]) is None


def test_it_is_refused_to_anyone_who_is_not_a_member_and_changes_nothing(tmp_path):
    c, links, push, perks, _ = setup(tmp_path)
    fill(links, USER["id"])
    push.store.upsert(subscription(FCM + "mine"), rules(), member={"uid": USER["id"], "iat": 1})
    r = c.delete("/api/me", headers=SAME)
    assert (r.status_code, r.get_json()) == (401, {"error": "discord_required"})
    forged = c.delete("/api/me", headers={**SAME, "Cookie": f"{dg.SESSION_COOKIE}=forged"})
    assert forged.status_code == 401
    assert links.get(USER["id"]) is not None and push.store.get(FCM + "mine") is not None and perks.synced == []


def test_someone_signed_in_who_left_the_server_can_still_erase_what_we_hold(tmp_path):
    """Delete my data is a right, not a perk: open to anyone signed in with Discord, in our server or not."""
    links = MemberLinks(tmp_path / "member-links.json")
    c, gate, _ = make(tmp_path, links=links, perks=Perks())
    fill(links, USER["id"])
    now = int(gate._clock())
    out = gate._session(USER["id"], "Deal Hunter", now, now, "out")
    who = {**SAME, "Cookie": f"{dg.SESSION_COOKIE}={out}"}
    bare = c.application.test_client(use_cookies=False)
    assert bare.get("/api/me/link", headers=who).status_code == 401  # the perks are a member's
    r = bare.delete("/api/me", headers=who)
    assert r.status_code == 204 and links.get(USER["id"]) is None


def test_another_site_cannot_send_it_and_it_is_rate_limited(tmp_path):
    c, links, _, _, _ = setup(tmp_path)
    h = member(c)
    fill(links, USER["id"])
    cross = {**h, "Sec-Fetch-Site": "cross-site"}
    assert c.delete("/api/me", headers=cross).status_code == 403
    assert links.get(USER["id"]) is not None
    codes = [erase(c, h).status_code for _ in range(25)]
    assert 429 in codes


def test_the_route_does_not_exist_with_the_gate_off(tmp_path):
    c, _, _, _, _ = setup(tmp_path, gate=False)
    assert c.delete("/api/me", headers=SAME).status_code == 404


def test_the_roles_the_bot_gave_are_taken_back_by_the_worker(tmp_path):
    """The real worker, on a scripted guild: after the erase its next round leaves the member with no managed role."""
    from advisor.discord_perks import PerkWorker

    guild = FakeGuild()
    links = MemberLinks(tmp_path / "member-links.json")
    worker = PerkWorker(bot_for(guild), links)
    c, _, _ = make(tmp_path, links=links, perks=worker)
    h = member(c)
    uid = USER["id"]
    guild.members[uid] = []
    fill(links, uid)
    worker.request_sync(uid)
    worker.drain()
    assert "Linked" in guild.role_names(uid)
    assert c.delete("/api/me", headers=h).status_code == 204
    worker.drain()
    assert guild.role_names(uid) == []


# --- GET /privacy ----------------------------------------------------------------------------------------------------


def test_the_notice_is_public_even_behind_the_gate_and_cacheable(tmp_path):
    c, _, _, _, _ = setup(tmp_path)
    r = c.get("/privacy")
    assert r.status_code == 200 and r.mimetype == "text/html"
    assert r.headers["Cache-Control"].startswith("public, max-age=")
    assert "Cookie" not in r.headers.get("Vary", "") and not r.headers.getlist("Set-Cookie")
    tag = r.headers["ETag"]
    assert c.get("/privacy", headers={"If-None-Match": tag}).status_code == 304
    css = c.get("/privacy.css")
    assert css.status_code == 200 and css.mimetype == "text/css" and css.headers["Cache-Control"].startswith("public")


def test_the_notice_works_with_the_gate_off_and_without_a_built_front_end(tmp_path):
    c, _, _, _, _ = setup(tmp_path, gate=False)
    assert c.get("/privacy").status_code == 200
    assert c.head("/privacy").status_code == 200


def test_the_notice_says_what_it_must_in_plain_words(tmp_path):
    c, _, _, _, _ = setup(tmp_path)
    text = c.get("/privacy").get_data(as_text=True)
    flat = " ".join(text.split()).lower()
    for needle in (
        "independent", "not affiliated with, endorsed by or sponsored by real", "discord id", "real username",
        "players you follow", "never ask for your email", "never ask for or see your real password", "no ads",
        "no third-party analytics", "never sell", "30 days", f"{CLICK_KEEP_DAYS} days", f"{PUSH_ROW_TTL_DAYS} days", "hosting provider",
        "delete my data", "aged 13 or over", "last updated", "#feedback", "market data provider",
        "you stay in the discord server", "never what they say", "immediate", "erased",
        "without signing in", "anonymous visit id", "not a cookie", f"{VISIT_KEEP_DAYS} days after its last visit",
        "we never keep your network address", "the visits of this device", "global privacy control",
    ):
        assert needle in flat, needle
    assert "<h1>" in text and 'lang="en"' in text and 'name="viewport"' in text
    assert 'href="/privacy.css"' in text


def test_the_notice_says_plainly_that_members_activity_is_recorded_with_their_discord_account():
    flat = " ".join(privacy.render_page().split()).lower()
    for needle in (
        "recorded with your discord account", "to improve the site", "in our discord server",
        "how many messages you post", "never what they say", "joins, leaves", "the accounts you look up",
        f"{MEMBER_ACTIVITY_KEEP_DAYS} days", f"{ANON_ACTIVITY_KEEP_DAYS} days", "history included",
        "while you are not signed in", "nothing more is recorded under your discord id until you sign in again",
        "your activity on the site and in our discord",
    ):
        assert needle in flat, needle
    assert "we do not build profiles" not in flat and "never your name" not in flat
    assert "we do not keep your email, avatar" not in flat


def test_the_notice_loads_nothing_from_elsewhere_and_has_no_script(tmp_path):
    c, _, _, _, _ = setup(tmp_path)
    text = c.get("/privacy").get_data(as_text=True)
    low = text.lower()
    assert "<script" not in low and "http://" not in low
    assert "src=\"http" not in low and "href=\"http" not in low.replace('href="https://discord', "")


def test_the_retention_in_the_notice_comes_from_the_code():
    flat = " ".join(privacy.render_page().split())
    assert f"{dg.SESSION_MAX_AGE_S // 86400} days" in flat
    assert f"{PUSH_ROW_TTL_DAYS} days" in flat and f"{CLICK_KEEP_DAYS} days" in flat
    assert f"{VISIT_KEEP_DAYS} days after its last visit" in flat
    assert f"{MEMBER_ACTIVITY_KEEP_DAYS} days" in flat and f"{ANON_ACTIVITY_KEEP_DAYS} days" in flat


def test_the_notice_no_longer_claims_no_record_and_no_analytics():
    flat = " ".join(privacy.render_page().split()).lower()
    assert "leaves no record" not in flat and "no ads and no analytics" not in flat
    assert "run no ads and no analytics" not in flat


def test_the_invite_is_linked_when_the_server_has_one(monkeypatch):
    html = privacy.render_page(invite="https://discord.gg/palace")
    assert 'href="https://discord.gg/palace"' in html and 'rel="noopener noreferrer"' in html
    assert "https://discord.gg" not in privacy.render_page(invite=None)


@pytest.mark.parametrize("bad", ['"><script>', "javascript:alert(1)", "http://x"])
def test_an_invite_that_is_not_a_discord_link_is_never_put_in_the_page(bad):
    assert bad not in privacy.render_page(invite=bad)


# --- review fixes ----------------------------------------------------------------------------------------------------


def test_the_session_is_cleared_even_when_the_daily_check_renews_it_on_the_same_request(tmp_path):
    from advisor.discord_gate import RECHECK_AFTER_S
    from tests.test_discord_gate import Clock

    clock = Clock()
    c, _, _ = make(tmp_path, clock=clock, links=MemberLinks(tmp_path / "member-links.json"))
    h = member(c)
    clock.t += RECHECK_AFTER_S + 60  # the gate asks Discord again and would renew the cookie on this request
    r = erase(c, h)
    assert r.status_code == 204
    sessions = [x for x in r.headers.getlist("Set-Cookie") if x.startswith(dg.SESSION_COOKIE + "=")]
    assert sessions and all("Max-Age=0" in x for x in sessions)


def test_a_write_that_fails_is_told_not_hidden_and_a_retry_finishes_the_job(tmp_path, monkeypatch):
    import os

    c, links, push, _, _ = setup(tmp_path)
    h = member(c)
    fill(links, USER["id"])
    push.store.upsert(subscription(FCM + "mine"), rules(), member={"uid": USER["id"], "iat": 1})
    real = os.replace

    def broken(src, dst):
        raise OSError("disk full")

    monkeypatch.setattr("os.replace", broken)
    r = erase(c, h)
    assert r.status_code == 500 and links.get(USER["id"]) is not None  # memory and disk still agree: nothing changed
    assert "Set-Cookie" not in r.headers or not any("Max-Age=0" in x for x in r.headers.getlist("Set-Cookie"))
    monkeypatch.setattr("os.replace", real)
    assert erase(c, h).status_code == 204
    assert USER["id"] not in (tmp_path / "push.json").read_text()
    assert set(on_disk(tmp_path / "member-links.json")["unlinked"]) == {USER["id"]}
    assert on_disk(tmp_path / "member-links.json")["links"].get(USER["id"]) is None
    assert links.get(USER["id"]) is None and push.store.get(FCM + "mine") is None


def test_the_notice_says_what_is_kept_in_memory_about_a_discord_id_and_does_not_promise_alerts_are_off():
    flat = " ".join(privacy.render_page().split()).lower()
    assert "your discord id" in flat and "slash commands" in flat and "in memory" in flat
    assert "off at the moment" not in flat
