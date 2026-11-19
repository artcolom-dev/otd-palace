"""The Discord gate's own logic: its settings, the way back after login, the signed cookies, the login itself and the
daily membership check. Discord is a scripted fake here: no test ever reaches the network."""

import json
from urllib.parse import parse_qs, urlsplit

import pytest

from advisor import discord_gate as dg

CLIENT_ID = "123456789012345678"
GUILD_ID = "876543210987654321"
CLIENT_SECRET = "client-secret-abcdefghijklmnopqrstuv"
BOT_TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.bot-token-for-tests-only-0123456789"
SESSION_SECRET = "session-secret-0123456789abcdefghijklmnop"
ENV = {
    "ADVISOR_DISCORD_CLIENT_ID": CLIENT_ID,
    "ADVISOR_DISCORD_CLIENT_SECRET": CLIENT_SECRET,
    "ADVISOR_DISCORD_BOT_TOKEN": BOT_TOKEN,
    "ADVISOR_DISCORD_GUILD_ID": GUILD_ID,
    "ADVISOR_SESSION_SECRET": SESSION_SECRET,
    "ADVISOR_PUBLIC_URL": "https://palace.example.test",
}
SECRETS = (CLIENT_SECRET, BOT_TOKEN, SESSION_SECRET)
USER_TOKEN = "user-access-token-never-kept"
USER = {"id": "111122223333444455", "username": "dealhunter", "global_name": "Deal Hunter"}


def config():
    return dg.config_from_env(ENV)


class Clock:
    def __init__(self, t: float = 1_800_000_000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t


class FakeDiscord:
    """Answers each (method, path) with the scripted (status, JSON) and records what was asked; an exception in the
    script is raised, as a transport that timed out would."""

    def __init__(self, **script):
        self.script = {
            "token": (200, {"access_token": USER_TOKEN, "token_type": "Bearer"}),
            "me": (200, USER),
            "join": (201, {}),
            "member": (200, {"user": {"id": USER["id"]}}),
            **script,
        }
        self.calls = []

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, headers, body))
        path = urlsplit(url).path
        if path.endswith("/oauth2/token"):
            key = "token"
        elif path.endswith("/users/@me"):
            key = "me"
        elif method == "PUT":
            key = "join"
        else:
            key = "member"
        answer = self.script[key]
        if isinstance(answer, Exception):
            raise answer
        status, data = answer
        return status, json.dumps(data).encode()


def gate(fake=None, clock=None, **kw):
    fake = fake or FakeDiscord()
    return dg.DiscordGate(config(), dg.DiscordClient(config(), transport=fake), clock=clock or Clock(), **kw), fake


# --- settings -------------------------------------------------------------------------------------------------------


def test_with_no_setting_the_gate_is_off_and_nothing_is_wrong():
    assert dg.config_from_env({}) is None
    assert dg.config_problem({}) is None
    assert dg.config_problem({"ADVISOR_DISCORD_CLIENT_ID": "  "}) is None  # blank counts as unset


def test_all_six_settings_turn_it_on_with_the_callback_under_the_public_address():
    cfg = config()
    assert dg.config_problem(ENV) is None
    assert cfg.redirect_uri == "https://palace.example.test/auth/discord/callback"
    assert (cfg.client_id, cfg.guild_id) == (CLIENT_ID, GUILD_ID)


def test_values_are_trimmed_and_a_trailing_slash_on_the_address_is_dropped():
    env = {key: f" {value}\n" for key, value in ENV.items()}
    env["ADVISOR_PUBLIC_URL"] = "https://palace.example.test/\n"
    assert dg.config_problem(env) is None
    assert dg.config_from_env(env).redirect_uri == "https://palace.example.test/auth/discord/callback"


@pytest.mark.parametrize("missing", list(ENV))
def test_a_partial_setup_names_what_is_missing_and_never_prints_a_secret(missing):
    env = {key: value for key, value in ENV.items() if key != missing}
    problem = dg.config_problem(env)
    assert problem is not None and missing in problem
    assert not any(secret in problem for secret in SECRETS)
    with pytest.raises(ValueError):
        dg.config_from_env(env)


@pytest.mark.parametrize(
    "name, value",
    [
        ("ADVISOR_DISCORD_CLIENT_ID", "not-a-number"),
        ("ADVISOR_DISCORD_GUILD_ID", "12"),
        ("ADVISOR_DISCORD_CLIENT_SECRET", "short"),
        ("ADVISOR_DISCORD_CLIENT_SECRET", "has a space in it, which no secret has"),
        ("ADVISOR_DISCORD_BOT_TOKEN", "tiny"),
        ("ADVISOR_SESSION_SECRET", "x" * 31),
        ("ADVISOR_PUBLIC_URL", "http://palace.example.test"),
        ("ADVISOR_PUBLIC_URL", "https://palace.example.test/some/path"),
        ("ADVISOR_PUBLIC_URL", "palace.example.test"),
        ("ADVISOR_PUBLIC_URL", "https://user@palace.example.test"),
        ("ADVISOR_PUBLIC_URL", "https://palace.example.test?x=1"),
    ],
)
def test_an_invalid_value_is_named_without_being_echoed(name, value):
    problem = dg.config_problem({**ENV, name: value})
    assert problem is not None and name in problem
    assert not any(secret in problem for secret in SECRETS)
    if len(value) > 6 and name != "ADVISOR_PUBLIC_URL":
        assert value not in problem


def test_plain_http_is_allowed_only_on_this_machine_for_a_local_try():
    for url in ("http://localhost:8795", "http://127.0.0.1:8795", "http://localhost"):
        assert dg.config_problem({**ENV, "ADVISOR_PUBLIC_URL": url}) is None, url
    assert dg.config_problem({**ENV, "ADVISOR_PUBLIC_URL": "http://localhost.example.test"}) is not None


def test_the_config_never_shows_its_secrets_when_printed():
    text = repr(config())
    assert not any(secret in text for secret in SECRETS)


# --- the way back after login ---------------------------------------------------------------------------------------


@pytest.mark.parametrize("given", ["/", "/#deals", "/?open=104", "/#account/dealhunter", "/a/dealhunter"])
def test_a_same_site_path_is_kept(given):
    assert dg.safe_next(given) == given


@pytest.mark.parametrize(
    "given",
    [None, "", "deals", "//evil.example", "/\\evil.example", "\\\\evil.example", "https://evil.example/",
     "javascript:alert(1)", "/\nSet-Cookie: x", "/\x00", "/" + "a" * 600, "/ space", "/é"],
)
def test_anything_else_goes_home(given):
    assert dg.safe_next(given) == "/"


# --- starting a login -----------------------------------------------------------------------------------------------


def test_start_sends_the_visitor_to_discord_with_the_right_query_and_a_state_kept_in_a_signed_cookie():
    g, _ = gate()
    url, cookie = g.start("/#deals")
    parts = urlsplit(url)
    assert (parts.scheme, parts.netloc, parts.path) == ("https", "discord.com", "/oauth2/authorize")
    query = {key: values[0] for key, values in parse_qs(parts.query).items()}
    assert query == {
        "client_id": CLIENT_ID,
        "redirect_uri": "https://palace.example.test/auth/discord/callback",
        "response_type": "code",
        "scope": "identify guilds.join",
        "state": query["state"],
    }
    assert len(query["state"]) >= 32
    assert query["state"] not in cookie or "." in cookie  # signed, not the bare state
    other_url, _ = g.start("/")
    assert parse_qs(urlsplit(other_url).query)["state"][0] != query["state"]


# --- finishing a login ----------------------------------------------------------------------------------------------


def login(g, next_path="/#deals", **args):
    url, cookie = g.start(next_path)
    state = parse_qs(urlsplit(url).query)["state"][0]
    return g.finish({"code": "the-code", "state": state, **args}, cookie)


def test_a_login_joins_the_server_and_hands_back_a_session_without_the_users_token():
    g, fake = gate()
    outcome = login(g)
    assert outcome.error is None and outcome.next == "/#deals"
    session = g.read_session(outcome.session)
    assert session == {"uid": USER["id"], "name": "Deal Hunter", "iat": 1_800_000_000, "checked_at": 1_800_000_000,
                       "state": "in"}
    assert USER_TOKEN not in outcome.session
    method, url, headers, body = fake.calls[-1]
    assert (method, url) == ("PUT", f"https://discord.com/api/v10/guilds/{GUILD_ID}/members/{USER['id']}")
    assert headers["Authorization"] == f"Bot {BOT_TOKEN}"
    assert json.loads(body) == {"access_token": USER_TOKEN}
    token_call = fake.calls[0]
    assert token_call[0] == "POST" and token_call[1] == "https://discord.com/api/v10/oauth2/token"
    form = parse_qs(token_call[3].decode())
    assert form["grant_type"] == ["authorization_code"] and form["code"] == ["the-code"]
    assert form["redirect_uri"] == ["https://palace.example.test/auth/discord/callback"]
    assert fake.calls[1][2]["Authorization"] == f"Bearer {USER_TOKEN}"


def test_someone_already_in_the_server_gets_in_too():
    g, _ = gate(FakeDiscord(join=(204, None)))
    assert login(g).error is None


def test_the_name_falls_back_to_the_username_and_is_cut_to_32_characters():
    g, _ = gate(FakeDiscord(me=(200, {"id": USER["id"], "username": "plainname", "global_name": None})))
    assert g.read_session(login(g).session)["name"] == "plainname"
    g, _ = gate(FakeDiscord(me=(200, {"id": USER["id"], "username": "u", "global_name": "N" * 50 + "\x07"})))
    assert g.read_session(login(g).session)["name"] == "N" * 32


@pytest.mark.parametrize(
    "fake, reason",
    [
        (FakeDiscord(token=(400, {"error": "invalid_grant"})), "discord"),
        (FakeDiscord(token=(200, {"no": "token"})), "discord"),
        (FakeDiscord(me=(401, {})), "discord"),
        (FakeDiscord(me=(200, {"id": "not-a-snowflake", "username": "x"})), "discord"),
        (FakeDiscord(token=TimeoutError()), "discord"),
    ],
)
def test_a_discord_failure_before_it_says_who_they_are_signs_nobody_in(fake, reason):
    g, _ = gate(fake)
    outcome = login(g)
    assert (outcome.session, outcome.error) == (None, reason)


@pytest.mark.parametrize(
    "fake, reason, state",
    [
        (FakeDiscord(join=(403, {"code": 40007})), "refused", "banned"),
        (FakeDiscord(join=(400, {"code": 30001})), "full", "out"),
        (FakeDiscord(join=(500, {})), "discord", "out"),
        (FakeDiscord(join=(429, {})), "discord", "out"),
        (FakeDiscord(join=OSError("down")), "discord", "out"),
    ],
)
def test_a_join_that_fails_signs_them_in_but_never_as_a_member(fake, reason, state):
    clock = Clock()
    g, _ = gate(fake, clock)
    outcome = login(g)
    assert outcome.error == reason and g.read_session(outcome.session)["state"] == state
    visitor = g.visitor(outcome.session)
    assert (visitor.member, visitor.state, visitor.signed_in, visitor.alert_owner()) == (False, state, True, None)


def test_a_visitor_who_said_no_on_discord_is_told_so_and_discord_is_not_asked():
    g, fake = gate()
    url, cookie = g.start("/")
    state = parse_qs(urlsplit(url).query)["state"][0]
    outcome = g.finish({"error": "access_denied", "state": state}, cookie)
    assert (outcome.session, outcome.error) == (None, "denied")
    assert fake.calls == []


@pytest.mark.parametrize("case", ["no cookie", "other state", "forged cookie", "no code", "expired"])
def test_a_state_that_does_not_match_its_cookie_stops_the_login(case):
    clock = Clock()
    g, fake = gate(clock=clock)
    url, cookie = g.start("/")
    state = parse_qs(urlsplit(url).query)["state"][0]
    args = {"code": "c", "state": state}
    if case == "no cookie":
        cookie = None
    elif case == "other state":
        args["state"] = "x" * 43
    elif case == "forged cookie":
        cookie = cookie[:-4] + "AAAA"
    elif case == "no code":
        del args["code"]
    else:
        clock.t += dg.STATE_MAX_AGE_S + 1
    outcome = g.finish(args, cookie)
    assert (outcome.session, outcome.error) == (None, "state")
    assert fake.calls == []


# --- the session and the daily check --------------------------------------------------------------------------------


def member_cookie(g, clock):
    outcome = login(g)
    assert outcome.session
    return outcome.session


def test_a_fresh_session_is_a_member_without_asking_discord():
    clock = Clock()
    g, fake = gate(clock=clock)
    cookie = member_cookie(g, clock)
    calls = len(fake.calls)
    clock.t += dg.RECHECK_AFTER_S - 1
    visitor = g.visitor(cookie)
    assert (visitor.member, visitor.name, visitor.cookie, visitor.clear) == (True, "Deal Hunter", None, False)
    assert len(fake.calls) == calls


def test_no_cookie_or_a_forged_or_expired_one_is_no_member():
    clock = Clock()
    g, _ = gate(clock=clock)
    assert g.visitor(None).member is False
    assert g.visitor("garbage").member is False
    cookie = member_cookie(g, clock)
    assert g.visitor(cookie[:-3] + "xyz").member is False
    other, _ = gate(clock=clock)
    other._serializer = dg.URLSafeTimedSerializer("another-secret-0123456789abcdefghijk", salt=dg.SESSION_SALT)
    assert other.visitor(cookie).member is False
    clock.t += dg.SESSION_MAX_AGE_S + 1
    assert g.visitor(cookie).member is False


def test_after_a_day_a_member_still_in_the_server_gets_a_renewed_cookie():
    clock = Clock()
    g, fake = gate(clock=clock)
    cookie = member_cookie(g, clock)
    clock.t += dg.RECHECK_AFTER_S + 5
    visitor = g.visitor(cookie)
    assert visitor.member is True and visitor.cookie is not None and not visitor.clear
    assert fake.calls[-1][0] == "GET" and fake.calls[-1][1].endswith(f"/guilds/{GUILD_ID}/members/{USER['id']}")
    assert fake.calls[-1][2]["Authorization"] == f"Bot {BOT_TOKEN}"
    assert g.read_session(visitor.cookie)["checked_at"] == int(clock.t)
    assert g.read_session(visitor.cookie)["iat"] == 1_800_000_000  # the 30 days still count from the login


def test_someone_who_left_the_server_loses_the_extras_but_stays_signed_in_as_out():
    clock = Clock()
    g, fake = gate(clock=clock)
    cookie = member_cookie(g, clock)
    fake.script["member"] = (404, {"code": 10007})
    clock.t += dg.RECHECK_AFTER_S + 5
    visitor = g.visitor(cookie)
    assert (visitor.member, visitor.state, visitor.clear, visitor.name) == (False, "out", False, "Deal Hunter")
    assert g.read_session(visitor.cookie)["state"] == "out"
    assert g.may_alert({"member": {"uid": USER["id"], "iat": 1_800_000_000}}) is False


def test_someone_out_of_the_server_is_checked_again_within_minutes_and_comes_back_in():
    clock = Clock()
    g, fake = gate(FakeDiscord(join=(400, {"code": 30001})), clock)
    cookie = login(g).session
    fake.script["member"] = (200, {})  # they left a server and joined ours by the invite
    clock.t += dg.RECHECK_OUT_S - 5
    assert g.visitor(cookie).state == "out"  # not asked yet
    clock.t += 10
    visitor = g.visitor(cookie)
    assert (visitor.member, visitor.state) == (True, "in") and g.read_session(visitor.cookie)["state"] == "in"


def test_a_banned_session_stays_banned_until_discord_says_they_are_in():
    clock = Clock()
    g, fake = gate(FakeDiscord(join=(403, {})), clock)
    cookie = login(g).session
    fake.script["member"] = (404, {})
    clock.t += dg.RECHECK_AFTER_S + 5
    visitor = g.visitor(cookie)
    assert (visitor.member, visitor.state) == (False, "banned")  # never "out": that would offer the join again
    fake.script["member"] = (200, {})
    clock.t += dg.MEMBER_CACHE_S + 1
    assert g.recheck(visitor.cookie).state == "in"


def test_a_cookie_from_before_the_states_reads_as_a_member_and_an_unknown_state_is_cleared():
    clock = Clock()
    g, _ = gate(clock=clock)
    now = int(clock())
    old = g._dumps(g._serializer, {"uid": USER["id"], "name": "x", "iat": now, "checked_at": now})
    assert (g.visitor(old).member, g.visitor(old).state) == (True, "in")
    odd = g._dumps(g._serializer, {"uid": USER["id"], "name": "x", "iat": now, "checked_at": now, "state": "admin"})
    assert (g.visitor(odd).member, g.visitor(odd).clear) == (False, True)


@pytest.mark.parametrize("answer", [(500, {}), (502, {}), (429, {}), TimeoutError(), OSError("down")])
def test_when_discord_cannot_answer_the_daily_check_keeps_access_and_tries_again_later(answer):
    clock = Clock()
    g, fake = gate(clock=clock)
    cookie = member_cookie(g, clock)
    fake.script["member"] = answer
    clock.t += dg.RECHECK_AFTER_S + 5
    visitor = g.visitor(cookie)
    assert (visitor.member, visitor.cookie, visitor.clear) == (True, None, False)
    # Discord is back: once the short wait is over, the next request checks again and renews.
    fake.script["member"] = (200, {})
    clock.t += dg.UNKNOWN_CACHE_S + 1
    assert g.visitor(cookie).cookie is not None


def test_a_burst_of_requests_asks_discord_once():
    clock = Clock()
    g, fake = gate(clock=clock)
    cookie = member_cookie(g, clock)
    clock.t += dg.RECHECK_AFTER_S + 5
    before = len(fake.calls)
    for _ in range(20):
        assert g.visitor(cookie).member is True
    assert len(fake.calls) == before + 1


def test_the_check_cache_holds_a_bounded_number_of_people():
    clock = Clock()
    g, _ = gate(clock=clock, cache_max=3)
    for uid in range(10):
        g._remember(str(uid), "member")
    assert len(g._checks) == 3


def test_thirty_days_after_the_login_it_ends_however_often_it_was_renewed():
    clock = Clock()
    g, _ = gate(clock=clock)
    cookie = member_cookie(g, clock)
    for _ in range(31):
        clock.t += dg.RECHECK_AFTER_S + 1
        visitor = g.visitor(cookie)
        cookie = visitor.cookie or cookie
    assert (visitor.member, visitor.clear) == (False, True)


def test_a_session_cookie_with_a_broken_payload_is_cleared():
    clock = Clock()
    g, _ = gate(clock=clock)
    broken = g._dumps(g._serializer, {"uid": "abc", "name": 5})
    visitor = g.visitor(broken)
    assert (visitor.member, visitor.clear) == (False, True)


# --- the HTTP client ------------------------------------------------------------------------------------------------


def test_every_request_has_a_user_agent_and_a_timeout_and_reads_nothing_huge():
    seen = {}

    def opener(request, timeout):
        seen["timeout"] = timeout
        seen["ua"] = request.get_header("User-agent")
        raise TimeoutError

    client = dg.DiscordClient(config(), opener=opener)
    with pytest.raises(dg.DiscordError):
        client.exchange_code("c")
    assert seen["timeout"] == dg.DISCORD_TIMEOUT_S and seen["ua"].startswith("DiscordBot (")


def test_a_discord_error_holds_nothing_private():
    g, _ = gate(FakeDiscord(token=(400, {"error": "invalid_grant", "echo": CLIENT_SECRET})))
    with pytest.raises(dg.DiscordError) as raised:
        g._client.exchange_code("the-code")
    assert CLIENT_SECRET not in str(raised.value) and "the-code" not in str(raised.value)


# --- alerts ---------------------------------------------------------------------------------------------------------


def test_alerts_go_only_to_a_member_whose_login_is_under_30_days_and_who_has_not_left():
    clock = Clock()
    g, _ = gate(clock=clock)
    member = {"uid": USER["id"], "iat": int(clock.t)}
    assert g.may_alert({"member": member}) is True
    assert g.may_alert({}) is False  # subscribed before the gate, or without a session
    assert g.may_alert({"member": {"uid": "x", "iat": 1}}) is False
    g._remember(USER["id"], "gone")
    assert g.may_alert({"member": member}) is False
    g._remember(USER["id"], "member")
    clock.t += dg.SESSION_MAX_AGE_S + 1
    assert g.may_alert({"member": member}) is False


def test_the_visitor_says_who_they_are_for_the_alerts():
    clock = Clock()
    g, _ = gate(clock=clock)
    visitor = g.visitor(login(g).session)
    assert visitor.alert_owner() == {"uid": USER["id"], "iat": int(clock.t)}
    assert dg.NOBODY.alert_owner() is None


@pytest.mark.parametrize("status", [401, 403])
def test_a_daily_check_the_bot_is_not_allowed_to_make_is_logged_loudly_without_the_token(status, caplog):
    clock = Clock()
    g, fake = gate(clock=clock)
    cookie = member_cookie(g, clock)
    fake.script["member"] = (status, {})
    clock.t += dg.RECHECK_AFTER_S + 5
    with caplog.at_level("WARNING"):
        assert g.visitor(cookie).member is True  # in for now: one broken setting must not lock every member out
    assert f"HTTP {status}" in caplog.text and BOT_TOKEN not in caplog.text


def test_too_many_discord_calls_at_once_turn_the_next_one_away_without_waiting():
    import threading

    busy, release = threading.Semaphore(0), threading.Event()

    def slow(method, url, headers, body):
        busy.release()
        release.wait(5)
        return 200, b'{"access_token": "t"}'

    client = dg.DiscordClient(config(), transport=slow)
    threads = [threading.Thread(target=client.exchange_code, args=("c",)) for _ in range(dg.DISCORD_MAX_CONCURRENT)]
    for t in threads:
        t.start()
    for _ in threads:
        assert busy.acquire(timeout=5)  # every slot is taken
    try:
        with pytest.raises(dg.DiscordError):
            dg.DiscordClient.exchange_code(client, "c")
        assert client.member_state(USER["id"]) == "unknown"
    finally:
        release.set()
        for t in threads:
            t.join(5)
    assert dg.DISCORD_TIMEOUT_S <= 5


def test_the_member_count_is_read_with_the_bot_from_the_guilds_approximate_count():
    fake = FakeDiscord(member=(200, {"id": GUILD_ID, "approximate_member_count": 321}))
    client = dg.DiscordClient(config(), transport=fake)
    assert client.member_count() == 321
    method, url, headers, body = fake.calls[-1]
    assert method == "GET" and url.endswith(f"/guilds/{GUILD_ID}?with_counts=true") and body is None
    assert headers["Authorization"] == f"Bot {BOT_TOKEN}"


@pytest.mark.parametrize("answer", [(500, {}), (200, {}), (200, {"approximate_member_count": "12"}),
                                    (200, {"approximate_member_count": True}), TimeoutError()])
def test_no_usable_member_count_is_none(answer):
    client = dg.DiscordClient(config(), transport=FakeDiscord(member=answer))
    assert client.member_count() is None
