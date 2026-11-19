"""The web app: the page with the latest snapshot inlined, the snapshot as JSON for polling, a health check,
the outbound click counter with its token-guarded totals, the player photos from our own origin, a public page and a
drawn card for each deal (to share), and the alerts' push subscriptions (only while push is on) with the service worker that shows them.

With the Discord gate on (see `advisor.discord_gate`), the site is free for everyone and the extras are for members of
our Discord server. Anyone else (no session, or signed in but not in the server) gets the free site: the page and
/api/snapshot carry the free site's snapshot (`advisor.public`: the best few deals, a summary of the moves, each
sport's best passes), built on the server, never the whole one. What only a member may have stays closed on the
server: the account lookups, the alerts and the linked account answer 401 {"error": "discord_required"} to anyone
else. The page carries a mark of who is asking (no name). /auth/* runs the login and the "check again" after a join.
/discord/interactions, our Discord slash commands, is open too: Discord signs each call (see
`advisor.discord_commands`). With the gate off, none of this exists and everyone gets the whole snapshot.

The page and the snapshot go out gzipped to a client that accepts gzip, each compressed once per snapshot version;
the built text files (/assets/*, the manifest, the SVGs) likewise, each compressed once; and an account's passes
(/api/passes/import, megabytes for a big account), compressed once per answer the importer keeps.
"""

import functools
import hashlib
import hmac
import html
import ipaddress
import json
import math
import mimetypes
import os
import re
import stat
import time
from collections.abc import Callable
from pathlib import Path

from flask import Flask, Response, abort, g, jsonify, redirect, request, send_from_directory
from werkzeug.exceptions import NotFound
from werkzeug.security import safe_join

from advisor import activity_report
from advisor.activity import SNOWFLAKE, ActivityLog, parse_batch
from advisor.admin_stats import build_report
from advisor.clicks import ClickLog
from advisor.discord_gate import (
    AUTH_PER_MIN,
    FAILURE_PAGE,
    NOBODY,
    SESSION_COOKIE,
    SESSION_MAX_AGE_S,
    STATE_COOKIE,
    STATE_MAX_AGE_S,
    DiscordGate,
    Visitor,
    safe_next,
)
from advisor.discord_perks import perks_state
from advisor.handoff import HANDOFF_COOKIE, HANDOFF_MAX_AGE_S, Handoffs
from advisor.importer import PassImporter, valid_username
from advisor.members import MemberLinks, roles_for
from advisor.photos import PhotoStore
from advisor import privacy, share
from advisor.push import Dispatcher, parse_endpoint, parse_subscription
from advisor.ratelimit import TokenBuckets
from advisor.rules import (
    LINK_PER_MIN,
    CLICK_MAX_BYTES,
    CLICK_PER_MIN,
    CLICK_RATE_MAX_ADDRESSES,
    CLIENT_KEY_MAX_CHARS,
    DISCORD_INTERACTION_MAX_BYTES,
    HSTS_MAX_AGE_S,
    IMPORT_ADDRESS_WINDOW_S,
    IMPORT_FOLLOW_UP_BURST,
    IMPORT_FOLLOW_UP_PER_MIN,
    IMPORT_PER_ADDRESS,
    IMPORT_RETRY_AFTER_S,
    PHOTO_BROWSER_CACHE_S,
    PHOTO_NONE_CACHE_S,
    PUSH_CLIENT_PER_MIN,
    PUSH_MAX_BYTES,
    PUSH_RATE_MAX_ADDRESSES,
    SHARE_PER_MIN,
    SHARE_RATE_MAX_ADDRESSES,
    STATIC_GZIP_LEVEL,
    STATIC_GZIP_SUFFIXES,
    ACTIVITY_EVENTS_PER_MIN,
    ACTIVITY_MAX_BYTES,
    ADMIN_DEEP_CACHE_S,
    ADMIN_STATS_CACHE_S,
    VISIT_MAX_BYTES,
    VISIT_NEW_DEVICES_PER_HOUR,
    VISIT_PER_MIN,
)
from advisor.store import GZIP_TAG, SnapshotStore, compress, etags
from advisor.visits import VisitLog, looks_like_bot, parse_visit

SNAPSHOT_MARKER = "<!--SNAPSHOT-->"
# Where the home page's link-preview tags go (the page's title and line are in its head already).
PREVIEW_MARKER = "<!--PREVIEW-->"
HOME_TITLE = "OTD Palace"
HOME_LINE = "An independent guide to the Real card market: the best deals right now, priced from real sales, the players moving and the passes worth getting."
# The site's own address, for the canonical links and the sitemap when no gate names it (the gate's public URL wins).
SITE_URL = "https://otdpalace.com"
# The front end's views, each at its own address (frontend/src/lib/tabHint.ts maps them to the tabs; "/" is Today), by
# path: the title and line the page carries for it, so a search engine lists each view with its own words.
VIEWS = {
    "/": ("OTD Palace · Real card deals, prices and passes today", HOME_LINE),
    "/deals": ("Real card deals under market price · OTD Palace",
               "The best deals on Real cards right now, each priced from real sales and ranked by how far under its "
               "usual price it is listed."),
    "/prices": ("Real card prices moving today · OTD Palace",
                "The Real players whose cards sold for much more, or much less, today than over the last 7 days."),
    "/passes": ("Real On This Day passes worth getting · OTD Palace",
                "Which Real On This Day passes are worth getting, by sport: what each one costs and what it can pay "
                "back in Rax."),
    "/plan": ("Your Real plan · OTD Palace",
              "What your Real passes can pay a year, the account type they make, and the next moves to make."),
}
# The public pages a search engine is pointed at (/sitemap.xml): the views, then the privacy page.
SITEMAP_PATHS = (*VIEWS, "/privacy")
# What the server writes over in the built page's head for each view (index.html's own title and line).
_TITLE_TAG = re.compile(r"<title>[^<]*</title>\s*")
_DESCRIPTION_TAG = re.compile(r'<meta name="description" content="[^"]*"\s*/?>\s*')
# The built page's entry script, which names its build: every snapshot answer carries it (X-Build), so a page left open
# across a deploy can tell it runs old code and reload itself.
BUILD_ENTRY = re.compile(r'src="/assets/(index-[A-Za-z0-9_-]{1,64}\.js)"')
IMMUTABLE = "public, max-age=31536000, immutable"
BROTLI_TAG = "-br"  # what tells a brotli file's ETag from the gzipped one's ("-gz")
# The launch screens an iPhone shows while the site opens from its home screen, one per screen size in device
# pixels (portrait): black with the mark, so a dark site does not open on a white flash. index.html links each one.
SPLASH_SIZES = ((1320, 2868), (1290, 2796), (1284, 2778), (1206, 2622), (1179, 2556), (1170, 2532), (1125, 2436),
                (1242, 2688), (828, 1792), (750, 1334))
SPLASH_FILES = frozenset(f"splash-{w}x{h}.png" for w, h in SPLASH_SIZES)
# The only files served from the root of the static directory: the icons the page links to, the home-screen
# manifest with its icons and launch screens, the alerts' service worker (it must sit at the root to cover the whole
# site) and robots.txt. Everything else the build writes there is either the page itself or lives under /assets.
ROOT_FILES = frozenset(
    {"favicon.svg", "logo.svg", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png",
     "apple-touch-icon.png", "og.png", "sw.js", "robots.txt"}
) | SPLASH_FILES
# What a built file is served as when its extension alone might not say it right (the platform's own type table
# decides the others).
FILE_TYPES = {".webmanifest": "application/manifest+json", ".js": "text/javascript"}
SERVICE_WORKER = "sw.js"
# Push answers for the page: each outcome of a subscription or a test, as an HTTP status.
UPSERT_STATUS = {"ok": 204, "dead": 410, "full": 503}
TEST_STATUS = {"sent": 204, "limited": 429, "unknown": 404, "gone": 410, "failed": 502}
# How long the gate screen's counts may be kept by a browser or a cache in between.
TEASER_CACHE_S = 60
# The gate's mark in the page, by the asker's state (advisor/discord_gate.py: "in" a member, "anon" no session, "out"
# signed in but not in our server, "banned" refused by it): the front end reads it before anything else (see
# `page_bodies`). It names nobody: one page serves everyone in a state.
GATE_MARKS = {
    state: '<script id="me" type="application/json">'
           + json.dumps({"gate": True, "member": state == "in", "state": state}, separators=(",", ":")) + "</script>"
    for state in ("in", "anon", "out", "banned")
}

# The inlined snapshot is type="application/json": data, not a script, so script-src needs no nonce for it.
# There is no connect-src: default-src 'self' already lets the page poll /api/snapshot and beacon /api/out.
# img-src stays 'self': a player photo is fetched by the server and served from /img/players/, never hotlinked.
HANDOFF_CLAIM_PER_MIN = 60  # the home-screen app asks every few seconds while its login is open elsewhere

# Shown in the window a login from the home-screen app ended in (Safari's over the app, or the browser): the app takes
# the session itself, so closing this window is all there is left to do. {next} is filled in, escaped.
HANDOFF_DONE_PAGE = FAILURE_PAGE.format(
    title="You're signed in",
    words="Close this window to go back to the OTD Palace app (Done or ✕ at the top): it is signed in too.",
    actions='<a class="home" href="{next}">Continue here instead</a>',
)

_POLICY = (
    "default-src 'self'",
    "script-src 'self'",
    "img-src 'self'",
    "style-src 'self'",
    "font-src 'self'",  # the two faces are served from /assets, fingerprinted like the rest of the build
    "object-src 'none'",
    "base-uri 'none'",  # stricter than 'self': the page has no <base>
    "form-action 'none'",  # it does not fall back to default-src; no form of the site submits anywhere
    "frame-ancestors 'none'",
)
CONTENT_SECURITY_POLICY = "; ".join(_POLICY)
# The admin panel alone also shows members' Discord avatars, from Discord's own image host (advisor/activity_report.py).
ADMIN_CONTENT_SECURITY_POLICY = "; ".join(
    "img-src 'self' https://cdn.discordapp.com" if part == "img-src 'self'" else part for part in _POLICY)
# The longest way to write an IP address (an IPv6 address holding an IPv4 one).
_ADDRESS_MAX_CHARS = 45
# Browser features the site never uses, turned off for it and anything it could ever embed.
PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
STRICT_TRANSPORT_SECURITY = f"max-age={HSTS_MAX_AGE_S}"

# The page any unknown address gets: dark like the site, with the way home. Its style is an external sheet, since
# the CSP allows no inline style.
NOT_FOUND_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page not found · OTD Palace</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/error.css">
</head>
<body>
<main>
<a class="brand" href="/"><img src="/logo.svg" alt="" width="40" height="40">OTD Palace</a>
<h1>Page not found</h1>
<p>Nothing lives at this address. The deals are on the home page.</p>
<a class="home" href="/">Go to the deals</a>
</main>
<footer>Not affiliated with Real.</footer>
</body>
</html>
"""
# The admin panel's answer to someone who may not see it: asked to sign in (401), or told no (403). Same look as the
# page above; the panel itself is the front end's (frontend/src/views/AdminView.tsx), served at /admin to an admin.
ADMIN_REFUSED_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Admin · OTD Palace</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/error.css">
</head>
<body>
<main>
<a class="brand" href="/"><img src="/logo.svg" alt="" width="40" height="40">OTD Palace</a>
<h1>{title}</h1>
<p>{words}</p>
{action}
</main>
<footer>Not affiliated with Real.</footer>
</body>
</html>
"""
ADMIN_SIGN_IN = ADMIN_REFUSED_PAGE.format(
    title="Sign in first", words="This page is for the people who run the site. Sign in with Discord to open it.",
    action='<a class="home" href="/auth/discord?next=%2Fadmin">Continue with Discord</a>')
ADMIN_FORBIDDEN = ADMIN_REFUSED_PAGE.format(
    title="Not for this account", words="This page is for the people who run the site.",
    action='<a class="home" href="/">Go to the deals</a>')
PRIVATE_NO_STORE = "private, no-store"

ERROR_CSS = """:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; padding: 24px 16px; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 40px; background: #000000; color: #d9d9d9;
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 26rem; text-align: center; }
.brand {
  display: inline-flex; align-items: center; gap: 10px; min-height: 44px; color: #d9d9d9; font-weight: 700;
  text-decoration: none;
}
.brand img { border-radius: 10px; }
h1 { margin: 28px 0 8px; font-size: 1.75rem; line-height: 1.2; }
p { margin: 0 0 24px; color: #8a8e94; }
.alt { margin: 24px 0 0; font-size: 0.9375rem; }
.alt a { color: #f5893a; font-weight: 700; }
.home {
  display: inline-flex; align-items: center; min-height: 44px; padding: 10px 24px; border-radius: 999px;
  background: #f5893a; color: #1b1004; font-weight: 700; text-decoration: none;
}
.home:hover { background: #f89b55; }
a:focus-visible { outline: 2px solid #f5893a; outline-offset: 3px; }
footer { color: #82878d; font-size: 0.8125rem; }
"""

# The longest id a deal's address may carry (Real's listing ids are far shorter): longer is no deal, and never worth parsing.
_LISTING_ID_MAX_DIGITS = 18


# The cards kept drawn at once (for the current snapshot version); past this the table starts over.
CARD_CACHE_MAX = 256


def _twin_limits(snap: dict) -> dict:
    """How many similar deals to show and how close their price must be, as the snapshot's rules say."""
    rules = snap.get("rules")
    limits = rules.get("twins") if isinstance(rules, dict) else None
    out = {}
    if isinstance(limits, dict):
        if type(limits.get("max")) is int and 0 < limits["max"] <= 10:
            out["limit"] = limits["max"]
        if type(limits.get("price_band")) in (int, float) and 0 <= limits["price_band"] <= 1:
            out["band"] = limits["price_band"]
    return out


def _listing_id(text: str) -> int | None:
    """The listing id an address names: plain digits, positive, not absurdly long; else None."""
    if text.isascii() and text.isdecimal() and len(text) <= _LISTING_ID_MAX_DIGITS and int(text) > 0:
        return int(text)
    return None


# What turns JSON text into something that cannot close the <script> element it sits in.
_HTML_SAFE = {"<": "\\u003c", ">": "\\u003e", "&": "\\u0026", " ": "\\u2028", " ": "\\u2029"}


def _inline_json(body: bytes) -> str:
    text = body.decode()
    for char, escape in _HTML_SAFE.items():
        text = text.replace(char, escape)
    return text


def _accepts_gzip() -> bool:
    """Whether the request's Accept-Encoding takes gzip: named with a quality above 0, or, when gzip is not named at
    all, covered by "*" with a quality above 0 (any coding will do, and gzip is the one every client can read)."""
    named = star = None
    for coding, quality in request.accept_encodings:
        coding = coding.lower()
        if coding in ("gzip", "x-gzip"):
            named = quality if named is None else max(named, quality)
        elif coding == "*":
            star = quality
    if named is not None:
        return named > 0
    return star is not None and star > 0


def _accepts_brotli() -> bool:
    """Whether the request's Accept-Encoding names br with a quality above 0 (a "*" is answered with gzip instead)."""
    return any(coding.lower() == "br" and quality > 0 for coding, quality in request.accept_encodings)


def _encoded(body: bytes, gzipped: bool, mimetype: str) -> Response:
    """A response carrying `body`, gzip-encoded or not; either way it varies by Accept-Encoding."""
    response = Response(body, mimetype=mimetype)
    if gzipped:
        response.headers["Content-Encoding"] = "gzip"
    response.headers["Vary"] = "Accept-Encoding"
    return response


LINK_MAX_BYTES = 8192  # a /api/me/link body: a username, a few settings and up to 200 players followed
IMPORT_STATUS = {"ok": 200, "not_found": 404, "private": 422, "busy": 503}


def _roles_of(row: dict) -> list[str]:
    """The roles a member's link row earns (their account type follows the yearly figure the site reported)."""
    return roles_for(row["summary"], row.get("year"))


def _no_store(response: Response) -> Response:
    response.headers["Cache-Control"] = "no-store"
    return response


def _client_address() -> str:
    """Who is asking, for the click and push rate limits only (kept in memory, never written): the address the
    platform's proxy saw (X-Real-IP, which it sets on every request) when it is an IP address, written one way
    whatever form it came in, else the peer of the connection; never longer than CLIENT_KEY_MAX_CHARS."""
    given = request.headers.get("X-Real-IP", "").strip()
    if 0 < len(given) <= _ADDRESS_MAX_CHARS:  # longer is no address: not even worth parsing
        try:
            return str(ipaddress.ip_address(given))[:CLIENT_KEY_MAX_CHARS]
        except ValueError:
            pass
    return (request.remote_addr or "")[:CLIENT_KEY_MAX_CHARS]


def _network_key(address: str) -> str:
    """The key a visit limit counts an address under: an IPv6 address by its /64 network (one subscriber holds a
    whole /64, so counting each address apart would be no limit at all), anything else as it is."""
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return address
    if parsed.version == 6 and parsed.ipv4_mapped is None:
        return str(ipaddress.ip_network(f"{parsed}/64", strict=False))[:CLIENT_KEY_MAX_CHARS]
    return address


def _not_modified(response: Response) -> Response:
    """A 304 in place of `response`: its validators and caching headers, no body."""
    reply = Response(status=304)
    for name in ("ETag", "Vary", "Cache-Control", "X-Build"):
        if name in response.headers:
            reply.headers[name] = response.headers[name]
    return reply


def _read_body(limit: int) -> bytes | None:
    """The request body, or None when it is bigger than `limit` bytes (announced or not)."""
    if request.content_length is not None and request.content_length > limit:
        return None
    body = request.stream.read(limit + 1)
    return None if len(body) > limit else body


def _bearer_matches(header: str | None, token: str) -> bool:
    """Whether an Authorization header carries exactly this bearer token, compared in constant time.

    The scheme is case-insensitive, as HTTP has it ("bearer" will do); the token is not.
    """
    scheme, _, given = (header or "").partition(" ")
    return scheme.lower() == "bearer" and hmac.compare_digest(given.encode(), token.encode())


def _sports_of(body: bytes) -> frozenset[str]:
    """The sports a snapshot offers as filters: those of its listings, and those its OTD passes are grouped under."""
    try:
        snapshot = json.loads(body)
    except ValueError:
        return frozenset()
    if not isinstance(snapshot, dict):
        return frozenset()
    sports = snapshot.get("sports")
    otd = snapshot.get("otd")
    picks = otd.get("picks") if isinstance(otd, dict) else None
    found = list(sports) if isinstance(sports, list) else []
    found += list(picks) if isinstance(picks, dict) else []
    return frozenset(sport for sport in found if isinstance(sport, str))


_INITIALLED = re.compile(r"^\s*[A-Za-z]\.\s")  # "J. White": an initial and a surname


def _players_of(body: bytes) -> dict[tuple[str, int], tuple[str, str | None]]:
    """The players a snapshot shows, by (sport, player id), with their names and, where a pass of theirs says it,
    their position: those of its deals, the deals that just went away, the price moves, and the player and fighter
    passes (a team pass carries a team's id)."""
    try:
        snapshot = json.loads(body)
    except ValueError:
        return {}
    if not isinstance(snapshot, dict):
        return {}
    moves = snapshot.get("moves") if isinstance(snapshot.get("moves"), dict) else {}
    otd = snapshot.get("otd") if isinstance(snapshot.get("otd"), dict) else {}
    rows: list = []
    for group in (snapshot.get("deals"), snapshot.get("gone"), moves.get("risers"), moves.get("fallers")):
        rows += group if isinstance(group, list) else []
    markets = otd.get("markets")
    rows += [m for m in markets if isinstance(m, dict) and m.get("kind") != "team"] if isinstance(markets, list) else []
    players: dict[tuple[str, int], tuple[str, str | None]] = {}
    positions: dict[tuple[str, int], str] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        sport, player_id, name = row.get("sport"), row.get("player_id"), row.get("player_name")
        if isinstance(sport, str) and type(player_id) is int and isinstance(name, str):
            known = players.get((sport, player_id))
            # The live deals write "J. White"; a move or a pass of the same player has the whole name, which finds a
            # photo more surely: it wins.
            if known is None or (_INITIALLED.match(known[0]) and not _INITIALLED.match(name)):
                players[(sport, player_id)] = (name, None)
            if isinstance(row.get("position"), str):
                positions.setdefault((sport, player_id), row["position"])
    return {who: (name, positions.get(who)) for who, (name, _) in players.items()}


def _teaser_of(snapshot: dict) -> dict:
    """The gate screen's counts from a snapshot: how many deals are up, across how many sports, the best discount (in
    whole percent, rounded down so it never says more than the deal) and when the data was made. Counts only: no
    listing, no player, no price."""
    deals = snapshot.get("deals")
    rows = [row for row in deals if isinstance(row, dict)] if isinstance(deals, list) else []
    discounts = [row["discount"] for row in rows
                 if type(row.get("discount")) in (int, float) and 0 < row["discount"] < 1]
    sports = {row["sport"] for row in rows if isinstance(row.get("sport"), str)}
    made = snapshot.get("generated_at")
    return {
        "deals": len(rows),
        "sports": len(sports),
        "best_pct": math.floor(max(discounts) * 100 + 1e-9) if discounts else None,
        "generated_at": made if isinstance(made, str) and len(made) <= 40 else None,
    }


def _set_cookie(response: Response, name: str, value: str, max_age: int) -> None:
    """A cookie only this site's own requests carry, over https, out of reach of the page's scripts."""
    response.set_cookie(name, value, max_age=max_age, path="/", secure=True, httponly=True, samesite="Lax")


def _clear_cookie(response: Response, name: str) -> None:
    response.delete_cookie(name, path="/", secure=True, httponly=True, samesite="Lax")


def create_app(
    store: SnapshotStore,
    static_dir: Path,
    clicks: ClickLog | None = None,
    stats_token: str | None = None,
    photos: PhotoStore | None = None,
    push: Dispatcher | None = None,
    clock: Callable[[], float] = time.monotonic,
    importer: PassImporter | None = None,
    gate: DiscordGate | None = None,
    links: MemberLinks | None = None,
    perks=None,
    interactions=None,
    visits: VisitLog | None = None,
    admin_ids: frozenset[str] = frozenset(),
    activity: ActivityLog | None = None,
) -> Flask:
    """The app reading from `store` and serving the built front end in `static_dir`; it starts nothing itself.

    Outbound clicks are counted in `clicks` (not at all without one), at most CLICK_PER_MIN a minute from one address
    (`clock` times that, in seconds). `/api/stats` hands their totals to a request bearing `stats_token`, and does
    not exist while there is no token. Player photos come from `photos`; without one every photo is missing and
    the page shows initials. The push routes exist only with a `push`
    dispatcher (VAPID keys set); without one each of them answers 404. `/api/passes/import` exists only with an
    `importer` (the live feed); without one it answers 404. With a `gate`, the market is for members of our Discord
    (see the module's docstring); without one the /auth/* routes do not exist and everything is open as before.
    With a gate and `links` (advisor/members.py), a member's linked Real account lives at /api/me/link, and each link,
    refresh or unlink asks `perks` (advisor/discord_perks.PerkWorker, or None) to set their Discord roles again.
    With `interactions` (an `advisor.discord_commands.Interactions`), POST /discord/interactions answers our Discord
    slash commands; without one it does not exist.
    With `visits` (advisor/visits.py), POST /api/visit counts the page's anonymous visit beacon (at most VISIT_PER_MIN a
    minute and VISIT_NEW_DEVICES_PER_HOUR new devices an hour from one address; bots answered, never counted), and the
    logins are counted. /admin and /api/admin/stats show the figures (advisor/admin_stats.py) to the Discord ids in
    `admin_ids` only: 404 while there are none (or no gate, or no visit log), 401 to anyone not signed in, 403 to
    anyone else.
    With `activity` (advisor/activity.py), POST /api/events keeps the page's batched events (at most
    ACTIVITY_EVENTS_PER_MIN events a minute from one address), the visit beacon, the logins, the account lookups and
    the links are recorded event by event, and the admin's deep routes (/api/admin/members, members.csv,
    member/<id>, accounts, features, sources, discord; advisor/activity_report.py) exist, guarded like /admin.
    """
    app = Flask(__name__, static_folder=None)
    click_rate = TokenBuckets(CLICK_PER_MIN, CLICK_PER_MIN / 60, CLICK_RATE_MAX_ADDRESSES, clock)
    push_rate = TokenBuckets(PUSH_CLIENT_PER_MIN, PUSH_CLIENT_PER_MIN / 60, PUSH_RATE_MAX_ADDRESSES, clock)
    share_rate = TokenBuckets(SHARE_PER_MIN, SHARE_PER_MIN / 60, SHARE_RATE_MAX_ADDRESSES, clock)
    import_rate = TokenBuckets(IMPORT_PER_ADDRESS, IMPORT_PER_ADDRESS / IMPORT_ADDRESS_WINDOW_S,
                               CLICK_RATE_MAX_ADDRESSES, clock)
    follow_up_rate = TokenBuckets(IMPORT_FOLLOW_UP_BURST, IMPORT_FOLLOW_UP_PER_MIN / 60, CLICK_RATE_MAX_ADDRESSES, clock)
    auth_rate = TokenBuckets(AUTH_PER_MIN, AUTH_PER_MIN / 60, CLICK_RATE_MAX_ADDRESSES, clock)
    claim_rate = TokenBuckets(HANDOFF_CLAIM_PER_MIN, HANDOFF_CLAIM_PER_MIN / 60, CLICK_RATE_MAX_ADDRESSES, clock)
    handoffs = Handoffs(clock)
    link_rate = TokenBuckets(LINK_PER_MIN, LINK_PER_MIN / 60, CLICK_RATE_MAX_ADDRESSES, clock)
    visit_rate = TokenBuckets(VISIT_PER_MIN, VISIT_PER_MIN / 60, CLICK_RATE_MAX_ADDRESSES, clock)
    new_device_rate = TokenBuckets(VISIT_NEW_DEVICES_PER_HOUR, VISIT_NEW_DEVICES_PER_HOUR / 3600,
                                   CLICK_RATE_MAX_ADDRESSES, clock)
    event_rate = TokenBuckets(ACTIVITY_EVENTS_PER_MIN, ACTIVITY_EVENTS_PER_MIN / 60, CLICK_RATE_MAX_ADDRESSES, clock)
    # The admin figures last computed, as (when, by `clock`; the JSON), so a panel left open costs little.
    admin_cache: list = [None, b""]
    # The deep tabs' figures last computed, by tab: (when, by `clock`; the answer).
    deep_cache: dict[str, tuple[float, object]] = {}
    # The import answer last sent, as (the answer, its JSON, that JSON gzipped or None until a client takes gzip). The
    # answer itself is held, so the next ask for the same kept answer reuses the bytes and compresses nothing again.
    import_bodies: tuple = (None, b"", None)
    # The gzipped built files, by path: ((mtime, size) of the file compressed, (gzipped bytes, ETag) or None when
    # gzip does not make it smaller). Only files that exist get in, so it holds at most what the build wrote.
    packed_files: dict[str, tuple[tuple[int, int], tuple[bytes, str] | None]] = {}
    # The brotli files the build wrote beside the assets, by path: ((mtime, size) of the .br file, (bytes, ETag)).
    brotli_files: dict[str, tuple[tuple[int, int], tuple[bytes, str]]] = {}
    # The sports of the snapshot last asked about, by its ETag, so a click does not parse the snapshot again.
    known: tuple[str | None, frozenset[str]] = (None, frozenset())
    # The players of the snapshot last asked about, by its ETag, so a photo does not parse the snapshot again.
    shown: tuple[str | None, dict[tuple[str, int], tuple[str, str | None]]] = (None, {})
    # The current snapshot parsed (a deal's page reads its deals), by its ETag; and the cards drawn for it, by listing.
    parsed: tuple[str | None, dict] = (None, {})
    cards: dict[int, tuple[str, bytes, bytes]] = {}
    # The page last served to each kind of visitor (None with the gate off, else the asker's state: "in", "anon", "out"
    # or "banned") on each view (its path, from VIEWS), plain and gzipped, with the snapshot ETag and the built page
    # it was made from: at most 5 kinds by len(VIEWS) views.
    page_cache: dict[tuple[str | None, str], tuple[str | None, str, bytes, bytes]] = {}
    # The gate screen's counts of the snapshot last asked about, by its ETag.
    teased: tuple[str | None, dict] = (None, {})

    site_url = SITE_URL if gate is None else gate.public_url

    def view_head(template: str, path: str) -> str:
        """The built page with the view's own head: its title and line in place of index.html's, its canonical address
        and its link-preview tags, all where the page marks them (a page without the mark is left as it is)."""
        if PREVIEW_MARKER not in template:
            return template
        title, line = VIEWS[path]
        url = site_url + path
        tags = [f"<title>{html.escape(title)}</title>",
                f'<meta name="description" content="{html.escape(line)}">',
                f'<link rel="canonical" href="{html.escape(url)}">',
                *share.preview_tags(title, line, url)]
        template = _DESCRIPTION_TAG.sub("", _TITLE_TAG.sub("", template, count=1), count=1)
        return template.replace(PREVIEW_MARKER, "\n    ".join(tags), 1)

    def page_bodies(template: str, kind: str | None = None, path: str = "/") -> tuple[bytes, bytes]:
        """The page with the current snapshot inlined, plain and gzipped: made once per snapshot version (and per
        build of the front end, per kind of visitor and per view, `path` naming the view: its own head). With the gate
        on, it also carries the gate's mark, and anyone but a member gets the free site's snapshot in it, never the
        whole one. No page names anyone: the same one serves everyone in a state, and the name comes from /api/me."""
        public = kind is not None and kind != "in"
        current = store.current(public=public)
        etag = None if current is None else current[1]
        key = (kind, path)
        cached = page_cache.get(key)  # one read: another thread may swap it in the meantime, for an equally good one
        if cached is None or cached[0] != etag or cached[1] != template:
            data = "" if current is None else _inline_json(current[0])
            tag = f'<script id="snapshot" type="application/json">{data}</script>' if data else ""
            tag += GATE_MARKS.get(kind or "", "")
            plain = view_head(template, path).replace(SNAPSHOT_MARKER, tag, 1).encode()
            cached = (etag, template, plain, compress(plain))
            page_cache[key] = cached
        return cached[2], cached[3]

    def visitor() -> Visitor:
        """Who is asking, read from the session cookie once per request (and checked against our server once a
        day); nobody in particular with the gate off."""
        if gate is None:
            return NOBODY
        if "visitor" not in g:
            g.visitor = gate.visitor(request.cookies.get(SESSION_COOKIE))
        return g.visitor

    def turned_away() -> Response | None:
        """The 401 for a visitor who is not a member while the gate is on; None to let the request through."""
        if gate is None or visitor().member:
            return None
        response = _no_store(jsonify(error="discord_required"))
        response.status_code = 401
        return response

    def members_only(view):
        """A route that answers 401 {"error": "discord_required"} to anyone but a member while the gate is on."""

        @functools.wraps(view)
        def guarded(*args, **kw):
            return turned_away() or view(*args, **kw)

        return guarded

    def known_sports() -> frozenset[str]:
        """The sports the current snapshot offers; none before the first one."""
        nonlocal known
        current = store.current()
        if current is None:
            return frozenset()
        body, etag = current
        cached = known  # one read: another thread may swap it in the meantime, for an equally good pair
        if cached[0] != etag:
            cached = (etag, _sports_of(body))
            known = cached
        return cached[1]

    def shown_players() -> dict[tuple[str, int], tuple[str, str | None]]:
        """The players the current snapshot shows, with their names and positions; none before the first one."""
        nonlocal shown
        current = store.current()
        if current is None:
            return {}
        body, etag = current
        cached = shown  # one read: another thread may swap it in the meantime, for an equally good pair
        if cached[0] != etag:
            cached = (etag, _players_of(body))
            shown = cached
        return cached[1]

    def current_snapshot() -> tuple[str, dict] | None:
        """The current snapshot as a dict with its ETag (parsed once per version); None before the first one."""
        nonlocal parsed, cards
        current = store.current()
        if current is None:
            return None
        body, etag = current
        cached = parsed  # one read: another thread may swap it in the meantime, for an equally good pair
        if cached[0] != etag:
            try:
                data = json.loads(body)
            except ValueError:
                data = {}
            cached = (etag, data if isinstance(data, dict) else {})
            parsed = cached
            cards = {}  # a card is drawn from one version of a deal
        return etag, cached[1]

    def shared_deal(listing: str) -> tuple[str, dict, dict, bool] | None:
        """The deal an address names, as (snapshot ETag, snapshot, row, has gone); None when there is none."""
        listing_id = _listing_id(listing)
        current = current_snapshot()
        if listing_id is None or current is None:
            return None
        found = share.find_deal(current[1], listing_id, store.ended)
        return None if found is None else (current[0], current[1], found[0], found[1])

    def share_gate() -> Response | None:
        """The answer that turns a visitor away from a deal's page (too many asked from one address a minute), or None."""
        return None if share_rate.take(_client_address()) else _no_store(Response(status=429))

    def packed_file(directory: Path, name: str) -> tuple[bytes, str] | None:
        """The gzipped bytes of a built file and their ETag, compressed once per version of the file; None when there
        is no such file under `directory` (or no name a file can have, such as one holding a NUL byte) or gzip would
        not make it smaller. The plain path then answers, with its own 404 when there is no file."""
        path = safe_join(os.fspath(directory), name)
        if path is None:
            return None
        try:
            info = os.stat(path)
            if not stat.S_ISREG(info.st_mode):
                return None
            version = (info.st_mtime_ns, info.st_size)
            cached = packed_files.get(path)  # one read: another thread may swap it meanwhile, for an equally good one
            if cached is not None and cached[0] == version:
                return cached[1]
            body = Path(path).read_bytes()
        except (OSError, ValueError):
            return None
        packed = compress(body, STATIC_GZIP_LEVEL)
        entry = (packed, hashlib.sha256(body).hexdigest()[:32] + GZIP_TAG) if len(packed) < len(body) else None
        packed_files[path] = (version, entry)
        return entry

    def brotli_file(directory: Path, name: str) -> tuple[bytes, str] | None:
        """The brotli bytes the build wrote beside a file (`<name>.br`, see `vite.config.ts`) and their ETag, read once
        per version of that file; None when the build wrote none (or the file itself is not there)."""
        path, packed = safe_join(os.fspath(directory), name), safe_join(os.fspath(directory), name + ".br")
        if path is None or packed is None:
            return None
        try:
            if not stat.S_ISREG(os.stat(path).st_mode):
                return None
            info = os.stat(packed)
            if not stat.S_ISREG(info.st_mode):
                return None
            version = (info.st_mtime_ns, info.st_size)
            cached = brotli_files.get(packed)  # one read, as in packed_file
            if cached is not None and cached[0] == version:
                return cached[1]
            body = Path(packed).read_bytes()
        except (OSError, ValueError):
            return None
        entry = (body, hashlib.sha256(body).hexdigest()[:32] + BROTLI_TAG)
        brotli_files[packed] = (version, entry)
        return entry

    def built_file(directory: Path, name: str, cache_control: str, brotli: bool = False) -> Response:
        """A file of the build, gzipped when it is text, the client takes gzip and gzip makes it smaller; 404 when
        there is no such file under `directory`. With `brotli` (the fingerprinted assets), a client that names br gets
        the brotli file the build wrote beside it instead, when there is one: smaller than gzip by about 14 %."""
        suffix = Path(name).suffix
        mimetype = FILE_TYPES.get(suffix)
        compressible = suffix in STATIC_GZIP_SUFFIXES
        coding = "gzip"
        packed = None
        if compressible and brotli and _accepts_brotli():
            packed = brotli_file(directory, name)
            coding = "br"
        if packed is None:
            coding = "gzip"
            packed = packed_file(directory, name) if compressible and _accepts_gzip() else None
        if packed is None:
            response = send_from_directory(directory, name, mimetype=mimetype)
        else:
            body, etag = packed
            response = Response(body, mimetype=mimetype or mimetypes.guess_type(name)[0] or "application/octet-stream")
            response.headers["Content-Encoding"] = coding
            response.set_etag(etag)
            response = response.make_conditional(request)
        if compressible:
            response.headers["Vary"] = "Accept-Encoding"
        response.headers["Cache-Control"] = cache_control
        return response

    if gate is not None:
        public_host = gate.public_url.split("://", 1)[-1].split("/", 1)[0].lower()

        @app.before_request
        def one_address() -> Response | None:
            """www.<public host> is a second site to a browser (its own cookies, offline copy and settings), and the
            login's state cookie set there never reached the callback on the public address: send it all there."""
            if request.host.lower() != f"www.{public_host}":
                return None
            path = request.full_path if request.query_string else request.path
            code = 301 if request.method in ("GET", "HEAD") else 308
            return redirect(gate.public_url + path, code=code)

    @app.after_request
    def keep_session(response: Response) -> Response:
        """Sends back what the day's check made of the session cookie: renewed, or cleared (it is broken, or its
        holder left the server). An answer that read the cookie varies by it, so no cache hands it to someone else."""
        found = g.get("visitor")
        if found is None:
            return response
        if found.clear:
            _clear_cookie(response, SESSION_COOKIE)
        elif found.cookie:
            _set_cookie(response, SESSION_COOKIE, found.cookie, found.max_age)
        response.vary.add("Cookie")
        # What was answered to a member is for that browser alone, even for a cache that ignores Vary (many do for Cookie).
        kept = response.headers.get("Cache-Control", "")
        if "no-store" not in kept and "private" not in kept:
            response.headers["Cache-Control"] = f"private, {kept}" if kept else "private"
        return response

    @app.after_request
    def add_security_headers(response: Response) -> Response:
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            ADMIN_CONTENT_SECURITY_POLICY if request.path == "/admin" else CONTENT_SECURITY_POLICY)
        response.headers["Permissions-Policy"] = PERMISSIONS_POLICY
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        if request.is_secure:  # over https; behind the platform's proxy, waitress sets the scheme it was asked in
            response.headers["Strict-Transport-Security"] = STRICT_TRANSPORT_SECURITY
        # Whatever did not say how to cache it (errors, automatic OPTIONS replies, ...) is not to be kept.
        response.headers.setdefault("Cache-Control", "no-store")
        return response

    @app.errorhandler(404)
    def not_found(error: NotFound) -> Response:
        return _no_store(Response(NOT_FOUND_PAGE, status=404, mimetype="text/html"))

    @app.get("/error.css")
    def error_css() -> Response:
        response = Response(ERROR_CSS, mimetype="text/css")
        response.headers["Cache-Control"] = "no-cache"
        return response

    def view_page(path: str) -> Response:
        """The page, for the view at `path` (a key of VIEWS): the same front end with that view's own head."""
        try:
            template = (static_dir / "index.html").read_text(encoding="utf-8")
        except FileNotFoundError:
            response = Response("front end not built", status=503, mimetype="text/plain")
        else:
            gzipped = _accepts_gzip()
            kind = None if gate is None else visitor().state
            plain, packed = page_bodies(template, kind, path)
            response = _encoded(packed if gzipped else plain, gzipped, mimetype="text/html")
        response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/")
    def index() -> Response:
        return view_page("/")

    # Each other view at its own address, as a fixed path (it wins over /<name>, the root files'): any other address
    # stays a 404.
    for view_path in VIEWS:
        if view_path != "/":
            app.add_url_rule(view_path, f"view_{view_path.strip('/')}", functools.partial(view_page, view_path),
                             methods=["GET"])

    @app.get("/sitemap.xml")
    def sitemap() -> Response:
        """The public pages for a search engine: the views and the privacy page, never an account, a deal or /admin."""
        entries = "".join(f"<url><loc>{html.escape(site_url + path)}</loc></url>" for path in SITEMAP_PATHS)
        body = ('<?xml version="1.0" encoding="UTF-8"?>\n'
                f'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{entries}</urlset>\n')
        response = Response(body, mimetype="application/xml")
        response.headers["Cache-Control"] = "public, max-age=3600"
        return response

    @app.get("/d/<listing>")
    def deal_page(listing: str) -> Response:
        """A deal's public page, to share: its facts and the way to Real; for a deal that went away, that and similar
        deals; 404 (with a page that says so) for one nobody remembers."""
        if (turned_away := share_gate()) is not None:
            return turned_away
        found = shared_deal(listing)
        demo = bool(found and isinstance(found[1].get("rules"), dict) and found[1]["rules"].get("demo") is True)
        if found is None:
            return _no_store(Response(share.render_missing(), status=404, mimetype="text/html"))
        _, snap, row, gone = found
        gated = gate is not None and not visitor().member  # its way to more deals is the gate: say what it asks
        # A gone deal's similar deals are live ones: for members only, or the page would hand the market out.
        similar = share.twins(row, share.safe_deals(snap), **_twin_limits(snap)) if gone and not gated else []
        page = share.render_page(row, gone, similar, f"{request.host_url.rstrip('/')}/d/{row['listing_id']}", demo,
                                 gated=gated)
        gzipped = _accepts_gzip()
        body = page.encode()
        response = _encoded(compress(body) if gzipped else body, gzipped, mimetype="text/html")
        response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/a/<username>")
    def account_page(username: str) -> Response:
        """A Real account's analysis, as a link to share: a preview page (title, a line, how many passes when the
        server already kept that account) that goes straight on to /#account/<name>. It never asks the producer to
        read anything. Without an importer (the sample data) it sends the visitor home; 404 for a name that cannot
        be one."""
        if (turned_away := share_gate()) is not None:
            return turned_away
        if importer is None:
            return redirect("/", code=302)
        name = valid_username(username)
        if name is None:
            return _no_store(Response(share.render_missing(), status=404, mimetype="text/html"))
        kept = importer.cached(name) if hasattr(importer, "cached") else None
        shown = kept.username if kept is not None and kept.status == "ok" and kept.username else name
        passes = len(kept.passes) if kept is not None and kept.status == "ok" else None
        if gate is not None and not visitor().member:
            passes = None  # what the site read of an account is for members; the preview keeps its title

        page = share.render_account(shown, passes, f"{request.host_url.rstrip('/')}/a/{shown}")
        response = Response(page, mimetype="text/html")
        response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/d/<listing>/card.svg")
    def deal_card(listing: str) -> Response:
        """The deal drawn as a card (rarity frame, rating, price, % under), made once per snapshot version."""
        if (turned_away := share_gate()) is not None:
            return turned_away
        found = shared_deal(listing)
        if found is None:
            return _no_store(Response(status=404))
        etag, _, row, gone = found
        gzipped = _accepts_gzip()
        key = f"{etag.strip(chr(34)).removesuffix(GZIP_TAG)}.{row['listing_id']}"
        cached = cards.get(row["listing_id"])  # one read: another thread may swap it meanwhile, for an equal card
        if cached is None or cached[0] != key:
            plain = share.render_card(row, gone).encode()
            cached = (key, plain, compress(plain))
            if len(cards) >= CARD_CACHE_MAX:
                cards.clear()
            cards[row["listing_id"]] = cached
        tags = etags(key)
        response = _encoded(cached[2] if gzipped else cached[1], gzipped, mimetype="image/svg+xml")
        response.headers["ETag"] = tags[1] if gzipped else tags[0]
        response.headers["Cache-Control"] = "no-cache"
        if any(request.if_none_match.contains_weak(tag.strip('"')) for tag in tags):
            return _not_modified(response)
        return response

    @app.get("/share.css")
    def share_css() -> Response:
        response = Response(share.SHARE_CSS, mimetype="text/css")
        response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/share.js")
    def share_js() -> Response:
        response = Response(share.SHARE_JS, mimetype="text/javascript")
        response.headers["Cache-Control"] = "no-cache"
        return response

    built: tuple[int, str | None] | None = None  # (index.html's mtime, its entry script), read again when it changes

    def build_name() -> str | None:
        """The built page's entry script ("index-Ab12.js"), or None with no built page."""
        nonlocal built
        try:
            stamp = (static_dir / "index.html").stat().st_mtime_ns
            if built is None or built[0] != stamp:
                found = BUILD_ENTRY.search((static_dir / "index.html").read_text(encoding="utf-8"))
                built = (stamp, found[1] if found else None)
        except OSError:
            return None
        return built[1]

    @app.get("/api/snapshot")
    def snapshot() -> Response:
        """The snapshot; without its passes when `?otd=` names the ones it carries (the poller holds them already).
        With the gate on, anyone but a member gets the free site's snapshot (`advisor.public`), never the whole one.

        Its ETag is the version ("7", or "7-gz" gzipped; "7p" and "7p-gz" for the free site's) whichever part goes
        out, and a client holding either tag of the current version of its own variant gets a 304."""
        gzipped = _accepts_gzip()
        public = gate is not None and not visitor().member
        # one read: the bytes and the ETag of the same version
        current = store.current(gzipped=gzipped, otd=request.args.get("otd"), public=public)
        if current is None:
            return jsonify(error="warming up"), 503
        body, etag = current
        response = _encoded(body, gzipped, mimetype="application/json")
        response.headers["ETag"] = etag
        response.headers["Cache-Control"] = "no-cache"
        if (name := build_name()) is not None:
            response.headers["X-Build"] = name
        version = etag.strip('"').removesuffix(GZIP_TAG)
        if any(request.if_none_match.contains_weak(tag.strip('"')) for tag in etags(version)):
            return _not_modified(response)
        return response

    @app.get("/healthz")
    def healthz() -> Response:
        """Whether the data is fresh, how old it is and its version: nothing else, so nothing private can leak here.

        503 until the first refresh has finished (a deploy is not ready yet); after it, 200 even when that refresh failed
        or the data is stale: the page says "Paused", and a fix can still ship while the source is down."""
        health = store.health()
        response = _no_store(jsonify({key: health[key] for key in ("ok", "age_s", "version")}))
        if not health["ready"]:
            response.status_code = 503
        return response

    @app.post("/api/out")
    def out() -> Response:
        """Count a click that leaves for Real or the community: 204 whether or not it was one the site sends.

        403 when the browser says another site sent it (only the page's own beacon is same-origin), 429 past
        CLICK_PER_MIN a minute from one address."""
        site = request.headers.get("Sec-Fetch-Site")
        if site is not None and site != "same-origin":
            return _no_store(Response(status=403))
        if not click_rate.take(_client_address()):
            return _no_store(Response(status=429))
        body = _read_body(CLICK_MAX_BYTES)
        if body is None:
            return _no_store(Response(status=413))
        try:
            click = json.loads(body)
        except ValueError:  # not JSON, or not UTF-8
            return _no_store(Response(status=400))
        if clicks is not None and isinstance(click, dict):
            fields = (click.get(field) for field in ("panel", "target", "level", "sport", "pos"))
            clicks.record(*fields, known_sports=known_sports())
        return _no_store(Response(status=204))

    @app.get("/api/stats")
    def stats() -> Response:
        if not stats_token:
            return _no_store(Response("Not Found", status=404, mimetype="text/plain"))
        if not _bearer_matches(request.headers.get("Authorization"), stats_token):
            response = Response(status=401)
            response.headers["WWW-Authenticate"] = "Bearer"
            return _no_store(response)
        return _no_store(jsonify(clicks.totals() if clicks is not None else {"days": {}}))

    @app.post("/api/visit")
    def visit() -> Response:
        """Counts the page's anonymous visit beacon (advisor/visits.py): 204 whether or not it was counted (a bot is
        answered and dropped; so is a report past VISIT_PER_MIN a minute, or a new device past VISIT_NEW_DEVICES_PER_HOUR
        an hour, from one address: a 429 would be a console error on a busy shared address). 403 when the browser says
        another site sent it, 413 past VISIT_MAX_BYTES, 400 for a report that is not what the page sends. The user agent is read, never kept."""
        site = request.headers.get("Sec-Fetch-Site")
        if site is not None and site != "same-origin":
            return _no_store(Response(status=403))
        if visits is None:
            return _no_store(Response(status=204))
        address = _network_key(_client_address())
        if not visit_rate.take(address):
            return _no_store(Response(status=204))
        body = _read_body(VISIT_MAX_BYTES)
        if body is None:
            return _no_store(Response(status=413))
        try:
            found = parse_visit(json.loads(body), request.host.split(":", 1)[0])
        except ValueError:
            found = None
        if found is None:
            return _no_store(Response(status=400))
        if looks_like_bot(request.headers.get("User-Agent")):
            return _no_store(Response(status=204))
        if not visits.knows(found.device) and not new_device_rate.take(address):
            return _no_store(Response(status=204))
        who = visitor()
        state = who.state if gate is not None else "anon"
        visits.record(found, state=state, uid=who.uid)
        if activity is not None:
            activity.add_visit(found.device, {"view": "tab"}.get(found.event, found.event), found.tab, found.cls,
                               found.app, found.source, state, who.uid, who.name, who.iat,
                               first=visits.first_seen(found.device))
        return _no_store(Response(status=204))

    @app.post("/api/events")
    def page_events() -> Response:
        """Keeps the page's batched activity events (advisor/activity.py): 204 whether or not they were kept (a bot
        is answered and dropped; so are events past ACTIVITY_EVENTS_PER_MIN a minute, or a device the visit log never
        saw past VISIT_NEW_DEVICES_PER_HOUR an hour, from one address). 403 when the browser says another site sent
        it, 413 past ACTIVITY_MAX_BYTES, 400 for a report that is not what the page sends."""
        site = request.headers.get("Sec-Fetch-Site")
        if site is not None and site != "same-origin":
            return _no_store(Response(status=403))
        if activity is None:
            return _no_store(Response(status=204))
        body = _read_body(ACTIVITY_MAX_BYTES)
        if body is None:
            return _no_store(Response(status=413))
        try:
            found = parse_batch(json.loads(body))
        except ValueError:
            found = None
        if found is None:
            return _no_store(Response(status=400))
        if looks_like_bot(request.headers.get("User-Agent")):
            return _no_store(Response(status=204))
        address = _network_key(_client_address())
        if not event_rate.take(address, len(found.events)):
            return _no_store(Response(status=204))
        if (visits is None or not visits.knows(found.device)) and not new_device_rate.take(address):
            return _no_store(Response(status=204))
        who = visitor()
        activity.add_page(found, who.state if gate is not None else "anon", who.uid, who.name, who.iat)
        return _no_store(Response(status=204))

    def admin_refusal(page: bool) -> Response | None:
        """Who may see the admin panel: None for an admin; else 404 while it is off, 401 to anyone not signed in, 403
        to anyone else (a page with words for /admin, JSON for the API)."""
        if gate is None or not admin_ids or visits is None:
            abort(404)
        who = visitor()
        if who.signed_in and who.uid in admin_ids:
            return None
        status = 403 if who.signed_in else 401
        if page:
            response = Response(ADMIN_FORBIDDEN if who.signed_in else ADMIN_SIGN_IN, status=status,
                                mimetype="text/html")
        else:
            response = jsonify(error="forbidden" if who.signed_in else "discord_required")
            response.status_code = status
        response.headers["Cache-Control"] = PRIVATE_NO_STORE
        response.headers["X-Robots-Tag"] = "noindex"
        return response

    def admin_report() -> bytes:
        """The admin figures as JSON, computed at most every ADMIN_STATS_CACHE_S seconds."""
        at, body = admin_cache
        if at is not None and clock() - at < ADMIN_STATS_CACHE_S:
            return body
        mark = visits.member_hash
        linked = {mark(uid) for uid in links.uids()} if links is not None else set()
        pings = {mark(uid) for uid in links.with_pings()} if links is not None else set()
        subscribed = set()
        if push is not None:
            subscribed = {mark(row["member"]["uid"]) for row in push.store.rows()
                          if isinstance(row.get("member"), dict) and row["member"].get("uid")}
        report = build_report(visits.data(), visits.today(), clicks.totals() if clicks is not None else {"days": {}},
                              linked=linked - {None}, pings=pings - {None}, push=subscribed - {None})
        body = json.dumps(report, separators=(",", ":")).encode()
        admin_cache[:] = [clock(), body]
        return body

    @app.get("/admin")
    def admin_page() -> Response:
        """The admin panel: the front end's page, without the market in it, for an admin only (see `admin_refusal`)."""
        if (refused := admin_refusal(page=True)) is not None:
            return refused
        try:
            template = (static_dir / "index.html").read_text(encoding="utf-8")
        except FileNotFoundError:
            response = Response("front end not built", status=503, mimetype="text/plain")
        else:
            page = template.replace(SNAPSHOT_MARKER, "", 1).replace(PREVIEW_MARKER, "", 1)
            response = Response(page, mimetype="text/html")
        response.headers["Cache-Control"] = PRIVATE_NO_STORE
        response.headers["X-Robots-Tag"] = "noindex"
        return response

    @app.get("/api/admin/stats")
    def admin_stats() -> Response:
        """The admin panel's figures (advisor/admin_stats.py), for an admin only (see `admin_refusal`)."""
        if (refused := admin_refusal(page=False)) is not None:
            return refused
        response = Response(admin_report(), mimetype="application/json")
        response.headers["Cache-Control"] = PRIVATE_NO_STORE
        response.headers["X-Robots-Tag"] = "noindex"
        return response

    def push_owners() -> set[str]:
        if push is None:
            return set()
        return {row["member"]["uid"] for row in push.store.rows()
                if isinstance(row.get("member"), dict) and isinstance(row["member"].get("uid"), str)}

    def deep_report(name: str):
        """A deep tab's figures (advisor/activity_report.py), computed at most every ADMIN_DEEP_CACHE_S seconds."""
        cached = deep_cache.get(name)
        if cached is not None and clock() - cached[0] < ADMIN_DEEP_CACHE_S:
            return cached[1]
        now = activity.now()
        if name == "members":
            report = activity_report.members_report(activity, links, push_owners(), now)
        elif name == "accounts":
            report = activity_report.accounts_report(activity, links, now)
        elif name == "features":
            report = activity_report.features_report(activity, now)
        elif name == "sources":
            report = activity_report.sources_report(activity, links, now)
        else:
            report = activity_report.discord_report(activity, visits.discord_counts(), links, now)
        deep_cache[name] = (clock(), report)
        return report

    def admin_answer(body: bytes | str, mimetype: str = "application/json") -> Response:
        response = Response(body, mimetype=mimetype)
        response.headers["Cache-Control"] = PRIVATE_NO_STORE
        response.headers["X-Robots-Tag"] = "noindex"
        return response

    @app.get("/api/admin/<any(members, accounts, features, sources, discord):name>")
    def admin_deep(name: str) -> Response:
        """A deep tab of the admin panel, for an admin only (see `admin_refusal`); 404 without the activity store."""
        if (refused := admin_refusal(page=False)) is not None:
            return refused
        if activity is None:
            abort(404)
        return admin_answer(json.dumps(deep_report(name), separators=(",", ":"), ensure_ascii=False))

    @app.get("/api/admin/members.csv")
    def admin_members_csv() -> Response:
        """The members directory as a spreadsheet, for an admin only (see `admin_refusal`)."""
        if (refused := admin_refusal(page=False)) is not None:
            return refused
        if activity is None:
            abort(404)
        response = admin_answer(activity_report.members_csv(deep_report("members")), "text/csv")
        day = time.strftime("%Y-%m-%d", time.gmtime(activity.now()))
        response.headers["Content-Disposition"] = f'attachment; filename="otd-palace-members-{day}.csv"'
        return response

    @app.get("/api/admin/member/<uid>")
    def admin_member(uid: str) -> Response:
        """One member's row and timeline, for an admin only (see `admin_refusal`); 404 for anyone the site never
        saw."""
        if (refused := admin_refusal(page=False)) is not None:
            return refused
        if activity is None or not SNOWFLAKE.fullmatch(uid):
            abort(404)
        found = activity_report.member_timeline(activity, uid, links, push_owners(), activity.now())
        if found is None:
            abort(404)
        return admin_answer(json.dumps(found, separators=(",", ":"), ensure_ascii=False))

    @app.get("/img/players/<sport>/<int:player_id>")
    def player_photo(sport: str, player_id: int) -> Response:
        """A player's photo, or 204 when there is none: an empty answer the img fails on (the page then shows
        initials) without the error line a 404 leaves in the browser's console.

        Only a player the snapshot shows is ever looked up out there, so this is no proxy to fetch any id; another
        one gets what is already on disk. A settled "no photo" is kept 10 minutes; while a sport's map is still being
        built the 204 is `no-store`, and the page asks once more a little later.
        """
        name, position = shown_players().get((sport, player_id), (None, None))
        photo, settled = photos.lookup(sport, player_id, name, position) if photos is not None else (None, True)
        if photo is None:
            response = Response(status=204)
            # A sport whose name map is not built yet (a fresh server) has not said "no match": do not keep this.
            response.headers["Cache-Control"] = f"public, max-age={PHOTO_NONE_CACHE_S}" if settled else "no-store"
            return response
        body, content_type = photo
        response = Response(body, mimetype=content_type)
        response.headers["Cache-Control"] = f"public, max-age={PHOTO_BROWSER_CACHE_S}"
        response.set_etag(hashlib.sha256(body).hexdigest()[:32])
        return response.make_conditional(request)

    def push_body(parse):
        """The parsed JSON body of a push request, or the error response: 404 while push is off, 429 past
        PUSH_CLIENT_PER_MIN a minute from one address, 415 when it is not JSON, 413 past PUSH_MAX_BYTES, 400 when
        `parse` refuses it."""
        if push is None:
            return None, _no_store(Response("Not Found", status=404, mimetype="text/plain"))
        if not push_rate.take(_client_address()):
            return None, _no_store(Response(status=429))
        if request.mimetype != "application/json":
            return None, _no_store(Response(status=415))
        body = _read_body(PUSH_MAX_BYTES)
        if body is None:
            return None, _no_store(Response(status=413))
        parsed = parse(body)
        if parsed is None:
            return None, _no_store(Response(status=400))
        return parsed, None

    @app.get("/api/passes/import")
    @members_only
    def passes_import() -> Response:
        """The passes of a Real username, for the page to keep (see `advisor.importer`): 200, 404 when no account has
        that name, 422 when none of its passes can be read, 503 when the lookup cannot happen now, 400 for a name
        that cannot be one, 429 past IMPORT_PER_ADDRESS lookups from one address in IMPORT_ADDRESS_WINDOW_S (the page's
        next asks for an account still being read have a limit of their own: IMPORT_FOLLOW_UP_PER_MIN a minute); 404
        while the site has no importer. A 503 says in Retry-After, and in words, when to ask again. Gzipped for a
        client that takes it."""
        if importer is None:
            return _no_store(Response("Not Found", status=404, mimetype="text/plain"))
        name = valid_username(request.args.get("u", ""))
        if name is None:
            return _no_store(Response(status=400))
        found = lookup(name)
        if isinstance(found, Response):
            return found
        note_lookup(found, name)
        return import_response(found)

    def note_lookup(found, name: str) -> None:
        """Records an account lookup that has its answer (advisor/activity.py), under the member who asked."""
        if activity is None or (found.status == "ok" and getattr(found, "waiting", 0)):
            return
        who = visitor()
        activity.note_lookup(found.username or name, who.uid if who.signed_in else None, found.status,
                             len(found.passes) if found.status == "ok" else None)

    def lookup(name: str):
        """The import answer for `name`, or the 429 when this address spent its lookups. An answer already kept costs
        the producer nothing: only a lookup that leaves counts against the address. The page asking again while an
        account's seasons are still being read costs the producer no read either (it keeps that answer), so it does
        not spend the address's lookups; it still holds a thread while it waits, so it has a limit of its own, roomy
        enough for the page's pace."""
        found = importer.cached(name) if hasattr(importer, "cached") else None
        if found is None:
            again = hasattr(importer, "follow_up") and importer.follow_up(name)
            if not (follow_up_rate if again else import_rate).take(_client_address()):
                return _no_store(Response(status=429))
            found = importer.lookup(name)
        return found

    def import_response(found, extra: dict | None = None) -> Response:
        """An import answer as the page reads it (gzipped for a client that takes it), with `extra` fields added."""
        gzipped = _accepts_gzip()
        if extra:
            data = json.loads(import_body(found, False)) | extra
            plain = json.dumps(data, separators=(",", ":")).encode()
            response = _encoded(compress(plain) if gzipped else plain, gzipped, mimetype="application/json")
        else:
            response = _encoded(import_body(found, gzipped), gzipped, mimetype="application/json")
        response.status_code = IMPORT_STATUS[found.status]
        if found.status == "busy":
            response.headers["Retry-After"] = str(getattr(found, "retry_after", 0) or IMPORT_RETRY_AFTER_S)
        return _no_store(response)

    def import_body(found, gzipped: bool) -> bytes:
        """The JSON of an import answer, gzipped when asked; a busy one says in words when to come back."""
        nonlocal import_bodies
        cached, plain, packed = import_bodies  # one read: a tuple is swapped whole, never changed in place
        if cached is not found:
            data = found.json()
            if found.status == "busy":
                wait_s = getattr(found, "retry_after", 0) or IMPORT_RETRY_AFTER_S
                data["message"] = f"Too many account lookups right now. Try again in {wait_s} s."
            plain, packed = json.dumps(data, separators=(",", ":")).encode(), None
        if gzipped and packed is None:
            packed = compress(plain)
        import_bodies = (found, plain, packed)
        return packed if gzipped else plain

    @app.get("/api/push/key")
    @members_only
    def push_key() -> Response:
        if push is None:
            return _no_store(Response("Not Found", status=404, mimetype="text/plain"))
        return _no_store(jsonify(public_key=push.link["public_key"]))

    @app.put("/api/push/subscription")
    @members_only
    def push_subscribe() -> Response:
        """Adds or updates this device's subscription and rules (with every category off, nothing is kept): 204, 410
        when the push service said the endpoint is gone (the page turns alerts off), 503 when there is no room."""
        parsed, error = push_body(parse_subscription)
        if error is not None:
            return error
        subscription, rules = parsed
        owner = visitor().alert_owner()  # with the gate on: whose alerts these are, so they end with the membership
        result = push.store.upsert(subscription, rules, member=owner) if owner else push.store.upsert(subscription, rules)
        return _no_store(Response(status=UPSERT_STATUS[result]))

    @app.delete("/api/push/subscription")
    def push_unsubscribe() -> Response:
        """Forgets this device's subscription: 204. Open to anyone even with the gate on: it reveals nothing, and
        someone who left our server must still be able to stop the alerts."""
        endpoint, error = push_body(parse_endpoint)
        if error is not None:
            return error
        push.store.delete(endpoint)
        return _no_store(Response(status=204))

    @app.post("/api/push/test")
    @members_only
    def push_test() -> Response:
        """Sends this device the test alert: 204, or 429 past three an hour for it (or the server's hourly budget), 404
        when it is not subscribed, 410 when the push service said it is gone, 502 when it could not take it."""
        endpoint, error = push_body(parse_endpoint)
        if error is not None:
            return error
        return _no_store(Response(status=TEST_STATUS[push.send_test(endpoint)]))

    @app.get("/api/me")
    def me() -> Response:
        """Whether the gate is on, whether the asker is a member, their state ("anon", "in", "out", "banned"; None with
        the gate off) and, once signed in with Discord, the name to show; never kept."""
        found = visitor()
        return _no_store(jsonify(gate=gate is not None, member=gate is not None and found.member,
                                 state=found.state if gate is not None else None,
                                 name=found.name if found.signed_in else None))

    # --- a member's linked Real account (advisor/members.py) ---

    def link_json(row: dict | None, uid: str | None = None) -> dict:
        """What the page reads of a member's link: the link (or None), the state of their Discord perks, and when
        they last unlinked (seconds since the epoch, or None), so a device still linked from before does not link
        them back."""
        link = None if row is None else {
            "username": row["username"], "linked_at": row["linked_at"], "refreshed_at": row["refreshed_at"],
            "passes": row["summary"].get("passes", 0), "year": row["year"], "pings": row["pings"],
            "dm_closed": row["dm_closed"]}
        unlinked = links.unlinked_at(uid) if row is None and uid else None
        return {"link": link, "perks": perks_state(row), "unlinked_at": unlinked, "now": time.time()}

    def link_guard(write: bool, signed_in: bool = False) -> Response | None:
        """The answer that stops a /api/me/link request: 404 without the gate or the store, 401 for anyone but a
        member (`signed_in`: for anyone not signed in with Discord, a member or not); for a change, 403 when the
        browser says another site sent it and 429 past LINK_PER_MIN a minute."""
        if gate is None or links is None:
            return _no_store(Response("Not Found", status=404, mimetype="text/plain"))
        if signed_in and not visitor().signed_in:
            response = _no_store(jsonify(error="discord_required"))
            response.status_code = 401
            return response
        if not signed_in and ((away := turned_away()) is not None or not visitor().uid):
            return away or _no_store(Response(status=401))
        if write:
            site = request.headers.get("Sec-Fetch-Site")
            if site is not None and site != "same-origin":
                return _no_store(Response(status=403))
            if not link_rate.take(_client_address()):
                return _no_store(Response(status=429))
        return None

    def link_body() -> tuple[dict | None, Response | None]:
        if request.mimetype != "application/json":
            return None, _no_store(Response(status=415))
        raw = _read_body(LINK_MAX_BYTES)
        if raw is None:
            return None, _no_store(Response(status=413))
        try:
            data = json.loads(raw)
        except ValueError:
            data = None
        if not isinstance(data, dict):
            return None, _no_store(Response(status=400))
        return data, None

    def resync(uid: str) -> None:
        if perks is not None:
            perks.request_sync(uid)  # in the background: Discord never slows or breaks a link

    @app.get("/api/me/link")
    def my_link() -> Response:
        """The member's linked Real account and their perks' state (see `link_json`)."""
        if (stopped := link_guard(False)) is not None:
            return stopped
        uid = visitor().uid
        return _no_store(jsonify(link_json(links.get(uid), uid)))

    @app.post("/api/me/link")
    def link_account() -> Response:
        """Links (or refreshes) a Real username for the member, `{"username", "year"?}`: the import answer as
        /api/passes/import gives it, plus `link` and `perks`, with its status (404, 422, 503...); 409 with words when
        another member linked that name; 400 for a name that cannot be one. The lookup spends the address's import
        budget, like /api/passes/import."""
        if (stopped := link_guard(True)) is not None:
            return stopped
        if importer is None:
            return _no_store(Response("Not Found", status=404, mimetype="text/plain"))
        data, error = link_body()
        if error is not None:
            return error
        name = valid_username(data.get("username"))
        if name is None:
            return _no_store(Response(status=400))
        uid = visitor().uid
        taken = _no_store(jsonify(error="taken", message=(
            f"{name} is linked to another Discord member already. If it is yours, ask the team in the server.")))
        taken.status_code = 409
        owner = links.owner_of(name)
        if owner is not None and owner != uid:
            return taken
        found = lookup(name)
        if isinstance(found, Response):
            return found
        note_lookup(found, name)
        if found.status != "ok":
            return import_response(found)
        before = links.get(uid)
        outcome = links.claim(uid, found.username or name, found.passes, now=time.time(), year=data.get("year"))
        if outcome == "taken":
            return taken
        if outcome == "full":
            full = _no_store(jsonify(error="full", message="Linking is full right now. Try again later."))
            full.status_code = 503
            return full
        after = links.get(uid)
        if activity is not None and (before is None or before["username"].casefold() != after["username"].casefold()):
            activity.note_link(uid, after["username"], after["summary"].get("passes"))
        # Roles again when they may change: not at each of the page's asks while an account's seasons are read.
        if found.waiting == 0 or before is None or _roles_of(before) != _roles_of(after):
            resync(uid)
        return import_response(found, link_json(after, uid))

    @app.patch("/api/me/link")
    def link_settings() -> Response:
        """Changes the member's settings, `{"pings"?: bool, "follows"?: ["sport:player_id"], "year"?: number}`: the
        link and perks after; 404 when they linked nothing, 400 for a value that does not fit."""
        if (stopped := link_guard(True)) is not None:
            return stopped
        data, error = link_body()
        if error is not None:
            return error
        pings, follows, year = data.get("pings"), data.get("follows"), data.get("year")
        if (pings is not None and not isinstance(pings, bool)) or (follows is not None and not isinstance(follows, list)):
            return _no_store(Response(status=400))
        if year is not None and (not isinstance(year, (int, float)) or isinstance(year, bool)):
            return _no_store(Response(status=400))
        uid = visitor().uid
        before = links.get(uid)
        # The yearly figure is the visitor's own browser's say-so (anyone can send anything): the store keeps it only
        # when it is a whole number from 0 to 50 million, and it serves nothing but a cosmetic role and a line of text.
        row = links.update(uid, pings=pings, follows=follows, year=year)
        if row is None:
            return _no_store(Response(status=404))
        if before is not None and _roles_of(before) != _roles_of(row):  # their account type changed: the role follows
            resync(uid)
        return _no_store(jsonify(link_json(row, uid)))

    @app.delete("/api/me/link")
    def unlink_account() -> Response:
        """Forgets the member's link and takes their perks' roles back: 204."""
        if (stopped := link_guard(True)) is not None:
            return stopped
        uid = visitor().uid
        try:
            links.unlink(uid)
        except OSError:
            return _no_store(Response(status=500))  # nothing changed: the member may press Unlink again
        if activity is not None:
            activity.note_link(uid, "", None, linked=False)
        resync(uid)
        return _no_store(Response(status=204))

    @app.delete("/api/me")
    def delete_my_data() -> Response:
        """"Delete my data": removes everything the server holds under the member's Discord id (advisor/privacy.py),
        asks the bot to take back their roles, and signs them out: 204, also when there was nothing left (a retry
        is safe). Same guard as the other writes, but open to anyone signed in with Discord, in our server or not
        (someone who left must still be able to erase what we hold): 401 for anyone not signed in, 403 from another
        site, 429 past LINK_PER_MIN a minute, 404 without the gate, 500 when a file could not be written (retry)."""
        if (stopped := link_guard(True, signed_in=True)) is not None:
            return stopped
        device = None
        if request.mimetype == "application/json":  # the page names its own visit id, to drop that device's rows too
            raw = _read_body(VISIT_MAX_BYTES)
            try:
                sent = json.loads(raw) if raw else None
            except ValueError:
                sent = None
            device = sent.get("device") if isinstance(sent, dict) else None
        done = privacy.erase_member(visitor().uid, links, push, perks, visits=visits, device=device,
                                    activity=activity)
        if done["failed"]:  # a file could not be written: nothing is claimed, they stay signed in and may retry
            return _no_store(Response(status=500))
        g.visitor = Visitor(member=False, clear=True)  # keep_session clears the cookie, and never renews it instead
        return _no_store(Response(status=204))

    @app.get("/api/teaser")
    def teaser() -> Response:
        """The gate screen's counts (see `_teaser_of`), open to anyone and kept TEASER_CACHE_S seconds."""
        nonlocal teased
        current = current_snapshot()
        if current is None:
            return _no_store(jsonify(deals=0, sports=0, best_pct=None, generated_at=None))
        cached = teased  # one read: another thread may swap it in the meantime, for an equally good pair
        if cached[0] != current[0]:
            cached = (current[0], _teaser_of(current[1]))
            teased = cached
        response = jsonify(cached[1])
        response.headers["Cache-Control"] = f"public, max-age={TEASER_CACHE_S}"
        return response

    def auth_gate() -> Response | None:
        """The answer that stops an /auth/* request before it starts: 404 with the gate off, 429 past AUTH_PER_MIN a
        minute from one address; None to go on."""
        if gate is None:
            abort(404)
        return None if auth_rate.take(_client_address()) else _no_store(Response(status=429))

    @app.get("/auth/discord")
    def auth_start() -> Response:
        """Sends the visitor to Discord's consent page, with a short-lived cookie holding the login's state and the
        page to come back to (`?next=`, a path on this site, else home)."""
        if (stopped := auth_gate()) is not None:
            return stopped
        url, login = gate.start(request.args.get("next"))
        if visits is not None:
            visits.count("auth_start")
        response = _no_store(redirect(url, code=302))
        _set_cookie(response, STATE_COOKIE, login, STATE_MAX_AGE_S)
        return response

    @app.get("/auth/discord/callback")
    def auth_callback() -> Response:
        """Where Discord sends the visitor back: in our server and holding a session, on to where they were; else a
        page that says what went wrong, with the way back to the free site (and Try again, unless Discord refused the
        join). A join that failed after Discord said who they are still signs them in, as not in the server. The login
        cookie is used up either way."""
        if (stopped := auth_gate()) is not None:
            return stopped
        kept = gate.read_state(request.cookies.get(STATE_COOKIE))
        given = request.args.get("state")
        handed = None
        if kept is None or not isinstance(given, str) or given != kept["state"]:
            handed = handoffs.login_state(given, _client_address())  # a login the home-screen app started
            kept = handed or kept
        outcome = gate.finish_from(request.args, kept)
        if handed is not None and outcome.session is not None:
            handoffs.keep(handed["state"], outcome.session)
        if handed is not None and outcome.error is None and outcome.session is not None:
            response = _no_store(Response(HANDOFF_DONE_PAGE.replace("{next}", html.escape(outcome.next)),
                                          mimetype="text/html"))
        elif outcome.error is None and outcome.session is not None:
            response = _no_store(redirect(outcome.next, code=302))
        else:
            status, page = gate.failure_page(outcome.error or "discord", outcome.next)
            response = _no_store(Response(page, status=status, mimetype="text/html"))
        if outcome.session is not None:
            _set_cookie(response, SESSION_COOKIE, outcome.session, SESSION_MAX_AGE_S)
            if visits is not None:
                visits.count("auth_ok")
            if activity is not None:
                session = gate.read_session(outcome.session) or {}
                activity.note_auth(str(session.get("uid", "")), session.get("name"))
        _clear_cookie(response, STATE_COOKIE)
        return response

    @app.post("/auth/handoff")
    def auth_handoff() -> Response:
        """The home-screen app's login (see advisor/handoff.py): {"url"}, the Discord address to open, with a claim
        cookie for POST /auth/handoff/claim. 403 when the browser says another site sent it."""
        if (stopped := auth_gate()) is not None:
            return stopped
        site = request.headers.get("Sec-Fetch-Site")
        if site is not None and site != "same-origin":
            return _no_store(Response(status=403))
        claim, state = handoffs.start(safe_next(request.args.get("next")), _client_address())
        if visits is not None:
            visits.count("auth_start")
        response = _no_store(jsonify(url=gate.authorize_url(state)))
        _set_cookie(response, HANDOFF_COOKIE, claim, HANDOFF_MAX_AGE_S)
        return response

    @app.post("/auth/handoff/claim")
    def auth_handoff_claim() -> Response:
        """The app asks whether its login is done: {"status": "done"} with the session cookie (the claim is then used
        up), "waiting", or "gone" (no such login, out of time, or another network). 403 from another site; 429 past
        HANDOFF_CLAIM_PER_MIN a minute from one address."""
        if gate is None:
            abort(404)
        if not claim_rate.take(_client_address()):
            return _no_store(Response(status=429))
        site = request.headers.get("Sec-Fetch-Site")
        if site is not None and site != "same-origin":
            return _no_store(Response(status=403))
        found = handoffs.claim(request.cookies.get(HANDOFF_COOKIE), _client_address())
        response = _no_store(jsonify(status=found.status))
        if found.status == "done" and found.session is not None:
            _set_cookie(response, SESSION_COOKIE, found.session, SESSION_MAX_AGE_S)
        if found.status != "waiting":
            _clear_cookie(response, HANDOFF_COOKIE)
        return response

    @app.post("/auth/recheck")
    def auth_recheck() -> Response:
        """"I joined, check again": asks Discord now whether the signed-in asker is in our server (unless it was asked
        under RECHECK_MIN_S ago), renews their cookie on the answer and says {"member", "state"}. 401 for anyone not
        signed in, 403 when the browser says another site sent it, 429 past AUTH_PER_MIN a minute from one address."""
        if (stopped := auth_gate()) is not None:
            return stopped
        site = request.headers.get("Sec-Fetch-Site")
        if site is not None and site != "same-origin":
            return _no_store(Response(status=403))
        if not visitor().signed_in:
            response = _no_store(jsonify(error="discord_required"))
            response.status_code = 401
            return response
        g.visitor = gate.recheck(request.cookies.get(SESSION_COOKIE))  # keep_session sends the renewed cookie back
        return _no_store(jsonify(member=g.visitor.member, state=g.visitor.state))

    @app.post("/auth/logout")
    def auth_logout() -> Response:
        """Signs out: clears the session cookie, 204. 403 when the browser says another site sent it."""
        if (stopped := auth_gate()) is not None:
            return stopped
        site = request.headers.get("Sec-Fetch-Site")
        if site is not None and site != "same-origin":
            return _no_store(Response(status=403))
        response = _no_store(Response(status=204))
        _clear_cookie(response, SESSION_COOKIE)
        return response

    @app.post("/discord/interactions")
    def discord_interactions() -> Response:
        """Discord's calls for our slash commands (see `advisor.discord_commands`): open to anyone, gate or no gate,
        since Discord's signature is the check (401 without it); 413 past DISCORD_INTERACTION_MAX_BYTES; 404 while the
        commands are off."""
        if interactions is None:
            abort(404)
        body = _read_body(DISCORD_INTERACTION_MAX_BYTES)
        if body is None:
            return _no_store(Response(status=413))
        status, answer = interactions.handle(request.headers.get("X-Signature-Ed25519"),
                                             request.headers.get("X-Signature-Timestamp"), body)
        response = Response(status=status) if answer is None else jsonify(answer)
        response.status_code = status
        return _no_store(response)

    privacy.register(app)

    @app.get("/<name>")
    def root_file(name: str) -> Response:
        if name not in ROOT_FILES:
            abort(404)
        # the name carries no fingerprint, so it is revalidated
        response = built_file(static_dir, name, cache_control="no-cache")
        if name == SERVICE_WORKER:
            response.headers["Service-Worker-Allowed"] = "/"  # it covers the whole site from the root
        return response

    @app.get("/assets/<path:name>")
    def assets(name: str) -> Response:
        if name.endswith(".br"):  # the brotli copies go out under their file's own name only
            abort(404)
        return built_file(static_dir / "assets", name, cache_control=IMMUTABLE, brotli=True)  # fingerprinted names

    return app
