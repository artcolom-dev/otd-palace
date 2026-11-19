"""Activity: what each device and each signed-in member does on the site, event by event, and what happens in our
Discord, for the admin panel's Members, Accounts, Discord, Features and Sources tabs (advisor/activity_report.py).

A device is the page's random visit id (frontend/src/lib/visit.ts): no address, no user agent, no fingerprint is
ever kept with it. A device seen signed in is tied to that member's Discord id, and so is everything it did before
(its history comes with it). The privacy notice (advisor/privacy.py) says so, and "Delete my data" erases it all
(`erase_member`).

What is kept, in one SQLite file of the data directory (activity.db), every table bounded in rows and in days:
  devices   visit id -> first and last seen, first source ("?tag", a referrer host, or "" for direct), class,
            home-screen flag, and the member it was seen signed in as. At most ACTIVITY_MAX_DEVICES.
  events    time, device, member, the session's state, class, kind (rules.ACTIVITY_PAGE_EVENTS from the page,
            rules.ACTIVITY_SERVER_EVENTS from the server), a small checked argument and a number. At most
            ACTIVITY_EVENTS_PER_DAY a day, ACTIVITY_DEVICE_EVENTS_PER_DAY a device a day, ACTIVITY_MAX_EVENTS in all.
  members   Discord id -> the name to show, first and last seen on the site, the last session state.
  lookups   each Real account looked up: when, by which member (none: anonymous), the answer, its passes.
  accounts  each Real account looked up: its last known passes and yearly figure.
  erased    Discord id -> when they deleted their data: nothing of theirs is recorded again until they log in anew.
  dropped   per day, how many events the bounds turned away.
  d_*       our Discord (advisor/discord_activity.py): people (name, avatar, roles, joined, in the server), messages
            per day, channel and author (counts only, never their text), joins, leaves and role changes, the bot's
            posts with their reactions, and where each channel was last read.
Members' rows go MEMBER_ACTIVITY_KEEP_DAYS after their last activity, anonymous ones ANON_ACTIVITY_KEEP_DAYS.

Nothing is written on a request: the web app hands rows to a queue (bounded), and a thread of its own (`run_writer`)
stores them every ACTIVITY_FLUSH_S in one transaction. The admin's reads take the same lock, briefly.
"""

import json
import logging
import os
import re
import sqlite3
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path

from advisor.account_types import YEAR_MAX
from advisor.importer import valid_username
from advisor.rules import (
    ACTIVITY_BATCH_MAX,
    ACTIVITY_DEVICE_EVENTS_PER_DAY,
    ACTIVITY_EVENTS_PER_DAY,
    ACTIVITY_FLUSH_S,
    ACTIVITY_LOOKUP_DEDUP_S,
    ACTIVITY_MAX_DEVICES,
    ACTIVITY_MAX_EVENTS,
    ACTIVITY_MAX_ACCOUNTS,
    ACTIVITY_MAX_LOOKUPS,
    ACTIVITY_MAX_MEMBERS,
    ACTIVITY_PAGE_EVENTS,
    ACTIVITY_QUEUE_MAX,
    ACTIVITY_TIME_MAX_S,
    ANON_ACTIVITY_KEEP_DAYS,
    DISCORD_ACTIVITY_MSG_ROWS_PER_DAY,
    DISCORD_ACTIVITY_PEOPLE_MAX,
    DISCORD_ACTIVITY_POSTS,
    DISCORD_CHANNEL_KEEP_DAYS,
    MEMBER_ACTIVITY_KEEP_DAYS,
    VISIT_CLASSES,
)

log = logging.getLogger(__name__)

DAY_S = 86400
DEVICE = re.compile(r"[A-Za-z0-9_-]{22}")
SNOWFLAKE = re.compile(r"\d{15,21}")
WORD = re.compile(r"[a-z0-9][a-z0-9_.-]{0,31}")
LISTING = re.compile(r"\d{1,18}")
STATES = ("anon", "in", "out", "banned")
_BATCH_FIELDS = frozenset({"d", "k", "a", "e"})
_NAME_MAX = 64
_TITLE_MAX = 90

SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, first INTEGER NOT NULL, last INTEGER NOT NULL,
    source TEXT NOT NULL, cls TEXT NOT NULL, app INTEGER NOT NULL, member TEXT) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS devices_member ON devices(member) WHERE member IS NOT NULL;
CREATE INDEX IF NOT EXISTS devices_first ON devices(first);
CREATE TABLE IF NOT EXISTS events (ts INTEGER NOT NULL, device TEXT, member TEXT, state TEXT NOT NULL, cls TEXT,
    kind TEXT NOT NULL, arg TEXT, n INTEGER);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_member ON events(member, ts) WHERE member IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_device ON events(device, ts) WHERE device IS NOT NULL;
CREATE TABLE IF NOT EXISTS members (uid TEXT PRIMARY KEY, name TEXT, first INTEGER NOT NULL, last INTEGER NOT NULL,
    state TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS lookups (ts INTEGER NOT NULL, username TEXT NOT NULL, member TEXT, status TEXT NOT NULL,
    passes INTEGER);
CREATE INDEX IF NOT EXISTS lookups_ts ON lookups(ts);
CREATE INDEX IF NOT EXISTS lookups_member ON lookups(member) WHERE member IS NOT NULL;
CREATE TABLE IF NOT EXISTS accounts (key TEXT PRIMARY KEY, username TEXT NOT NULL, passes INTEGER, year INTEGER,
    at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS erased (uid TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS dropped (day INTEGER PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS d_people (uid TEXT PRIMARY KEY, name TEXT, avatar TEXT, roles TEXT, joined INTEGER,
    present INTEGER, seen INTEGER NOT NULL, checked INTEGER) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS d_msgs (day INTEGER NOT NULL, channel TEXT NOT NULL, uid TEXT NOT NULL, n INTEGER NOT NULL,
    PRIMARY KEY (day, channel, uid)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS d_msgs_uid ON d_msgs(uid);
CREATE TABLE IF NOT EXISTS d_chan (day INTEGER NOT NULL, channel TEXT NOT NULL, n INTEGER NOT NULL,
    PRIMARY KEY (day, channel)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS d_events (ts INTEGER NOT NULL, uid TEXT NOT NULL, kind TEXT NOT NULL, arg TEXT);
CREATE INDEX IF NOT EXISTS d_events_uid ON d_events(uid, ts);
CREATE INDEX IF NOT EXISTS d_events_ts ON d_events(ts);
CREATE TABLE IF NOT EXISTS d_posts (id TEXT PRIMARY KEY, channel TEXT NOT NULL, ts INTEGER NOT NULL, title TEXT,
    reactions INTEGER NOT NULL, top TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS d_cursors (channel TEXT PRIMARY KEY, last_id TEXT NOT NULL, at INTEGER NOT NULL)
    WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS d_status (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
"""


@dataclass(frozen=True)
class PageEvent:
    kind: str
    arg: str | None = None
    n: int | None = None


@dataclass(frozen=True)
class Batch:
    """A report from the page: its visit id, class, home-screen flag and up to ACTIVITY_BATCH_MAX events."""

    device: str
    cls: str
    app: bool
    events: tuple[PageEvent, ...]


def _arg_ok(rule: str, arg: object) -> str | None | bool:
    """The argument as kept, None for no argument, or False when it is not what `rule` allows."""
    if rule == "none":
        return None if arg is None else False
    if not isinstance(arg, str) or len(arg) > 64:
        return False
    if rule == "word":
        return arg if WORD.fullmatch(arg) else False
    if rule == "id":
        return arg if LISTING.fullmatch(arg) else False
    if rule == "user":
        name = valid_username(arg)
        return name if name is not None and name == arg else False
    return False


def _event(item: object) -> PageEvent | None:
    if not isinstance(item, list) or not 1 <= len(item) <= 3:
        return None
    kind = item[0]
    if not isinstance(kind, str) or kind not in ACTIVITY_PAGE_EVENTS:
        return None
    arg = _arg_ok(ACTIVITY_PAGE_EVENTS[kind], item[1] if len(item) > 1 else None)
    if arg is False:
        return None
    n = item[2] if len(item) > 2 else None
    if kind in ("time", "year"):
        high, low = (ACTIVITY_TIME_MAX_S, 1) if kind == "time" else (YEAR_MAX, 0)
        if type(n) is not int or not low <= n <= high:
            return None
    elif n is not None:
        return None
    return PageEvent(kind, arg, n)


def parse_batch(data: object) -> Batch | None:
    """A report checked field by field and event by event, or None when anything in it is not what the page sends
    (it is refused whole)."""
    if not isinstance(data, dict) or not set(data) <= _BATCH_FIELDS:
        return None
    device, cls, app, items = (data.get(key) for key in ("d", "k", "a", "e"))
    if not (isinstance(device, str) and DEVICE.fullmatch(device) and cls in VISIT_CLASSES and type(app) is bool):
        return None
    if not isinstance(items, list) or not 1 <= len(items) <= ACTIVITY_BATCH_MAX:
        return None
    events = tuple(_event(item) for item in items)
    if any(e is None for e in events):
        return None
    return Batch(device, cls, app, events)  # type: ignore[arg-type]


def clean_name(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    name = "".join(ch for ch in value if ch.isprintable()).strip()[:_NAME_MAX]
    return name or None


def day_of(ts: float) -> int:
    """The UTC day of a time in seconds since the epoch, as days since 1970-01-01."""
    return int(ts // DAY_S)


class ActivityLog:
    """The activity store. Safe from several threads: `add_*`/`note_*` only queue (memory, under a short lock); the
    writer thread's `flush()` stores; `erase_*` and the admin's `read()` take the database lock.

    `clock` returns seconds since the epoch. `path` None keeps it all in memory (tests, previews)."""

    def __init__(self, path: Path | None, clock: Callable[[], float] = time.time, *,
                 max_events: int = ACTIVITY_MAX_EVENTS, max_devices: int = ACTIVITY_MAX_DEVICES,
                 max_members: int = ACTIVITY_MAX_MEMBERS, max_lookups: int = ACTIVITY_MAX_LOOKUPS,
                 per_day: int = ACTIVITY_EVENTS_PER_DAY, per_device: int = ACTIVITY_DEVICE_EVENTS_PER_DAY,
                 queue_max: int = ACTIVITY_QUEUE_MAX):
        self._path = path
        self._clock = clock
        self._max_events = max_events
        self._max_devices = max_devices
        self._max_members = max_members
        self._max_lookups = max_lookups
        self._per_day = per_day
        self._per_device = per_device
        self._queue_max = queue_max
        self._lock = threading.Lock()  # the queue and the day's counts
        self._db_lock = threading.RLock()
        self._queue: list[tuple] = []
        self._counted_day = -1
        self._day_total = 0
        self._device_counts: dict[str, int] = {}
        self._dropped = 0
        self._seen_lookups: dict[tuple, float] = {}
        self._pruned_on = -1
        self._db = self._open()
        self._erased: dict[str, int] = dict(self._db.execute("SELECT uid, at FROM erased").fetchall())

    # -- opening -------------------------------------------------------------------------------------------------

    def _connect(self) -> sqlite3.Connection:
        target = ":memory:" if self._path is None else str(self._path)
        db = sqlite3.connect(target, check_same_thread=False, isolation_level=None)
        if self._path is not None:
            db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA synchronous=NORMAL")
        db.executescript(SCHEMA)
        db.execute("PRAGMA quick_check").fetchone()
        return db

    def _open(self) -> sqlite3.Connection:
        """The database; one that cannot be read is set aside as `<name>.corrupt` and a new one is started."""
        if self._path is not None:
            self._path.parent.mkdir(parents=True, exist_ok=True)
        try:
            return self._connect()
        except sqlite3.DatabaseError as error:
            if self._path is None:
                raise
            log.warning("activity in %s could not be read (%s); starting empty", self._path, type(error).__name__)
            for suffix in ("", "-wal", "-shm"):
                try:
                    os.replace(f"{self._path}{suffix}", f"{self._path}.corrupt{suffix}")
                except OSError:
                    pass
            return self._connect()

    def close(self) -> None:
        with self._db_lock:
            self._db.close()

    # -- what the web app calls (memory only) -----------------------------------------------------------------------

    def now(self) -> int:
        return int(self._clock())

    def _member_of(self, state: str, uid: str | None, iat: int | None) -> str | None:
        """The Discord id an event is kept under: the signed-in member's, unless they erased their data and have not
        logged in anew since."""
        if state == "anon" or not uid or not SNOWFLAKE.fullmatch(uid):
            return None
        erased_at = self._erased.get(uid)
        if erased_at is not None and (iat is None or iat <= erased_at):
            return None
        return uid

    def _admit(self, device: str | None, count: int, ts: int) -> int:
        """How many of `count` events from `device` fit today's bounds (under the lock); the rest is counted dropped."""
        day = day_of(ts)
        if day != self._counted_day:
            self._counted_day, self._day_total = day, 0
            self._device_counts = {}
        room = min(count, self._per_day - self._day_total, self._queue_max - len(self._queue))
        if device is not None:
            room = min(room, self._per_device - self._device_counts.get(device, 0))
        room = max(0, room)
        self._day_total += room
        if device is not None and room:
            self._device_counts[device] = self._device_counts.get(device, 0) + room
        self._dropped += count - room
        return room

    def add_page(self, batch: Batch, state: str, uid: str | None, name: str | None = None,
                 iat: int | None = None) -> int:
        """Queues a report from the page, as sent by who the session cookie says (`state`, `uid`, `name`, `iat`).
        How many of its events were kept (the bounds may turn some away)."""
        ts = self.now()
        member = self._member_of(state, uid, iat)
        rows = []
        for e in batch.events:
            rows.append(("event", ts, batch.device, member, state, batch.cls, batch.app, e.kind, e.arg, e.n, None,
                         clean_name(name) if member else None))
        with self._lock:
            room = self._admit(batch.device, len(rows), ts)
            self._queue.extend(rows[:room])
        return room

    def add_visit(self, device: str, kind: str, tab: str | None, cls: str, app: bool, source: str | None,
                  state: str, uid: str | None, name: str | None = None, iat: int | None = None,
                  first: int | None = None) -> bool:
        """Queues what the visit beacon said (advisor/visits.py): "load" (with the visit's source, kept as the
        device's first one when it is new), "tab" or "signin". `first`: when the visit log first saw the device,
        for a device older than this log."""
        if kind not in ("load", "tab", "signin"):
            return False
        ts = self.now()
        member = self._member_of(state, uid, iat)
        row = ("event", ts, device, member, state, cls, app, kind, tab, None, (source or "", first),
               clean_name(name) if member else None)
        with self._lock:
            if not self._admit(device, 1, ts):
                return False
            self._queue.append(row)
        return True

    def note_auth(self, uid: str, name: str | None) -> None:
        """A login finished for `uid`: their row (with the name to show), an "auth" event, and the end of a
        "Delete my data" pause."""
        if not SNOWFLAKE.fullmatch(uid or ""):
            return
        ts = self.now()
        with self._lock:
            self._erased.pop(uid, None)
            if self._admit(None, 1, ts):
                self._queue.append(("auth", ts, uid, clean_name(name)))

    def note_link(self, uid: str | None, username: str, passes: int | None, linked: bool = True) -> None:
        """A Real account linked (`linked`) or unlinked by a member, seen by the server."""
        member = self._member_of("in", uid, None)
        if member is None:
            return
        ts = self.now()
        with self._lock:
            if self._admit(None, 1, ts):
                self._queue.append(("event", ts, None, member, "in", None, None, "linked" if linked else "unlinked",
                                    username if linked else None, passes if linked else None, None, None))

    def note_lookup(self, username: str, uid: str | None, status: str, passes: int | None) -> bool:
        """An account looked up through the server: the same member (or anyone anonymous) asking for the same name
        within ACTIVITY_LOOKUP_DEDUP_S counts once. Whether it was kept."""
        name = valid_username(username)
        if name is None or status not in ("ok", "not_found", "private"):
            return False
        ts = self.now()
        member = self._member_of("in", uid, None) if uid else None
        key = (member, name.casefold())
        with self._lock:
            for old in [k for k, at in self._seen_lookups.items() if ts - at >= ACTIVITY_LOOKUP_DEDUP_S]:
                del self._seen_lookups[old]
            if key in self._seen_lookups or len(self._seen_lookups) >= 50_000:
                return False
            self._seen_lookups[key] = ts
            if len(self._queue) >= self._queue_max:
                self._dropped += 1
                return False
            self._queue.append(("lookup", ts, name, member, status, passes))
        return True

    def blocked(self, uid: str) -> bool:
        """Whether nothing may be recorded under `uid` (they deleted their data and have not logged in since)."""
        return uid in self._erased

    def pending(self) -> int:
        with self._lock:
            return len(self._queue)

    # -- the writer -------------------------------------------------------------------------------------------------

    def flush(self) -> int:
        """Stores what waits, in one transaction; prunes once a day. How many rows were stored. A failed write is
        logged and its rows dropped (the next ones still go)."""
        with self._lock:
            rows, self._queue = self._queue, []
            dropped, self._dropped = self._dropped, 0
            today = self._counted_day if self._counted_day >= 0 else day_of(self.now())
        with self._db_lock:
            try:
                self._db.execute("BEGIN")
                for row in rows:
                    getattr(self, f"_store_{row[0]}")(*row[1:])
                if dropped:
                    self._db.execute("INSERT INTO dropped(day, n) VALUES(?, ?) ON CONFLICT(day) DO UPDATE SET n = n + ?",
                                     (today, dropped, dropped))
                self._db.execute("COMMIT")
            except sqlite3.Error as error:
                log.warning("activity could not be stored (%s): %d rows dropped", type(error).__name__, len(rows))
                try:
                    self._db.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                return 0
            self.prune()
        return len(rows)

    def _count(self, sql: str, args: tuple = ()) -> int:
        return self._db.execute(sql, args).fetchone()[0]

    def _store_member(self, uid: str, ts: int, name: str | None, state: str | None) -> bool:
        """The member's row made or brought up to date; False when the table is full and they are new."""
        if self._db.execute("SELECT 1 FROM members WHERE uid = ?", (uid,)).fetchone() is None:
            if self._count("SELECT COUNT(*) FROM members") >= self._max_members:
                return False
            self._db.execute("INSERT INTO members(uid, name, first, last, state) VALUES(?, ?, ?, ?, ?)",
                             (uid, name, ts, ts, state))
            return True
        self._db.execute("UPDATE members SET last = MAX(last, ?), name = COALESCE(?, name), state = COALESCE(?, state)"
                         " WHERE uid = ?", (ts, name, state, uid))
        return True

    def _store_event(self, ts, device, member, state, cls, app, kind, arg, n, visit, name) -> None:
        if member is not None and not self._store_member(member, ts, name, state):
            member = None
        if device is not None:
            found = self._db.execute("SELECT member FROM devices WHERE id = ?", (device,)).fetchone()
            if found is None:
                if self._count("SELECT COUNT(*) FROM devices") >= self._max_devices:
                    self._db.execute("INSERT INTO dropped(day, n) VALUES(?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1",
                                     (day_of(ts),))
                    return
                source, first = visit if visit is not None else ("", None)
                first = min(first, ts) if isinstance(first, int) and first > 0 else ts
                self._db.execute("INSERT INTO devices(id, first, last, source, cls, app, member) VALUES(?,?,?,?,?,?,?)",
                                 (device, first, ts, source if kind == "load" else "", cls, int(bool(app)), member))
            else:
                self._db.execute("UPDATE devices SET last = MAX(last, ?), cls = ?, app = ? WHERE id = ?",
                                 (ts, cls, int(bool(app)), device))
                if member is not None and found[0] is None:
                    # Signed in on this device for the first time: what it did before is theirs too.
                    self._db.execute("UPDATE devices SET member = ? WHERE id = ?", (member, device))
                    self._db.execute("UPDATE events SET member = ? WHERE device = ? AND member IS NULL",
                                     (member, device))
        if kind == "year" and arg is not None and n is not None:
            # The page's say-so sizes an account the server looked up; it never adds one (anyone can send any name).
            self._db.execute("UPDATE accounts SET year = ?, at = ? WHERE key = ?", (n, ts, arg.casefold()))
        self._db.execute("INSERT INTO events(ts, device, member, state, cls, kind, arg, n) VALUES(?,?,?,?,?,?,?,?)",
                         (ts, device, member, state, cls, kind, arg, n))

    def _store_auth(self, ts: int, uid: str, name: str | None) -> None:
        self._db.execute("DELETE FROM erased WHERE uid = ?", (uid,))
        if self._store_member(uid, ts, name, "in"):
            self._db.execute("INSERT INTO events(ts, device, member, state, cls, kind, arg, n) VALUES(?,?,?,?,?,?,?,?)",
                             (ts, None, uid, "in", None, "auth", None, None))

    def _store_account(self, username: str, passes: int | None, year: int | None, ts: int) -> None:
        self._db.execute(
            "INSERT INTO accounts(key, username, passes, year, at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET"
            " username = excluded.username, passes = COALESCE(excluded.passes, passes),"
            " year = COALESCE(excluded.year, year), at = excluded.at",
            (username.casefold(), username, passes, year, ts))

    def _store_lookup(self, ts: int, username: str, member: str | None, status: str, passes: int | None) -> None:
        if member is not None and self._db.execute("SELECT 1 FROM members WHERE uid = ?", (member,)).fetchone() is None:
            self._store_member(member, ts, None, None)
        self._db.execute("INSERT INTO lookups(ts, username, member, status, passes) VALUES(?, ?, ?, ?, ?)",
                         (ts, username, member, status, passes))
        if status == "ok":
            self._store_account(username, passes, None, ts)

    # -- upkeep -----------------------------------------------------------------------------------------------------

    def prune(self, force: bool = False) -> None:
        """Drops what is too old to keep, once a UTC day (or when `force`), and the oldest past each table's bound."""
        now = self.now()
        today = day_of(now)
        with self._db_lock:
            if self._pruned_on == today and not force:
                return
            self._pruned_on = today
            member_cut = now - MEMBER_ACTIVITY_KEEP_DAYS * DAY_S
            anon_cut = now - ANON_ACTIVITY_KEEP_DAYS * DAY_S
            db = self._db
            try:
                db.execute("BEGIN")
                db.execute("DELETE FROM events WHERE ts < ? OR (member IS NULL AND ts < ?)", (member_cut, anon_cut))
                db.execute("DELETE FROM devices WHERE last < ? OR (member IS NULL AND last < ?)", (member_cut, anon_cut))
                db.execute("DELETE FROM members WHERE last < ?", (member_cut,))
                db.execute("DELETE FROM lookups WHERE ts < ? OR (member IS NULL AND ts < ?)", (member_cut, anon_cut))
                db.execute("DELETE FROM accounts WHERE at < ?", (member_cut,))
                db.execute("DELETE FROM dropped WHERE day < ?", (today - MEMBER_ACTIVITY_KEEP_DAYS,))
                db.execute("DELETE FROM d_msgs WHERE day < ?", (today - MEMBER_ACTIVITY_KEEP_DAYS,))
                db.execute("DELETE FROM d_chan WHERE day < ?", (today - DISCORD_CHANNEL_KEEP_DAYS,))
                db.execute("DELETE FROM d_events WHERE ts < ?", (member_cut,))
                db.execute("DELETE FROM d_people WHERE seen < ?", (member_cut,))
                db.execute("DELETE FROM d_posts WHERE ts < ?", (member_cut,))
                db.execute("DELETE FROM d_cursors WHERE at < ?", (now - 30 * DAY_S,))
                self._cap("events", "ts", self._max_events)
                self._cap("lookups", "ts", self._max_lookups)
                self._cap("d_events", "ts", self._max_events // 10)
                self._cap_keyed("accounts", "key", "at", ACTIVITY_MAX_ACCOUNTS)
                self._cap_keyed("d_posts", "id", "ts", DISCORD_ACTIVITY_POSTS)
                self._cap_keyed("d_people", "uid", "seen", DISCORD_ACTIVITY_PEOPLE_MAX)
                self._cap_keyed("erased", "uid", "at", self._max_members)
                db.execute("COMMIT")
            except sqlite3.Error as error:
                log.warning("activity could not be pruned (%s)", type(error).__name__)
                try:
                    db.execute("ROLLBACK")
                except sqlite3.Error:
                    pass

    def _cap(self, table: str, order: str, keep: int) -> None:
        over = self._count(f"SELECT COUNT(*) FROM {table}") - keep  # noqa: S608 - table and column are ours
        if over > 0:
            self._db.execute(f"DELETE FROM {table} WHERE rowid IN (SELECT rowid FROM {table} ORDER BY {order} LIMIT ?)",
                             (over,))

    def _cap_keyed(self, table: str, key: str, order: str, keep: int) -> None:
        over = self._count(f"SELECT COUNT(*) FROM {table}") - keep  # noqa: S608
        if over > 0:
            self._db.execute(f"DELETE FROM {table} WHERE {key} IN (SELECT {key} FROM {table} ORDER BY {order} LIMIT ?)",
                             (over,))

    # -- "Delete my data" -------------------------------------------------------------------------------------------

    def erase_member(self, uid: str, device: object = None) -> int:
        """Removes everything recorded under the member's Discord id: their events, every device they used signed
        in (with all it did, before and after), the lookups they made, their row, and their Discord activity
        (messages counted, joins, leaves, roles, name and avatar); and `device`, the visit id the page sends. Nothing
        is recorded under them again until they log in anew. How many rows went. Raises sqlite3.Error when the file
        could not be written (nothing is then removed: a retry finishes it)."""
        if not SNOWFLAKE.fullmatch(uid or ""):
            return 0
        now = self.now()
        with self._lock:
            self._erased[uid] = now
            # What waits in the queue for them goes too, before it is ever stored.
            self._queue = [row for row in self._queue if not self._is_theirs(row, uid, device)]
        with self._db_lock:
            db = self._db
            db.execute("BEGIN")
            try:
                gone = 0
                devices = [r[0] for r in db.execute("SELECT id FROM devices WHERE member = ?", (uid,))]
                if isinstance(device, str) and DEVICE.fullmatch(device):
                    devices.append(device)
                for chunk in _chunks(devices, 400):
                    marks = ",".join("?" * len(chunk))
                    gone += db.execute(f"DELETE FROM events WHERE device IN ({marks})", chunk).rowcount  # noqa: S608
                    gone += db.execute(f"DELETE FROM devices WHERE id IN ({marks})", chunk).rowcount  # noqa: S608
                for table in ("events", "lookups"):
                    gone += db.execute(f"DELETE FROM {table} WHERE member = ?", (uid,)).rowcount  # noqa: S608
                for table in ("members", "d_people", "d_msgs", "d_events"):
                    gone += db.execute(f"DELETE FROM {table} WHERE uid = ?", (uid,)).rowcount  # noqa: S608
                db.execute("DELETE FROM accounts WHERE key NOT IN (SELECT lower(username) FROM lookups)"
                           " AND key NOT IN (SELECT lower(arg) FROM events WHERE kind = 'year')")
                db.execute("INSERT INTO erased(uid, at) VALUES(?, ?) ON CONFLICT(uid) DO UPDATE SET at = excluded.at",
                           (uid, now))
                db.execute("COMMIT")
            except sqlite3.Error:
                db.execute("ROLLBACK")
                raise
        return gone

    @staticmethod
    def _is_theirs(row: tuple, uid: str, device: object) -> bool:
        if row[0] == "event":
            return row[3] == uid or (device is not None and row[2] == device)
        if row[0] == "auth":
            return row[2] == uid
        if row[0] == "lookup":
            return row[3] == uid
        return False

    def erase_device(self, device: object) -> int:
        """Drops one device's row and all it did (the page's own id, sent with "Delete my data")."""
        if not isinstance(device, str) or not DEVICE.fullmatch(device):
            return 0
        with self._lock:
            self._queue = [row for row in self._queue if not (row[0] == "event" and row[2] == device)]
        with self._db_lock:
            self._db.execute("BEGIN")
            try:
                gone = self._db.execute("DELETE FROM events WHERE device = ?", (device,)).rowcount
                gone += self._db.execute("DELETE FROM devices WHERE id = ?", (device,)).rowcount
                self._db.execute("COMMIT")
            except sqlite3.Error:
                self._db.execute("ROLLBACK")
                raise
        return gone

    # -- Discord (advisor/discord_activity.py) ------------------------------------------------------------------------

    def discord_write(self, write: Callable[[sqlite3.Connection], None]) -> None:
        """Runs `write` on the database in one transaction (the Discord reader's rounds)."""
        with self._db_lock:
            self._db.execute("BEGIN")
            try:
                write(self._db)
                self._db.execute("COMMIT")
            except Exception:
                self._db.execute("ROLLBACK")
                raise

    def note_messages(self, counts: dict[tuple[int, str, str | None], int]) -> None:
        """Messages counted by (UTC day, channel name, author's Discord id or None for a bot): per channel always, per
        author while the day has room and the author has not erased their data."""

        def write(db: sqlite3.Connection) -> None:
            for (day, channel, uid), n in counts.items():
                db.execute("INSERT INTO d_chan(day, channel, n) VALUES(?, ?, ?) ON CONFLICT(day, channel) DO UPDATE"
                           " SET n = n + excluded.n", (day, channel, n))
                if uid is None or self.blocked(uid):
                    continue
                known = db.execute("SELECT 1 FROM d_msgs WHERE day = ? AND channel = ? AND uid = ?",
                                   (day, channel, uid)).fetchone()
                if known is None and self._count_in(db, "SELECT COUNT(*) FROM d_msgs WHERE day = ?", (day,)) \
                        >= DISCORD_ACTIVITY_MSG_ROWS_PER_DAY:
                    continue
                db.execute("INSERT INTO d_msgs(day, channel, uid, n) VALUES(?, ?, ?, ?) ON CONFLICT(day, channel, uid)"
                           " DO UPDATE SET n = n + excluded.n", (day, channel, uid, n))

        self.discord_write(write)

    @staticmethod
    def _count_in(db: sqlite3.Connection, sql: str, args: tuple) -> int:
        return db.execute(sql, args).fetchone()[0]

    def note_person(self, uid: str, *, name: str | None = None, avatar: str | None = None,
                    roles: list[str] | None = None, joined: int | None = None, present: bool | None = None,
                    checked: bool = False, at: int | None = None, soft: bool = False) -> list[tuple[str, str | None]]:
        """What our server says of someone (each given field), with the changes since last time written as Discord
        events: "join", "leave", "role+" and "role-" (by role name). The changes, as (kind, arg). `soft`: the name
        and avatar only fill what is missing (a message's author says less than the member's own row)."""
        if not SNOWFLAKE.fullmatch(uid or "") or self.blocked(uid):
            return []
        now = at if at is not None else self.now()
        changes: list[tuple[str, str | None]] = []

        def write(db: sqlite3.Connection) -> None:
            was = db.execute("SELECT roles, present, name, avatar FROM d_people WHERE uid = ?", (uid,)).fetchone()
            keep_name = keep_avatar = False
            if was is None:
                db.execute("INSERT INTO d_people(uid, seen) VALUES(?, ?)", (uid, now))
                old_roles, old_present = None, None
            else:
                keep_name, keep_avatar = soft and was[2] is not None, soft and was[3] is not None
                old_roles = json.loads(was[0]) if was[0] else None
                old_present = None if was[1] is None else bool(was[1])
            if present is not None and old_present is not None and present != old_present:
                changes.append(("join" if present else "leave", None))
            if roles is not None and old_roles is not None:
                changes.extend(("role+", r) for r in sorted(set(roles) - set(old_roles)))
                changes.extend(("role-", r) for r in sorted(set(old_roles) - set(roles)))
            fields = {"seen": now}
            if name is not None and not keep_name:
                fields["name"] = clean_name(name)
            if avatar is not None and not keep_avatar:
                fields["avatar"] = avatar
            if roles is not None:
                fields["roles"] = json.dumps(sorted(roles)[:50])
            if joined is not None:
                fields["joined"] = joined
            if present is not None:
                fields["present"] = int(present)
            if checked:
                fields["checked"] = now
            sets = ", ".join(f"{k} = ?" for k in fields)
            db.execute(f"UPDATE d_people SET {sets} WHERE uid = ?", (*fields.values(), uid))  # noqa: S608
            for kind, arg in changes:
                db.execute("INSERT INTO d_events(ts, uid, kind, arg) VALUES(?, ?, ?, ?)", (now, uid, kind, arg))

        self.discord_write(write)
        return changes

    def note_join_message(self, uid: str, ts: int, name: str | None = None, avatar: str | None = None) -> None:
        """Someone joined our server, as its welcome message says (`ts` from the message itself)."""
        if not SNOWFLAKE.fullmatch(uid or "") or self.blocked(uid):
            return

        def write(db: sqlite3.Connection) -> None:
            if db.execute("SELECT 1 FROM d_events WHERE uid = ? AND kind = 'join' AND ts = ?", (uid, ts)).fetchone():
                return
            db.execute("INSERT INTO d_events(ts, uid, kind, arg) VALUES(?, ?, 'join', NULL)", (ts, uid))
            db.execute("INSERT INTO d_people(uid, name, avatar, joined, seen) VALUES(?, ?, ?, ?, ?) ON CONFLICT(uid)"
                       " DO UPDATE SET name = COALESCE(excluded.name, name), avatar = COALESCE(excluded.avatar, avatar),"
                       " joined = COALESCE(joined, excluded.joined), seen = MAX(seen, excluded.seen)",
                       (uid, clean_name(name), avatar, ts, max(ts, self.now())))

        self.discord_write(write)

    def note_post(self, message_id: str, channel: str, ts: int, title: str | None, reactions: int,
                  top: str | None) -> None:
        """One of the bot's posts, with its reactions now."""
        if not SNOWFLAKE.fullmatch(message_id or ""):
            return

        def write(db: sqlite3.Connection) -> None:
            db.execute("INSERT INTO d_posts(id, channel, ts, title, reactions, top) VALUES(?, ?, ?, ?, ?, ?)"
                       " ON CONFLICT(id) DO UPDATE SET reactions = excluded.reactions, top = excluded.top,"
                       " title = COALESCE(excluded.title, title)",
                       (message_id, channel, ts, (title or "")[:_TITLE_MAX] or None, max(0, int(reactions)),
                        (top or "")[:40] or None))

        self.discord_write(write)

    def cursor(self, channel_id: str) -> str | None:
        with self._db_lock:
            found = self._db.execute("SELECT last_id FROM d_cursors WHERE channel = ?", (channel_id,)).fetchone()
        return found[0] if found else None

    def set_cursor(self, channel_id: str, last_id: str) -> None:
        self.discord_write(lambda db: db.execute(
            "INSERT INTO d_cursors(channel, last_id, at) VALUES(?, ?, ?) ON CONFLICT(channel) DO UPDATE SET"
            " last_id = excluded.last_id, at = excluded.at", (channel_id, last_id, self.now())))

    def set_status(self, values: dict) -> None:
        self.discord_write(lambda db: [db.execute(
            "INSERT INTO d_status(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value))) for key, value in values.items()])

    def site_members_to_check(self, limit: int) -> list[str]:
        """The members seen on the site, the longest unchecked in our server first (none who erased their data)."""
        with self._db_lock:
            rows = self._db.execute(
                "SELECT m.uid FROM members m LEFT JOIN d_people p ON p.uid = m.uid"
                " WHERE m.uid NOT IN (SELECT uid FROM erased) ORDER BY COALESCE(p.checked, 0), m.last DESC LIMIT ?",
                (limit,)).fetchall()
        return [r[0] for r in rows]

    # -- reading (the admin panel) -----------------------------------------------------------------------------------

    def read(self, sql: str, args: Iterable = ()) -> list[tuple]:
        """Rows of a query of our own (advisor/activity_report.py), under the lock."""
        with self._db_lock:
            return self._db.execute(sql, tuple(args)).fetchall()

    def size_bytes(self) -> int:
        if self._path is None:
            return 0
        return sum(os.path.getsize(p) for p in (f"{self._path}", f"{self._path}-wal") if os.path.exists(p))


def _chunks(items: list, size: int) -> Iterable[list]:
    for at in range(0, len(items), size):
        yield items[at:at + size]


def run_writer(activity: ActivityLog, stop: threading.Event, every_s: float = ACTIVITY_FLUSH_S) -> None:
    """Stores what waits every `every_s` seconds until `stop` is set (the server flushes once more on shutdown)."""
    while not stop.wait(every_s):
        try:
            activity.flush()
        except Exception:  # noqa: BLE001 - the thread must outlive any one bad write
            log.exception("activity flush failed")
