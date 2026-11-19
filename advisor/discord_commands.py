"""Slash commands in our Discord server, answered by the site itself over HTTP: Discord's "Interactions Endpoint URL",
with no gateway connection and nothing running in the background.

Discord POSTs each use of a command to /discord/interactions, signed with the application's Ed25519 key: the
X-Signature-Ed25519 header signs the X-Signature-Timestamp header followed by the raw body. A request whose signature
does not check, or whose timestamp is more than SIGNATURE_MAX_AGE_S from our clock, gets 401 and nothing else (Discord
itself sends such requests when the address is saved in the Developer Portal, to see that we refuse them). A PING gets
{"type": 1}. The route is not behind the members gate: Discord is the one calling, and the signature is the check.

The commands (COMMANDS: /deals, /price, /otd, /fees and /start) read the current snapshot and nothing else, so no call
leaves the server while one is answered and every answer is immediate. Four more are about the member (/link, /unlink,
/me, /help) and are answered only to them: /link links their Real account through the same store, importer and roles
as the site's POST /api/me/link, so nobody has to leave Discord to do it. An account that has to be read from Real can
take longer than the 3 seconds Discord gives, so /link then answers "thinking" at once, reads the account in a
background thread (at most MAX_BACKGROUND at a time) and edits that answer through the interaction's own webhook
(valid 15 minutes, no bot token needed). The buttons of the role picker in #welcome (custom ids `role:alerts` and
`role:<sport>`) come through the same endpoint: a click toggles the Deal Alerts role or a sport's role for whoever
clicked, the same way, and is answered to them alone. Each answer is plain and short, seen only by
whoever asked unless they set `share`, never pings anyone, shows no link preview, and ends with the site's address.
Data that is missing, stale or the sample market is said so. A member may ask USER_PER_MIN times a minute and the
whole server GUILD_PER_MIN times (in memory, never written); an interaction from anywhere but our server is told
where the commands work.

They are off unless ADVISOR_DISCORD_PUBLIC_KEY (the application's public key, 64 hex characters) and the gate's six
settings are set (see `advisor.discord_gate`); the commands are registered for our server only, where they appear at
once, with `python -m advisor.discord_commands register` (a bulk overwrite: running it twice changes nothing).

Nothing here logs or prints a token, and no error message holds one.
"""

import json
import logging
import math
import os
import re
import statistics
import sys
import threading
import time
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from advisor import discord_gate, discord_invites
from advisor.importer import valid_username
from advisor.account_types import type_of
from advisor.members import roles_for, sport_role
from advisor.ratelimit import TokenBuckets
from advisor.rules import (AFTER_FEES_MIN_REF, LISTING_FEE, OFFER_ACCEPTED, OFFER_LEVEL, OTD_LADDERS, OTD_SPORT_MONTHS,
                           SELLER_FEE)
from advisor.real import RARITY_EMOJI, RARITY_NAMES, rarity_index
from advisor.share import _NUMBERS, _season, _sport, _text, _unit, safe_deals, valid_deal
from advisor.store import SnapshotStore

log = logging.getLogger(__name__)

# Offers, the cheap way to build a pass (frontend/src/lib/offers.ts says the same, from the same rules): an expectation.
OFFERS_LINE = (f"Cheaper with offers: offer about {round((1 - OFFER_LEVEL) * 100)}% under the usual price on many cards "
               f"of these passes. Most are refused (about 1 in {round(1 / OFFER_ACCEPTED)} is accepted in what we "
               "measured), so send many: the ones accepted are the cheapest rating you will get. Offers need Real Pro.")
# Passes first (the internal research notes headlines 2 and 6: a Common pays back in 2 to 3.5 months,
# the median deal leaves about +3 Rax after fees).
PASSES_FIRST_LINE = "Over a year, a pass that pays back usually gives more than a deal: see /otd."

PUBLIC_KEY_ENV = "ADVISOR_DISCORD_PUBLIC_KEY"
INTERACTIONS_PATH = "/discord/interactions"
SIGNATURE_MAX_AGE_S = 5 * 60  # a signed request older (or further ahead) than this is a replay: refused
USER_PER_MIN = 10  # commands one member may use a minute
GUILD_PER_MIN = 120  # commands the whole server may use a minute
AUTOCOMPLETE_PER_MIN = 120  # name suggestions one member may get a minute (one per key pressed)
LINK_PER_MIN = 3  # /link uses one member may make a minute (each can ask Real)
TAPS_BURST, TAPS_PER_MIN = 6, 12  # role-button taps one member may make at once, and a minute (each asks Discord)
FOLLOW_UP_WAITS = (0.5, 1.0)  # a follow-up Discord answers "not yet" (404) or "wait" (429) is tried again after these
MAX_BACKGROUND = 4  # answers being worked out in the background at once (each holds a thread); more are told to wait
USERS_MAX = 10_000  # members whose limits are remembered at once
TOP_DEALS = 5
TOP_PASSES = 5
AUTOCOMPLETE_MAX = 25  # Discord shows 25 suggestions at most
CONTENT_MAX_CHARS = 2000  # Discord's limit for a message
NAME_MAX_CHARS = 40  # a longer name from the data is cut
PRICE_MAX = 100_000_000  # the biggest price /fees takes
MARGIN_MAX = 1000  # the biggest margin /fees takes, in percent
CHOICE_MAX_CHARS = 100  # Discord's limit for a suggestion's name and value

# Discord's numbers.
PING, APPLICATION_COMMAND, MESSAGE_COMPONENT, AUTOCOMPLETE = 1, 2, 3, 4
PONG, CHANNEL_MESSAGE, DEFERRED_MESSAGE, AUTOCOMPLETE_RESULT = 1, 4, 5, 8
SUPPRESS_EMBEDS, EPHEMERAL = 1 << 2, 1 << 6
SUB_COMMAND_TYPE, STRING, INTEGER, BOOLEAN = 1, 3, 4, 5
CHAT_INPUT = 1

# The beginner path: the first three steps of "New to Real" on the site's Earn page (frontend/src/content/earn.ts,
# TIER_PLANS), word for word; a test keeps them equal.
FIRST_MOVES = (
    "Take the free player pass in every sport that offers one. Pick a top-10 earner of a sport that is playing now.",
    "Answer the daily streak poll in each sport. If you pick right more than half the time, ride the run to 8.",
    "Do the karma routine: polls, live games, a comment. It turns into a little Rax and feeds the leaderboards.",
)

# The sports the site covers, in the order the season rules list them.
SPORTS = tuple(OTD_SPORT_MONTHS)
MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
          "November", "December")

# The role picker's buttons (scripts/discord_setup.py posts them in #welcome): custom id -> the role it toggles.
ALERTS_ROLE = "Deal Alerts"
ROLE_BUTTONS = {"role:alerts": ALERTS_ROLE} | {f"role:{sport}": sport_role(sport) for sport in OTD_SPORT_MONTHS}
_APPLICATION = re.compile(r"\d{15,21}")
_WEBHOOK_TOKEN = re.compile(r"[A-Za-z0-9._-]{20,300}")

_PUBLIC_KEY = re.compile(r"[0-9a-fA-F]{64}")
_SIGNATURE = re.compile(r"[0-9a-fA-F]{128}")
_TIMESTAMP = re.compile(r"\d{1,12}")
_MARKET_KEY = re.compile(r"[a-z][a-z0-9_-]{0,19}:\d{1,12}")  # an autocomplete value: "sport:player id"
_INITIALLED = re.compile(r"^\s*[A-Za-z]\.\s")  # "J. White": the live deals' way of writing a name
_MARKDOWN = re.compile(r"([\\*_~`|<>#\[\]()])")
_PAYBACK_MONTH = re.compile(r"(\d{4})-(\d{2})")

_SHARE = {"type": BOOLEAN, "name": "share", "description": "Post the answer for everyone in the channel (only you see it "
                                                            "otherwise)"}
_SPORT_OPTION = {"type": STRING, "name": "sport", "description": "Only this sport",
                 "choices": [{"name": _sport(sport), "value": sport} for sport in SPORTS]}
COMMANDS = [
    {"name": "deals", "type": CHAT_INPUT, "description": "The best deals right now that still leave Rax after fees",
     "options": [_SPORT_OPTION,
                 {"type": INTEGER, "name": "max_price", "description": "Only deals at or under this many Rax",
                  "min_value": 1, "max_value": PRICE_MAX},
                 # Collectors think in floors: "Epic" is Epic and every rarer card, as the site's "And rarer".
                 {"type": INTEGER, "name": "rarity", "description": "Only this rarity or rarer",
                  "choices": [{"name": name, "value": index} for index, name in enumerate(RARITY_NAMES)]},
                 _SHARE]},
    {"name": "price", "type": CHAT_INPUT, "description": "A player's usual price, recent sales and cheapest deal",
     "options": [{"type": STRING, "name": "player", "description": "The player's name", "required": True,
                  "autocomplete": True, "max_length": CHOICE_MAX_CHARS},
                 _SHARE]},
    {"name": "otd", "type": CHAT_INPUT, "description": "The passes that pay back best On This Day",
     "options": [_SPORT_OPTION, _SHARE]},
    {"name": "fees", "type": CHAT_INPUT, "description": "What you keep after a sale, and the most to pay for a card",
     "options": [{"type": INTEGER, "name": "price", "description": "The sale price, in Rax", "required": True,
                  "min_value": 1, "max_value": PRICE_MAX},
                 {"type": INTEGER, "name": "margin", "description": "The profit you want, in percent (0 to break even)",
                  "min_value": 0, "max_value": MARGIN_MAX},
                 _SHARE]},
    {"name": "start", "type": CHAT_INPUT, "description": "New to Real? The first three moves", "options": [_SHARE]},
    {"name": "link", "type": CHAT_INPUT, "description": "Link your Real account: roles, and advice that knows your passes",
     "options": [{"type": STRING, "name": "username", "description": "Your Real username", "required": True,
                  "min_length": 2, "max_length": 31}]},
    {"name": "unlink", "type": CHAT_INPUT, "description": "Forget your linked Real account and its roles", "options": []},
    {"name": "me", "type": CHAT_INPUT, "description": "Your linked account: passes, sports and roles", "options": []},
    {"name": "invites", "type": CHAT_INPUT, "description": "Your invites, the top inviters, and how to make your link",
     "options": []},
    {"name": "help", "type": CHAT_INPUT, "description": "What each command does", "options": []},
]
# Each option's type, by name: what an answer reads is checked against it.
OPTION_TYPES = {option["name"]: option["type"] for command in COMMANDS for option in command["options"]}


# --- the settings ----------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class CommandsConfig:
    public_key: str  # the application's public key, lower-case hex: not a secret
    guild_id: str  # our server: the only one the commands answer in
    public_url: str  # the site's address, which every answer links to


def _public_key(value: str) -> Ed25519PublicKey | None:
    if not _PUBLIC_KEY.fullmatch(value):
        return None
    try:
        return Ed25519PublicKey.from_public_bytes(bytes.fromhex(value))
    except ValueError:
        return None


def config_problem(env) -> str | None:
    """Why the commands' settings cannot be used, or None (the key unset: the commands are off; or set and usable, with
    the gate on). The message names the setting, never a value."""
    key = (env.get(PUBLIC_KEY_ENV) or "").strip()
    if not key:
        return None
    if _public_key(key) is None:
        return (f"{PUBLIC_KEY_ENV} must be the Discord application's public key: 64 hex characters (copy it from the "
                "Developer Portal, General Information).")
    if not all((env.get(name) or "").strip() for name in discord_gate.ENV_NAMES):
        return (f"{PUBLIC_KEY_ENV} is set but the Discord gate is off: the slash commands need the gate's six settings "
                "too, or unset it.")
    return None


def config_from_env(env) -> CommandsConfig | None:
    """The commands' settings, or None when the public key is unset (the commands are off). Raises ValueError with
    `config_problem`'s message (or the gate's) on settings that cannot be used: the server refuses them first."""
    problem = config_problem(env) or discord_gate.config_problem(env)
    if problem is not None:
        raise ValueError(problem)
    key = (env.get(PUBLIC_KEY_ENV) or "").strip()
    gate = discord_gate.config_from_env(env)
    if not key or gate is None:
        return None
    return CommandsConfig(public_key=key.lower(), guild_id=gate.guild_id, public_url=gate.public_url)


def verify(key: Ed25519PublicKey, signature: str | None, timestamp: str | None, body: bytes, now: float) -> bool:
    """Whether Discord signed this request: the signature over the timestamp then the body checks with our key, and the
    timestamp is within SIGNATURE_MAX_AGE_S of `now`."""
    if not signature or not timestamp or not _SIGNATURE.fullmatch(signature) or not _TIMESTAMP.fullmatch(timestamp):
        return False
    if abs(now - int(timestamp)) > SIGNATURE_MAX_AGE_S:
        return False
    try:
        key.verify(bytes.fromhex(signature), timestamp.encode() + body)
    except InvalidSignature:
        return False
    return True


# --- words -----------------------------------------------------------------------------------------------------------


def kept(price: int, listing_fee: bool = True) -> int:
    """What a sale at `price` leaves the seller: Real keeps a tenth (rounded in its favour), and a normal listing costs
    LISTING_FEE more; Quick List has no fee. The same sum as a deal's margin after fees (`advisor.deals`)."""
    return math.floor(price * (1 - SELLER_FEE)) - (LISTING_FEE if listing_fee else 0)


def _rax(n: float) -> str:
    return f"{round(n):,} Rax"


def _name(value: object) -> str:
    """A name from the data as a message shows it: control characters out, cut, and nothing in it can format text or
    write a mention."""
    text = str(value) if type(value) is int else _text(value).strip()
    text = text if len(text) <= NAME_MAX_CHARS else text[: NAME_MAX_CHARS - 1].rstrip() + "…"
    return _MARKDOWN.sub(r"\\\1", text)


def _fold(text: str) -> str:
    """A name the way a search compares it: accents off, case off, spaces collapsed ("Jokić" finds "jokic")."""
    plain = "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))
    return " ".join(plain.casefold().split())


def _age(seconds: float) -> str:
    if seconds < 120:
        return f"{int(seconds)} seconds"
    if seconds < 2 * 3600:
        return f"{int(seconds // 60)} minutes"
    return f"{int(seconds // 3600)} hours"


def _month(text: object) -> str | None:
    """'2027-05' as 'May 2027'; None for anything else."""
    found = _PAYBACK_MONTH.fullmatch(text) if isinstance(text, str) else None
    if found is None or not 1 <= int(found.group(2)) <= 12:
        return None
    return f"{MONTHS[int(found.group(2)) - 1]} {found.group(1)}"


def _number(value: object) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def _when(text: object) -> float | None:
    if not isinstance(text, str):
        return None
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)).timestamp()


# --- reading a snapshot ----------------------------------------------------------------------------------------------


def _rows(snapshot: dict, key: str) -> list[dict]:
    rows = snapshot.get(key)
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def _usable(row: dict, now: float) -> bool:
    """Whether a deal row can be shown now: the page could draw it, its numbers are finite (the margin included), and
    its end time is readable and still ahead: an end time that cannot be read is no proof the deal is still on."""
    ends = _when(row.get("ends_at"))
    numbers = all(_number(row.get(key)) for key in (*_NUMBERS, "flip_margin"))
    return valid_deal(row) and numbers and ends is not None and ends > now


def live_deals(snapshot: dict, now: float) -> list[dict]:
    """The snapshot's deals that can be shown now (`_usable`), in its order."""
    return [row for row in _rows(snapshot, "deals") if _usable(row, now)]


def margin_deals(snapshot: dict, now: float, sport: str | None = None, max_price: int | None = None,
                 min_rarity: int | None = None) -> list[dict]:
    """The deals that leave rax after fees if resold at the usual price, the way the site's next moves pick them,
    among those anybody may be pointed at (`share.safe_deals`: the New level's, no auction, no falling market, no
    player likely to miss the next game): a positive margin after fees, no thin usual price (under the snapshot's
    after_fees_min_ref), one per player and season, of `min_rarity` or rarer when given. Best first, as the site ranks them: the most margin per rax spent,
    then the most margin, then the cheapest."""
    rules = snapshot.get("rules") if isinstance(snapshot.get("rules"), dict) else {}
    thin = rules.get("after_fees_min_ref") if _number(rules.get("after_fees_min_ref")) else AFTER_FEES_MIN_REF
    best: dict[tuple, dict] = {}
    for row in safe_deals(snapshot):
        if not (_usable(row, now) and row["flip_margin"] > 0 and row["price"] > 0 and row["reference"] >= thin):
            continue
        if (sport is not None and row["sport"] != sport) or (max_price is not None and row["price"] > max_price):
            continue
        if min_rarity is not None and row["rarity"] < min_rarity:  # valid_deal (in _usable) checked it is 0..7
            continue
        group = (row["sport"], row["season"], row["player_id"])
        if group not in best or _rank(row) < _rank(best[group]):
            best[group] = row
    return sorted(best.values(), key=_rank)


def _rank(row: dict) -> tuple:
    return (-row["flip_margin"] / row["price"], -row["flip_margin"], row["price"], row["listing_id"])


def players(snapshot: dict) -> dict[tuple[str, int], str]:
    """The players a snapshot names, by (sport, player id): those of its deals, its price moves and its player and
    fighter passes. A whole name wins over the deals' "J. White"."""
    moves = snapshot.get("moves") if isinstance(snapshot.get("moves"), dict) else {}
    otd = snapshot.get("otd") if isinstance(snapshot.get("otd"), dict) else {}
    rows = _rows(snapshot, "deals") + _rows(moves, "risers") + _rows(moves, "fallers")
    rows += [row for row in _rows(otd, "markets") if row.get("kind") != "team"]
    found: dict[tuple[str, int], str] = {}
    for row in rows:
        sport, player_id, name = row.get("sport"), row.get("player_id"), row.get("player_name")
        if not (isinstance(sport, str) and type(player_id) is int and isinstance(name, str) and name.strip()):
            continue
        known = found.get((sport, player_id))
        if known is None or (_INITIALLED.match(known) and not _INITIALLED.match(name)):
            found[(sport, player_id)] = name.strip()
    return found


def _matches(index: list[tuple[str, str, str, int]], query: str) -> list[tuple[str, str, str, int]]:
    """The players whose name holds `query` (folded), a name or a word of it that starts with it first."""
    q = _fold(query)
    starts, holds = [], []
    for entry in index:
        folded = entry[0]
        if not q or folded.startswith(q) or f" {q}" in f" {folded}":
            starts.append(entry)
        elif q in folded:
            holds.append(entry)
    return starts + holds


# --- the interactions ------------------------------------------------------------------------------------------------


def _message(text: str, share: bool, footer: str) -> dict:
    """A reply: `text` (cut to fit, so the footer, the site's address, always stays) then `footer`."""
    room = CONTENT_MAX_CHARS - len(footer) - 1
    if len(text) > room:
        text = text[: room - 1] + "…"
    text = f"{text}\n{footer}"
    flags = SUPPRESS_EMBEDS | (0 if share else EPHEMERAL)
    return {"type": CHANNEL_MESSAGE, "data": {"content": text, "flags": flags, "allowed_mentions": {"parse": []}}}


def _options(data: dict) -> dict[str, object]:
    """The command's options by name, each kept only when its value has the type the command declares."""
    found = {}
    for option in data.get("options") if isinstance(data.get("options"), list) else ():
        if not isinstance(option, dict):
            continue
        name, value = option.get("name"), option.get("value")
        want = OPTION_TYPES.get(name) if isinstance(name, str) else None
        if (want == STRING and isinstance(value, str)) or (want == BOOLEAN and isinstance(value, bool)) or (
                want == INTEGER and type(value) is int):
            found[name] = value
    return found


def _user(payload: dict) -> str:
    member = payload.get("member") if isinstance(payload.get("member"), dict) else {}
    user = member.get("user") if isinstance(member.get("user"), dict) else payload.get("user")
    uid = user.get("id") if isinstance(user, dict) else None
    return uid if isinstance(uid, str) and uid.isdigit() and len(uid) <= 32 else ""


class Interactions:
    """Answers Discord's interactions for our commands from `store`'s snapshot. Safe to use from several threads at
    once. `clock` gives seconds since the epoch (the signatures' timestamps are on it), `monotonic` times the limits."""

    def __init__(self, config: CommandsConfig, store: SnapshotStore, clock: Callable[[], float] = time.time,
                 monotonic: Callable[[], float] = time.monotonic, links=None, importer=None, perks=None,
                 transport: discord_gate.Transport | None = None, spawn: Callable[[Callable[[], None]], bool] | None = None):
        """`links` (advisor.members.MemberLinks), `importer` (what reads a Real account) and `perks`
        (advisor.discord_perks.PerkWorker, or None) make /link, /unlink, /me and the role buttons work; without links
        they say so. `transport` carries the follow-up calls to Discord (a fake in tests); `spawn(work)` runs `work` in
        the background and says whether it could (by default a bounded daemon thread)."""
        key = _public_key(config.public_key)
        if key is None:
            raise ValueError(f"{PUBLIC_KEY_ENV} is not a public key")
        self._key = key
        self._config = config
        self._store = store
        self._clock = clock
        self._users = TokenBuckets(USER_PER_MIN, USER_PER_MIN / 60, USERS_MAX, monotonic)
        self._server = TokenBuckets(GUILD_PER_MIN, GUILD_PER_MIN / 60, 1, monotonic)
        self._typing = TokenBuckets(AUTOCOMPLETE_PER_MIN, AUTOCOMPLETE_PER_MIN / 60, USERS_MAX, monotonic)
        self._slow = TokenBuckets(LINK_PER_MIN, LINK_PER_MIN / 60, USERS_MAX, monotonic)
        self._taps = TokenBuckets(TAPS_BURST, TAPS_PER_MIN / 60, USERS_MAX, monotonic)
        self._sleep = time.sleep
        self._links, self._importer, self._perks = links, importer, perks
        self._send = transport or discord_gate._url_transport(discord_gate._OPENER.open)
        self._spawn = spawn or self._start
        self._running = 0
        self._running_lock = threading.Lock()
        # The snapshot last read, by its ETag: (etag, snapshot, players, the players sorted for a search).
        self._read: tuple = (None, {}, {}, [])
        self._reading = threading.Lock()  # one thread parses a new snapshot; the others wait for it, not parse it too
        self._answers = {"deals": self._deals, "price": self._price, "otd": self._otd, "fees": self._fees,
                         "start": self._first_moves, "unlink": self._unlink, "me": self._me, "help": self._help}

    def handle(self, signature: str | None, timestamp: str | None, body: bytes) -> tuple[int, dict | None]:
        """(HTTP status, JSON answer or None) for a request to the interactions endpoint, with its two signature
        headers and its raw body: 401 when Discord did not sign it, 400 when it is no interaction we answer."""
        if not verify(self._key, signature, timestamp, body, self._clock()):
            return 401, None
        try:
            payload = json.loads(body)
        except (ValueError, RecursionError):
            return 400, None
        kind = payload.get("type") if isinstance(payload, dict) else None
        if type(kind) is not int:
            return 400, None
        if kind == PING:
            return 200, {"type": PONG}
        if kind not in (APPLICATION_COMMAND, AUTOCOMPLETE, MESSAGE_COMPONENT):
            return 400, None
        data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        options, user = _options(data), _user(payload)
        ours = payload.get("guild_id") == self._config.guild_id
        footer = f"-# OTD Palace: {self._config.public_url}"
        if kind == AUTOCOMPLETE:
            try:
                choices = self._suggest(options.get("player", "")) if ours and self._typing.take(user) else []
            except Exception:  # noqa: BLE001 - a snapshot we did not foresee: no suggestion, never a failure
                log.exception("discord autocomplete failed")
                choices = []
            return 200, {"type": AUTOCOMPLETE_RESULT, "data": {"choices": choices}}
        if not ours:
            return 200, _message("These commands work only in the OTD Palace Discord server.", False, footer)
        if not (self._users.take(user) and self._server.take("all")):
            return 200, _message("That is a lot of questions at once. Try again in a minute.", False, footer)
        name = data.get("name")
        try:
            if kind == MESSAGE_COMPONENT:
                return 200, self._button(payload, data, user, footer)
            if name == "link":
                return 200, self._link(payload, options, user, footer)
            if name == "invites":  # to the caller alone, always: it holds their own count
                return 200, _message(self._invites(payload, user), False, footer)
            answer = self._answers.get(name) if isinstance(name, str) else None
            text = answer(options | {"_user": user}) if answer is not None else "That is not a command here any more."
        except Exception:  # noqa: BLE001 - Discord would only say "the application did not respond"
            log.exception("discord command /%s failed", name)
            return 200, _message("Something went wrong on our side. Try again in a minute.", False, footer)
        return 200, _message(text, options.get("share") is True, footer)

    # -- the snapshot --

    def _snapshot(self) -> tuple[dict, dict, list] | None:
        """(snapshot, players, search index), parsed once per version; None before the first snapshot."""
        current = self._store.current()
        if current is None:
            return None
        body, etag = current
        cached = self._read  # one read: another thread may swap it in the meantime, for an equally good one
        if cached[0] != etag:
            with self._reading:
                cached = self._read
                if cached[0] != etag:
                    try:
                        data = json.loads(body)
                    except (ValueError, RecursionError):
                        data = {}
                    data = data if isinstance(data, dict) else {}
                    found = players(data)
                    index = sorted((_fold(name), name, sport, pid) for (sport, pid), name in found.items())
                    cached = (etag, data, found, index)
                    self._read = cached
        return cached[1], cached[2], cached[3]

    def _data_notes(self, snapshot: dict) -> list[str]:
        """What to say before an answer read from the snapshot: sample data, stale data."""
        notes = []
        rules = snapshot.get("rules") if isinstance(snapshot.get("rules"), dict) else {}
        if rules.get("demo"):
            notes.append("Sample data, not the live market.")
        health = self._store.health()
        if not health["ok"] and health["age_s"] is not None:
            notes.append(f"Heads up: the market data is {_age(health['age_s'])} old.")
        return notes

    # -- the commands --

    def _deals(self, options: dict) -> str:
        read = self._snapshot()
        if read is None:
            return "The market data is not ready yet. Try again in a minute."
        snapshot = read[0]
        health = self._store.health()
        if not health["ok"]:
            age = f"{_age(health['age_s'])} old" if health["age_s"] is not None else "out of date"
            return f"Deals are paused: the market data is {age}, so prices may have moved. Try again in a few minutes."
        sport = options.get("sport") if options.get("sport") in SPORTS else None
        max_price = options.get("max_price")
        rarity = options.get("rarity")
        rarity = rarity if type(rarity) is int and 0 <= rarity < len(RARITY_NAMES) else None
        rows = margin_deals(snapshot, self._clock(), sport, max_price, rarity)[:TOP_DEALS]
        notes = self._data_notes(snapshot)
        if not rows:
            where = f"No {_sport(sport)} deal" if sport else "No deal"
            if rarity is not None:
                floor = RARITY_NAMES[rarity] if rarity == len(RARITY_NAMES) - 1 else f"{RARITY_NAMES[rarity]} or rarer"
                where = f"{where} of {floor}"
            under = f" at {_rax(max_price)} or less" if max_price else ""
            return "\n".join([*notes, f"{where}{under} leaves Rax after fees right now. New ones come in all day."])
        lines = [*notes, "**Deals that leave Rax after fees** (if resold at the usual price):"]
        for row in rows:
            lines.append(
                f"• **{_name(row['player_name'])}** · {_sport(_text(row['sport']))} {_season(row)} · "
                f"{RARITY_EMOJI[row['rarity']]} {RARITY_NAMES[row['rarity']]} · {_rax(row['price'])} {_unit(row)} "
                f"→ usual {round(row['reference']):,} · "
                f"{math.floor(row['discount'] * 100 + 1e-9)}% under · +{round(row['flip_margin']):,} after fees · "
                f"{self._config.public_url}/d/{row['listing_id']}"
            )
        lines.append(PASSES_FIRST_LINE)
        return "\n".join(lines)

    def _suggest(self, text: object) -> list[dict]:
        read = self._snapshot()
        if read is None or not isinstance(text, str):
            return []
        return [
            {"name": f"{name} · {_sport(sport)}"[:CHOICE_MAX_CHARS], "value": f"{sport}:{pid}"}
            for _, name, sport, pid in _matches(read[2], text)[:AUTOCOMPLETE_MAX]
        ]

    def _price(self, options: dict) -> str:
        read = self._snapshot()
        if read is None:
            return "The market data is not ready yet. Try again in a minute."
        snapshot, found, index = read
        asked = str(options.get("player", "")).strip()
        who: list[tuple[str, int]] = []
        if _MARKET_KEY.fullmatch(asked):
            sport, _, pid = asked.partition(":")
            if (sport, int(pid)) not in found:
                return "That player is no longer in the market data. Type the name again to pick from the list."
            who = [(sport, int(pid))]
        if not who:
            exact = [(sport, pid) for folded, _, sport, pid in index if folded == _fold(asked)]
            who = exact or [(sport, pid) for _, _, sport, pid in _matches(index, asked)] if asked else []
        if not who:
            return (f"No player called \"{_name(asked)}\" in the current market data. Pick a name from the list that "
                    "shows as you type.")
        if len(who) > 1 and not all(found[w] == found[who[0]] for w in who):
            names = ", ".join(f"{_name(found[w])} ({_sport(w[0])})" for w in who[:5])
            return f"Several players match \"{_name(asked)}\": {names}. Pick one from the list that shows as you type."
        notes = self._data_notes(snapshot)
        return "\n\n".join(["\n".join(notes)] * bool(notes) + [self._one_price(snapshot, w, found[w]) for w in who[:2]])

    def _one_price(self, snapshot: dict, who: tuple[str, int], name: str) -> str:
        sport, pid = who
        lines = [f"**{_name(name)}** · {_sport(sport)}"]
        rows = [row for row in live_deals(snapshot, self._clock()) if (row["sport"], row["player_id"]) == who]
        if rows:
            row = min(rows, key=lambda r: (r["price"], -r["discount"]))
            lines.append(f"Cheapest deal now: {_rax(row['price'])} {_unit(row)} · {_season(row)} "
                         f"{RARITY_EMOJI[row['rarity']]} {RARITY_NAMES[row['rarity']]}, {row['rating']:.1f} rating · "
                         f"{self._config.public_url}/d/{row['listing_id']}")
            source = (f"from {row['ref_sample']:,} sales" if row.get("ref_source") == "sales"
                      else "Real's own estimate")
            falling = ", and prices are falling" if row.get("falling") else ""
            lines.append(f"Usual price of that card: {_rax(row['reference'])} ({source}){falling}.")
            sales = [s[0] for s in row.get("recent_sales") or () if isinstance(s, list) and s and _number(s[0])]
            if sales:
                lines.append(f"Its {len(sales)} recent sales: median {_rax(statistics.median(sales))}.")
        else:
            lines.append("No current deal for this player: the site lists only cards well under their usual price.")
        moves = snapshot.get("moves") if isinstance(snapshot.get("moves"), dict) else {}
        for move in _rows(moves, "risers") + _rows(moves, "fallers"):
            numbers = all(_number(move.get(k)) for k in ("median_recent", "median_base", "change", "sales_recent"))
            if (move.get("sport"), move.get("player_id")) != who or not numbers:
                continue
            way = "up" if move["change"] >= 0 else "down"
            lines.append(f"Price move, {_name(move.get('season'))} cards rated {_name(move.get('bucket'))}: median "
                         f"{_rax(move['median_recent'])} over {move['sales_recent']} recent sales, {way} "
                         f"{round(abs(move['change']) * 100)}% from {_rax(move['median_base'])}.")
        return "\n".join(lines)

    def _otd(self, options: dict) -> str:
        read = self._snapshot()
        if read is None:
            return "The market data is not ready yet. Try again in a minute."
        snapshot = read[0]
        sport = options.get("sport") if options.get("sport") in SPORTS else None
        otd = snapshot.get("otd") if isinstance(snapshot.get("otd"), dict) else {}
        markets = {row["key"]: row for row in _rows(otd, "markets") if isinstance(row.get("key"), str)}
        picks = otd.get("picks") if isinstance(otd.get("picks"), dict) else {}
        ranked = []  # (rank, market, rung): the site's picks, each sport's best first
        for pick_sport, keys in sorted(picks.items()):
            if (sport is not None and pick_sport != sport) or not isinstance(keys, list):
                continue
            for place, key in enumerate(keys):
                market = markets.get(key) if isinstance(key, str) else None
                rungs = market.get("rungs") if market is not None else None
                rung = next((r for r in rungs if isinstance(r, dict) and r.get("tier") == market.get("best")),
                            None) if isinstance(rungs, list) else None
                if rung is None or not all(_number(rung.get(k)) for k in ("cost", "year_rax", "year_per_rax")):
                    continue
                rank = (place,) if sport else (-rung["year_per_rax"], -rung["year_rax"])
                ranked.append((rank, market, rung))
        ranked.sort(key=lambda item: item[0])
        notes = self._data_notes(snapshot)
        if not ranked:
            where = f"No {_sport(sport)} pass" if sport else "No pass"
            return "\n".join([*notes, f"{where} pays back On This Day in the current data."])
        lines = [*notes, f"**Passes that pay back best On This Day**{f' ({_sport(sport)})' if sport else ''}:",
                 "A pass pays you Rax again on the anniversaries of its player's games (On This Day), up to a lifetime "
                 "limit."]
        for i, (_, market, rung) in enumerate(ranked[:TOP_PASSES], 1):
            tier = _name(_text(rung.get("tier")).capitalize())
            index = rarity_index(_text(rung.get("tier")))
            tier = f"{RARITY_EMOJI[index]} {tier}" if index >= 0 else tier
            back = _month(rung.get("payback_month"))
            back = f"pays back by end of {back}" if back else "payback month not known"
            lines.append(f"{i}. **{_name(market.get('player_name'))}** · {_sport(_text(market.get('sport')))} "
                         f"{_name(market.get('season_label') or market.get('season'))} · {tier}: about "
                         f"{_rax(rung['cost'])} · about {_rax(rung['year_rax'])} a year · {back}")
        lines.append("Estimates from past games, not a promise.")
        lines.append(OFFERS_LINE)
        return "\n".join(lines)

    def _fees(self, options: dict) -> str:
        price = options.get("price")
        if not isinstance(price, int) or not 1 <= price <= PRICE_MAX:
            return f"Give a sale price from 1 to {PRICE_MAX:,} Rax."
        margin = options.get("margin", 0)
        margin = margin if isinstance(margin, int) and 0 <= margin <= MARGIN_MAX else 0
        normal, quick = kept(price), kept(price, listing_fee=False)
        lines = [f"**A sale at {_rax(price)}**"]
        if normal > 0:
            lines.append(f"• Normal listing: you keep {_rax(normal)} (Real keeps 10%, and the listing fee is "
                         f"{LISTING_FEE} Rax, never refunded).")
        else:
            lines.append(f"• Normal listing: you keep nothing after Real's 10% and the {LISTING_FEE} Rax listing fee.")
        lines.append(f"• Quick List: you would keep {_rax(quick)} (no listing fee), but Quick List picks the price "
                     "itself, Real's floor, so it may not be this one.")

        def most(amount: int) -> int:  # the most to pay so that `amount` back is the margin asked
            return max(0, amount * 100 // (100 + margin))

        goal = "To break even" if margin == 0 else f"To make {margin}%"
        if normal > 0:
            lines.append(f"{goal}, pay at most {_rax(most(normal))} with a normal listing, or {_rax(most(quick))} "
                         "with Quick List.")
        else:
            lines.append(f"{goal} with Quick List, pay at most {_rax(most(quick))}.")
        return "\n".join(lines)

    def _first_moves(self, options: dict) -> str:
        steps = "\n".join(f"{i}. {step}" for i, step in enumerate(FIRST_MOVES, 1))
        return f"**New to Real? Start here:**\n{steps}\nThe Earn page has the next steps."

    # -- the member's account: /link, /unlink, /me, /help and the role buttons --

    def _unavailable(self, uid: str) -> str | None:
        if self._links is None or not uid:
            return "Linking is not available right now. Try the site: " + self._config.public_url
        return None

    def _start(self, work: Callable[[], None]) -> bool:
        """Runs `work` in a daemon thread, unless MAX_BACKGROUND are running already (False then)."""
        with self._running_lock:
            if self._running >= MAX_BACKGROUND:
                return False
            self._running += 1

        def run() -> None:
            try:
                work()
            except Exception:  # noqa: BLE001 - nothing here may take the server down
                log.exception("a discord answer failed in the background")
            finally:
                with self._running_lock:
                    self._running -= 1

        threading.Thread(target=run, name="discord-interaction", daemon=True).start()
        return True

    def _later(self, payload: dict, footer: str, make: Callable[[], str]) -> dict:
        """Answers "thinking" (only for the member who asked) now, and edits that answer with `make()`'s text once it
        is worked out; the "busy" words at once when there is no room to work in the background."""
        app, token = payload.get("application_id"), payload.get("token")
        if not (isinstance(app, str) and _APPLICATION.fullmatch(app) and isinstance(token, str)
                and _WEBHOOK_TOKEN.fullmatch(token)):
            return _message("Something went wrong on our side. Try again in a minute.", False, footer)

        def work() -> None:
            try:
                text = make()
            except Exception:  # noqa: BLE001 - the member still gets an answer
                log.exception("a discord answer could not be worked out")
                text = "Something went wrong on our side. Try again in a minute."
            self._follow_up(app, token, _message(text, False, footer)["data"]["content"])

        if not self._spawn(work):
            return _message("Busy right now. Try again in a minute.", False, footer)
        return {"type": DEFERRED_MESSAGE, "data": {"flags": EPHEMERAL}}

    def _follow_up(self, app: str, token: str, content: str) -> None:
        """Edits the "thinking" answer through the interaction's webhook; a failure is logged once, with its class."""
        url = f"{discord_gate.API}/webhooks/{app}/{token}/messages/@original"
        body = json.dumps({"content": content, "allowed_mentions": {"parse": []}}, ensure_ascii=False).encode()
        headers = {"Content-Type": "application/json",
                   "User-Agent": f"DiscordBot ({self._config.public_url}, {discord_gate.USER_AGENT_VERSION})"}
        # The work may be done before Discord has registered the "thinking" answer (404), or Discord may say to wait
        # (429): try again a couple of times, then give up, said once.
        for wait in (*FOLLOW_UP_WAITS, None):
            try:
                status, _ = self._send("PATCH", url, headers, body)
            except Exception as error:  # noqa: BLE001 - no answer at all
                log.warning("discord follow-up failed (%s)", type(error).__name__)
                return
            if 200 <= status < 300:
                return
            if status in (404, 429) and wait is not None:
                self._sleep(wait)
                continue
            log.warning("discord follow-up refused (HTTP %d)", status)
            return

    def _link(self, payload: dict, options: dict, uid: str, footer: str) -> dict:
        """/link username:<name>: the same link as the site's POST /api/me/link, from inside Discord."""
        if (words := self._unavailable(uid)) is not None or self._importer is None:
            return _message(words or "Linking is not available right now. Try the site: " + self._config.public_url,
                            False, footer)
        name = valid_username(options.get("username"))
        if name is None:
            return _message("That does not look like a Real username. It is 2 to 30 letters, numbers, _ or . "
                            "(without the @).", False, footer)
        owner = self._links.owner_of(name)
        if owner is not None and owner != uid:
            return _message(self._taken(name), False, footer)
        if not self._slow.take(uid):
            return _message("One account at a time. Try again in a minute.", False, footer)
        found = self._importer.cached(name) if hasattr(self._importer, "cached") else None
        if found is not None:  # already read: nothing to wait for
            return _message(self._finish_link(uid, name, found), False, footer)
        return self._later(payload, footer, lambda: self._finish_link(uid, name, self._importer.lookup(name)))

    @staticmethod
    def _taken(name: str) -> str:
        return (f"**{_name(name)}** is linked to another Discord member already. If it is yours, ask the team in the "
                "server.")

    def _finish_link(self, uid: str, name: str, found) -> str:
        """The words for what reading `name` found, linking it to the member when it was read."""
        shown = _name(name)
        if found.status == "not_found":
            return f"No Real account is called **{shown}**. Check the spelling: it is your username, without the @."
        if found.status == "private":
            return (f"We could not read any pass on **{shown}**. If the account is private, make it public in Real, "
                    "then try /link again.")
        if found.status != "ok":
            wait = getattr(found, "retry_after", 0) or 60
            return f"Account lookups are busy right now. Try again in {max(1, round(wait / 60))} minute(s)."
        before = self._links.get(uid)
        outcome = self._links.claim(uid, found.username or name, found.passes, now=self._clock())
        if outcome == "taken":
            return self._taken(name)
        if outcome == "full":
            return "Linking is full right now. Try again later."
        after = self._links.get(uid)
        if self._perks is not None and (found.waiting == 0 or before is None
                                        or roles_for(before["summary"], before.get("year")) != roles_for(after["summary"], after.get("year"))):
            self._perks.request_sync(uid)  # the roles, in the background: Discord never slows a link
        lines = [f"Linked **{_name(after['username'])}**: {self._counts(after['summary'])}.",
                 f"Roles: {', '.join(roles_for(after['summary'], after.get('year')))}. They show in a few seconds.",
                 "The site's advice now knows what you own."]  # the site's address ends every reply already
        if found.waiting:
            lines.append("Some of your seasons are still being read. Run /link again in a minute for the full picture.")
        return "\n".join(lines)

    @staticmethod
    def _counts(summary: dict) -> str:
        sports = summary.get("sports") if isinstance(summary.get("sports"), dict) else {}
        mix = " · ".join(f"{_sport(s)} {x['n']}" for s, x in sorted(
            sports.items(), key=lambda kv: (-kv[1].get("n", 0), kv[0])) if isinstance(x, dict) and x.get("n"))
        n = summary.get("passes", 0)
        return f"{n:,} pass{'es' if n != 1 else ''}" + (f" ({mix})" if mix else "")

    def _unlink(self, options: dict) -> str:
        uid = options.get("_user", "")
        if (words := self._unavailable(uid)) is not None:
            return words
        try:
            had = self._links.unlink(uid)
        except OSError:
            return "Not unlinked: something went wrong on our side. Try /unlink again in a moment."
        if not had:
            return "You have no linked account. Use /link with your Real username to link one."
        if self._perks is not None:
            self._perks.request_sync(uid)
        return "Unlinked. Your account is forgotten here and the roles it gave you are on their way out."

    def _me(self, options: dict) -> str:
        uid = options.get("_user", "")
        if (words := self._unavailable(uid)) is not None:
            return words
        row = self._links.get(uid)
        if row is None:
            return "You have not linked a Real account yet. Use /link with your Real username."
        summary = row["summary"]
        ago = _age(max(0, self._clock() - row["refreshed_at"]))
        lines = [f"**{_name(row['username'])}** · {self._counts(summary)} · read {ago} ago"]
        rungs: dict[str, int] = {}
        for sport in (summary.get("sports") or {}).values():
            for tier, n in (sport.get("rungs") or {}).items() if isinstance(sport, dict) else ():
                rungs[tier] = rungs.get(tier, 0) + n
        order = [t for t, _, _ in OTD_LADDERS["player"]] + [t for t in rungs if t not in {x for x, _, _ in OTD_LADDERS["player"]}]
        mix = " · ".join(f"{t.capitalize()} {rungs[t]}" for t in order if rungs.get(t))
        if mix:
            lines.append(f"By rarity: {mix}")
        lines.append(f"Roles: {', '.join(roles_for(summary, row.get('year')))}")
        year = row.get("year")
        if year is None:
            lines.append(f"On This Day this year: open the site to see yours: {self._config.public_url}")
        else:
            lines.append(f"On This Day this year: up to about {_rax(year)} a year ({type_of(year).name})")
        lines.append(f"Deal pings by DM: {'on' if row['pings'] else 'off'}. Change it on the site. /link again refreshes.")
        return "\n".join(lines)

    def _help(self, options: dict) -> str:
        return "\n".join([
            "**What the Palace bot does**",
            "/deals · the best live deals that still leave Rax after fees",
            "/price · a player's usual price, recent sales and cheapest deal",
            "/otd · the passes that pay back best On This Day",
            "/fees · what a sale leaves, and the most to pay for a card",
            "/start · New to Real? The first three moves",
            "/link · link your Real account for roles and advice that knows your passes",
            "/me · your linked account · /unlink · forget it",
            "/invites · your invites, the top inviters, and how to make your own link",
            "In #welcome, tap a button to turn Deal Alerts and your sports on or off.",
        ])

    def _invites(self, payload: dict, uid: str) -> str:
        """The invite board (advisor/discord_invites.py), read from what the perks worker last fetched: no call to
        Discord here. The caller's roles are the ones Discord sent with the command."""
        member = payload.get("member") if isinstance(payload.get("member"), dict) else {}
        held = [r for r in member.get("roles", []) if isinstance(r, str)] if isinstance(member.get("roles"), list) else []
        return discord_invites.answer(getattr(self._perks, "invites", None), uid, held)

    def _button(self, payload: dict, data: dict, uid: str, footer: str) -> dict:
        """A tap on the role picker in #welcome: toggles that role for whoever tapped, and says so to them alone."""
        role = ROLE_BUTTONS.get(data.get("custom_id")) if isinstance(data.get("custom_id"), str) else None
        bot = getattr(self._perks, "bot", None)
        if role is None:
            return _message("That button is not in use any more. Look in #welcome for the new ones.", False, footer)
        if bot is None or not uid:
            return _message("Roles are not available right now. Try again later.", False, footer)
        if not self._taps.take(uid):
            return _message("Easy, one tap at a time. Try again in a few seconds.", False, footer)
        member = payload.get("member") if isinstance(payload.get("member"), dict) else {}
        held = [r for r in member.get("roles", []) if isinstance(r, str)] if isinstance(member.get("roles"), list) else []

        def make() -> str:
            on = bot.toggle_role(uid, role, held)
            if on is None:
                return "That did not work just now. Try again in a minute."
            if role == ALERTS_ROLE:
                return (f"{role} is on. You get a ping for the very best deals. Tap again to turn it off." if on
                        else f"{role} is off. No more pings. Tap again to turn it back on.")
            return (f"{role} is on. Tap again to turn it off." if on else f"{role} is off. Tap again to turn it back on.")

        return self._later(payload, footer, make)


# --- the registration ------------------------------------------------------------------------------------------------


def _commands_url(env) -> tuple[str, dict[str, str]]:
    """The address of our server's commands and the headers that carry the bot token; SystemExit naming a setting
    that is missing or wrong, never its value."""
    values = {name: (env.get(name) or "").strip() for name in
              ("ADVISOR_DISCORD_CLIENT_ID", "ADVISOR_DISCORD_GUILD_ID", "ADVISOR_DISCORD_BOT_TOKEN")}
    for name, value in values.items():
        if not value:
            raise SystemExit(f"{name} is not set.")
    for name in ("ADVISOR_DISCORD_CLIENT_ID", "ADVISOR_DISCORD_GUILD_ID"):
        if not discord_gate._SNOWFLAKE.fullmatch(values[name]):
            raise SystemExit(f"{name} must be the Discord id, a number of 15 to 21 digits.")
    if not discord_gate._SECRET.fullmatch(values["ADVISOR_DISCORD_BOT_TOKEN"]):
        raise SystemExit("ADVISOR_DISCORD_BOT_TOKEN does not look like one: copy it again from the Developer Portal.")
    site = (env.get("ADVISOR_PUBLIC_URL") or "").strip().rstrip("/") or "https://discord.com"
    url = (f"{discord_gate.API}/applications/{values['ADVISOR_DISCORD_CLIENT_ID']}/guilds/"
           f"{values['ADVISOR_DISCORD_GUILD_ID']}/commands")
    headers = {"Authorization": f"Bot {values['ADVISOR_DISCORD_BOT_TOKEN']}", "Content-Type": "application/json",
               "User-Agent": f"DiscordBot ({site}, {discord_gate.USER_AGENT_VERSION})"}
    return url, headers


def _commands_call(env, method: str, body: bytes | None, transport) -> list[dict]:
    url, headers = _commands_url(env)
    send = transport or discord_gate._url_transport(discord_gate._OPENER.open)
    try:
        status, raw = send(method, url, headers, body)
    except discord_gate.DiscordError as error:
        raise SystemExit(f"Discord did not answer: {error}") from None
    try:
        answer = json.loads(raw) if raw else None
    except ValueError:
        answer = None
    if status != 200 or not isinstance(answer, list):
        said = answer if isinstance(answer, dict) else {}
        detail = {key: said[key] for key in ("message", "code", "errors") if key in said}
        raise SystemExit(f"Discord refused (HTTP {status}): {json.dumps(detail)}")
    return answer


def register(env=os.environ, transport=None) -> list[dict]:
    """Puts COMMANDS as our server's whole command list (Discord's bulk overwrite: what is not in it goes away, so
    running it twice changes nothing) and returns the commands Discord kept."""
    return _commands_call(env, "PUT", json.dumps(COMMANDS).encode(), transport)


def registered(env=os.environ, transport=None) -> list[dict]:
    """The commands our server has now, as Discord lists them."""
    return _commands_call(env, "GET", None, transport)


def _describe(command: dict) -> str:
    options = command.get("options") if isinstance(command.get("options"), list) else []
    names = " ".join(f"[{o.get('name')}]" if not o.get("required") else f"{o.get('name')}:"
                     for o in options if isinstance(o, dict))
    return f"/{command.get('name')} {names}".rstrip() + f"  (id {command.get('id')})"


def main(argv: list[str], env=os.environ, transport=None) -> int:
    """`register` puts the commands on our server; `show` lists what it has. Reads ADVISOR_DISCORD_CLIENT_ID,
    ADVISOR_DISCORD_GUILD_ID and ADVISOR_DISCORD_BOT_TOKEN (and ADVISOR_PUBLIC_URL, for the User-Agent)."""
    if argv not in (["register"], ["show"]):
        print("usage: python -m advisor.discord_commands register | show", file=sys.stderr)
        return 2
    found = register(env, transport) if argv == ["register"] else registered(env, transport)
    print(f"{len(found)} commands on the server:")
    for command in found:
        print("  " + _describe(command))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
