"""What the live feed already said that stays true after the feed forgets it.

The feed's producer keeps its sales and fair values in memory, so a restart of the producer sends documents with
none for a while, and every deal judged on them would go away until it has read them again. A sale is a fact: one
the feed sent stays a sale until it leaves the sales window, whatever later documents leave out. A fair value is
Real's own read of a card's market, sent without a time: it is held for `fmv_hold` after the last document that
carried it, the time the producer itself keeps one.

Listings, pass markets and coverage are never remembered: they describe the market of the moment.

The memory is written to `path` (when given) at most every `save_every`, and once more by `flush` when the server stops
(so what was learned since the last write is not lost), so it also outlives a restart of the site;
an unreadable file is moved aside to `<name>.corrupt` and the memory starts empty, and a remembered row that no longer
fits the model is dropped.
"""

import json
import logging
import os
import tempfile
import threading
from dataclasses import asdict, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

from advisor.model import Fmv, RawData, Sale
from advisor.rules import (
    FEED_MEMORY_FMV_HOLD,
    FEED_MEMORY_MAX_SALES,
    FEED_MEMORY_SAVE_EVERY,
    MOVES_RECENT_H,
    SALES_WINDOW_DAYS,
)

log = logging.getLogger(__name__)

# Two documents count a sale's age from different seconds, so one sale can come back a second or two off.
SAME_SALE_WITHIN = timedelta(seconds=5)
FILE_VERSION = 1

SaleKey = tuple[str, int, int, int, str, int]


def _key(sale: Sale) -> SaleKey:
    return (sale.sport, sale.season, sale.player_id, sale.card_id, sale.bucket, sale.price)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat()


class FeedMemory:
    def __init__(
        self,
        path: Path | None,
        *,
        save_every: timedelta = FEED_MEMORY_SAVE_EVERY,
        fmv_hold: timedelta = FEED_MEMORY_FMV_HOLD,
        max_sales: int = FEED_MEMORY_MAX_SALES,
    ):
        self.path = path
        self._save_every = save_every
        self._fmv_hold = fmv_hold
        self._max_sales = max_sales
        self._sales: dict[SaleKey, list[Sale]] = {}
        self._fmv: dict[int, tuple[Fmv, datetime]] = {}  # card id -> (fair value, last document that carried it)
        self._saved_at: datetime | None = None
        self._learned_at: datetime | None = None  # the moment of the last document merged
        self._lock = threading.Lock()  # merge runs in the collector's thread, flush in the one that stops the server
        self._thinned_to: int | None = None  # the last per-market limit the memory was thinned to, for the log
        if path is not None:
            self._load(path)

    def merge(self, raw: RawData) -> RawData:
        """`raw` with every sale and fair value the memory still holds; the memory learns what `raw` says first."""
        with self._lock:
            return self._merge(raw)

    def flush(self) -> None:
        """Writes the memory now if it learned anything since it was last written (the server stopping)."""
        with self._lock:
            if self.path is not None and self._learned_at is not None and self._learned_at != self._saved_at:
                self._save(self.path, self._learned_at)

    def _merge(self, raw: RawData) -> RawData:
        now = raw.fetched_at
        self._learned_at = now
        window_h = (raw.coverage or {}).get("sales_window_h")
        window = timedelta(hours=window_h) if isinstance(window_h, int) else timedelta(days=SALES_WINDOW_DAYS)
        for sale in raw.sales:
            self._add_sale(sale)
        for card_id, fmv in raw.fmv.items():
            self._fmv[card_id] = (fmv, now)
        self._forget(now - window, now - self._fmv_hold, now - timedelta(hours=MOVES_RECENT_H))
        if self.path is not None and (self._saved_at is None or now - self._saved_at >= self._save_every):
            self._save(self.path, now)
        sales = sorted((sale for same in self._sales.values() for sale in same), key=lambda s: s.sold_at, reverse=True)
        return replace(raw, sales=tuple(sales), fmv={card_id: fmv for card_id, (fmv, _) in self._fmv.items()})

    def _add_sale(self, sale: Sale) -> None:
        same = self._sales.setdefault(_key(sale), [])
        if not any(abs(known.sold_at - sale.sold_at) <= SAME_SALE_WITHIN for known in same):
            same.append(sale)

    def _forget(self, sales_before: datetime, fmv_before: datetime, today_from: datetime) -> None:
        for key in list(self._sales):
            kept = [sale for sale in self._sales[key] if sale.sold_at >= sales_before]
            if kept:
                self._sales[key] = kept
            else:
                del self._sales[key]
        if sum(len(same) for same in self._sales.values()) > self._max_sales:
            self._thin(today_from)
        for card_id in [card_id for card_id, (_, seen) in self._fmv.items() if seen < fmv_before]:
            del self._fmv[card_id]

    def _thin(self, today_from: datetime) -> None:
        """Back under `max_sales`, the busiest markets first: each market (sport, season, player, value bucket) keeps
        its newest sales of today and, apart, its newest of the days before, the same number L for all, the largest L
        that fits. A quiet market keeps everything, and the week a price move is measured against is never emptied
        for today's rush (dropping the oldest first did exactly that). With more markets than room, the newest go on."""
        halves: dict[tuple, list[Sale]] = {}
        for same in self._sales.values():
            for sale in same:
                half = (sale.sport, sale.season, sale.player_id, sale.bucket, sale.sold_at >= today_from)
                halves.setdefault(half, []).append(sale)
        sizes = sorted(len(group) for group in halves.values())
        level, used = 0, 0  # the largest L with sum(min(size, L)) <= max_sales
        for i, size in enumerate(sizes):
            room = (self._max_sales - used) // (len(sizes) - i)
            if room < size:
                level = room
                break
            used += size
        else:
            return
        if level == 0:
            every = sorted((sale for same in self._sales.values() for sale in same), key=lambda s: s.sold_at)
            keep = set(map(id, every[len(every) - self._max_sales:]))
        else:
            keep = {id(sale) for group in halves.values()
                    for sale in sorted(group, key=lambda s: s.sold_at, reverse=True)[:level]}
        for key in list(self._sales):
            kept = [sale for sale in self._sales[key] if id(sale) in keep]
            if kept:
                self._sales[key] = kept
            else:
                del self._sales[key]
        if level != self._thinned_to:  # said once per change, not at every document
            self._thinned_to = level
            log.info("the feed memory is full: each market keeps its newest %d sales of today and %d before", level, level)

    # -- the file -------------------------------------------------------------------------------------------------
    def _load(self, path: Path) -> None:
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return
        except OSError as error:
            log.warning("the feed memory in %s could not be read: %s", path, error)
            return
        try:
            data = json.loads(text)
            sales, fmv = data["sales"], data["fmv"]
            if data.get("version") != FILE_VERSION or not isinstance(sales, list) or not isinstance(fmv, list):
                raise ValueError("not a feed memory")
        except (ValueError, TypeError, KeyError):
            _set_aside(path)
            return
        dropped = 0
        for row in sales:
            try:
                fields = {**row, "sold_at": datetime.fromisoformat(row["sold_at"])}
                sale = Sale(**fields)
                if sale.sold_at.tzinfo is None:
                    raise ValueError("no zone")
            except (TypeError, ValueError, KeyError):
                dropped += 1
                continue
            self._add_sale(sale)
        for row in fmv:
            try:
                seen = datetime.fromisoformat(row.pop("seen_at"))
                value = Fmv(**row)
                if seen.tzinfo is None or type(value.card_id) is not int:
                    raise ValueError("no zone")
            except (AttributeError, TypeError, ValueError, KeyError):
                dropped += 1
                continue
            self._fmv[value.card_id] = (value, seen)
        if dropped:
            log.warning("%d remembered feed rows no longer fit and were dropped", dropped)

    def _save(self, path: Path, now: datetime) -> None:
        self._saved_at = now
        data = {
            "version": FILE_VERSION,
            "sales": [{**asdict(sale), "sold_at": _iso(sale.sold_at)} for same in self._sales.values() for sale in same],
            "fmv": [{**asdict(fmv), "seen_at": _iso(seen)} for fmv, seen in self._fmv.values()],
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
            log.warning("the feed memory could not be written to %s: %s", path, error)
            if tmp_name is not None:
                try:
                    os.unlink(tmp_name)
                except OSError:
                    pass


def _set_aside(path: Path) -> None:
    """Move an unreadable memory file to `<name>.corrupt`, so it is kept and not written over."""
    aside = path.with_name(path.name + ".corrupt")
    try:
        os.replace(path, aside)
    except OSError as error:
        log.warning("the unreadable feed memory %s could not be moved to %s: %s", path, aside, error)
    else:
        log.warning("the unreadable feed memory was moved to %s", aside)
