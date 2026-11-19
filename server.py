"""Starts the advisor: the collector in a background thread, the web app in front of it.

    uv run python server.py

Environment: ADVISOR_SOURCE (replay, the default, fixture, or feed: the live market, read from a private feed that
needs ADVISOR_FEED_URL, its https:// address, and ADVISOR_FEED_TOKEN, its bearer token of at least
rules.FEED_TOKEN_MIN_CHARS characters; the server refuses to start without them, and never prints either), PORT (8795),
ADVISOR_ALLOW_DEMO (1 lets a platform start, one with PORT set, serve the sample data without naming a source),
ADVISOR_INTERVAL_S (seconds between refreshes, rules.COLLECT_INTERVAL_S by default),
ADVISOR_STALE_AFTER_S (read in advisor/rules.py: the age past which the data counts as stale),
ADVISOR_STATS_TOKEN (the bearer token that reads the click counts at /api/stats, at least
rules.STATS_TOKEN_MIN_CHARS characters; unset, there is no such page),
ADVISOR_COMMUNITY_URL (our Discord invite, read in advisor/rules.py; unset, the community link stays hidden),
ADVISOR_SUPPORT_URL (a Real share link to a card of the account a gift of Rax goes to, read in advisor/rules.py;
unset, the "Support the Palace" page names the account only),
ADVISOR_VAPID_PRIVATE, ADVISOR_VAPID_PUBLIC and ADVISOR_VAPID_SUBJECT (the alerts' keypair from
scripts/gen_vapid.py and the site's https:// address or mailto: of the site; unset, there are no alerts at all,
see advisor/push.py),
ADVISOR_DATA_DIR (where the server keeps what it writes, data/ by default; a relative path is taken from this
file's directory),
ADVISOR_ADMIN_DISCORD_IDS (a comma list of the Discord user ids that may open the admin panel at /admin, with its
figures at /api/admin/stats; unset or empty, both answer 404. It needs the Discord gate: the panel is opened signed
in with Discord. A value that is no Discord id stops the server).
The page's anonymous visit beacon is counted in visits.json of the data directory (advisor/visits.py), written every
rules.VISIT_FLUSH_S seconds; with the gate on, a signed-in member is kept there only as a hash keyed from
ADVISOR_SESSION_SECRET, and the bot reads our server's member count every rules.DISCORD_COUNT_EVERY_S seconds.
What each device and each signed-in member does on the site (the page's batched events, the visits, the logins, the
account lookups, the links) is kept in activity.db of the data directory (advisor/activity.py, SQLite), written every
rules.ACTIVITY_FLUSH_S seconds by a thread of its own, for the admin panel's deep tabs. With the gate on, the bot also
reads our Discord every rules.DISCORD_ACTIVITY_EVERY_S seconds, GET only (advisor/discord_activity.py: messages counted
per channel, day and author, joins, leaves, roles, reactions on its posts); ADVISOR_DISCORD_ACTIVITY=0 turns that off.

The Discord gate (advisor/discord_gate.py: the site is free for everyone, and members of our Discord server, free too,
get every deal, the full moves, their own plan and pings; anyone else gets the free site, advisor/public.py) needs six settings, all
or none: ADVISOR_DISCORD_CLIENT_ID and ADVISOR_DISCORD_CLIENT_SECRET (the Discord application's OAuth2 id and secret),
ADVISOR_DISCORD_BOT_TOKEN (its bot's token; the bot sits in our server with the Create Instant Invite permission, which
adding a member takes), ADVISOR_DISCORD_GUILD_ID (our server's id), ADVISOR_SESSION_SECRET (at least
discord_gate.SESSION_SECRET_MIN_CHARS random characters that sign the login cookies) and ADVISOR_PUBLIC_URL (the
site's https:// address alone; Discord sends visitors back to <it>/auth/discord/callback, which must be registered as
a redirect in the Developer Portal). None set, the gate is off and the site is open to everyone; some set, or one
that cannot be used, and the server refuses to start, naming the setting but never printing its value. When a login
fails, its page offers ADVISOR_COMMUNITY_URL, the invite, as the way to join by hand.
With the gate's settings, on the live market, the bot also posts in our server (advisor/discord_post.py): the best
new deals in #live-deals and the day's pass picks in #otd-picks, remembered in discord-posts.json of the data
directory, with "What's new" in #announcements (advisor/whatsnew.json), the Monday digest and the season-clock
heads-ups in #market-talk. ADVISOR_DISCORD_POST=0 turns that off; ADVISOR_DISCORD_DEALS_CHANNEL,
ADVISOR_DISCORD_OTD_CHANNEL, ADVISOR_DISCORD_ANNOUNCE_CHANNEL, ADVISOR_DISCORD_TALK_CHANNEL and
ADVISOR_DISCORD_ALERTS_ROLE name ids instead of finding the channels and the Deal Alerts role by name.
With the gate on, a member's linked Real account is kept in member-links.json of the data directory
(advisor/members.py), and on the live market the bot gives roles from it, keeps #linked-lounge and #big-accounts and
DMs personal deal pings (advisor/discord_perks.py); ADVISOR_DISCORD_PERKS=0 turns the bot's part off.
With the gate on, ADVISOR_DISCORD_PUBLIC_KEY (the application's public key, 64 hex characters) turns on our Discord
slash commands (advisor/discord_commands.py), answered at <ADVISOR_PUBLIC_URL>/discord/interactions, the Interactions
Endpoint URL of the Developer Portal; set without the gate, or not a key, and the server refuses to start. They
include /link, /unlink and /me (the member's own account, from inside Discord) and the role picker's buttons.
Outbound click counts are kept in clicks.json of the data directory, push subscriptions in push.json, player photos
in photos/. The demo sources' players carry real names but invented ids, so their photos are matched by name only,
never from an id, in photos-demo/ (a cache of its own, so invented ids never mix with the live ones).
The demo market itself ships inside the package, in advisor/fixtures/.
"""

import hashlib
import hmac
import os
import re
import signal
import sys
import threading
from pathlib import Path

from waitress import serve

from advisor.clicks import ClickLog
from advisor.collector import run_collector
from advisor.discord_commands import Interactions, config_from_env as commands_config_from_env
from advisor.discord_commands import config_problem as commands_problem
from advisor.discord_gate import DiscordGate, config_from_env as gate_config_from_env, config_problem as gate_problem
from advisor.discord_invites import SWITCH_ENV as INVITES_SWITCH_ENV, InviteBoard
from advisor.discord_perks import PerkBot, PerkWorker, config_from_env as perks_config_from_env
from advisor.discord_post import Poster, config_from_env as post_config_from_env, run_poster
from advisor.importer import DemoImporter, PassImporter
from advisor.members import MemberLinks
from advisor.injuries import InjuryBoard, InjuryView, run_injuries
from advisor.photos import PhotoStore
from advisor.price_history import PriceHistory
from advisor.push import Dispatcher, PushStore, WebPushSender, config_from_env
from advisor.resale import ResaleBoard, ResaleView, fetch_table, run_resale
from advisor.rules import COLLECT_INTERVAL_S, COMMUNITY_URL, REQUEST_MAX_BYTES, STATS_TOKEN_MIN_CHARS
from advisor.sources.base import Source
from advisor.sources.feed import FeedSource, config_problem
from advisor.sources.memory import FeedMemory
from advisor.sources.fixture import FixtureSource, ReplaySource
from advisor.store import SnapshotStore
from advisor.visits import VisitLog, run_discord_counter, run_flusher
from advisor.activity import ActivityLog, run_writer
from advisor.discord_activity import DiscordReader, config_from_env as reader_config_from_env, run_reader
from advisor.web import create_app

ROOT = Path(__file__).resolve().parent
FIXTURE_PATH = ROOT / "advisor" / "fixtures" / "demo_raw.json"  # read-only, part of the code
STATIC_DIR = ROOT / "advisor" / "static"
DEFAULT_DATA_DIR = "data"  # git-ignored
SOURCES = {"replay": ReplaySource, "fixture": FixtureSource}
SOURCE_NAMES = (*SOURCES, "feed")  # the feed is built from its own settings, not from the bundled fixture
DEMO_SOURCES = frozenset({"replay", "fixture"})  # the bundled sample data: the screens tag it "Sample data"
DEFAULT_PORT = 8795
# Room for the page and its polling beside the account lookups, each of which may hold a thread for up to
# rules.IMPORT_TIMEOUT_S (at most rules.IMPORT_MAX_CONCURRENT of them at once).
WEB_THREADS = 16
# How waitress serves the app. It turns away only a body well past the biggest any route takes (REQUEST_MAX_BYTES),
# so a small overrun gets the app's own 413 with its headers; ident="" sends no Server header naming the stack. It
# takes the scheme from the X-Forwarded-Proto of the platform's https proxy (so HSTS goes out over https) and drops
# every other proxy header, so a visitor's own X-Forwarded-For never changes the peer address.
WAITRESS = {
    "threads": WEB_THREADS,
    "max_request_body_size": REQUEST_MAX_BYTES,
    "ident": "",
    "trusted_proxy": "*",
    "trusted_proxy_headers": {"x-forwarded-proto"},
}


ADMIN_IDS_SETTING = "ADVISOR_ADMIN_DISCORD_IDS"
_SNOWFLAKE = re.compile(r"\d{15,21}")


def admin_ids(env) -> frozenset[str]:
    """The Discord ids in ADVISOR_ADMIN_DISCORD_IDS (a comma list; blanks ignored), checked by
    `refuse_unsafe_settings` first."""
    return frozenset(part.strip() for part in (env.get(ADMIN_IDS_SETTING) or "").split(",") if part.strip())


def visit_member_key(gate: DiscordGate | None, env) -> bytes | None:
    """The key that hashes a signed-in member's Discord id in the visit log: derived from the session secret, so the
    hash is stable across restarts and cannot be turned back into an id without the secret. None without the gate."""
    if gate is None:
        return None
    secret = (env.get("ADVISOR_SESSION_SECRET") or "").strip().encode()
    return hmac.new(secret, b"otd-palace.visits.member", hashlib.sha256).digest()


def feed_settings(env) -> tuple[str, str]:
    """The feed's address and token, trimmed (a token read from a file may end in a newline)."""
    return (env.get("ADVISOR_FEED_URL") or "").strip(), (env.get("ADVISOR_FEED_TOKEN") or "").strip()


def make_resale(source_name: str, env=os.environ):
    """(board, view) of the resale table, read from the feed's `/resale` route (see `advisor.resale`); (None, None) off
    the live feed or without its address and token: the sample data has no real players to count."""
    url, token = feed_settings(env)
    if source_name != "feed" or not url or not token:
        return None, None
    board = ResaleBoard(lambda: fetch_table(url, token))
    return board, ResaleView(board)


def make_source(name: str, env=os.environ, data: Path | None = None) -> Source:
    """The named source; the feed remembers what it sent in `data` (see `advisor.sources.memory`)."""
    if name not in SOURCE_NAMES:
        raise SystemExit(f"ADVISOR_SOURCE must be one of {', '.join(SOURCE_NAMES)}, not {name!r}")
    if name == "feed":
        memory = FeedMemory(None if data is None else data / "feed-memory.json")
        return FeedSource(*feed_settings(env), memory=memory)
    return SOURCES[name](FIXTURE_PATH)


def make_history(name: str, data: Path | None = None) -> PriceHistory:
    """The price curve's memory (see `advisor.price_history`): kept in `data` on the live feed, so a curve grows past
    the week the sales tape holds and outlives a restart; in memory only on the sample data."""
    return PriceHistory(data / "price-history.json" if name == "feed" and data is not None else None)


def data_dir(env) -> Path:
    """Where the server keeps what it writes: ADVISOR_DATA_DIR, data/ by default, relative to this file's directory.

    Never the code's own directory, the root of the disk or any directory above the code: the image's start script
    hands the data directory over to the app user, which must never own the code (it mirrors this refusal)."""
    data = ROOT / (env.get("ADVISOR_DATA_DIR") or DEFAULT_DATA_DIR)
    resolved, root = data.resolve(), ROOT.resolve()
    if resolved == root or resolved in root.parents:
        raise SystemExit(
            f"ADVISOR_DATA_DIR must be a directory of its own, not {resolved}, which holds the code; "
            "leave it unset for data/."
        )
    return data


def refuse_unsafe_settings(env) -> None:
    """Stops the server before it starts on settings that would put it at risk in public: the invented demo market
    served by a platform deploy (PORT set) that never named a source, a stats token too short to be safe, a feed
    source without a usable address and token, a Discord gate half set up or set with a value it cannot use, and a
    slash-command key without the gate or that is no key (the message names the setting, never its value)."""
    if "ADVISOR_SOURCE" not in env and "PORT" in env and env.get("ADVISOR_ALLOW_DEMO") != "1":
        raise SystemExit(
            "ADVISOR_SOURCE is not set, so this deploy would serve the invented demo market as if it were live. "
            "Set ADVISOR_SOURCE, or ADVISOR_ALLOW_DEMO=1 to serve the sample data on purpose."
        )
    if env.get("ADVISOR_SOURCE") == "feed":
        problem = config_problem(*feed_settings(env))
        if problem is not None:
            raise SystemExit(problem)
    token = (env.get("ADVISOR_STATS_TOKEN") or "").strip()
    if token and len(token) < STATS_TOKEN_MIN_CHARS:
        raise SystemExit(
            f"ADVISOR_STATS_TOKEN is too short: use at least {STATS_TOKEN_MIN_CHARS} random characters, "
            "or leave it unset to turn /api/stats off."
        )
    if not all(_SNOWFLAKE.fullmatch(part) for part in admin_ids(env)):
        raise SystemExit(f"{ADMIN_IDS_SETTING} must be a comma list of Discord user ids (15 to 21 digits each), "
                         "or unset to turn the admin panel off.")
    problem = gate_problem(env) or commands_problem(env)
    if problem is not None:
        raise SystemExit(problem)
    if env.get("ADVISOR_REQUIRE_GATE") == "1" and gate_config_from_env(env) is None:
        raise SystemExit(
            "ADVISOR_REQUIRE_GATE=1 but the Discord gate's settings are not all set, so everyone would get the whole "
            "site, members' extras included. Set all six gate settings (see the README), or unset ADVISOR_REQUIRE_GATE."
        )


def make_gate(env) -> DiscordGate | None:
    """The Discord gate when its six settings are set (checked by `refuse_unsafe_settings` first), else None."""
    config = gate_config_from_env(env)
    return None if config is None else DiscordGate(config, invite_url=COMMUNITY_URL)


def make_poster(env, data: Path, demo: bool) -> Poster | None:
    """The Discord poster when the gate's settings exist and ADVISOR_DISCORD_POST is not "0", else None; never on
    the sample data, whose deals are invented."""
    config = None if demo else post_config_from_env(env)
    return None if config is None else Poster(config, data / "discord-posts.json")
def make_interactions(env, store: SnapshotStore, links=None, importer=None, perks=None) -> Interactions | None:
    """The slash commands, reading `store`, when their key and the gate are set (checked by `refuse_unsafe_settings`
    first), else None. With the members' links and the importer, /link, /unlink and /me work from inside Discord; with
    the perks worker, linking sets the member's roles and the role buttons in #welcome work."""
    config = commands_config_from_env(env)
    return None if config is None else Interactions(config, store, links=links, importer=importer, perks=perks)


def make_importer(source_name: str, store: SnapshotStore, env=os.environ):
    """What reads a Real account's passes: through the private feed on the live market, or a sample account made from
    the sample data's own passes (`DemoImporter`), so the demo shows linking too."""
    if source_name == "feed":
        return PassImporter(*feed_settings(env))
    return DemoImporter(store)


def make_links(gate: DiscordGate | None, data: Path) -> MemberLinks | None:
    """The members' linked accounts, kept with the gate on only: without it nobody has a Discord id."""
    return None if gate is None else MemberLinks(data / "member-links.json")


def make_perks(env, links: MemberLinks | None, demo: bool, data: Path | None = None) -> PerkWorker | None:
    """The bot's roles, lounges and personal pings for linked members (advisor/discord_perks.py): with the gate's
    settings, ADVISOR_DISCORD_PERKS not "0" and on the live market only (a sample account earns no role). With the
    data directory, the same worker reads the invite board (advisor/discord_invites.py, /invites), kept in
    invites.json; ADVISOR_DISCORD_INVITES=0 turns the board off alone."""
    config = None if demo or links is None else perks_config_from_env(env)
    if config is None:
        return None
    worker = PerkWorker(PerkBot(config), links)
    if data is not None and (env.get(INVITES_SWITCH_ENV) or "").strip() != "0":
        worker.invites = InviteBoard(data / "invites.json")
    return worker


def main() -> None:
    refuse_unsafe_settings(os.environ)
    source_name = os.environ.get("ADVISOR_SOURCE", "replay")
    port = int(os.environ.get("PORT", DEFAULT_PORT))
    interval_s = float(os.environ.get("ADVISOR_INTERVAL_S", COLLECT_INTERVAL_S))
    stats_token = (os.environ.get("ADVISOR_STATS_TOKEN") or "").strip() or None
    data = data_dir(os.environ)

    store = SnapshotStore()
    clicks = ClickLog(data / "clicks.json")
    demo = source_name in DEMO_SOURCES
    photos = PhotoStore(data / "photos-demo", ids_are_real=False) if demo else PhotoStore(data / "photos")
    push_config = config_from_env(os.environ)
    gate = make_gate(os.environ)
    push = None
    if push_config is not None:
        push = Dispatcher(PushStore(data / "push.json"), WebPushSender(push_config), push_config.public_key, interval_s)
        if gate is not None:
            push.allowed = gate.may_alert  # alerts only for members: they stop when the membership does
        push.start()
    stop = threading.Event()
    source = make_source(source_name, os.environ, data)
    # Who is hurt, from ESPN's public list, joined to the deals' players by their exact ESPN id. Live data only: the
    # demo's players carry real names but invented ids.
    injury_board = None if demo else InjuryBoard()
    injuries = None if injury_board is None else InjuryView(injury_board, photos)
    # How many recent listings of a deal's player sold, from the feed's own resale route (live feed only).
    resale_board, resale = make_resale(source_name, os.environ)
    # A visitor's passes from their Real username: through the same private feed on the live market.
    importer = make_importer(source_name, store)
    # Each price move's curve: its market's middle sale a finished day, remembered past the tape's week.
    history = make_history(source_name, data)
    collector = threading.Thread(
        target=run_collector,
        args=(source, store, stop, interval_s),
        kwargs={"demo": demo, "dispatcher": push, "injuries": injuries, "resale": resale,
                "accounts": importer is not None, "history": history},
        daemon=True,
    )
    collector.start()
    if injury_board is not None:
        threading.Thread(target=run_injuries, args=(injury_board, stop), name="injuries", daemon=True).start()
    if resale_board is not None:
        threading.Thread(target=run_resale, args=(resale_board, stop), name="resale", daemon=True).start()
    # The best new deals and the day's pass picks, posted in our Discord server.
    poster = make_poster(os.environ, data, demo)
    if poster is not None:
        threading.Thread(target=run_poster, args=(poster, store, stop), name="discord-post", daemon=True).start()
    # Members' linked accounts, and what linking unlocks in our Discord.
    links = make_links(gate, data)
    perks = make_perks(os.environ, links, demo, data)
    if perks is not None:
        threading.Thread(target=perks.run, args=(store, stop), name="discord-perks", daemon=True).start()
    # Visits for the admin panel, written by a thread of their own; our Discord server's member count, read hourly.
    visits = VisitLog(data / "visits.json", member_key=visit_member_key(gate, os.environ))
    threading.Thread(target=run_flusher, args=(visits, stop), name="visits-flush", daemon=True).start()
    if gate is not None:
        threading.Thread(target=run_discord_counter, args=(visits, gate.member_count, stop), name="discord-count",
                         daemon=True).start()
    # Every device's and member's activity for the admin panel's deep tabs, and our Discord read by the bot (GET only).
    activity = ActivityLog(data / "activity.db")
    threading.Thread(target=run_writer, args=(activity, stop), name="activity-write", daemon=True).start()
    reader_config = reader_config_from_env(os.environ)
    if reader_config is not None:
        reader = DiscordReader(reader_config, activity, pause=stop.wait)
        threading.Thread(target=run_reader, args=(reader, stop), name="discord-activity", daemon=True).start()
    admins = admin_ids(os.environ)
    # The name-to-photo maps, built before a visitor has to wait for one.
    threading.Thread(target=photos.warm, name="photos-warm", daemon=True).start()
    alerts = "on" if push is not None else "off"
    print(f"Advisor on http://localhost:{port} (source: {source_name}, refreshed every {interval_s:g} s, "
          f"alerts {alerts}, Discord gate {'on' if gate is not None else 'off'}, "
          f"Discord posts {'on' if poster is not None else 'off'}, "
          f"Discord perks {'on' if perks is not None else 'off'}, "
          f"admin panel {'on' if admins and gate is not None else 'off'})", flush=True)
    # A stop request (a redeploy sends SIGTERM) ends the server the way Ctrl-C does, so the counts, the subscriptions
    # the price history and the feed's memory get flushed.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        app = create_app(store, STATIC_DIR, clicks=clicks, stats_token=stats_token, photos=photos, push=push,
                         importer=importer, gate=gate, links=links, perks=perks, visits=visits, admin_ids=admins,
                         activity=activity,
                         interactions=make_interactions(os.environ, store, links, importer, perks))
        serve(app, host="0.0.0.0", port=port, **WAITRESS)
    finally:
        stop.set()
        clicks.flush()
        visits.flush()
        activity.flush()
        if push is not None:
            push.store.flush()
        history.flush()
        flush_source = getattr(source, "flush", None)
        if flush_source is not None:
            flush_source()


if __name__ == "__main__":
    main()
