"""Outbound click counts: how many visitors the site sends to Real, and from where on the page.

A click is counted under its UTC day, the panel it came from, what it opened, the visitor's level and sport
filter, and the row's position. Nothing finer than the day is kept, and nothing about the visitor: no IP
address, user agent, cookie or referrer ever reaches this module.

The counts cannot grow without end: a sport filter only counts when it is one the site offers right now, a day
takes at most CLICK_MAX_KEYS_PER_DAY distinct counts, and days older than CLICK_KEEP_DAYS are dropped.
"""

import json
import logging
import os
import re
import tempfile
import threading
from collections import Counter
from collections.abc import Callable, Collection
from datetime import datetime, timedelta, timezone
from pathlib import Path

from advisor.rules import (
    CLICK_FLUSH_S,
    CLICK_KEEP_DAYS,
    CLICK_MAX_KEYS_PER_DAY,
    CLICK_MAX_POS,
    CLICK_PANELS,
    CLICK_SPORT_FILTERS,
    CLICK_TARGETS,
    LEVELS,
)

_SPORT = re.compile(r"[a-z]{2,12}")
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")
_ROW_KEYS = frozenset({"panel", "target", "level", "sport", "pos", "count"})

log = logging.getLogger(__name__)

# (day "YYYY-MM-DD", panel, target, level, sport, pos)
Key = tuple[str, str, str, str, str, int]


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _day(moment: datetime) -> str:
    """The UTC day of an aware datetime, as "YYYY-MM-DD"."""
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%d")


def _valid(panel: object, target: object, level: object, sport: object, pos: object) -> bool:
    """Whether the fields have the shape of a click the site sends; which sports it offers is checked apart."""
    return (
        isinstance(panel, str) and panel in CLICK_PANELS
        and isinstance(target, str) and target in CLICK_TARGETS
        and isinstance(level, str) and level in LEVELS
        and isinstance(sport, str) and (sport in CLICK_SPORT_FILTERS or _SPORT.fullmatch(sport) is not None)
        and type(pos) is int and 0 <= pos <= CLICK_MAX_POS  # not a bool, not a float
    )


def _set_aside(path: Path) -> None:
    """Move an unreadable count file to `<name>.corrupt`, over any older one, so it is kept and not written over."""
    aside = path.with_name(path.name + ".corrupt")
    try:
        os.replace(path, aside)
    except OSError as error:
        log.warning("unreadable click counts in %s could not be moved to %s: %s", path, aside, error)
    else:
        log.warning("unreadable click counts moved to %s", aside)


def _load(path: Path) -> Counter[Key]:
    """The counts saved in `path`; a missing or unreadable file, or a row that does not check out, counts nothing.

    A file that is not JSON, or not in the expected shape, is set aside as `<name>.corrupt` before starting empty.
    """
    counts: Counter[Key] = Counter()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return counts
    except ValueError as error:  # not JSON, or not UTF-8
        log.warning("click counts in %s could not be read (%s); starting from zero", path, error)
        _set_aside(path)
        return counts
    except OSError as error:
        log.warning("click counts in %s could not be read (%s); starting from zero", path, error)
        return counts
    days = data.get("days") if isinstance(data, dict) else None
    if not isinstance(days, dict):
        log.warning("click counts in %s are not in the expected shape; starting from zero", path)
        _set_aside(path)
        return counts
    for day, rows in days.items():
        if not (isinstance(day, str) and _DAY.fullmatch(day) and isinstance(rows, list)):
            continue
        for row in rows:
            if not (isinstance(row, dict) and set(row) == _ROW_KEYS):
                continue
            fields = (row["panel"], row["target"], row["level"], row["sport"], row["pos"])
            count = row["count"]
            if _valid(*fields) and type(count) is int and count > 0:
                counts[(day, *fields)] += count
    return counts


class ClickLog:
    """Counts outbound clicks and keeps them in a JSON file; safe to use from several web threads at once.

    `clock` returns the current time as an aware datetime; the UTC day of that time is all that is kept.
    A count is written to `path` when it is the first since the log started, or when CLICK_FLUSH_S seconds have
    passed since the last write; `flush()` writes whatever is pending at once.
    """

    def __init__(self, path: Path, clock: Callable[[], datetime] = _utc_now):
        self._path = path
        self._clock = clock
        self._lock = threading.Lock()
        self._counts = _load(path)
        self._keys_per_day: Counter[str] = Counter(key[0] for key in self._counts)
        self._prune(clock())
        self._last_write: datetime | None = None
        self._pending = False

    def record(
        self, panel: object, target: object, level: object, sport: object, pos: object, *,
        known_sports: Collection[str],
    ) -> bool:
        """Count one click; False, and nothing counted, when it is not one the site sends or the day is full.

        `sport` must be one of CLICK_SPORT_FILTERS or one of `known_sports`, the sports the site offers right now.
        A day that holds CLICK_MAX_KEYS_PER_DAY distinct counts takes no new one; the counts it holds still go up.
        """
        if not (_valid(panel, target, level, sport, pos) and (sport in CLICK_SPORT_FILTERS or sport in known_sports)):
            return False
        now = self._clock()
        day = _day(now)
        key = (day, panel, target, level, sport, pos)
        with self._lock:
            if key not in self._counts:
                if self._keys_per_day[day] >= CLICK_MAX_KEYS_PER_DAY:
                    return False
                self._keys_per_day[day] += 1
            self._counts[key] += 1
            self._pending = True
            if self._last_write is None or (now - self._last_write).total_seconds() >= CLICK_FLUSH_S:
                self._write(now)
        return True

    def totals(self) -> dict:
        """Every count, by day, in order: {"days": {day: [{panel, target, level, sport, pos, count}, ...]}}."""
        with self._lock:
            return self._totals()

    def flush(self) -> None:
        """Write the counts not written yet, whatever the time since the last write."""
        with self._lock:
            if self._pending:
                self._write(self._clock())

    def _totals(self) -> dict:
        days: dict[str, list[dict]] = {}
        for (day, panel, target, level, sport, pos), count in sorted(self._counts.items()):
            days.setdefault(day, []).append(
                {"panel": panel, "target": target, "level": level, "sport": sport, "pos": pos, "count": count}
            )
        return {"days": days}

    def _prune(self, now: datetime) -> None:
        """Drop the counts of the days more than CLICK_KEEP_DAYS days before `now`'s UTC day."""
        oldest = _day(now - timedelta(days=CLICK_KEEP_DAYS))  # "YYYY-MM-DD" strings sort like the days they name
        for key in [key for key in self._counts if key[0] < oldest]:
            del self._counts[key]
        for day in [day for day in self._keys_per_day if day < oldest]:
            del self._keys_per_day[day]

    def _write(self, now: datetime) -> None:
        """Drop the days too old to keep, then write every count to a temporary file next to `path` and rename it
        over `path`; called under the lock.

        A failed write is logged and leaves the last good file in place; the counts stay pending for the next one.
        """
        self._prune(now)
        self._last_write = now
        tmp_name = None
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                "w", encoding="utf-8", dir=self._path.parent, prefix=f".{self._path.name}.", suffix=".tmp", delete=False
            ) as tmp:
                tmp_name = tmp.name
                json.dump(self._totals(), tmp, separators=(",", ":"))
                tmp.flush()
                os.fsync(tmp.fileno())
            os.replace(tmp_name, self._path)
        except OSError as error:
            log.warning("click counts could not be written to %s: %s", self._path, error)
            if tmp_name is not None:
                try:
                    os.unlink(tmp_name)
                except OSError:
                    pass
            return
        self._pending = False
