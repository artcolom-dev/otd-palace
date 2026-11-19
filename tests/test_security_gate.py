"""Attacks on the login, the session and the routes' gate, one test each (see the internal research notes).

Every test is an attacker's move: it fails when the move works. Discord is a scripted fake and nothing reaches the
network."""

import json
from urllib.parse import quote

import pytest

from advisor import discord_gate as dg
from advisor.importer import Imported
from advisor.members import MemberLinks, _year
from advisor.push import Dispatcher, PushStore
from advisor.visits import VisitLog
from tests.test_discord_gate import ENV, USER, Clock, FakeDiscord
from tests.test_gate_web import as_member, cookies_of, log_in, make
from tests.test_push import FakeSender
from tests.test_link_web import Importer, Perks, SAME, setup


def bare(c):
    """A browser with an empty cookie jar: only the cookies a test names are sent."""
    return c.application.test_client(use_cookies=False)


def sees_the_whole_market(r) -> bool:
    """Whether a /api/snapshot answer is a member's (the whole snapshot), not the free site's (which says `locked`)."""
    return r.status_code == 200 and "locked" not in r.get_json()

# --- auth: where the visitor lands after the login --------------------------------------------------------------


@pytest.mark.parametrize("given", [
    "//evil.example", "/\\evil.example", "/%2f%2fevil.example", "/%5cevil.example", "https://evil.example",
    "javascript:alert(1)", "/\r\nSet-Cookie: x=1", "/\nLocation: https://evil.example", "/\t/evil.example",
    "\\\\evil.example", "/ /evil.example", "///evil.example", "/∕evil.example", "evil.example",
])
def test_no_next_value_ever_leaves_the_site(given):
    assert dg.safe_next(given) in ("/", given) and (dg.safe_next(given) == "/" or dg.safe_next(given).startswith("/"))
    kept = dg.safe_next(given)
    assert not kept.startswith(("//", "/\\")) and "\n" not in kept and "\r" not in kept


def test_a_login_through_a_hostile_next_lands_on_the_home_page(tmp_path):
    c, _, _ = make(tmp_path)
    for hostile in ("//evil.example/x", "/\\evil.example", "/%0d%0aX-Evil: 1"):
        start = c.get(f"/auth/discord?next={quote(hostile, safe='')}")
        state = cookies_of(start)[dg.STATE_COOKIE].value
        from urllib.parse import parse_qs, urlsplit
        wanted = parse_qs(urlsplit(start.headers["Location"]).query)["state"][0]
        back = c.get(f"/auth/discord/callback?code=abc&state={wanted}", headers={"Cookie": f"{dg.STATE_COOKIE}={state}"})
        location = back.headers["Location"]
        assert location.startswith("/") and not location.startswith("//") and "\\" not in location
        assert "evil" not in location or location.startswith("/%0d")


# --- auth: the login cookies ----------------------------------------------------------------------------------------


def test_the_login_and_session_cookies_obey_the_host_prefix_rules(tmp_path):
    c, _, _ = make(tmp_path)
    start = c.get("/auth/discord")
    morsel = cookies_of(start)[dg.STATE_COOKIE]
    for header in start.headers.getlist("Set-Cookie"):
        assert header.startswith("__Host-") and "Secure" in header and "HttpOnly" in header
        assert "Path=/" in header and "Domain" not in header and "SameSite=Lax" in header
    assert morsel["max-age"] == str(dg.STATE_MAX_AGE_S)


def test_the_login_cookie_is_no_session_and_a_session_is_no_login(tmp_path):
    c, gate, _ = make(tmp_path)
    c = bare(c)
    start = c.get("/auth/discord")
    login = cookies_of(start)[dg.STATE_COOKIE].value
    as_session = c.get("/api/me", headers={"Cookie": f"{dg.SESSION_COOKIE}={login}"})
    assert as_session.get_json()["member"] is False
    session = log_in(c)
    from urllib.parse import parse_qs, urlsplit
    state = parse_qs(urlsplit(c.get("/auth/discord").headers["Location"]).query)["state"][0]
    back = c.get(f"/auth/discord/callback?code=abc&state={state}", headers={"Cookie": f"{dg.STATE_COOKIE}={session}"})
    assert back.status_code == 400


def test_a_state_from_another_browser_logs_nobody_in(tmp_path):
    """Login CSRF: the attacker's own state and code, sent to the victim's browser (which holds another state)."""
    from urllib.parse import parse_qs, urlsplit
    c, _, fake = make(tmp_path)
    c = bare(c)
    attacker = c.get("/auth/discord")
    attacker_state = parse_qs(urlsplit(attacker.headers["Location"]).query)["state"][0]
    victim = c.get("/auth/discord")  # the victim's browser has its own login cookie
    victim_cookie = cookies_of(victim)[dg.STATE_COOKIE].value
    back = c.get(f"/auth/discord/callback?code=attackers&state={attacker_state}",
                 headers={"Cookie": f"{dg.STATE_COOKIE}={victim_cookie}"})
    assert back.status_code == 400 and dg.SESSION_COOKIE not in cookies_of(back)
    assert not any("oauth2/token" in call[1] for call in fake.calls)  # the code was never even traded


def test_a_session_signed_with_another_secret_or_tampered_with_is_nobody(tmp_path):
    c, gate, _ = make(tmp_path)
    session = log_in(c)
    c = bare(c)
    other = dg.DiscordGate(dg.config_from_env({**ENV, "ADVISOR_SESSION_SECRET": "another-secret-0123456789abcdefghijklmnop"}),
                           clock=gate._clock)
    forged = other._dumps(other._serializer, {"uid": USER["id"], "name": "x", "iat": 1_800_000_000, "checked_at": 1_800_000_000})
    assert c.get("/api/me", headers=as_member(forged)).get_json()["member"] is False
    head, _, tail = session.rpartition(".")
    for broken in (head + "." + tail[:-2] + ("AA" if tail[-2:] != "AA" else "BB"), session[:-1], "." + session, session + "x"):
        assert c.get("/api/me", headers=as_member(broken)).get_json()["member"] is False


def test_a_session_for_a_non_snowflake_or_with_odd_field_types_is_refused(tmp_path):
    c, gate, _ = make(tmp_path)
    now = int(gate._clock())
    for payload in ({"uid": "1", "name": "x", "iat": now, "checked_at": now},
                    {"uid": USER["id"], "name": "x", "iat": True, "checked_at": now},
                    {"uid": USER["id"], "name": "x", "iat": float(now), "checked_at": now},
                    {"uid": USER["id"], "name": 5, "iat": now, "checked_at": now},
                    {"uid": 5, "name": "x", "iat": now, "checked_at": now},
                    {"uid": USER["id"], "name": "x", "iat": now, "checked_at": now, "state": "admin"},
                    {"uid": USER["id"], "name": "x", "iat": now, "checked_at": now, "state": ["in"]}):
        cookie = gate._dumps(gate._serializer, payload)
        assert not sees_the_whole_market(c.get("/api/snapshot", headers=as_member(cookie)))
        assert c.get("/api/me", headers=as_member(cookie)).get_json()["member"] is False


def test_the_first_login_fails_closed_when_discord_is_down(tmp_path):
    from urllib.parse import parse_qs, urlsplit
    c, _, _ = make(tmp_path, fake=FakeDiscord(token=TimeoutError("down")))
    start = c.get("/auth/discord")
    state = parse_qs(urlsplit(start.headers["Location"]).query)["state"][0]
    back = c.get(f"/auth/discord/callback?code=abc&state={state}",
                 headers={"Cookie": f"{dg.STATE_COOKIE}={cookies_of(start)[dg.STATE_COOKIE].value}"})
    assert back.status_code == 502 and dg.SESSION_COOKIE not in cookies_of(back)


def test_a_member_who_left_loses_access_after_the_daily_check_even_while_discord_flaps(tmp_path):
    clock = Clock()
    c, gate, fake = make(tmp_path, clock=clock)
    session = log_in(c)
    clock.t += dg.RECHECK_AFTER_S + 1
    fake.script["member"] = (404, {})
    r = c.get("/api/snapshot", headers=as_member(session))
    assert r.status_code == 200 and not sees_the_whole_market(r)
    fake.script["member"] = (200, {})  # even if the old cookie is sent again, the answer "gone" is remembered a while
    assert not sees_the_whole_market(c.get("/api/snapshot", headers=as_member(session)))


# --- the gate covers every route that holds market or member data --------------------------------------------------

PUBLIC = {  # the front door and the free site: no member's data, and the market only as the free site's snapshot
    "/", "/assets/<path:name>", "/<name>", "/error.css", "/healthz", "/api/out", "/api/visit", "/api/events", "/api/stats",
    "/api/teaser",
    "/api/me", "/api/push/subscription", "/auth/discord", "/auth/discord/callback", "/auth/logout", "/auth/recheck",
    "/auth/handoff", "/auth/handoff/claim",
    "/api/snapshot",
    "/discord/interactions", "/privacy", "/privacy.css", "/share.css", "/share.js", "/d/<listing>", "/d/<listing>/card.svg",
    "/a/<username>", "/img/players/<sport>/<int:player_id>", "/.well-known/security.txt",
    "/deals", "/prices", "/passes", "/plan", "/sitemap.xml",  # the views' own addresses (the page, like "/") and their list
}
MEMBERS = {"/api/passes/import", "/api/push/key", "/api/push/test", "/api/me/link"}
ADMIN = {"/admin", "/api/admin/stats", "/api/admin/members.csv", "/api/admin/member/<uid>",  # tighter still: the ids in
         "/api/admin/<any(members, accounts, features, sources, discord):name>"}  # ADVISOR_ADMIN_DISCORD_IDS only
# A rule whose literal text is no path it answers, asked at a path it does answer.
SAMPLE = {"/api/admin/<any(members, accounts, features, sources, discord):name>": "/api/admin/members"}


def test_every_route_is_either_on_the_public_list_or_closed_to_non_members(tmp_path):
    from advisor.discord_commands import Interactions, config_from_env as commands_config
    from advisor.activity import ActivityLog
    from advisor.store import SnapshotStore
    dispatcher = Dispatcher(PushStore(tmp_path / "push.json"), FakeSender(201), public_key="BKey", check_s=10)
    links = MemberLinks(tmp_path / "m.json")
    c, _, _ = make(tmp_path, importer=Importer(), push=dispatcher, links=links, stats_token="s" * 32,
                   visits=VisitLog(tmp_path / "v.json"), admin_ids=frozenset({"999988887777666655"}),
                   activity=ActivityLog(None),
                   interactions=Interactions(commands_config({**ENV, "ADVISOR_DISCORD_PUBLIC_KEY": "ab" * 32}), SnapshotStore()))
    unknown = []
    for rule in c.application.url_map.iter_rules():
        if rule.rule in PUBLIC:
            continue
        if rule.rule not in MEMBERS | ADMIN:
            unknown.append(rule.rule)
            continue
        for method in sorted(rule.methods - {"HEAD", "OPTIONS"}):
            assert c.open(SAMPLE.get(rule.rule, rule.rule), method=method).status_code == 401, (method, rule.rule)
    assert unknown == []


def test_the_member_routes_refuse_a_session_that_is_not_in_the_server(tmp_path):
    """Signed in with Discord is not enough: out of the server (left, or the join failed) or refused by it, every
    member route still answers 401, and the snapshot is the free site's."""
    dispatcher = Dispatcher(PushStore(tmp_path / "push.json"), FakeSender(201), public_key="BKey", check_s=10)
    links = MemberLinks(tmp_path / "m.json")
    for join, state in (((400, {"code": 30001}), "out"), ((403, {}), "banned")):
        c, gate, _ = make(tmp_path, fake=FakeDiscord(join=join), importer=Importer(), push=dispatcher, links=links)
        c = bare(c)
        from urllib.parse import parse_qs, urlsplit
        start = c.get("/auth/discord")
        wanted = parse_qs(urlsplit(start.headers["Location"]).query)["state"][0]
        back = c.get(f"/auth/discord/callback?code=abc&state={wanted}",
                     headers={"Cookie": f"{dg.STATE_COOKIE}={cookies_of(start)[dg.STATE_COOKIE].value}"})
        session = cookies_of(back)[dg.SESSION_COOKIE].value
        assert gate.read_session(session)["state"] == state
        who = {**as_member(session), "Sec-Fetch-Site": "same-origin"}
        for method, path in (("GET", "/api/passes/import?u=kept"), ("GET", "/api/push/key"), ("POST", "/api/push/test"),
                             ("PUT", "/api/push/subscription"), ("GET", "/api/me/link"), ("POST", "/api/me/link"),
                             ("PATCH", "/api/me/link"), ("DELETE", "/api/me/link")):
            r = c.open(path, method=method, headers=who, data=b"{}", content_type="application/json")
            assert r.status_code == 401, (state, method, path)
        assert not sees_the_whole_market(c.get("/api/snapshot", headers=who))


def test_head_and_options_leak_nothing_and_grant_no_cross_origin_reads(tmp_path):
    c, _, _ = make(tmp_path)
    head = c.head("/api/snapshot")
    assert head.status_code == 200 and head.headers["ETag"].endswith('p"') and not head.get_data()
    for path in ("/api/snapshot", "/api/me", "/api/me/link", "/"):
        r = c.options(path, headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
        assert "Access-Control-Allow-Origin" not in r.headers and not r.get_data()
    for path in ("/api/snapshot", "/api/me", "/", "/d/101", "/a/someone"):
        r = c.get(path, headers={"Origin": "https://evil.example"})
        assert "Access-Control-Allow-Origin" not in r.headers


def test_verb_tunnelling_headers_do_not_turn_a_get_into_a_write(tmp_path):
    c, _, _ = make(tmp_path, links=MemberLinks(tmp_path / "m.json"), importer=Importer())
    session = as_member(log_in(c))
    for header in ("X-HTTP-Method-Override", "X-Method-Override", "X-HTTP-Method"):
        r = c.get("/api/me/link", headers={**session, header: "DELETE"})
        assert r.status_code == 200
    assert c.get("/api/me/link?_method=DELETE", headers=session).status_code == 200


def test_personalised_answers_are_never_cached_for_someone_else(tmp_path):
    links = MemberLinks(tmp_path / "m.json")
    c, _, _ = make(tmp_path, links=links, importer=Importer())
    member = {**as_member(log_in(c)), "Accept-Encoding": "gzip"}
    for path in ("/api/me", "/api/me/link", "/api/snapshot", "/", "/d/101", "/a/someone", "/d/101/card.svg"):
        r = c.get(path, headers=member)
        control = r.headers.get("Cache-Control", "")
        assert "public" not in control and "max-age" not in control.replace("max-age=0", ""), (path, control)
        varies = {v.strip().lower() for v in r.headers.get("Vary", "").split(",")}
        if path in ("/api/snapshot", "/", "/d/101", "/a/someone"):
            assert "cookie" in varies, (path, r.headers.get("Vary"))
            assert "private" in control or "no-store" in control, (path, control)




# --- where to report a problem ------------------------------------------------------------------------------------


def test_security_txt_points_to_the_discord_server_and_invents_no_address(tmp_path, monkeypatch):
    from advisor import rules
    monkeypatch.setattr(rules, "COMMUNITY_URL", "https://discord.gg/palace")
    c, _, _ = make(tmp_path)
    r = c.get("/.well-known/security.txt")
    text = r.get_data(as_text=True)
    assert r.status_code == 200 and r.mimetype == "text/plain"
    assert "Contact: https://discord.gg/palace" in text and "#feedback" in text
    assert "@" not in text.replace("#feedback", "") and "mailto:" not in text
    assert "Expires: " in text and "Canonical: " not in text


def test_security_txt_is_absent_while_there_is_no_server_to_point_to(tmp_path, monkeypatch):
    from advisor import rules
    monkeypatch.setattr(rules, "COMMUNITY_URL", None)
    c, _, _ = make(tmp_path)
    assert c.get("/.well-known/security.txt").status_code == 404


# --- a weak or reused session secret ------------------------------------------------------------------------------


@pytest.mark.parametrize("secret", ["a" * 40, "0123456789" * 4, "abababababababababababababababab", "A1" * 20])
def test_a_long_but_guessable_session_secret_is_refused(secret):
    problem = dg.config_problem({**ENV, "ADVISOR_SESSION_SECRET": secret})
    assert problem is not None and "ADVISOR_SESSION_SECRET" in problem and secret not in problem


@pytest.mark.parametrize("other", ["ADVISOR_DISCORD_CLIENT_SECRET", "ADVISOR_DISCORD_BOT_TOKEN"])
def test_the_session_secret_must_not_be_another_secret_reused(other):
    problem = dg.config_problem({**ENV, "ADVISOR_SESSION_SECRET": ENV[other]})
    assert problem is not None and "ADVISOR_SESSION_SECRET" in problem and ENV[other] not in problem


def test_a_random_secret_the_readme_way_is_accepted():
    import secrets
    assert dg.config_problem({**ENV, "ADVISOR_SESSION_SECRET": secrets.token_urlsafe(48)}) is None


# --- a removed member cannot keep the site by asking in parallel ----------------------------------------------------


def test_parallel_requests_of_a_removed_member_are_all_turned_away():
    import threading
    import time as _time
    from tests.test_discord_gate import gate as make_gate

    class Slow(FakeDiscord):
        def __call__(self, method, url, headers, body):
            if method == "GET" and "/members/" in url:
                _time.sleep(0.3)
            return super().__call__(method, url, headers, body)

    clock = Clock()
    g, fake = make_gate(Slow(), clock)
    now = int(clock())
    cookie = g._dumps(g._serializer, {"uid": USER["id"], "name": "x", "iat": now, "checked_at": now})
    clock.t += dg.RECHECK_AFTER_S + 1
    fake.script["member"] = (404, {})
    results = []
    threads = [threading.Thread(target=lambda: results.append(g.visitor(cookie).member)) for _ in range(3)]
    threads += [threading.Thread(target=lambda: results.append(g.recheck(cookie).member)) for _ in range(3)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert results == [False] * 6
