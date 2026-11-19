"""The Real account each member of our Discord linked, kept on the server so it follows them to any device.

With the Discord gate on, a member who links their Real username on the site gets it remembered here, by their
Discord id: the name, when it was linked and last refreshed, a summary of the last import (how many passes, per sport
and per rung), the yearly estimate the page worked out, the players behind their passes (for their personal deal
pings), the players they follow on the site, and their ping settings. The passes themselves are not kept: the page
reads them again through the importer.

One Real username per Discord id, and one Discord id per Real username: a second member claiming a name someone else
linked is refused ("taken"). Anyone can type any username, so nothing here proves an account is theirs: what it
unlocks is cosmetic (see advisor/discord_perks.py) and never a permission.

Everything lives in one small JSON file of the data directory (member-links.json), changed under one lock and
written through a temporary file, so a crash never leaves half a file. Every list is bounded, and so is the number of
members kept (MEMBER_LINKS_MAX). A file that cannot be read is set aside as `<name>.corrupt` and the store starts
empty; a row that does not check out is dropped.
"""

import json
import logging
import math
import os
import re
import tempfile
import threading
import time
from pathlib import Path

from advisor.account_types import ACCOUNT_TYPES, YEAR_MAX, type_by_passes, type_of
from advisor.importer import valid_username
from advisor.rules import (
    LINK_FOLLOWS_MAX,
    LINK_OWNED_MAX,
    LINK_PINGED_KEPT,
    LINK_PLAYERS_MAX,
    MEMBER_LINKS_MAX,
    OTD_LADDERS,
)

log = logging.getLogger(__name__)

_SNOWFLAKE = re.compile(r"\d{15,21}")
_KEY = re.compile(r"([a-z][a-z0-9_-]{0,19}):(\d{4}):(player|team|fighter):(\d{1,12})")
_PLAYER = re.compile(r"[a-z][a-z0-9_-]{0,19}:\d{1,12}")
_SEASON_PLAYER = re.compile(r"[a-z][a-z0-9_-]{0,19}:\d{4}:\d{1,12}")
_TIERS = frozenset(t for ladder in OTD_LADDERS.values() for t, _, _ in ladder)

# Discord roles from a linked account (advisor/discord_perks.py sets them). Cosmetic only: anyone can type any
# username, so these roles must never carry a permission.
ROLE_LINKED = "Linked"
# The size roles are the account types (advisor/account_types.py), by the yearly On This Day figure the site reported.
SIZE_ROLES = tuple(t.name for t in ACCOUNT_TYPES)
# The size roles before the account types, by number of passes: still on members until the bot refreshes them, taken back then.
LEGACY_SIZE_ROLES = ("Rookie", "Collector", "Big Account")
SPORT_ROLE_MIN = 3  # a sport's role takes at least this many passes in it


def _rung(holding: dict, kind: str) -> str:
    """A pass's rung, as the site reads it (lib/passes.ts heldRung): Real's own when it says it, else the rung the exact
    rating reaches (a rating below 0 reads as 0), else the rarity given by hand."""
    if holding.get("rarity") in _TIERS:
        return holding["rarity"]
    rating = holding.get("rating")
    ladder = OTD_LADDERS.get(kind, OTD_LADDERS["player"])
    if not (isinstance(rating, (int, float)) and not isinstance(rating, bool) and math.isfinite(rating)):
        rating = next((entry for name, entry, _ in ladder if name == holding.get("tier")), 0)
    tier = "general"
    for name, entry, _ in ladder:
        if max(0, rating) >= entry:
            tier = name
    return tier


def summarize(passes) -> dict:
    """{"passes": n, "sports": {sport: {"n": n, "rungs": {tier: n}}}} of an import's passes."""
    sports: dict[str, dict] = {}
    n = 0
    seen: set[str] = set()
    for holding in passes:
        m = _KEY.fullmatch(holding.get("key", "")) if isinstance(holding, dict) else None
        if m is None or holding["key"] in seen:
            continue  # a pass listed twice is one pass
        seen.add(holding["key"])
        n += 1
        sport = sports.setdefault(m[1], {"n": 0, "rungs": {}})
        sport["n"] += 1
        rung = _rung(holding, m[3])
        sport["rungs"][rung] = sport["rungs"].get(rung, 0) + 1
    return {"passes": n, "sports": sports}


def owned_of(passes) -> dict[str, int]:
    """The rung held per player-season ("sport:season:player_id" -> the rung's place on its ladder, 0 to 7), so a
    personal ping never offers a card of a pass held at its rarity or higher; first seen first, at most
    LINK_OWNED_MAX."""
    out: dict[str, int] = {}
    for holding in passes:
        m = _KEY.fullmatch(holding.get("key", "")) if isinstance(holding, dict) else None
        if m is None or m[3] == "team":
            continue
        tiers = [t for t, _, _ in OTD_LADDERS.get(m[3], OTD_LADDERS["player"])]
        out.setdefault(f"{m[1]}:{m[2]}:{m[4]}", tiers.index(_rung(holding, m[3])))
        if len(out) >= LINK_OWNED_MAX:
            break
    return out


def players_of(passes) -> list[str]:
    """The players behind an import's passes ("sport:player_id", any season; never a team), first seen first."""
    seen: dict[str, None] = {}
    for holding in passes:
        m = _KEY.fullmatch(holding.get("key", "")) if isinstance(holding, dict) else None
        if m is not None and m[3] != "team":
            seen.setdefault(f"{m[1]}:{m[4]}")
            if len(seen) >= LINK_PLAYERS_MAX:
                break
    return list(seen)


def sport_role(sport: str) -> str:
    """The role name of a sport: "NBA", "UFC", "Soccer"."""
    from advisor.discord_post import _sport

    return _sport(sport)


def roles_for(summary: dict | None, year: object = None) -> list[str]:
    """The roles a linked account earns: Linked, one per sport with SPORT_ROLE_MIN passes or more, and its type: that of
    the yearly figure the site reported (`year`), or, until it has, the one its number of passes most often has. Cosmetic
    only: the figure comes from the member's own browser."""
    if not isinstance(summary, dict):
        return []
    sports = summary.get("sports") if isinstance(summary.get("sports"), dict) else {}
    out = [ROLE_LINKED]
    out += [sport_role(s) for s, x in sorted(sports.items(), key=lambda kv: (-kv[1].get("n", 0), kv[0]))
            if isinstance(x, dict) and x.get("n", 0) >= SPORT_ROLE_MIN]
    known = _year(year)
    out.append(type_by_passes(summary.get("passes", 0)).name if known is None else type_of(known).name)
    return out


def _year(value: object) -> int | None:
    """A yearly figure as a whole number of rax, 0 to YEAR_MAX; anything else (garbage) is None, and is ignored."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    try:  # a whole number of 400 digits is no float: it must not raise (OverflowError) in the middle of a request
        ok = math.isfinite(value)
    except OverflowError:
        return None
    return math.floor(value + 0.5) if ok and 0 <= math.floor(value + 0.5) <= YEAR_MAX else None  # half up, as the site


def _follows(values: object) -> list[str]:
    if not isinstance(values, list):
        return []
    out: dict[str, None] = {}
    for v in values:
        if isinstance(v, str) and _PLAYER.fullmatch(v):
            out.setdefault(v)
        if len(out) >= LINK_FOLLOWS_MAX:
            break
    return list(out)


def _number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _row(value: object) -> dict | None:
    """A stored row checked field by field, or None when it cannot be one."""
    if not isinstance(value, dict) or valid_username(value.get("username")) != value.get("username"):
        return None
    if not _number(value.get("linked_at")):
        return None
    summary = value.get("summary")
    pinged = value.get("pinged")
    channel = value.get("dm_channel")
    return {
        "username": value["username"],
        "linked_at": float(value["linked_at"]),
        "refreshed_at": float(value["refreshed_at"]) if _number(value.get("refreshed_at")) else float(value["linked_at"]),
        "summary": summary if isinstance(summary, dict) else {"passes": 0, "sports": {}},
        "year": _year(value.get("year")),
        "players": [p for p in value.get("players", []) if isinstance(p, str) and _PLAYER.fullmatch(p)][:LINK_PLAYERS_MAX]
        if isinstance(value.get("players"), list) else [],
        "follows": _follows(value.get("follows")),
        "owned": {k: v for k, v in list(value["owned"].items())[:LINK_OWNED_MAX]
                  if isinstance(k, str) and _SEASON_PLAYER.fullmatch(k) and type(v) is int and 0 <= v <= 7}
        if isinstance(value.get("owned"), dict) else {},
        "pings": value.get("pings") is not False,
        "dm_closed": value.get("dm_closed") is True,
        "gone": value.get("gone") is True,
        "dm_channel": channel if isinstance(channel, str) and _SNOWFLAKE.fullmatch(channel) else None,
        "pinged": [[p[0], float(p[1])] for p in pinged if isinstance(p, list) and len(p) == 2 and type(p[0]) is int
                   and _number(p[1])][-LINK_PINGED_KEPT:] if isinstance(pinged, list) else [],
    }


def _copy(row: dict) -> dict:
    return json.loads(json.dumps(row))


class MemberLinks:
    """The linked accounts, by Discord id. Safe to use from several threads at once: every change is made under one
    lock, on the copy in memory, and written whole before the lock is let go."""

    def __init__(self, path: Path, max_members: int = MEMBER_LINKS_MAX):
        self.path = path
        self._max = max_members
        self._lock = threading.Lock()
        self._rows: dict[str, dict] = {}
        # uid -> when they last unlinked: a device still linked from before must not link them back (see the page's
        # LinkSync, which reads it from GET /api/me/link).
        self._unlinked: dict[str, float] = {}
        self._load()

    def __repr__(self) -> str:
        return "MemberLinks()"

    def _load(self) -> None:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except (OSError, ValueError) as error:
            log.warning("linked accounts: %s could not be read (%s); starting empty", self.path.name,
                        type(error).__name__)
            self._set_aside()
            return
        rows = data.get("links") if isinstance(data, dict) else None
        if not isinstance(rows, dict):
            self._set_aside()
            return
        taken: set[str] = set()
        for uid, value in rows.items():
            row = _row(value)
            if not _SNOWFLAKE.fullmatch(str(uid)) or row is None or row["username"].casefold() in taken:
                continue
            taken.add(row["username"].casefold())
            self._rows[uid] = row
            if len(self._rows) >= self._max:
                break
        gone = data.get("unlinked")
        for uid, at in (gone.items() if isinstance(gone, dict) else ()):
            if _SNOWFLAKE.fullmatch(str(uid)) and _number(at) and uid not in self._rows and len(self._unlinked) < self._max:
                self._unlinked[uid] = float(at)

    def _set_aside(self) -> None:
        try:
            os.replace(self.path, self.path.with_name(self.path.name + ".corrupt"))
        except OSError:
            pass

    def _save(self) -> bool:
        """Writes the file through a temporary one next to it (call with the lock held); says whether it worked. A
        failed write is logged; the store goes on with what it has in memory."""
        tmp_name = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=self.path.parent,
                                             prefix=f".{self.path.name}.", suffix=".tmp", delete=False) as tmp:
                tmp_name = tmp.name
                json.dump({"links": self._rows, "unlinked": self._unlinked}, tmp, separators=(",", ":"))
            os.replace(tmp_name, self.path)
            return True
        except OSError as error:
            log.warning("linked accounts: %s could not be written (%s)", self.path.name, type(error).__name__)
            if tmp_name is not None:
                try:
                    os.unlink(tmp_name)
                except OSError:
                    pass
        return False

    def _owner(self, username: str) -> str | None:
        folded = username.casefold()
        return next((uid for uid, row in self._rows.items() if row["username"].casefold() == folded), None)

    def get(self, uid: str) -> dict | None:
        """A copy of the member's row, or None when they linked nothing."""
        with self._lock:
            row = self._rows.get(uid)
            return None if row is None else _copy(row)

    def owner_of(self, username: str) -> str | None:
        """The Discord id that linked `username` (compared without case), or None."""
        with self._lock:
            return self._owner(username)

    def claim(self, uid: str, username: str, passes, now: float, year: object = None) -> str:
        """Links `username` (checked with `valid_username`) to the member, from an import's `passes`: "ok", "taken"
        when another member linked that name, or "full" when the store holds MEMBER_LINKS_MAX members already. The
        same name again is a refresh: when it was linked and the member's settings stay."""
        with self._lock:
            owner = self._owner(username)
            if owner is not None and owner != uid:
                return "taken"
            was = self._rows.get(uid)
            if was is None and len(self._rows) >= self._max:
                return "full"
            same = was is not None and was["username"].casefold() == username.casefold()
            row = {
                "username": username,
                "linked_at": was["linked_at"] if same else float(now),
                "refreshed_at": float(now),
                "summary": summarize(passes),
                "year": reported if (reported := _year(year)) is not None else (was["year"] if same else None),
                "players": players_of(passes),
                "owned": owned_of(passes),
                "follows": was["follows"] if was else [],
                "pings": was["pings"] if was else True,
                "dm_closed": was["dm_closed"] if was else False,
                "gone": was["gone"] if was else False,
                "dm_channel": was["dm_channel"] if was else None,
                "pinged": was["pinged"] if was else [],
            }
            self._rows[uid] = row
            self._unlinked.pop(uid, None)
            self._save()
            return "ok"

    def unlink(self, uid: str) -> bool:
        """Forgets the member's link; says whether there was one (raises OSError, memory put back, when the file could not be written: a retry
        finishes it). The unlink is remembered either way: a device that
        linked on its own while the server kept nothing must not be able to link the member back."""
        with self._lock:
            row = self._rows.pop(uid, None)
            mark = self._unlinked.pop(uid, None)
            self._unlinked[uid] = time.time()
            while len(self._unlinked) > self._max:
                self._unlinked.pop(next(iter(self._unlinked)))
            if not self._save():
                if row is not None:
                    self._rows[uid] = row
                if mark is not None:
                    self._unlinked[uid] = mark
                else:
                    self._unlinked.pop(uid, None)
                raise OSError("the linked accounts could not be written")
            return row is not None

    def erase(self, uid: str) -> bool:
        """Removes everything held under the member's Discord id: the link and what hangs on it (follows, ping settings,
        DM state, pings sent, the pass summary). What stays is a tombstone, the member's id and the time of the erase
        and nothing else, so a device still linked from before cannot link them back (GET /api/me/link reports it as
        `unlinked_at`) until they link again on purpose. Says whether a link was held; a member with none writes nothing. Done under the lock and written whole, like every other change. Raises OSError,
        with memory put back as it was, when the file could not be written: the data is still there, and a retry
        can finish the job."""
        with self._lock:
            row = self._rows.pop(uid, None)
            if row is None:
                return False  # a tombstone already there stays as it is
            mark = self._unlinked.pop(uid, None)
            self._unlinked[uid] = time.time()
            while len(self._unlinked) > self._max:
                self._unlinked.pop(next(iter(self._unlinked)))
            if not self._save():
                if row is not None:
                    self._rows[uid] = row
                if mark is not None:
                    self._unlinked[uid] = mark
                else:
                    self._unlinked.pop(uid, None)
                raise OSError("the linked accounts could not be written")
            return True

    def unlinked_at(self, uid: str) -> float | None:
        """When the member last unlinked (seconds since the epoch), while they have not linked again; else None."""
        with self._lock:
            return self._unlinked.get(uid)

    def update(self, uid: str, pings: bool | None = None, follows: object = None, year: object = None) -> dict | None:
        """Changes the member's settings (each one given); turning pings on tries DMs again. The row after, or None
        when they linked nothing."""
        with self._lock:
            row = self._rows.get(uid)
            if row is None:
                return None
            if pings is not None:
                row["pings"] = bool(pings)
                if pings:
                    row["dm_closed"] = False
            if follows is not None:
                row["follows"] = _follows(follows)
            if (kept := _year(year)) is not None:  # a figure that does not fit is ignored, never stored
                row["year"] = kept
            self._save()
            return _copy(row)

    def uids(self) -> list[str]:
        """The Discord id of every member with a linked account."""
        with self._lock:
            return list(self._rows)

    def with_pings(self) -> list[str]:
        """The Discord id of every member whose deal pings are on (the admin panel counts them)."""
        with self._lock:
            return [uid for uid, row in self._rows.items() if row["pings"]]

    def pingable(self) -> list[tuple[str, dict]]:
        """(uid, a copy of the row) of each member whose deal pings are on and whose DMs are not known closed and who are not known gone from the server."""
        with self._lock:
            return [(uid, _copy(row)) for uid, row in self._rows.items() if row["pings"] and not row["dm_closed"]
                    and not row["gone"]]

    def note_ping(self, uid: str, listing_id: int, at: float) -> None:
        """Remembers a deal pinged to the member (the newest LINK_PINGED_KEPT), so it is never pinged twice."""
        with self._lock:
            row = self._rows.get(uid)
            if row is None:
                return
            row["pinged"] = [p for p in row["pinged"] if p[0] != listing_id][-(LINK_PINGED_KEPT - 1):]
            row["pinged"].append([listing_id, float(at)])
            self._save()

    def note_gone(self, uid: str, gone: bool) -> None:
        """Remembers that the member is not in the Discord server (banned, removed, left), or that they are again:
        a member known gone is sent no DM. Writes only a change."""
        with self._lock:
            row = self._rows.get(uid)
            if row is None or row["gone"] is gone:
                return
            row["gone"] = gone
            self._save()

    def note_dm(self, uid: str, channel: str | None = None, closed: bool = False) -> None:
        """Remembers the member's DM channel, or that their DMs are closed (pings then stop until turned on again)."""
        with self._lock:
            row = self._rows.get(uid)
            if row is None:
                return
            if channel is not None and _SNOWFLAKE.fullmatch(channel):
                row["dm_channel"] = channel
            if closed:
                row["dm_closed"] = True
            self._save()
