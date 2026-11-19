"""Our Discord, read by the gate's bot for the admin panel (advisor/activity.py keeps it; activity_report.py shows it).

Every DISCORD_ACTIVITY_EVERY_S, a round of GET calls only (this module never posts, edits or changes a role):
  - the server's roles, to name them;
  - the whole member list, when the bot has Discord's Server Members intent: everyone's name, avatar, roles and
    whether they are in (joins and leaves are the changes between two rounds). Without the intent Discord answers
    403 (code 50001, as it does for our bot today) and the round falls back on: the members who signed in on the site,
    DISCORD_ACTIVITY_MEMBER_CHECKS of them a round, one by one (in the server or not, roles, name, avatar), and the
    server's welcome messages (a join each). The server's member count is read hourly by advisor/visits.py;
  - the new messages of each text channel and of the active threads (forum posts count under their forum), from where
    the last round stopped (DISCORD_ACTIVITY_BACKFILL_DAYS back the first time), at most DISCORD_ACTIVITY_PAGES pages
    of 100 a channel a round: counted per UTC day, channel and author, the text never kept;
  - the last 50 messages of the channels the bot posts in, for the reactions on its own posts.
A pause of DISCORD_ACTIVITY_PAUSE_S between calls keeps a round well inside Discord's limits; a 429 ends the round
(the next one picks up where it stopped). Nothing here logs the token or anything Discord said but its status.
Turn it off with ADVISOR_DISCORD_ACTIVITY=0.
"""

import json
import logging
import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime

from advisor.activity import SNOWFLAKE, ActivityLog, day_of
from advisor.discord_gate import _OPENER, API, USER_AGENT_VERSION, Transport, _url_transport
from advisor.discord_gate import config_from_env as gate_config_from_env
from advisor.discord_post import CHANNEL_NAMES
from advisor.rules import (
    DISCORD_ACTIVITY_BACKFILL_DAYS,
    DISCORD_ACTIVITY_EVERY_S,
    DISCORD_ACTIVITY_MEMBER_CHECKS,
    DISCORD_ACTIVITY_PAGES,
    DISCORD_ACTIVITY_PAUSE_S,
    DISCORD_ACTIVITY_THREADS,
)

log = logging.getLogger(__name__)

SWITCH_ENV = "ADVISOR_DISCORD_ACTIVITY"  # "0" turns the reading off
DISCORD_EPOCH_MS = 1_420_070_400_000
TEXT_TYPES = frozenset({0, 5})  # a text channel, an announcement channel
THREAD_TYPES = frozenset({10, 11, 12})
JOIN_MESSAGE = 7  # Discord's "user joined" system message
POST_CHANNELS = frozenset(CHANNEL_NAMES.values())  # where the bot posts: #live-deals, #otd-picks, ...
ANSWER_MAX_BYTES = 4 * 1024 * 1024  # a page of 100 messages with embeds, or of 1,000 members, is far bigger than the gate's answers
MEMBER_LIST_PAGES = 20  # 20,000 members at most from the full list in one round
_AVATAR = re.compile(r"(a_)?[0-9a-f]{32}")


@dataclass(frozen=True)
class ReaderConfig:
    bot_token: str = field(repr=False)
    guild_id: str
    public_url: str


def config_from_env(env) -> ReaderConfig | None:
    """The gate's bot, server and address, when the gate is set and ADVISOR_DISCORD_ACTIVITY is not "0"."""
    if (env.get(SWITCH_ENV) or "").strip() == "0":
        return None
    gate = gate_config_from_env(env)
    return None if gate is None else ReaderConfig(gate.bot_token, gate.guild_id, gate.public_url)


def snowflake_at(ts: float) -> int:
    """The smallest Discord id made at `ts` (seconds since the epoch)."""
    return max(0, int(ts * 1000) - DISCORD_EPOCH_MS) << 22


def time_of(snowflake: str | int) -> float:
    """When a Discord id was made, in seconds since the epoch."""
    return ((int(snowflake) >> 22) + DISCORD_EPOCH_MS) / 1000


def _iso_time(value: object) -> int | None:
    if not isinstance(value, str):
        return None
    try:
        return int(datetime.fromisoformat(value).timestamp())
    except ValueError:
        return None


def _person(user: object, nick: object = None) -> tuple[str | None, str | None, str | None, bool]:
    """(id, name to show, avatar hash, is a bot) of a Discord user object."""
    if not isinstance(user, dict) or not isinstance(user.get("id"), str) or not SNOWFLAKE.fullmatch(user["id"]):
        return None, None, None, False
    name = next((v for v in (nick, user.get("global_name"), user.get("username")) if isinstance(v, str) and v), None)
    avatar = user.get("avatar") if isinstance(user.get("avatar"), str) and _AVATAR.fullmatch(user["avatar"]) else None
    return user["id"], name, avatar, user.get("bot") is True


class _Limited(Exception):
    """Discord said to wait: the round ends here."""


class DiscordReader:
    """One round at a time (`run_once`), from one thread. `pause(seconds)` waits between calls and says whether to
    stop (the server's stop event); `transport` is Discord's API (a fake one in tests)."""

    def __init__(self, config: ReaderConfig, activity: ActivityLog, transport: Transport | None = None,
                 clock: Callable[[], float] = time.time, pause: Callable[[float], bool] | None = None):
        self._config = config
        self._activity = activity
        self._send = transport or _url_transport(_OPENER.open, ANSWER_MAX_BYTES)
        self._clock = clock
        self._pause = pause or (lambda s: False)
        self._agent = f"DiscordBot ({config.public_url}, {USER_AGENT_VERSION})"
        self._stopped = False

    def _get(self, path: str) -> tuple[int | None, object]:
        """GET `path`: (status, parsed answer), (None, None) when Discord did not answer. A 429 raises `_Limited`."""
        if self._stopped or self._pause(DISCORD_ACTIVITY_PAUSE_S):
            self._stopped = True
            raise _Limited
        headers = {"User-Agent": self._agent, "Authorization": f"Bot {self._config.bot_token}"}
        try:
            status, raw = self._send("GET", API + path, headers, None)
        except Exception as error:  # noqa: BLE001 - a timeout, a refused connection: only its class
            log.warning("Discord activity: Discord did not answer (%s)", type(error).__name__)
            return None, None
        if status == 429:
            raise _Limited
        try:
            return status, json.loads(raw) if raw else None
        except ValueError:
            return status, None

    def run_once(self) -> dict:
        """One round; what it did, as kept for the panel: when, whether the member list could be read, how many
        channels and messages were read, members checked, posts seen, and the error that ended it early, if any."""
        status = {"at": int(self._clock()), "members_list": None, "channels": 0, "messages": 0, "checked": 0,
                  "posts": 0, "error": None}
        try:
            roles = self._roles()
            listed = self._member_list(roles, status)
            if not listed:
                self._check_site_members(roles, status)
            self._channels(status)
        except _Limited:
            status["error"] = "stopped" if self._stopped else "limited"
        except Exception as error:  # noqa: BLE001 - one bad answer never ends the thread
            log.warning("Discord activity round failed (%s)", type(error).__name__)
            status["error"] = type(error).__name__
        try:
            self._activity.set_status({"discord": status})
        except Exception:  # noqa: BLE001
            log.warning("Discord activity status could not be kept")
        return status

    # -- the steps --------------------------------------------------------------------------------------------------

    def _roles(self) -> dict[str, str]:
        code, data = self._get(f"/guilds/{self._config.guild_id}/roles")
        if code != 200 or not isinstance(data, list):
            return {}
        return {r["id"]: r["name"] for r in data if isinstance(r, dict) and isinstance(r.get("id"), str)
                and isinstance(r.get("name"), str) and r["id"] != self._config.guild_id}

    def _note_member(self, data: object, roles: dict[str, str], checked: bool) -> str | None:
        if not isinstance(data, dict):
            return None
        uid, name, avatar, bot = _person(data.get("user"), data.get("nick"))
        if uid is None or bot:
            return None
        held = [roles[r] for r in data.get("roles", []) if isinstance(r, str) and r in roles]
        self._activity.note_person(uid, name=name, avatar=avatar, roles=held, joined=_iso_time(data.get("joined_at")),
                                   present=True, checked=checked)
        return uid

    def _member_list(self, roles: dict[str, str], status: dict) -> bool:
        """Everyone in the server, when Discord lets the bot list them (the Server Members intent): whether it did."""
        g = self._config.guild_id
        seen: set[str] = set()
        after = "0"
        for _ in range(MEMBER_LIST_PAGES):
            code, data = self._get(f"/guilds/{g}/members?limit=1000&after={after}")
            if code != 200 or not isinstance(data, list):
                status["members_list"] = "refused" if code in (401, 403) else "failed"
                return False
            for row in data:
                if (uid := self._note_member(row, roles, checked=True)) is not None:
                    seen.add(uid)
            ids = [row["user"]["id"] for row in data if isinstance(row, dict) and isinstance(row.get("user"), dict)
                   and isinstance(row["user"].get("id"), str)]
            if len(data) < 1000 or not ids:
                break
            after = max(ids, key=int)
        else:
            status["members_list"] = "partial"
            return True
        status["members_list"] = "ok"
        for (uid,) in self._activity.read("SELECT uid FROM d_people WHERE present = 1"):
            if uid not in seen:
                self._activity.note_person(uid, present=False, checked=True)
        return True

    def _check_site_members(self, roles: dict[str, str], status: dict) -> None:
        g = self._config.guild_id
        for uid in self._activity.site_members_to_check(DISCORD_ACTIVITY_MEMBER_CHECKS):
            code, data = self._get(f"/guilds/{g}/members/{uid}")
            if code == 200:
                self._note_member(data, roles, checked=True)
            elif code == 404:
                self._activity.note_person(uid, present=False, checked=True)
            else:
                continue
            status["checked"] += 1

    def _channels(self, status: dict) -> None:
        g = self._config.guild_id
        code, data = self._get(f"/guilds/{g}/channels")
        if code != 200 or not isinstance(data, list):
            return
        by_id = {c["id"]: c for c in data if isinstance(c, dict) and isinstance(c.get("id"), str)
                 and SNOWFLAKE.fullmatch(c["id"]) and isinstance(c.get("name"), str)}
        targets = [(cid, c["name"]) for cid, c in by_id.items() if c.get("type") in TEXT_TYPES]
        code, data = self._get(f"/guilds/{g}/threads/active")
        threads = data.get("threads") if code == 200 and isinstance(data, dict) else None
        if isinstance(threads, list):
            live = [t for t in threads if isinstance(t, dict) and t.get("type") in THREAD_TYPES
                    and isinstance(t.get("id"), str) and SNOWFLAKE.fullmatch(t["id"])]
            live.sort(key=lambda t: int(t["last_message_id"]) if str(t.get("last_message_id", "")).isdigit() else 0,
                      reverse=True)
            for t in live[:DISCORD_ACTIVITY_THREADS]:
                parent = by_id.get(t.get("parent_id"), {}).get("name") or "threads"
                targets.append((t["id"], parent))
        for cid, name in targets:
            self._read_channel(cid, name, status)
            status["channels"] += 1
        for cid, name in targets:
            if name in POST_CHANNELS and cid in by_id:
                self._read_posts(cid, name, status)

    def _read_channel(self, cid: str, name: str, status: dict) -> None:
        start = self._activity.cursor(cid) or str(snowflake_at(self._clock() - DISCORD_ACTIVITY_BACKFILL_DAYS * 86400))
        counts: dict[tuple[int, str, str | None], int] = {}
        people: dict[str, tuple[str | None, str | None]] = {}
        joins: list[tuple[str, int, str | None, str | None]] = []
        cursor = start
        for _ in range(DISCORD_ACTIVITY_PAGES):
            code, data = self._get(f"/channels/{cid}/messages?after={cursor}&limit=100")
            if code != 200 or not isinstance(data, list) or not data:
                break
            ids = []
            for m in data:
                if not isinstance(m, dict) or not isinstance(m.get("id"), str) or not SNOWFLAKE.fullmatch(m["id"]):
                    continue
                ids.append(int(m["id"]))
                uid, who, avatar, bot = _person(m.get("author"))
                ts = int(time_of(m["id"]))
                if m.get("type") == JOIN_MESSAGE and uid is not None:
                    joins.append((uid, ts, who, avatar))
                    continue
                key = (day_of(ts), name, None if bot else uid)
                counts[key] = counts.get(key, 0) + 1
                if uid is not None and not bot:
                    people[uid] = (who, avatar)
                status["messages"] += 1
            if not ids:
                break
            cursor = str(max(ids))
            if len(data) < 100:
                break
        if counts:
            self._activity.note_messages(counts)
        for uid, (who, avatar) in people.items():
            self._activity.note_person(uid, name=who, avatar=avatar, soft=True)
        for uid, ts, who, avatar in joins:
            self._activity.note_join_message(uid, ts, who, avatar)
        if cursor != start or self._activity.cursor(cid) is None:
            self._activity.set_cursor(cid, cursor)

    def _read_posts(self, cid: str, name: str, status: dict) -> None:
        code, data = self._get(f"/channels/{cid}/messages?limit=50")
        if code != 200 or not isinstance(data, list):
            return
        for m in data:
            if not isinstance(m, dict) or not isinstance(m.get("id"), str) or not SNOWFLAKE.fullmatch(m["id"]):
                continue
            _, _, _, bot = _person(m.get("author"))
            if not bot:
                continue
            reactions = [r for r in m.get("reactions") or [] if isinstance(r, dict) and type(r.get("count")) is int]
            reactions.sort(key=lambda r: -r["count"])
            top = " · ".join(f"{(r.get('emoji') or {}).get('name') or '?'} {r['count']}" for r in reactions[:3])
            self._activity.note_post(m["id"], name, int(time_of(m["id"])), _title(m),
                                     sum(r["count"] for r in reactions), top or None)
            status["posts"] += 1


def _title(message: dict) -> str | None:
    """A line that says which post it was: its embed's title, else the first line of its text (the bot's own)."""
    for embed in message.get("embeds") or []:
        if isinstance(embed, dict):
            for key in ("title", "description"):
                if isinstance(embed.get(key), str) and embed[key].strip():
                    return embed[key].strip().splitlines()[0]
    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return content.strip().splitlines()[0]
    return None


def run_reader(reader: DiscordReader, stop: threading.Event, every_s: float = DISCORD_ACTIVITY_EVERY_S,
               first_after_s: float = 120) -> None:
    """A round `first_after_s` after start, then every `every_s` seconds until `stop` is set."""
    if stop.wait(first_after_s):
        return
    while True:
        reader.run_once()
        if stop.wait(every_s):
            return
