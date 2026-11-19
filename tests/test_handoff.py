"""The home-screen app's login, handed back to it (advisor/handoff.py): the app starts it and keeps a claim, Discord's
answer in another window makes the session, and the app takes it with its claim, from the same network only."""

from urllib.parse import parse_qs, urlsplit

from advisor import discord_gate as dg
from advisor.handoff import HANDOFF_COOKIE, HANDOFF_MAX_AGE_S, Handoffs, same_network
from tests.test_discord_gate import Clock
from tests.test_gate_web import as_member, cookies_of, make

PHONE = {"X-Real-IP": "203.0.113.7", "Sec-Fetch-Site": "same-origin"}
SAFARI = {"X-Real-IP": "203.0.113.7"}  # the window over the app: the same phone, the same network
ELSEWHERE = {"X-Real-IP": "198.51.100.9"}


class Tick:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


# --- the pieces -----------------------------------------------------------------------------------------------------


def test_the_same_network_is_one_ipv4_address_or_one_ipv6_64():
    assert same_network("203.0.113.7", "203.0.113.7")
    assert not same_network("203.0.113.7", "203.0.113.8")
    assert same_network("2001:db8:1:2::1", "2001:db8:1:2:abcd::9")
    assert not same_network("2001:db8:1:2::1", "2001:db8:1:3::1")
    assert not same_network("203.0.113.7", "::ffff:203.0.113.8")
    assert not same_network("", "") and not same_network("nope", "nope")


def test_a_handoff_is_claimed_once_after_the_login_and_only_from_its_network():
    tick = Tick()
    h = Handoffs(tick)
    claim, state = h.start("/#passes", "203.0.113.7")
    assert h.claim(claim, "203.0.113.7").status == "waiting"
    assert h.login_state(state, "198.51.100.9") is None  # Discord's answer from elsewhere: not this handoff's
    assert h.login_state(state, "203.0.113.7") == {"state": state, "next": "/#passes"}
    h.keep(state, "the-session")
    assert h.login_state(state, "203.0.113.7") is None  # used: a second answer does not bind again
    assert h.claim(claim, "198.51.100.9").status == "gone"
    found = h.claim(claim, "203.0.113.7")
    assert (found.status, found.session) == ("done", "the-session")
    assert h.claim(claim, "203.0.113.7").status == "gone"  # used up


def test_a_handoff_lasts_ten_minutes_and_the_oldest_leave_first():
    tick = Tick()
    h = Handoffs(tick, max_items=2)
    claim, state = h.start("/", "203.0.113.7")
    tick.now += HANDOFF_MAX_AGE_S
    assert h.login_state(state, "203.0.113.7") is None and h.claim(claim, "203.0.113.7").status == "gone"
    first, _ = h.start("/", "203.0.113.7")
    h.start("/", "203.0.113.7")
    h.start("/", "203.0.113.7")
    assert h.claim(first, "203.0.113.7").status == "gone"
    assert h.claim("", "203.0.113.7").status == "gone" and h.claim(None, "203.0.113.7").status == "gone"


# --- from the web ---------------------------------------------------------------------------------------------------


def start(c, next_path="/%23passes"):
    r = c.post(f"/auth/handoff?next={next_path}", headers=PHONE)
    assert r.status_code == 200, r.get_data(as_text=True)
    url = r.get_json()["url"]
    assert url.startswith(dg.AUTHORIZE_URL + "?") and "no-store" in r.headers["Cache-Control"]
    claim = cookies_of(r)[HANDOFF_COOKIE]
    assert claim["httponly"] and claim["secure"] and int(claim["max-age"]) == HANDOFF_MAX_AGE_S
    return claim.value, parse_qs(urlsplit(url).query)["state"][0]


def claim_it(c, claim, headers=PHONE):
    return c.post("/auth/handoff/claim", headers={**headers, "Cookie": f"{HANDOFF_COOKIE}={claim}"})


def test_the_app_takes_the_session_a_login_in_another_window_made(tmp_path):
    c, _, _ = make(tmp_path, clock=Clock())
    claim, state = start(c)
    assert claim_it(c, claim).get_json() == {"status": "waiting"}
    # Discord sends the visitor back to the window over the app, which holds no login cookie.
    back = c.get(f"/auth/discord/callback?code=abc&state={state}", headers=SAFARI)
    assert back.status_code == 200 and "You're signed in" in back.get_data(as_text=True)
    assert 'href="/#passes"' in back.get_data(as_text=True)
    assert dg.SESSION_COOKIE in cookies_of(back)  # that window is signed in too
    r = claim_it(c, claim)
    assert r.get_json() == {"status": "done"} and "no-store" in r.headers["Cache-Control"]
    session = cookies_of(r)[dg.SESSION_COOKIE].value
    assert cookies_of(r)[HANDOFF_COOKIE].value == ""  # the claim is cleared
    me = c.get("/api/me", headers=as_member(session)).get_json()
    assert me["member"] is True and me["state"] == "in"
    assert claim_it(c, claim).get_json() == {"status": "gone"}


def test_a_handoff_started_by_someone_else_never_gives_them_the_session(tmp_path):
    c, _, _ = make(tmp_path, clock=Clock())
    claim, state = start(c)  # the one who would send this Discord address to someone
    back = c.get(f"/auth/discord/callback?code=abc&state={state}", headers=ELSEWHERE)
    assert back.status_code == 400 and dg.SESSION_COOKIE not in cookies_of(back)  # an unknown login, as before
    assert claim_it(c, claim).get_json() == {"status": "waiting"}


def test_a_claim_from_another_network_is_gone(tmp_path):
    c, _, _ = make(tmp_path, clock=Clock())
    claim, state = start(c)
    c.get(f"/auth/discord/callback?code=abc&state={state}", headers=SAFARI)
    assert claim_it(c, claim, ELSEWHERE).get_json() == {"status": "gone"}


def test_a_login_cookie_still_wins_and_redirects_as_before(tmp_path):
    c, _, _ = make(tmp_path, clock=Clock())
    start(c)
    s = c.get("/auth/discord?next=%2F")
    state = parse_qs(urlsplit(s.headers["Location"]).query)["state"][0]
    login_cookie = cookies_of(s)[dg.STATE_COOKIE].value
    back = c.get(f"/auth/discord/callback?code=abc&state={state}",
                 headers={**SAFARI, "Cookie": f"{dg.STATE_COOKIE}={login_cookie}"})
    assert back.status_code == 302 and back.headers["Location"] == "/"


def test_the_handoff_routes_refuse_other_sites_and_do_not_exist_without_the_gate(tmp_path):
    c, _, _ = make(tmp_path, clock=Clock())
    assert c.post("/auth/handoff", headers={**PHONE, "Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert c.post("/auth/handoff/claim", headers={**PHONE, "Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert claim_it(c, "made-up").get_json() == {"status": "gone"}
    (tmp_path / "off").mkdir()
    off, _, _ = make(tmp_path / "off", gate=False)
    assert off.post("/auth/handoff", headers=PHONE).status_code == 404
    assert off.post("/auth/handoff/claim", headers=PHONE).status_code == 404


def test_the_claim_is_rate_limited_per_address(tmp_path):
    c, _, _ = make(tmp_path, clock=Clock())
    codes = [claim_it(c, "x").status_code for _ in range(61)]
    assert codes[:60] == [200] * 60 and codes[60] == 429
