import http.client
import json
import os
import socket
import subprocess
import sys
import time

import pytest

import server
from advisor.clicks import ClickLog
from advisor.photos import PhotoStore
from advisor.push import PushStore
from advisor.rules import FEED_TOKEN_MIN_CHARS, PUSH_MAX_BYTES, REQUEST_MAX_BYTES, STATS_TOKEN_MIN_CHARS
from advisor.importer import DemoImporter, PassImporter
from advisor.members import MemberLinks
from advisor.sources.feed import FeedSource
from advisor.visits import VisitLog, run_discord_counter, run_flusher
from tests.test_discord_commands import ENV as COMMANDS_ENV
from tests.test_discord_gate import ENV as GATE_ENV, SECRETS as GATE_SECRETS
from tests.test_push import mint

SETTINGS = (
    "PORT", "ADVISOR_SOURCE", "ADVISOR_ALLOW_DEMO", "ADVISOR_STATS_TOKEN", "ADVISOR_DATA_DIR",
    "ADVISOR_VAPID_PRIVATE", "ADVISOR_VAPID_PUBLIC", "ADVISOR_VAPID_SUBJECT", "ADVISOR_FEED_URL", "ADVISOR_FEED_TOKEN",
    "ADVISOR_DISCORD_POST", "ADVISOR_DISCORD_PERKS", "ADVISOR_DISCORD_INVITES", *GATE_ENV, "ADVISOR_DISCORD_PUBLIC_KEY",
    "ADVISOR_ADMIN_DISCORD_IDS",
)
SAMPLE_OK = {"PORT": "0", "ADVISOR_ALLOW_DEMO": "1"}  # a platform start that asked for the sample data


@pytest.fixture(autouse=True)
def clean_env(monkeypatch, tmp_path):
    """Every test starts from no setting at all, with its data in its own directory."""
    for key in SETTINGS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("ADVISOR_DATA_DIR", str(tmp_path / "data"))


def run(monkeypatch, env):
    """Runs server.main() with the collector, the threads and waitress stubbed out; says what each was given."""
    seen = {"threads": [], "paths": {}}
    monkeypatch.setattr(server, "serve", lambda app, **kw: seen.update(serve=kw))
    monkeypatch.setattr(server, "run_collector", lambda *args, **kw: None)
    monkeypatch.setattr(server.signal, "signal", lambda *args: None)

    def create_app(*args, **kw):
        seen["app"] = kw
        seen["app_args"] = args
        return object()

    monkeypatch.setattr(server, "create_app", create_app)

    class Thread:
        def __init__(self, target, args=(), kwargs=None, daemon=None, name=None):
            seen["threads"].append((target, args, kwargs or {}))

        def start(self):
            pass

    monkeypatch.setattr(server.threading, "Thread", Thread)

    def recording(cls, name):
        class Recording(cls):
            def __init__(self, path, *args, **kw):
                seen["paths"][name] = path
                super().__init__(path, *args, **kw)

        return Recording

    monkeypatch.setattr(server, "ClickLog", recording(ClickLog, "clicks"))
    monkeypatch.setattr(server, "PushStore", recording(PushStore, "push"))
    monkeypatch.setattr(server, "PhotoStore", recording(PhotoStore, "photos"))
    monkeypatch.setattr(server, "VisitLog", recording(VisitLog, "visits"))
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    server.main()
    return seen


def collector_kwargs(seen):
    return next(kwargs for target, _, kwargs in seen["threads"] if target is server.run_collector)


def test_waitress_lets_the_app_answer_small_overruns_and_names_no_server(monkeypatch):
    # The biggest body a route takes is a push subscription (PUSH_MAX_BYTES; a click is capped smaller by its own
    # route). Waitress refuses only bodies well past it, so a small overrun gets the app's own 413, with its headers.
    seen = run(monkeypatch, SAMPLE_OK)
    assert seen["serve"]["max_request_body_size"] == REQUEST_MAX_BYTES >= 2 * PUSH_MAX_BYTES
    assert seen["serve"]["ident"] == ""  # no "Server: waitress" header
    # Waitress takes the scheme from the platform proxy's X-Forwarded-Proto and drops the other proxy headers.
    assert (seen["serve"]["trusted_proxy"], seen["serve"]["trusted_proxy_headers"]) == ("*", {"x-forwarded-proto"})
    assert "clear_untrusted_proxy_headers" not in seen["serve"]
    assert {key: seen["serve"][key] for key in server.WAITRESS} == server.WAITRESS


def ask(port, method, path, headers=None, body=None):
    """One request to a real server on this machine: (status, headers)."""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        response.read()
        return response.status, response.headers
    finally:
        connection.close()


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def test_the_real_server_sends_hsts_after_the_proxy_scheme_and_drops_x_forwarded_for(tmp_path):
    port = free_port()
    env = {key: value for key, value in os.environ.items() if key not in SETTINGS}
    env.update(PORT=str(port), ADVISOR_ALLOW_DEMO="1", ADVISOR_DATA_DIR=str(tmp_path / "data"), ADVISOR_INTERVAL_S="1")
    process = subprocess.Popen([sys.executable, str(server.ROOT / "server.py")], cwd=tmp_path, env=env,
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        deadline = time.monotonic() + 20
        while True:
            try:
                if ask(port, "GET", "/healthz")[0] == 200:
                    break
            except OSError:
                pass
            assert process.poll() is None and time.monotonic() < deadline, "the server did not start"
            time.sleep(0.1)
        status, headers = ask(port, "GET", "/healthz", {"X-Forwarded-Proto": "https"})
        assert (status, headers["Strict-Transport-Security"]) == (200, "max-age=31536000")
        for sent in ({}, {"X-Forwarded-Proto": "http"}):
            status, headers = ask(port, "GET", "/healthz", sent)
            assert status == 200 and "Strict-Transport-Security" not in headers, sent
        assert "Server" not in headers
        # A visitor's own X-Forwarded-For never changes who it is: all these clicks share one bucket of 30.
        click = json.dumps({"panel": "deals", "target": "listing", "level": "regular", "sport": "all", "pos": 1})
        codes = [ask(port, "POST", "/api/out", {"X-Forwarded-For": f"203.0.113.{n}"}, click)[0] for n in range(40)]
        assert codes[:30] == [204] * 30 and 429 in codes[30:], codes
    finally:
        process.terminate()
        process.wait(timeout=10)


@pytest.mark.parametrize("source", ["replay", "fixture"])
def test_the_fixture_and_its_replay_are_served_as_sample_data(source, monkeypatch):
    seen = run(monkeypatch, {"PORT": "0", "ADVISOR_SOURCE": source})
    assert collector_kwargs(seen)["demo"] is True


def test_the_demo_fixture_ships_inside_the_package():
    assert server.FIXTURE_PATH == server.ROOT / "advisor" / "fixtures" / "demo_raw.json"
    assert server.FIXTURE_PATH.is_file()


def test_a_platform_start_without_a_source_refuses_to_serve_sample_data(monkeypatch):
    for allow in (None, "0", "true", "yes", ""):
        env = {"PORT": "8080"} if allow is None else {"PORT": "8080", "ADVISOR_ALLOW_DEMO": allow}
        if allow is None:
            monkeypatch.delenv("ADVISOR_ALLOW_DEMO", raising=False)
        with pytest.raises(SystemExit) as stopped:
            run(monkeypatch, env)
        message = str(stopped.value.code)
        assert "ADVISOR_SOURCE" in message and "ADVISOR_ALLOW_DEMO=1" in message, allow


def test_sample_data_starts_when_asked_for_or_off_a_platform(monkeypatch):
    for env in ({"PORT": "8080", "ADVISOR_ALLOW_DEMO": "1"}, {"PORT": "8080", "ADVISOR_SOURCE": "replay"}):
        assert collector_kwargs(run(monkeypatch, env))["demo"] is True, env
    monkeypatch.delenv("PORT", raising=False)
    monkeypatch.delenv("ADVISOR_SOURCE", raising=False)
    monkeypatch.delenv("ADVISOR_ALLOW_DEMO", raising=False)
    assert collector_kwargs(run(monkeypatch, {}))["demo"] is True  # `python server.py` on a laptop


def test_a_short_stats_token_stops_the_server(monkeypatch):
    for token in ("Zq8-x1", "k" * (STATS_TOKEN_MIN_CHARS - 1)):
        with pytest.raises(SystemExit) as stopped:
            run(monkeypatch, {**SAMPLE_OK, "ADVISOR_STATS_TOKEN": token})
        message = str(stopped.value.code)
        assert "ADVISOR_STATS_TOKEN" in message and str(STATS_TOKEN_MIN_CHARS) in message
        assert token not in message  # the secret itself is never echoed


def test_a_long_enough_stats_token_or_none_starts(monkeypatch):
    assert STATS_TOKEN_MIN_CHARS == 32
    token = "t" * STATS_TOKEN_MIN_CHARS
    assert run(monkeypatch, {**SAMPLE_OK, "ADVISOR_STATS_TOKEN": token})["app"]["stats_token"] == token
    assert run(monkeypatch, {**SAMPLE_OK, "ADVISOR_STATS_TOKEN": ""})["app"]["stats_token"] is None


def test_the_stats_token_is_stripped_before_it_is_measured_and_used(monkeypatch):
    with pytest.raises(SystemExit):
        run(monkeypatch, {**SAMPLE_OK, "ADVISOR_STATS_TOKEN": " " * 30 + "Zq8-x1" + "\n"})
    token = "k" * STATS_TOKEN_MIN_CHARS
    assert run(monkeypatch, {**SAMPLE_OK, "ADVISOR_STATS_TOKEN": f"  {token}\n"})["app"]["stats_token"] == token
    assert run(monkeypatch, {**SAMPLE_OK, "ADVISOR_STATS_TOKEN": " \n "})["app"]["stats_token"] is None


def test_the_data_dir_defaults_to_data_and_resolves_against_the_code():
    assert server.data_dir({}) == server.ROOT / "data"
    assert server.data_dir({"ADVISOR_DATA_DIR": ""}) == server.ROOT / "data"
    assert server.data_dir({"ADVISOR_DATA_DIR": "state"}) == server.ROOT / "state"
    assert server.data_dir({"ADVISOR_DATA_DIR": "/srv/volume"}) == server.Path("/srv/volume")


def test_the_data_dir_can_never_be_the_root_the_code_or_a_parent_of_it(monkeypatch):
    # The start script hands the data directory to the app user: that must never be the code or the whole disk.
    for value in ("/", "//", str(server.ROOT), str(server.ROOT) + "/", ".", "./", "..", str(server.ROOT.parent),
                  "data/..", "/" + "/".join([".."] * 12)):
        with pytest.raises(SystemExit) as stopped:
            server.data_dir({"ADVISOR_DATA_DIR": value})
        assert "ADVISOR_DATA_DIR" in str(stopped.value.code), value
    with pytest.raises(SystemExit):
        run(monkeypatch, {**SAMPLE_OK, "ADVISOR_DATA_DIR": "/"})


def test_clicks_photos_and_push_subscriptions_live_in_the_data_dir(tmp_path, monkeypatch):
    private, public = mint()
    volume = tmp_path / "volume"
    monkeypatch.setattr(server, "DEMO_SOURCES", frozenset())  # as a live source would: it asks for photos
    env = {**SAMPLE_OK, "ADVISOR_SOURCE": "replay", "ADVISOR_DATA_DIR": str(volume),
           "ADVISOR_VAPID_PRIVATE": private, "ADVISOR_VAPID_PUBLIC": public,
           "ADVISOR_VAPID_SUBJECT": "mailto:hello@marketpalace.example"}
    seen = run(monkeypatch, env)
    assert seen["paths"] == {
        "clicks": volume / "clicks.json", "push": volume / "push.json", "photos": volume / "photos",
        "visits": volume / "visits.json",
    }


def test_the_demo_matches_photos_by_name_in_a_cache_of_its_own_and_warms_it(tmp_path, monkeypatch):
    # The demo's players are real names with invented ids: no id URL may ever be built from them, and what it finds
    # never mixes with the live store's photos/.
    seen = run(monkeypatch, {**SAMPLE_OK, "ADVISOR_DATA_DIR": str(tmp_path / "volume")})
    photos = seen["app"]["photos"]
    assert seen["paths"]["photos"] == tmp_path / "volume" / "photos-demo"
    assert photos.ids_are_real is False
    assert any(target == photos.warm for target, _, _ in seen["threads"])


def test_a_live_source_keeps_the_id_urls_in_photos(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DEMO_SOURCES", frozenset())
    seen = run(monkeypatch, {**SAMPLE_OK, "ADVISOR_SOURCE": "replay", "ADVISOR_DATA_DIR": str(tmp_path / "volume")})
    assert seen["app"]["photos"].ids_are_real is True
    assert seen["paths"]["photos"] == tmp_path / "volume" / "photos"


def test_without_vapid_keys_push_stays_off(monkeypatch):
    seen = run(monkeypatch, SAMPLE_OK)
    assert seen["app"]["push"] is None
    assert collector_kwargs(seen).get("dispatcher") is None
    assert isinstance(seen["app"]["importer"], DemoImporter)  # the sample data links a sample account


def test_with_vapid_keys_the_dispatcher_runs(monkeypatch):
    private, public = mint()
    for subject in ("https://marketpalace.example/contact", "mailto:hello@marketpalace.example"):
        env = {**SAMPLE_OK, "ADVISOR_VAPID_PRIVATE": private, "ADVISOR_VAPID_PUBLIC": public,
               "ADVISOR_VAPID_SUBJECT": subject}
        seen = run(monkeypatch, env)
        assert seen["app"]["push"] is not None, subject
        assert collector_kwargs(seen)["dispatcher"] is seen["app"]["push"], subject
        assert seen["app"]["push"].link["public_key"] == public, subject


# --- ADVISOR_SOURCE=feed --------------------------------------------------------------------------------------------

FEED_TOKEN = "t0k3n-" + "ab12cd34ef56" * 4  # 54 characters
FEED_ENV = {"ADVISOR_SOURCE": "feed", "ADVISOR_FEED_URL": "https://feed.example.test/market",
            "ADVISOR_FEED_TOKEN": FEED_TOKEN}


def test_a_feed_start_is_live_not_demo_with_real_deal_links_and_photos_from_real_ids(tmp_path, capsys, monkeypatch):
    # PORT is set, as on a platform, and no ADVISOR_ALLOW_DEMO: the feed is a named source, so it starts.
    seen = run(monkeypatch, {**FEED_ENV, "PORT": "0", "ADVISOR_DATA_DIR": str(tmp_path / "volume")})
    [source] = [args[0] for target, args, _ in seen["threads"] if target is server.run_collector]
    assert isinstance(source, FeedSource)
    assert source.memory_path == tmp_path / "volume" / "feed-memory.json"  # what the feed sent outlives restarts
    assert isinstance(seen["app"]["importer"], PassImporter)  # a username's passes, through the same feed
    assert collector_kwargs(seen)["demo"] is False
    assert seen["app"]["photos"].ids_are_real is True
    assert seen["paths"]["photos"] == tmp_path / "volume" / "photos"
    shown = capsys.readouterr().out
    assert "source: feed" in shown and FEED_TOKEN not in shown and "feed.example.test" not in shown


def test_a_feed_start_without_its_address_or_with_a_bad_one_stops_with_a_message_that_names_the_setting(monkeypatch):
    for url in (None, "", "http://feed.example.test/market", "ftp://feed.example.test/x", "feed.example.test"):
        env = {key: value for key, value in FEED_ENV.items() if key != "ADVISOR_FEED_URL"}
        if url is not None:
            env["ADVISOR_FEED_URL"] = url
        with pytest.raises(SystemExit) as stopped:
            run(monkeypatch, env)
        message = str(stopped.value.code)
        assert "ADVISOR_FEED_URL" in message and FEED_TOKEN not in message, url


def test_a_feed_start_with_a_missing_or_short_token_stops_without_echoing_it(monkeypatch):
    for token in (None, "", "   ", "abc123", "q" * (FEED_TOKEN_MIN_CHARS - 1), "q" * 40 + " " + "w" * 40):
        env = {key: value for key, value in FEED_ENV.items() if key != "ADVISOR_FEED_TOKEN"}
        if token is not None:
            env["ADVISOR_FEED_TOKEN"] = token
        with pytest.raises(SystemExit) as stopped:
            run(monkeypatch, env)
        message = str(stopped.value.code)
        assert "ADVISOR_FEED_TOKEN" in message and (len(token or "") < 6 or token.strip() not in message), repr(token)
    seen = run(monkeypatch, {**FEED_ENV, "ADVISOR_FEED_TOKEN": "q" * FEED_TOKEN_MIN_CHARS})
    assert seen["serve"]


def test_the_token_is_trimmed_like_the_stats_token_so_a_file_with_a_newline_works(monkeypatch):
    seen = run(monkeypatch, {**FEED_ENV, "ADVISOR_FEED_TOKEN": FEED_TOKEN + "\n"})
    assert seen["serve"]


def test_the_feed_settings_are_read_only_when_the_feed_is_the_source(monkeypatch):
    seen = run(monkeypatch, {**SAMPLE_OK, "ADVISOR_FEED_URL": "nonsense", "ADVISOR_FEED_TOKEN": "x"})
    assert seen["serve"]  # the demo ignores them


def test_the_unknown_source_message_lists_the_feed(monkeypatch):
    with pytest.raises(SystemExit) as stopped:
        run(monkeypatch, {"ADVISOR_SOURCE": "nonsense"})
    assert "feed" in str(stopped.value.code) and "nonsense" in str(stopped.value.code)


def test_waitress_has_room_for_slow_account_lookups_beside_the_page():
    assert server.WAITRESS["threads"] == server.WEB_THREADS == 16


def test_the_feeds_memory_is_saved_when_the_server_stops(tmp_path, monkeypatch):
    from advisor.sources.memory import FeedMemory

    flushed = []
    monkeypatch.setattr(FeedMemory, "flush", lambda self: flushed.append(self.path))
    run(monkeypatch, {**FEED_ENV, "PORT": "0", "ADVISOR_DATA_DIR": str(tmp_path / "volume")})
    assert flushed == [tmp_path / "volume" / "feed-memory.json"]

    def stopped(app, **kw):  # a redeploy's SIGTERM ends serve() with SystemExit: the memory is still saved
        raise SystemExit(0)

    flushed.clear()
    monkeypatch.setattr(server, "serve", stopped)
    with pytest.raises(SystemExit):
        server.main()
    assert flushed == [tmp_path / "volume" / "feed-memory.json"]


def test_the_resale_table_is_read_only_from_the_live_feed_and_only_with_its_address_and_token():
    env = {"ADVISOR_FEED_URL": " https://feed.example.internal/internal/market-feed \n", "ADVISOR_FEED_TOKEN": "t" * 40 + "\n"}
    board, view = server.make_resale("feed", env)
    assert board is not None and view is not None
    assert "feed.example" not in repr(board) and "t" * 40 not in repr(view)
    for name in ("replay", "fixture"):
        assert server.make_resale(name, env) == (None, None)  # the sample data has no real players to count
    assert server.make_resale("feed", {}) == (None, None)
    assert server.make_resale("feed", {"ADVISOR_FEED_URL": env["ADVISOR_FEED_URL"]}) == (None, None)


def test_without_the_discord_settings_the_gate_is_off(monkeypatch):
    seen = run(monkeypatch, SAMPLE_OK)
    assert seen["app"]["gate"] is None


def test_with_all_six_discord_settings_the_gate_is_on_with_the_invite_as_its_fallback(monkeypatch):
    monkeypatch.setattr(server, "COMMUNITY_URL", "https://discord.gg/palace")
    seen = run(monkeypatch, {**SAMPLE_OK, **GATE_ENV})
    gate = seen["app"]["gate"]
    assert isinstance(gate, server.DiscordGate) and gate.invite_url == "https://discord.gg/palace"


@pytest.mark.parametrize("missing", list(GATE_ENV))
def test_a_half_set_gate_stops_the_server_naming_the_setting_never_a_secret(monkeypatch, missing):
    env = {**SAMPLE_OK, **{key: value for key, value in GATE_ENV.items() if key != missing}}
    with pytest.raises(SystemExit) as stopped:
        run(monkeypatch, env)
    message = str(stopped.value.code)
    assert missing in message and not any(secret in message for secret in GATE_SECRETS)


@pytest.mark.parametrize("settings", [{}, {key: GATE_ENV[key] for key in list(GATE_ENV)[:3]}])
def test_require_gate_refuses_to_start_without_a_complete_gate(monkeypatch, settings):
    with pytest.raises(SystemExit) as stopped:
        run(monkeypatch, {**SAMPLE_OK, **settings, "ADVISOR_REQUIRE_GATE": "1"})
    message = str(stopped.value.code)
    assert (not settings and "ADVISOR_REQUIRE_GATE" in message or settings) and not any(secret in message for secret in GATE_SECRETS)


def test_require_gate_lets_a_complete_gate_start(monkeypatch):
    assert run(monkeypatch, {**SAMPLE_OK, **GATE_ENV, "ADVISOR_REQUIRE_GATE": "1"})["app"]["gate"] is not None


def test_require_gate_set_to_zero_changes_nothing(monkeypatch):
    assert run(monkeypatch, {**SAMPLE_OK, "ADVISOR_REQUIRE_GATE": "0"})["app"]["gate"] is None


def test_a_short_session_secret_stops_the_server(monkeypatch):
    with pytest.raises(SystemExit) as stopped:
        run(monkeypatch, {**SAMPLE_OK, **GATE_ENV, "ADVISOR_SESSION_SECRET": "too-short"})
    assert "ADVISOR_SESSION_SECRET" in str(stopped.value.code) and "too-short" not in str(stopped.value.code)


def test_without_the_public_key_there_are_no_slash_commands(monkeypatch):
    seen = run(monkeypatch, {**SAMPLE_OK, **GATE_ENV})
    assert seen["app"]["interactions"] is None


def test_with_the_public_key_and_the_gate_the_slash_commands_read_the_served_snapshot(monkeypatch):
    seen = run(monkeypatch, {**SAMPLE_OK, **COMMANDS_ENV})
    interactions = seen["app"]["interactions"]
    assert isinstance(interactions, server.Interactions)
    assert interactions._store is seen["app_args"][0]


@pytest.mark.parametrize("env, named", [
    ({"ADVISOR_DISCORD_PUBLIC_KEY": COMMANDS_ENV["ADVISOR_DISCORD_PUBLIC_KEY"]}, "gate"),
    ({**COMMANDS_ENV, "ADVISOR_DISCORD_PUBLIC_KEY": "not-a-key"}, "64 hex"),
])
def test_a_public_key_that_cannot_be_used_stops_the_server(monkeypatch, env, named):
    with pytest.raises(SystemExit) as stopped:
        run(monkeypatch, {**SAMPLE_OK, **env})
    message = str(stopped.value.code)
    assert "ADVISOR_DISCORD_PUBLIC_KEY" in message and named in message
    assert not any(secret in message for secret in GATE_SECRETS)


def test_with_the_gate_on_alerts_go_only_where_the_gate_allows(monkeypatch):
    private, public = mint()
    env = {**SAMPLE_OK, **GATE_ENV, "ADVISOR_VAPID_PRIVATE": private, "ADVISOR_VAPID_PUBLIC": public,
           "ADVISOR_VAPID_SUBJECT": "https://marketpalace.example"}
    seen = run(monkeypatch, env)
    assert seen["app"]["push"].allowed == seen["app"]["gate"].may_alert
    for key in GATE_ENV:
        monkeypatch.delenv(key)
    seen = run(monkeypatch, {key: value for key, value in env.items() if key not in GATE_ENV})
    assert seen["app"]["push"].allowed is None


def poster_threads(seen):
    return [(args, kwargs) for target, args, kwargs in seen["threads"] if target is server.run_poster]


def test_the_discord_poster_runs_on_the_live_market_with_the_gate_and_keeps_its_memory_in_the_data_dir(monkeypatch, tmp_path):
    seen = run(monkeypatch, {"PORT": "0", **FEED_ENV, **GATE_ENV})
    ((poster, store, stop), _), = poster_threads(seen)
    assert isinstance(poster, server.Poster) and poster.log.path == tmp_path / "data" / "discord-posts.json"
    assert isinstance(store, server.SnapshotStore) and stop.is_set()  # set once the stubbed server returned


@pytest.mark.parametrize("env", [
    {"PORT": "0", **FEED_ENV},  # no gate, no bot
    {"PORT": "0", **FEED_ENV, **GATE_ENV, "ADVISOR_DISCORD_POST": "0"},  # turned off
    {**SAMPLE_OK, **GATE_ENV},  # sample data is never posted
])
def test_the_discord_poster_stays_off_without_the_gate_when_turned_off_or_on_sample_data(monkeypatch, env):
    assert poster_threads(run(monkeypatch, env)) == []


def perk_threads(seen):
    return [args for target, args, _ in seen["threads"] if getattr(target, "__name__", "") == "run"]


def test_with_the_gate_linked_accounts_are_kept_in_the_data_dir_and_the_perks_run_on_the_live_market(monkeypatch, tmp_path):
    seen = run(monkeypatch, {"PORT": "0", **FEED_ENV, **GATE_ENV})
    links = seen["app"]["links"]
    assert isinstance(links, MemberLinks) and links.path == tmp_path / "data" / "member-links.json"
    assert seen["app"]["perks"] is not None and seen["app"]["perks"].links is links
    assert len(perk_threads(seen)) == 1
    assert collector_kwargs(seen)["accounts"] is True


def test_the_invite_board_rides_on_the_perks_worker_and_has_its_own_switch(monkeypatch, tmp_path):
    from advisor.discord_invites import InviteBoard

    seen = run(monkeypatch, {"PORT": "0", **FEED_ENV, **GATE_ENV})
    board = seen["app"]["perks"].invites
    assert isinstance(board, InviteBoard) and board.path == tmp_path / "data" / "invites.json"
    seen = run(monkeypatch, {"PORT": "0", **FEED_ENV, **GATE_ENV, "ADVISOR_DISCORD_INVITES": "0"})
    assert seen["app"]["perks"] is not None and seen["app"]["perks"].invites is None


@pytest.mark.parametrize("env", [
    {"PORT": "0", **FEED_ENV, **GATE_ENV, "ADVISOR_DISCORD_PERKS": "0"},  # turned off
    {**SAMPLE_OK, **GATE_ENV},  # a sample account earns no role
])
def test_the_perks_stay_off_when_turned_off_or_on_sample_data(monkeypatch, env):
    seen = run(monkeypatch, env)
    assert seen["app"]["perks"] is None and perk_threads(seen) == []
    assert isinstance(seen["app"]["links"], MemberLinks)


def test_without_the_gate_no_account_is_kept_on_the_server(monkeypatch):
    seen = run(monkeypatch, {"PORT": "0", **FEED_ENV})
    assert seen["app"]["links"] is None and seen["app"]["perks"] is None


# --- visits and the admin panel ------------------------------------------------------------------------------------


def test_visits_live_in_the_data_dir_and_are_flushed_by_a_thread_of_their_own(tmp_path, monkeypatch):
    seen = run(monkeypatch, SAMPLE_OK)
    assert seen["paths"]["visits"] == tmp_path / "data" / "visits.json"
    assert isinstance(seen["app"]["visits"], VisitLog)
    assert any(target is run_flusher for target, _, _ in seen["threads"])
    assert seen["app"]["admin_ids"] == frozenset()
    # Without the gate nobody is signed in: no member is ever followed, and Discord is never asked for a count.
    assert seen["app"]["visits"].member_hash("111122223333444455") is None
    assert not any(target is run_discord_counter for target, _, _ in seen["threads"])


def test_admin_ids_are_read_as_a_comma_list(monkeypatch):
    seen = run(monkeypatch, {**SAMPLE_OK, "ADVISOR_ADMIN_DISCORD_IDS": " 188573203822673920, 111122223333444455 ,"})
    assert seen["app"]["admin_ids"] == frozenset({"188573203822673920", "111122223333444455"})


@pytest.mark.parametrize("bad", ["me", "1885732038", "188573203822673920;drop", "18857320382267392O"])
def test_an_admin_id_that_is_no_discord_id_stops_the_server_naming_the_setting(monkeypatch, bad):
    monkeypatch.setenv("ADVISOR_ADMIN_DISCORD_IDS", bad)
    with pytest.raises(SystemExit) as stopped:
        server.refuse_unsafe_settings(os.environ)
    assert "ADVISOR_ADMIN_DISCORD_IDS" in str(stopped.value) and bad not in str(stopped.value)


def test_with_the_gate_members_are_hashed_with_a_key_from_the_session_secret_and_discord_is_counted(monkeypatch):
    seen = run(monkeypatch, {**SAMPLE_OK, **GATE_ENV})
    visits = seen["app"]["visits"]
    mark = visits.member_hash("111122223333444455")
    assert mark and "111122223333444455" not in mark
    assert all(secret not in mark for secret in GATE_SECRETS)
    assert any(target is run_discord_counter for target, _, _ in seen["threads"])
