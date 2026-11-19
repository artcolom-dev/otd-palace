"""Visits: how many devices use the site, how often they come back, where they come from, and how far they go.

The page keeps one random id in its own storage (no cookie) and reports, in a small beacon, that it opened (with its
tab, a coarse device class, whether it runs as the installed home-screen app, the referring site's host name and a
campaign tag from its address), that a tab opened, or that "Continue with Discord" was pressed. `parse_visit` checks
a report field by field; anything else is refused whole.

What is kept, per UTC day, all of it bounded and pruned:
  devices   id -> first day, the days it was active (the last VISIT_KEEP_DAYS), a few flags (pressed "Continue with
            Discord", seen signed in, seen in our server), its class, whether installed, its first source, and the
            keyed hash of the member who used it signed in. At most VISIT_MAX_DEVICES; one quiet for VISIT_KEEP_DAYS
            is dropped.
  members   keyed hash of a Discord id -> first day and active days: retention by member, never a name or an id.
            The key comes from the server's session secret, so the hash cannot be turned back into an id without it.
  days      per day: page loads, views per tab, referrer hosts and campaign tags (at most VISIT_MAX_SOURCES_PER_DAY
            each), sign-in presses, logins started and finished (counted by the server), devices past the limit.
  discord   per day: our Discord server's member count (one number).
No address, user agent, full referrer, cookie or Discord id is ever written here.
"""

import hashlib
import hmac
import json
import logging
import os
import re
import tempfile
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from advisor.rules import (
    DISCORD_COUNT_EVERY_S,
    DISCORD_COUNT_KEEP_DAYS,
    VISIT_CLASSES,
    VISIT_EVENTS,
    VISIT_FLUSH_S,
    VISIT_KEEP_DAYS,
    VISIT_MAX_DEVICES,
    VISIT_MAX_MEMBERS,
    VISIT_MAX_SOURCES_PER_DAY,
    VISIT_TABS,
)

log = logging.getLogger(__name__)

EPOCH = date(1970, 1, 1)
DEVICE = re.compile(r"[A-Za-z0-9_-]{22}")  # 16 random bytes, base64url without padding
MEMBER_MARK = re.compile(r"[0-9a-f]{20}")
# A site's host name: dot-separated labels, none starting or ending with "-", the last one starting with a letter
# (so an IP address is never kept), 100 characters at most.
_HOST = re.compile(r"(?=.{1,100}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}")
_TAG = re.compile(r"[a-z0-9][a-z0-9_.-]{0,31}")
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")
_FIELDS = frozenset({"d", "e", "t", "k", "a", "r", "s"})
_STRING_MAX = 300  # a referrer or tag longer than this is not even looked at
COUNTERS = ("auth_start", "auth_ok")  # what the server itself counts: logins started, and finished with a session
SIGNIN, SIGNED_IN, IN_SERVER = 1, 2, 4  # a device's flags
DIRECT, OTHER = "direct", "other"


@dataclass(frozen=True)
class Visit:
    device: str
    event: str
    tab: str | None
    cls: str
    app: bool
    ref: str | None
    tag: str | None

    @property
    def source(self) -> str:
        """How this visit came: "?<tag>" for a campaign, else the referrer's host, else "" (direct)."""
        return f"?{self.tag}" if self.tag else (self.ref or "")


# What a user agent that is no visitor's browser says: crawlers, link previews, headless browsers, HTTP libraries.
_BOT = re.compile(
    r"bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|embedly|python|curl|wget|"
    r"httpclient|okhttp|go-http|java/|node-fetch|axios|phantom|selenium|puppeteer|playwright",
    re.IGNORECASE,
)


def looks_like_bot(user_agent: str | None) -> bool:
    """Whether a request's user agent is no person's browser (every browser's starts with "Mozilla/"). It is read
    here, on the request, and never kept."""
    agent = (user_agent or "")[:512]
    return not agent.startswith("Mozilla/") or _BOT.search(agent) is not None


def day_number(moment: datetime) -> int:
    """The UTC day of an aware datetime, as days since 1970-01-01."""
    return (moment.astimezone(timezone.utc).date() - EPOCH).days


def day_name(number: int) -> str:
    return (EPOCH + timedelta(days=number)).isoformat()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _host(value: str, own_host: str) -> str | None:
    host = value.strip().lower().rstrip(".")
    if host.startswith("www."):
        host = host[4:]
    own = own_host.lower()
    own = own[4:] if own.startswith("www.") else own
    if not _HOST.fullmatch(host) or host == own:
        return None
    return host


def parse_visit(data: object, own_host: str) -> Visit | None:
    """A visit report checked field by field, or None when anything in it is not what the page sends. A referrer that
    is no host name, or a tag that is not a short plain word, is dropped alone (the visit still counts)."""
    if not isinstance(data, dict) or not set(data) <= _FIELDS:
        return None
    device, event, tab, cls, app = (data.get(key) for key in ("d", "e", "t", "k", "a"))
    ref, tag = data.get("r"), data.get("s")
    if not (isinstance(device, str) and DEVICE.fullmatch(device) and event in VISIT_EVENTS and cls in VISIT_CLASSES
            and type(app) is bool):
        return None
    if tab is not None and tab not in VISIT_TABS:
        return None
    if tab is None and event != "signin":
        return None
    if ref is not None and not isinstance(ref, str) or tag is not None and not isinstance(tag, str):
        return None
    ref = _host(ref, own_host) if ref and len(ref) <= _STRING_MAX else None
    tag = tag.strip().lower() if tag and len(tag) <= _STRING_MAX else None
    if tag is not None and not _TAG.fullmatch(tag):
        tag = None
    return Visit(device=device, event=event, tab=tab, cls=cls, app=app, ref=ref, tag=tag)


# --- reading a saved file back, row by row --------------------------------------------------------------------------


def _int(value: object) -> bool:
    return type(value) is int and 0 <= value < 1_000_000


def _days_ok(value: object) -> bool:
    """Active days as kept: at least one, each a day number, strictly rising."""
    return (isinstance(value, list) and 0 < len(value) <= VISIT_KEEP_DAYS + 2 and all(_int(day) for day in value)
            and all(a < b for a, b in zip(value, value[1:])))


def _source_ok(value: object) -> bool:
    if not isinstance(value, str):
        return False
    if value == "":
        return True
    if value.startswith("?"):
        return _TAG.fullmatch(value[1:]) is not None
    return _HOST.fullmatch(value) is not None


def _device_ok(row: object) -> bool:
    return (isinstance(row, dict) and set(row) <= {"f", "d", "x", "k", "a", "s", "m"} and _int(row.get("f"))
            and _days_ok(row.get("d")) and type(row.get("x")) is int and 0 <= row["x"] < 8
            and row.get("k") in VISIT_CLASSES and row.get("a") in (0, 1) and type(row.get("a")) is int
            and _source_ok(row.get("s"))
            and ("m" not in row or isinstance(row["m"], str) and MEMBER_MARK.fullmatch(row["m"]) is not None))


def _member_ok(row: object) -> bool:
    return isinstance(row, dict) and set(row) == {"f", "d"} and _int(row["f"]) and _days_ok(row["d"])


def _counts_ok(value: object, keys: Callable[[str], bool]) -> dict:
    if not isinstance(value, dict):
        return {}
    return {k: n for k, n in value.items() if isinstance(k, str) and keys(k) and _int(n) and n > 0}


def _day_ok(row: object) -> dict | None:
    if not isinstance(row, dict):
        return None
    kept: dict = {}
    for name in ("loads", "signin", "over", *COUNTERS):
        if _int(row.get(name)) and row[name] > 0:
            kept[name] = row[name]
    views = _counts_ok(row.get("views"), lambda k: k in VISIT_TABS)
    refs = _counts_ok(row.get("ref"), lambda k: k in (DIRECT, OTHER) or _HOST.fullmatch(k) is not None)
    tags = _counts_ok(row.get("tag"), lambda k: k == OTHER or _TAG.fullmatch(k) is not None)
    for name, counts in (("views", views), ("ref", refs), ("tag", tags)):
        if counts:
            kept[name] = dict(list(counts.items())[:VISIT_MAX_SOURCES_PER_DAY + 1])
    return kept


def _empty() -> dict:
    return {"devices": {}, "members": {}, "days": {}, "discord": {}}


def _set_aside(path: Path) -> None:
    aside = path.with_name(path.name + ".corrupt")
    try:
        os.replace(path, aside)
    except OSError as error:
        log.warning("unreadable visits in %s could not be moved aside: %s", path, error)
    else:
        log.warning("unreadable visits moved to %s", aside)


def _load(path: Path) -> dict:
    """What `path` holds, row by row checked: a missing file is empty; one that is not JSON, or not the expected
    shape, is set aside as `<name>.corrupt` and the log starts empty."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return _empty()
    except ValueError as error:
        log.warning("visits in %s could not be read (%s); starting empty", path, error)
        _set_aside(path)
        return _empty()
    except OSError as error:
        log.warning("visits in %s could not be read (%s); starting empty", path, error)
        return _empty()
    if not isinstance(data, dict) or not all(isinstance(data.get(k), dict) for k in _empty()):
        log.warning("visits in %s are not in the expected shape; starting empty", path)
        _set_aside(path)
        return _empty()
    kept = _empty()
    kept["devices"] = {k: row for k, row in data["devices"].items() if DEVICE.fullmatch(str(k)) and _device_ok(row)}
    kept["members"] = {k: row for k, row in data["members"].items()
                       if MEMBER_MARK.fullmatch(str(k)) and _member_ok(row)}
    for day, row in data["days"].items():
        if isinstance(day, str) and _DAY.fullmatch(day) and (checked := _day_ok(row)) is not None:
            kept["days"][day] = checked
    kept["discord"] = {day: n for day, n in data["discord"].items()
                       if isinstance(day, str) and _DAY.fullmatch(day) and _int(n)}
    return kept


class VisitLog:
    """Counts visits and keeps them in a JSON file; safe to use from several web threads at once.

    `clock` returns an aware datetime (only its UTC day is kept). `member_key` keys the hash of a member's Discord id
    (None: members are never followed). Nothing is written on a request: `flush()` writes what changed, called every
    VISIT_FLUSH_S by `run_flusher` and on shutdown.
    """

    def __init__(self, path: Path, clock: Callable[[], datetime] = _utc_now, member_key: bytes | None = None,
                 max_devices: int = VISIT_MAX_DEVICES, max_members: int = VISIT_MAX_MEMBERS):
        self._path = path
        self._clock = clock
        self._key = member_key
        self._max_devices = max_devices
        self._max_members = max_members
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._data = _load(path)
        self._pruned_on: int | None = None
        self._dirty = False
        self._prune(day_number(clock()))

    # -- what the web app calls --

    def member_hash(self, uid: str | None) -> str | None:
        """The keyed hash a member's Discord id is kept as; None without a key or an id."""
        if not self._key or not uid:
            return None
        return hmac.new(self._key, uid.encode(), hashlib.sha256).hexdigest()[:20]

    def first_seen(self, device: str) -> int | None:
        """When the device was first seen (the start of its first UTC day, in seconds since the epoch), or None."""
        with self._lock:
            row = self._data["devices"].get(device)
            return None if row is None else row["f"] * 86400

    def discord_counts(self) -> dict[str, int]:
        """Our Discord server's member count, one point a day (a copy)."""
        with self._lock:
            return dict(self._data["discord"])

    def knows(self, device: str) -> bool:
        with self._lock:
            return device in self._data["devices"]

    def record(self, visit: Visit, state: str = "anon", uid: str | None = None) -> bool:
        """Counts one visit; `state` and `uid` are who the session cookie says sent it (advisor/discord_gate.py).
        False when its device is new and the table is full (the day's totals still count it)."""
        today = day_number(self._clock())
        mark = self.member_hash(uid) if state != "anon" else None
        with self._lock:
            self._prune(today)
            self._dirty = True
            day = self._data["days"].setdefault(day_name(today), {})
            if visit.event in ("load", "view") and visit.tab:
                views = day.setdefault("views", {})
                views[visit.tab] = views.get(visit.tab, 0) + 1
            if visit.event == "load":
                day["loads"] = day.get("loads", 0) + 1
                self._bump(day, "ref", visit.ref or DIRECT)
                if visit.tag:
                    self._bump(day, "tag", visit.tag)
            elif visit.event == "signin":
                day["signin"] = day.get("signin", 0) + 1
            devices = self._data["devices"]
            row = devices.get(visit.device)
            if row is None:
                if len(devices) >= self._max_devices:
                    day["over"] = day.get("over", 0) + 1
                    return False
                row = devices[visit.device] = {"f": today, "d": [today], "x": 0, "k": visit.cls, "a": 0,
                                               "s": visit.source if visit.event == "load" else ""}
            elif row["d"][-1] < today:  # never behind the last day kept, even if the clock steps back
                row["d"].append(today)
            row["k"] = visit.cls
            row["a"] = 1 if visit.app else 0
            if visit.event == "signin":
                row["x"] |= SIGNIN
            if state in ("in", "out", "banned"):
                row["x"] |= SIGNED_IN | (IN_SERVER if state == "in" else 0)
            if mark is not None:
                members = self._data["members"]
                member = members.get(mark)
                if member is None and len(members) < self._max_members:
                    members[mark] = {"f": today, "d": [today]}
                elif member is not None and member["d"][-1] < today:
                    member["d"].append(today)
                if mark in members:
                    row["m"] = mark
            return True

    def count(self, name: str) -> None:
        """One more of a server-side count for today: "auth_start" or "auth_ok" (anything else is ignored)."""
        if name not in COUNTERS:
            return
        today = day_number(self._clock())
        with self._lock:
            self._prune(today)
            day = self._data["days"].setdefault(day_name(today), {})
            day[name] = day.get(name, 0) + 1
            self._dirty = True

    def note_discord_members(self, count: object) -> None:
        """Our Discord server's member count now: the last one of a day is the day's point."""
        if type(count) is not int or count < 0:
            return
        today = day_number(self._clock())
        with self._lock:
            self._prune(today)
            self._data["discord"][day_name(today)] = count
            self._dirty = True

    def erase_member(self, uid: str) -> int:
        """"Delete my data": drops the member's hash and every device seen signed in as them; how many devices went."""
        mark = self.member_hash(uid)
        if mark is None:
            return 0
        with self._lock:
            self._data["members"].pop(mark, None)
            mine = [d for d, row in self._data["devices"].items() if row.get("m") == mark]
            for device in mine:
                del self._data["devices"][device]
            self._dirty = True
        self.flush()
        return len(mine)

    def erase_device(self, device: object) -> bool:
        """Drops one device's row (the page's own id, sent with "Delete my data"); whether there was one."""
        if not isinstance(device, str) or not DEVICE.fullmatch(device):
            return False
        with self._lock:
            found = self._data["devices"].pop(device, None) is not None
            self._dirty = self._dirty or found
        return found

    def data(self) -> dict:
        """A copy of everything kept, pruned to today (for the admin panel, and tests)."""
        with self._lock:
            self._prune(day_number(self._clock()))
            text = json.dumps(self._data)  # a copy in plain JSON: twice as fast as a deep copy, under the lock
        return json.loads(text)

    def today(self) -> int:
        return day_number(self._clock())

    # -- upkeep --

    @staticmethod
    def _bump(day: dict, name: str, key: str) -> None:
        counts = day.setdefault(name, {})
        if key not in counts and len(counts) >= VISIT_MAX_SOURCES_PER_DAY:
            key = OTHER
        counts[key] = counts.get(key, 0) + 1

    def _prune(self, today: int) -> None:
        """Drops what is too old to keep, once a day; called under the lock (or before the log is shared)."""
        if self._pruned_on == today:
            return
        self._pruned_on = today
        oldest = today - VISIT_KEEP_DAYS
        changed = False
        for table in ("devices", "members"):
            rows = self._data[table]
            for key in [key for key, row in rows.items() if row["d"][-1] < oldest]:
                del rows[key]
                changed = True
            for row in rows.values():
                if row["d"][0] < oldest:
                    row["d"] = [day for day in row["d"] if day >= oldest]
                    changed = True
        for row in self._data["devices"].values():
            if "m" in row and row["m"] not in self._data["members"]:
                del row["m"]  # the member aged out: the device no longer points at them
                changed = True
        for table, keep in (("days", VISIT_KEEP_DAYS), ("discord", DISCORD_COUNT_KEEP_DAYS)):
            first = day_name(today - keep)
            for day in [day for day in self._data[table] if day < first]:
                del self._data[table][day]
                changed = True
        self._dirty = self._dirty or changed

    def flush(self) -> None:
        """Writes everything when something changed since the last write: to a temporary file next to the log's,
        renamed over it. A failed write is logged and tried again at the next flush."""
        with self._write_lock:
            with self._lock:
                if not self._dirty:
                    return
                text = json.dumps(self._data, separators=(",", ":"))
                self._dirty = False
            tmp_name = None
            try:
                self._path.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=self._path.parent,
                                                 prefix=f".{self._path.name}.", suffix=".tmp", delete=False) as tmp:
                    tmp_name = tmp.name
                    tmp.write(text)
                    tmp.flush()
                    os.fsync(tmp.fileno())
                os.replace(tmp_name, self._path)
            except OSError as error:
                log.warning("visits could not be written to %s: %s", self._path, error)
                with self._lock:
                    self._dirty = True
                if tmp_name is not None:
                    try:
                        os.unlink(tmp_name)
                    except OSError:
                        pass


def run_discord_counter(visits: VisitLog, read_count: Callable[[], int | None], stop: threading.Event,
                        every_s: float = DISCORD_COUNT_EVERY_S) -> None:
    """Notes our Discord server's member count now, then every `every_s` seconds until `stop` is set. A read that
    fails is skipped: the day keeps its last good point."""
    while True:
        try:
            count = read_count()
        except Exception:  # noqa: BLE001 - Discord being down never ends the thread
            log.warning("discord member count could not be read")
            count = None
        if count is not None:
            visits.note_discord_members(count)
        if stop.wait(every_s):
            return


def run_flusher(visits: VisitLog, stop: threading.Event, every_s: float = VISIT_FLUSH_S) -> None:
    """Writes the visits every `every_s` seconds until `stop` is set (the server flushes once more on shutdown)."""
    while not stop.wait(every_s):
        try:
            visits.flush()
        except Exception:  # noqa: BLE001 - the thread must outlive any one bad write
            log.exception("visits flush failed")
