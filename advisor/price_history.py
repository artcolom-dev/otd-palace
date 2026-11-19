"""The price curve's memory: for each market and each finished day, the day's middle sale and how many sales it had.

The sales tape holds a week (advisor/sources/memory.py), so a curve longer than that has to be remembered day by day.
A market is a price move's own (advisor/moves.py): sport, season, player and value bucket, and a day's figure is the
median sale price in Rax, the figure Prices already shows for "today" and for "the last 7 days". A day is a UTC day.

What is kept, and what never is:

- Only a finished day (before the UTC day of the round's moment) is learned: today is still being sold.
- A day counts only with PRICE_CURVE_MIN_SALES sales or more. Fewer is no figure at all: the curve has a gap there,
  never a guess, and nothing is filled in between two days or before the first day seen.
- A day is read again every round while the tape holds it, and the reading with the most sales wins: late sales
  improve it, and a tape thinned to its newest sales (the feed memory, when full) never weakens it.
- A day older than PRICE_CURVE_DAYS is dropped. Past `max_rows` day figures in all, the oldest days go first.

The file (`path`, when given) is written at most every `save_every` and once more by `flush` when the server stops.
An unreadable file is moved aside to `<name>.corrupt` and the history starts empty, a row that no longer fits is
dropped: either way the curve is only shorter, never wrong.
"""

import json
import logging
import math
import os
import statistics
import tempfile
import threading
from collections import defaultdict
from collections.abc import Iterable
from datetime import datetime, timedelta, timezone
from pathlib import Path

from advisor.model import Sale
from advisor.rules import PRICE_CURVE_DAYS, PRICE_CURVE_MIN_SALES, PRICE_HISTORY_MAX_ROWS, PRICE_HISTORY_SAVE_EVERY

log = logging.getLogger(__name__)

FILE_VERSION = 1

# A market, as a price move names it: (sport, season, player_id, bucket).
MarketKey = tuple[str, int, int, str]


def _day(moment: datetime) -> int:
    """The UTC day of `moment`, as a day number (date.toordinal)."""
    return moment.astimezone(timezone.utc).date().toordinal()


def _whole(value: object, low: int, high: float = math.inf) -> bool:
    return type(value) is int and low <= value <= high


class PriceHistory:
    def __init__(
        self,
        path: Path | None,
        *,
        days: int = PRICE_CURVE_DAYS,
        min_sales: int = PRICE_CURVE_MIN_SALES,
        max_rows: int = PRICE_HISTORY_MAX_ROWS,
        save_every: timedelta = PRICE_HISTORY_SAVE_EVERY,
    ):
        self.path = path
        self._keep_days = days
        self._min_sales = min_sales
        self._max_rows = max_rows
        self._save_every = save_every
        self._markets: dict[MarketKey, dict[int, tuple[int, int]]] = {}  # market -> day -> (middle sale, sales)
        self._changed = False  # learned something the file does not hold yet
        self._saved_at: datetime | None = None
        self._lock = threading.Lock()  # learn and series run in the collector's thread, flush in the one that stops
        if path is not None:
            self._load(path)

    @property
    def rows(self) -> int:
        """How many day figures are held, over every market."""
        with self._lock:
            return sum(len(days) for days in self._markets.values())

    def learn(self, sales: Iterable[Sale], now: datetime) -> None:
        """Reads every finished day `sales` holds (see the module's docstring), then forgets what is too old."""
        with self._lock:
            today = _day(now)
            oldest = today - self._keep_days
            by_day: dict[tuple[MarketKey, int], list[int]] = defaultdict(list)
            for sale in sales:
                day = _day(sale.sold_at)
                if oldest <= day < today and sale.sold_at <= now:
                    by_day[((sale.sport, sale.season, sale.player_id, sale.bucket), day)].append(sale.price)
            for (key, day), prices in by_day.items():
                if len(prices) < self._min_sales:
                    continue
                known = self._markets.get(key, {}).get(day)
                reading = (round(statistics.median(prices)), len(prices))
                if reading[0] > 0 and (known is None or reading[1] >= known[1]) and reading != known:
                    self._markets.setdefault(key, {})[day] = reading
                    self._changed = True
            self._forget(oldest)
            if self.path is not None and self._changed and (
                self._saved_at is None or now - self._saved_at >= self._save_every
            ):
                self._save(self.path, now)

    def series(self, key: MarketKey, now: datetime) -> list[list[int]]:
        """The market's finished days of the last PRICE_CURVE_DAYS, oldest first, as [days ago, middle sale, sales].
        Days ago counts from the UTC day of `now` (yesterday is 1). A day without a figure is simply not there."""
        with self._lock:
            today = _day(now)
            days = self._markets.get(key, {})
            return [[today - day, *days[day]] for day in sorted(days) if 1 <= today - day <= self._keep_days]

    def flush(self) -> None:
        """Writes the history now if it learned anything since it was last written (the server stopping)."""
        with self._lock:
            if self.path is not None and self._changed:
                self._save(self.path, self._saved_at or datetime.now(timezone.utc))

    def _forget(self, oldest: int) -> None:
        for key in list(self._markets):
            days = self._markets[key]
            for day in [day for day in days if day < oldest]:
                del days[day]
                self._changed = True
            if not days:
                del self._markets[key]
        rows = sum(len(days) for days in self._markets.values())
        if rows <= self._max_rows:
            return
        # Too many: whole days go, the oldest first; a single day too big keeps its markets with the most sales.
        for day in sorted({day for days in self._markets.values() for day in days})[:-1]:
            for key in list(self._markets):
                if self._markets[key].pop(day, None) is not None:
                    rows -= 1
                if not self._markets[key]:
                    del self._markets[key]
            self._changed = True
            if rows <= self._max_rows:
                return
        ranked = sorted(((reading[1], key, day) for key, days in self._markets.items() for day, reading in days.items()),
                        reverse=True)
        for _sales, key, day in ranked[self._max_rows:]:
            del self._markets[key][day]
            if not self._markets[key]:
                del self._markets[key]
        self._changed = True

    # -- the file -------------------------------------------------------------------------------------------------
    def _load(self, path: Path) -> None:
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return
        except OSError as error:
            log.warning("the price history in %s could not be read: %s", path, error)
            return
        try:
            data = json.loads(text)
            markets = data["markets"]
            if data.get("version") != FILE_VERSION or not isinstance(markets, list):
                raise ValueError("not a price history")
        except (ValueError, TypeError, KeyError):
            _set_aside(path)
            return
        dropped = 0
        for row in markets:
            try:
                sport, season, player_id, bucket, days = row
                if not (isinstance(sport, str) and isinstance(bucket, str) and _whole(season, 0) and _whole(player_id, 0)
                        and isinstance(days, list)):
                    raise ValueError("not a market")
            except (TypeError, ValueError):
                dropped += 1
                continue
            for point in days:
                if (isinstance(point, list) and len(point) == 3 and _whole(point[0], 1, 10**7)
                        and _whole(point[1], 1, 10**9) and _whole(point[2], 1, 10**7)):
                    self._markets.setdefault((sport, season, player_id, bucket), {})[point[0]] = (point[1], point[2])
                else:
                    dropped += 1
        if dropped:
            log.warning("%d remembered price history rows no longer fit and were dropped", dropped)

    def _save(self, path: Path, now: datetime) -> None:
        self._saved_at = now
        self._changed = False
        data = {
            "version": FILE_VERSION,
            "markets": [[*key, [[day, *reading] for day, reading in sorted(days.items())]]
                        for key, days in sorted(self._markets.items())],
        }
        tmp_name = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False
            ) as tmp:
                tmp_name = tmp.name
                json.dump(data, tmp, separators=(",", ":"))
                tmp.flush()
                os.fsync(tmp.fileno())
            os.replace(tmp_name, path)
        except OSError as error:
            log.warning("the price history could not be written to %s: %s", path, error)
            self._changed = True  # still to be written: tried again after `save_every`, and by flush
            if tmp_name is not None:
                try:
                    os.unlink(tmp_name)
                except OSError:
                    pass


def _set_aside(path: Path) -> None:
    """Move an unreadable history file to `<name>.corrupt`, so it is kept and not written over."""
    aside = path.with_name(path.name + ".corrupt")
    try:
        os.replace(path, aside)
    except OSError as error:
        log.warning("the unreadable price history %s could not be moved to %s: %s", path, aside, error)
    else:
        log.warning("the unreadable price history was moved to %s", aside)
