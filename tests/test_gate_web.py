"""The Discord gate seen from the web: the free site anyone gets, what stays for members, the login routes, the
states of someone signed in (in our server, out of it, refused by it), /api/me and /api/teaser.

Discord is the scripted fake of test_discord_gate; the cookies are sent and read by hand, as a browser on https would.
"""

import json
from http.cookies import SimpleCookie
from urllib.parse import parse_qs, quote, urlsplit

import pytest

from advisor import discord_gate as dg
from advisor.importer import Imported
from advisor.push import Dispatcher, PushStore
from advisor.store import SnapshotStore
from advisor.web import create_app
from tests.test_discord_gate import ENV, USER, Clock, FakeDiscord
from tests.test_push import FakeSender, body, subscription
from tests.test_share import deal

HTML = "<html><body><div id=root></div><!--SNAPSHOT--></body></html>"
SNAPSHOT_TAG = '<script id="snapshot" type="application/json">'
INVITE = "https://discord.gg/palace"
SNAP = {
    "version": 3,
    "generated_at": "2026-11-16T12:00:00Z",
    "sports": ["nba", "nfl", "mlb"],
    # 102 is a deal the New level does not show (medium confidence): never on the free site, members only.
    "deals": [deal(101, discount=0.342), deal(102, sport="nfl", discount=0.381, player_name="Secret Name",
                                              confidence="medium"),
              deal(103, sport="nba", discount=0.25)],
    "gone": [],
    "levels": {},
    "rules": {"demo": False},
}


class FakeImporter:
    def __init__(self):
        self.asked = []

    def lookup(self, username):
        self.asked.append(username)
        return Imported("ok", "Kept", ({"key": "nba:2026:player:1", "rating": 1.0},), False)

    def cached(self, username):
        return Imported("ok", "Kept", tuple({"key": f"nba:2026:player:{i}", "rating": 1.0} for i in range(42)), False)


def make(tmp_path, gate=True, snap=SNAP, fake=None, clock=None, **kw):
    (tmp_path / "index.html").write_text(HTML)
    store = SnapshotStore()
    if snap is not None:
        store.publish(snap)
    clock = clock or Clock()
    fake = fake or FakeDiscord()
    the_gate = None
    if gate:
        config = dg.config_from_env(ENV)
        the_gate = dg.DiscordGate(config, dg.DiscordClient(config, transport=fake), clock=clock, invite_url=INVITE)
    app = create_app(store, tmp_path, gate=the_gate, **kw)
    return app.test_client(), the_gate, fake


def cookies_of(response) -> dict[str, SimpleCookie]:
    found = {}
    for header in response.headers.getlist("Set-Cookie"):
        jar = SimpleCookie()
        jar.load(header)
        for name, morsel in jar.items():
            found[name] = morsel
    return found


def log_in(c, next_path="/"):
    """Goes through the login like a browser: the start, Discord's yes, the callback. The session cookie's value."""
    start = c.get(f"/auth/discord?next={quote(next_path, safe='')}")
    state = parse_qs(urlsplit(start.headers["Location"]).query)["state"][0]
    login_cookie = cookies_of(start)[dg.STATE_COOKIE].value
    back = c.get(f"/auth/discord/callback?code=abc&state={state}",
                 headers={"Cookie": f"{dg.STATE_COOKIE}={login_cookie}"})
    assert back.status_code == 302, back.get_data(as_text=True)
    return cookies_of(back)[dg.SESSION_COOKIE].value


def as_member(session):
    return {"Cookie": f"{dg.SESSION_COOKIE}={session}"}


# --- what the gate closes -------------------------------------------------------------------------------------------


def test_a_visitor_gets_the_free_snapshot_never_the_whole_one(tmp_path):
    c, _, _ = make(tmp_path)
    r = c.get("/api/snapshot")
    assert r.status_code == 200 and r.headers["ETag"] == '"3p"'
    free = r.get_json()
    assert [row["listing_id"] for row in free["deals"]] == [101]  # the best of the New level, one per player-season
    assert free["locked"]["deals"] == 3 and "Secret Name" not in r.get_data(as_text=True)
    assert "no-cache" in r.headers["Cache-Control"] and "cookie" in r.headers["Vary"].lower()
    # A member's tag never gets a visitor a 304, and a visitor's tag never gets a member one.
    assert c.get("/api/snapshot", headers={"If-None-Match": '"3"'}).status_code == 200
    assert c.get("/api/snapshot", headers={"If-None-Match": '"3p"'}).status_code == 304


def test_a_member_gets_the_whole_snapshot(tmp_path):
    c, _, _ = make(tmp_path)
    session = log_in(c)
    r = c.get("/api/snapshot", headers=as_member(session))
    assert r.status_code == 200 and r.get_json()["version"] == 3 and r.headers["ETag"] == '"3"'
    assert "locked" not in r.get_json() and len(r.get_json()["deals"]) == 3
    assert c.get("/api/snapshot", headers={**as_member(session), "If-None-Match": '"3p"'}).status_code == 200


def test_the_account_lookup_and_the_alerts_are_closed_too_but_unsubscribing_never_is(tmp_path):
    dispatcher = Dispatcher(PushStore(tmp_path / "push.json"), FakeSender(201), public_key="BKey", check_s=10)
    importer = FakeImporter()
    c, _, _ = make(tmp_path, importer=importer, push=dispatcher)
    closed = [
        c.get("/api/passes/import?u=kept"),
        c.get("/api/push/key"),
        c.put("/api/push/subscription", data=body(subscription()), content_type="application/json"),
        c.post("/api/push/test", data=json.dumps({"endpoint": subscription()["endpoint"]}),
               content_type="application/json"),
    ]
    for r in closed:
        assert (r.status_code, r.get_json()) == (401, {"error": "discord_required"}), r.request.path
    assert importer.asked == []
    gone = c.delete("/api/push/subscription", data=json.dumps({"endpoint": subscription()["endpoint"]}),
                    content_type="application/json")
    assert gone.status_code == 204
    session = log_in(c)
    assert c.get("/api/push/key", headers=as_member(session)).status_code == 200
    put = c.put("/api/push/subscription", data=body(subscription()), content_type="application/json",
                headers=as_member(session))
    assert put.status_code == 204
    assert dispatcher.store.get(subscription()["endpoint"])["member"] == {"uid": USER["id"], "iat": 1_800_000_000}
    assert c.get("/api/passes/import?u=kept", headers=as_member(session)).status_code == 200


def test_a_visitors_page_carries_the_free_snapshot_and_the_gate_mark(tmp_path):
    c, _, _ = make(tmp_path)
    page = c.get("/").get_data(as_text=True)
    assert SNAPSHOT_TAG in page and '"locked":' in page and "Secret Name" not in page
    assert '<script id="me" type="application/json">{"gate":true,"member":false,"state":"anon"}</script>' in page


def test_the_front_door_carries_a_link_preview_with_our_picture_for_anyone_who_pastes_the_link(tmp_path):
    c, gate, _ = make(tmp_path)
    (tmp_path / "index.html").write_text("<html><head><!--PREVIEW--></head><body><!--SNAPSHOT--></body></html>")
    page = c.get("/").get_data(as_text=True)
    assert f'<meta property="og:image" content="{gate.public_url}/og.png">' in page
    assert 'name="twitter:card" content="summary_large_image"' in page
    assert "Secret Name" not in page  # a link preview names no deal and no player
    assert "<!--PREVIEW-->" not in page


def test_a_members_page_carries_the_market_and_says_member_without_naming_them(tmp_path):
    c, _, _ = make(tmp_path)
    session = log_in(c)
    page = c.get("/", headers=as_member(session)).get_data(as_text=True)
    assert SNAPSHOT_TAG in page and "Secret Name" in page and '"locked":' not in page
    assert '<script id="me" type="application/json">{"gate":true,"member":true,"state":"in"}</script>' in page
    assert USER["global_name"] not in page  # one cached page for every member; the name comes from /api/me


def test_an_account_preview_says_no_count_of_passes_to_a_visitor(tmp_path):
    c, _, _ = make(tmp_path, importer=FakeImporter())
    page = c.get("/a/kept").get_data(as_text=True)
    assert "42 passes" not in page and "/#account/Kept" in page
    session = log_in(c)
    assert "42 passes" in c.get("/a/kept", headers=as_member(session)).get_data(as_text=True)


# --- what stays public ----------------------------------------------------------------------------------------------


def test_the_front_door_and_the_acquisition_pages_stay_open(tmp_path):
    c, _, _ = make(tmp_path)
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "index-abc.js").write_text("console.log(1)")
    (tmp_path / "favicon.svg").write_text("<svg/>")
    for path in ("/", "/healthz", "/assets/index-abc.js", "/favicon.svg", "/d/101", "/d/101/card.svg",
                 "/share.css", "/share.js", "/error.css", "/api/teaser", "/api/me"):
        assert c.get(path).status_code == 200, path
    assert c.get("/img/players/nba/22").status_code in (200, 204)
    assert c.post("/api/out", data=b"{}", content_type="application/json").status_code == 204


def test_a_shared_deals_way_to_more_deals_says_what_discord_adds(tmp_path):
    c, _, _ = make(tmp_path)
    page = c.get("/d/101").get_data(as_text=True)
    assert "Nikola Jokić" in page  # the preview stays
    assert "Browsing is free" in page and "with Discord" in page
    session = log_in(c)
    member_page = c.get("/d/101", headers=as_member(session)).get_data(as_text=True)
    assert "Browsing is free" not in member_page


# --- /api/me and /api/teaser ----------------------------------------------------------------------------------------


def test_me_says_gate_and_member_and_is_never_kept(tmp_path):
    c, _, _ = make(tmp_path)
    r = c.get("/api/me")
    assert r.get_json() == {"gate": True, "member": False, "state": "anon", "name": None}
    assert r.headers["Cache-Control"] == "no-store"
    session = log_in(c)
    assert c.get("/api/me", headers=as_member(session)).get_json() == {
        "gate": True, "member": True, "state": "in", "name": "Deal Hunter"}


def test_the_teaser_counts_without_naming_or_pricing_anything(tmp_path):
    c, _, _ = make(tmp_path)
    r = c.get("/api/teaser")
    assert r.get_json() == {"deals": 3, "sports": 2, "best_pct": 38, "generated_at": "2026-11-16T12:00:00Z"}
    assert r.headers["Cache-Control"] == "public, max-age=60"
    text = r.get_data(as_text=True)
    assert "Secret Name" not in text and "101" not in text and "150" not in text


def test_the_teaser_before_the_first_snapshot_has_nothing_to_count_and_is_not_kept(tmp_path):
    c, _, _ = make(tmp_path, snap=None)
    r = c.get("/api/teaser")
    assert r.get_json() == {"deals": 0, "sports": 0, "best_pct": None, "generated_at": None}
    assert r.headers["Cache-Control"] == "no-store"


# --- the login routes -----------------------------------------------------------------------------------------------


def test_the_login_starts_with_a_redirect_to_discord_and_a_short_lived_strict_cookie(tmp_path):
    c, _, _ = make(tmp_path)
    r = c.get("/auth/discord?next=%2F%23deals")
    assert r.status_code == 302
    parts = urlsplit(r.headers["Location"])
    assert (parts.netloc, parts.path) == ("discord.com", "/oauth2/authorize")
    query = parse_qs(parts.query)
    assert query["scope"] == ["identify guilds.join"] and query["response_type"] == ["code"]
    assert query["redirect_uri"] == ["https://palace.example.test/auth/discord/callback"]
    morsel = cookies_of(r)[dg.STATE_COOKIE]
    assert morsel["httponly"] and morsel["secure"] and morsel["samesite"] == "Lax"
    assert morsel["max-age"] == str(dg.STATE_MAX_AGE_S) and morsel["path"] == "/"
    assert r.headers["Cache-Control"] == "no-store"


def test_a_successful_login_sets_the_session_and_goes_back_where_the_visitor_was(tmp_path):
    c, _, _ = make(tmp_path)
    start = c.get("/auth/discord?next=%2F%23deals")
    state = parse_qs(urlsplit(start.headers["Location"]).query)["state"][0]
    login_cookie = cookies_of(start)[dg.STATE_COOKIE].value
    r = c.get(f"/auth/discord/callback?code=abc&state={state}", headers={"Cookie": f"{dg.STATE_COOKIE}={login_cookie}"})
    assert (r.status_code, r.headers["Location"]) == (302, "/#deals")
    jar = cookies_of(r)
    session = jar[dg.SESSION_COOKIE]
    assert session["httponly"] and session["secure"] and session["samesite"] == "Lax"
    assert session["max-age"] == str(dg.SESSION_MAX_AGE_S)
    assert jar[dg.STATE_COOKIE]["max-age"] == "0"  # the login cookie is used up


def test_a_next_that_points_off_the_site_goes_home(tmp_path):
    c, _, _ = make(tmp_path)
    for bad in ("//evil.example", "https://evil.example", "/\\evil.example"):
        start = c.get(f"/auth/discord?next={quote(bad, safe='')}")
        state = parse_qs(urlsplit(start.headers["Location"]).query)["state"][0]
        login_cookie = cookies_of(start)[dg.STATE_COOKIE].value
        r = c.get(f"/auth/discord/callback?code=abc&state={state}",
                  headers={"Cookie": f"{dg.STATE_COOKIE}={login_cookie}"})
        assert r.headers["Location"] == "/", bad


@pytest.mark.parametrize(
    "fake, query, status, words, after",
    [
        (FakeDiscord(), "error=access_denied", 400, "You said no on Discord", None),
        (FakeDiscord(), "code=abc&state=wrong", 400, "took too long or was opened twice", None),
        (FakeDiscord(join=(400, {"code": 30001})), "code=abc", 403, "100 servers", "out"),
        (FakeDiscord(join=(500, {})), "code=abc", 502, "Discord did not answer", "out"),
        (FakeDiscord(token=(500, {})), "code=abc", 502, "Discord did not answer", None),
    ],
)
def test_a_failed_login_explains_itself_with_a_try_again_and_the_invite(tmp_path, fake, query, status, words, after):
    c, _, _ = make(tmp_path, fake=fake)
    start = c.get("/auth/discord?next=%2F")
    state = parse_qs(urlsplit(start.headers["Location"]).query)["state"][0]
    login_cookie = cookies_of(start)[dg.STATE_COOKIE].value
    if "state=" not in query:
        query += f"&state={state}"
    r = c.get(f"/auth/discord/callback?{query}", headers={"Cookie": f"{dg.STATE_COOKIE}={login_cookie}"})
    page = r.get_data(as_text=True)
    assert r.status_code == status and r.mimetype == "text/html"
    assert words in page
    assert 'href="/auth/discord?next=%2F"' in page and "Try again" in page
    assert f'href="{INVITE}"' in page and "Keep browsing, free" in page
    if after is None:  # Discord never said who they are: nobody is signed in
        assert dg.SESSION_COOKIE not in cookies_of(r)
    else:  # they are who they say, but not in our server: signed in, the free site, and the way in again
        session = cookies_of(r)[dg.SESSION_COOKIE].value
        assert c.get("/api/me", headers=as_member(session)).get_json()["state"] == after
        assert c.get("/api/passes/import?u=x", headers=as_member(session)).status_code == 401
    assert r.headers["Cache-Control"] == "no-store"
    assert "<script" not in page  # the CSP allows no inline script; the page needs none


def test_a_refused_join_signs_in_as_banned_with_no_way_round_the_refusal(tmp_path):
    c, _, _ = make(tmp_path, fake=FakeDiscord(join=(403, {"code": 40007})), importer=FakeImporter())
    start = c.get("/auth/discord?next=%2F")
    state = parse_qs(urlsplit(start.headers["Location"]).query)["state"][0]
    r = c.get(f"/auth/discord/callback?code=abc&state={state}",
              headers={"Cookie": f"{dg.STATE_COOKIE}={cookies_of(start)[dg.STATE_COOKIE].value}"})
    page = r.get_data(as_text=True)
    assert r.status_code == 403 and "add this account to the OTD Palace server" in page
    assert "Try again" not in page and "/auth/discord" not in page and INVITE not in page  # no loop
    assert 'href="/"' in page and "Keep browsing, free" in page
    session = cookies_of(r)[dg.SESSION_COOKIE].value
    assert c.get("/api/me", headers=as_member(session)).get_json() == {
        "gate": True, "member": False, "state": "banned", "name": "Deal Hunter"}
    assert "locked" in c.get("/api/snapshot", headers=as_member(session)).get_json()
    assert c.get("/api/passes/import?u=kept", headers=as_member(session)).status_code == 401
    page = c.get("/", headers=as_member(session)).get_data(as_text=True)
    assert '{"gate":true,"member":false,"state":"banned"}' in page and "Secret Name" not in page


def test_logout_clears_the_session_and_answers_204(tmp_path):
    c, _, _ = make(tmp_path)
    session = log_in(c)
    r = c.post("/auth/logout", headers={**as_member(session), "Sec-Fetch-Site": "same-origin"})
    assert r.status_code == 204
    assert cookies_of(r)[dg.SESSION_COOKIE]["max-age"] == "0"
    assert c.post("/auth/logout", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403


def test_the_login_routes_are_rate_limited_per_address(tmp_path):
    c, _, _ = make(tmp_path)
    answers = [c.get("/auth/discord").status_code for _ in range(dg.AUTH_PER_MIN + 1)]
    assert answers[:-1] == [302] * dg.AUTH_PER_MIN and answers[-1] == 429


def test_a_member_who_left_the_server_keeps_the_free_site_and_stays_signed_in_as_out(tmp_path):
    clock = Clock()
    fake = FakeDiscord()
    c, gate, _ = make(tmp_path, fake=fake, clock=clock, importer=FakeImporter())
    session = log_in(c)
    fake.script["member"] = (404, {})
    clock.t += dg.RECHECK_AFTER_S + 1
    r = c.get("/api/snapshot", headers=as_member(session))
    assert r.status_code == 200 and "locked" in r.get_json() and "Secret Name" not in r.get_data(as_text=True)
    out = cookies_of(r)[dg.SESSION_COOKIE].value
    assert gate.read_session(out)["state"] == "out"
    assert c.get("/api/passes/import?u=kept", headers=as_member(out)).get_json() == {"error": "discord_required"}
    assert c.get("/api/me", headers=as_member(out)).get_json()["state"] == "out"


def test_check_again_after_joining_by_the_invite_unlocks_at_once(tmp_path):
    clock = Clock()
    fake = FakeDiscord(join=(400, {"code": 30001}))  # the join failed: signed in, not in the server
    c, gate, _ = make(tmp_path, fake=fake, clock=clock)
    start = c.get("/auth/discord?next=%2F")
    state = parse_qs(urlsplit(start.headers["Location"]).query)["state"][0]
    r = c.get(f"/auth/discord/callback?code=abc&state={state}",
              headers={"Cookie": f"{dg.STATE_COOKIE}={cookies_of(start)[dg.STATE_COOKIE].value}"})
    out = as_member(cookies_of(r)[dg.SESSION_COOKIE].value)
    fake.script["member"] = (404, {})
    same = {**out, "Sec-Fetch-Site": "same-origin"}
    assert c.post("/auth/recheck", headers=same).get_json() == {"member": False, "state": "out"}
    fake.script["member"] = (200, {})  # they joined by the invite
    clock.t += dg.RECHECK_MIN_S + 1
    r = c.post("/auth/recheck", headers=same)
    assert r.get_json() == {"member": True, "state": "in"} and r.headers["Cache-Control"] == "no-store"
    renewed = cookies_of(r)[dg.SESSION_COOKIE].value
    assert gate.read_session(renewed)["state"] == "in"
    assert "locked" not in c.get("/api/snapshot", headers=as_member(renewed)).get_json()
    # Only for someone signed in, only from this site, and limited like the login.
    nobody = c.application.test_client(use_cookies=False)
    assert nobody.post("/auth/recheck", headers={"Sec-Fetch-Site": "same-origin"}).status_code == 401
    assert c.post("/auth/recheck", headers={**out, "Sec-Fetch-Site": "cross-site"}).status_code == 403


def test_check_again_asks_discord_at_most_every_few_seconds(tmp_path):
    clock = Clock()
    fake = FakeDiscord()
    c, _, _ = make(tmp_path, fake=fake, clock=clock)
    session = {**as_member(log_in(c)), "Sec-Fetch-Site": "same-origin"}
    assert c.post("/auth/recheck", headers=session).status_code == 200
    assert len(fake.calls) == 3  # the login's own answer is fresh: Discord is not asked again
    clock.t += dg.RECHECK_MIN_S + 1
    asked = len(fake.calls)
    for _ in range(5):
        assert c.post("/auth/recheck", headers=session).status_code == 200
    assert len(fake.calls) == asked + 1


def test_a_daily_check_that_passes_renews_the_cookie_on_the_answer(tmp_path):
    clock = Clock()
    c, gate, _ = make(tmp_path, clock=clock)
    session = log_in(c)
    clock.t += dg.RECHECK_AFTER_S + 1
    r = c.get("/api/snapshot", headers=as_member(session))
    assert r.status_code == 200
    renewed = cookies_of(r)[dg.SESSION_COOKIE]
    assert gate.read_session(renewed.value)["checked_at"] == int(clock.t)
    assert int(renewed["max-age"]) <= dg.SESSION_MAX_AGE_S - dg.RECHECK_AFTER_S


# --- with the gate off, nothing changes -----------------------------------------------------------------------------


def test_with_the_gate_off_the_login_routes_do_not_exist_and_me_says_so(tmp_path):
    c, _, _ = make(tmp_path, gate=False)
    for path in ("/auth/discord", "/auth/discord/callback"):
        assert c.get(path).status_code == 404, path
    assert c.post("/auth/logout").status_code == 404
    assert c.post("/auth/recheck").status_code == 404
    assert c.get("/api/me").get_json() == {"gate": False, "member": False, "state": None, "name": None}
    page = c.get("/").get_data(as_text=True)
    assert SNAPSHOT_TAG in page and 'id="me"' not in page and '"locked":' not in page
    whole = c.get("/api/snapshot")
    assert whole.status_code == 200 and "locked" not in whole.get_json() and whole.headers["ETag"] == '"3"'
    assert "Browsing is free" not in c.get("/d/101").get_data(as_text=True)
    assert "Set-Cookie" not in c.get("/").headers


def test_a_gone_deals_page_names_no_live_deal_to_a_visitor(tmp_path):
    from tests.test_share import gone
    snap = {**SNAP, "gone": [gone(90, price=150, player_id=22, season=2026)]}
    c, _, _ = make(tmp_path, snap=snap)
    page = c.get("/d/90").get_data(as_text=True)
    assert "This deal has gone" in page and "Similar deals" not in page and 'href="/d/10' not in page
    session = log_in(c)
    assert "Similar deals" in c.get("/d/90", headers=as_member(session)).get_data(as_text=True)


def test_the_cookies_are_bound_to_this_exact_site():
    assert dg.SESSION_COOKIE.startswith("__Host-") and dg.STATE_COOKIE.startswith("__Host-")


def test_everyone_is_sent_the_sites_code_to_preload_since_everyone_gets_the_site(tmp_path):
    c, _, _ = make(tmp_path)
    (tmp_path / "index.html").write_text(
        '<html><head>\n    <link rel="modulepreload" href="/assets/App-x.js">\n'
        '    <link rel="stylesheet" href="/assets/index-x.css">\n</head><body><!--SNAPSHOT--></body></html>'
    )
    assert "App-x.js" in c.get("/").get_data(as_text=True)
    session = log_in(c)
    assert "App-x.js" in c.get("/", headers=as_member(session)).get_data(as_text=True)


def test_the_www_name_sends_every_ask_to_the_public_address_keeping_the_path(tmp_path):
    """www.<host> and <host> are two sites to a browser: the login's state cookie set on one never reached the callback
    on the other, and the offline copy and settings split in two. Every ask to www goes to the public address."""
    c, gate, _ = make(tmp_path)
    host = gate.public_url.split("://", 1)[1]
    got = c.get("/d/101?x=1", base_url=f"https://www.{host}")
    assert got.status_code == 301
    assert got.headers["Location"] == f"{gate.public_url}/d/101?x=1"
    posted = c.post("/auth/logout", base_url=f"https://www.{host}")
    assert posted.status_code == 308  # a POST stays a POST
    assert c.get("/", base_url=f"https://{host}").status_code == 200  # the public address itself is served


def test_without_the_gate_no_host_is_redirected(tmp_path):
    c, _, _ = make(tmp_path, gate=False)
    assert c.get("/", base_url="https://www.example.org").status_code == 200
