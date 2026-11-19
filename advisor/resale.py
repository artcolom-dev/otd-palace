"""Resale: per player and card-rating band, how many of the recent listings of his cards sold.
The private feed's `GET <ADVISOR_FEED_URL>/resale` (same bearer token) answers `{"version": 2, "generated_at": ...,
"window_days": 30, "min_listed": 20, "min_sources": 3, "bands": [3.0, 6.0, 10.0], "players": {sport: {player id:
{band: [listed, sold]}}}}`: counts only, from card listings that ENDED in the window. A card's band is the number of
edges at or under its rating (a rating below the first edge is band 0), since a player's small cards do not sell like
his big ones. A deal's player is joined by (sport, Real's player id), the id the feed itself names its deals' players
by, and the deal's own card rating picks the band.
The table is read at most once per `RESALE_TTL_S` (a failed read is retried after `RESALE_RETRY_S` and keeps the last
good table); its age counts from when it was BUILT, and one older than `RESALE_MAX_AGE_S` says nothing, as a stale
verdict is worse than none. What is read is checked count by count, and nothing that names the producer is ever kept,
shown or logged: not its address, not its token. Nothing here raises into a request.
"""
import bisect
import json
import logging
import math
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from advisor.injuries import run_injuries as run_resale  # the same loop: refresh every so often until stopped
from advisor.rules import (
    RESALE_MAX_AGE_S,
    RESALE_MAX_BYTES,
    RESALE_MIN_LISTED,
    RESALE_RETRY_S,
    RESALE_TIMEOUT_S,
    RESALE_TTL_S,
)
from advisor.sources.feed import USER_AGENT, FeedError, _http_get

__all__ = ["ResaleBoard", "ResaleView", "Table", "fetch_table", "parse", "run_resale"]

log = logging.getLogger(__name__)

_MAX_ID_DIGITS = 12  # a player id has at most 12 digits (advisor.importer's pass key says the same)
_MAX_BANDS = 8
_FUTURE_SLACK_S = 300  # a table "built" later than this from now was stamped by a wrong clock


def _is_number(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value)  # a bool is not a number here


def _plain_id(text: Any) -> bool:
    """The plain digits of a player id: no sign, no leading zero, at most 12 of them."""
    return isinstance(text, str) and text.isascii() and text.isdigit() and len(text) <= _MAX_ID_DIGITS and str(int(text)) == text


def _count(value: Any) -> tuple[int, int] | None:
    """(listed, sold) when `value` is a clean pair of whole numbers with enough listings, else None."""
    if not (isinstance(value, list) and len(value) == 2):
        return None
    listed, sold = value
    if any(type(n) is not int for n in (listed, sold)):  # a bool or a float is not a count
        return None
    return (listed, sold) if listed >= RESALE_MIN_LISTED and 0 <= sold <= listed else None


@dataclass(frozen=True)
class Table:
    """A checked table: the band edges and the counts by (sport, player id, band)."""

    bands: tuple[float, ...]
    counts: dict[tuple[str, int, int], tuple[int, int]]
    built_at: float | None  # when the producer built it, as an epoch; None when it said nothing usable

    def get(self, sport: str, player_id: int, rating: Any) -> tuple[int, int] | None:
        """(listed, sold) for a card of this rating, or None: no count there, or a rating that is not a number."""
        if not _is_number(rating):
            return None
        return self.counts.get((sport, player_id, bisect.bisect_right(self.bands, rating)))

    def size(self) -> int:
        return len(self.counts)


def _built_at(value: Any) -> float | None:
    try:
        moment = datetime.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        return None
    return moment.timestamp() if moment is not None and moment.tzinfo is not None else None


def parse(document: Any) -> Table:
    """The table in the feed's document. A document that is not ours (not an object, not version 2, bad band edges, no
    players) raises ValueError; an entry that is not a clean count is left out and the rest kept."""
    if not isinstance(document, dict) or type(document.get("version")) is not int or document["version"] != 2:
        raise ValueError("not a resale table")
    edges = document.get("bands")
    if not (isinstance(edges, list) and 1 <= len(edges) <= _MAX_BANDS and all(_is_number(e) and e > 0 for e in edges)):
        raise ValueError("not a resale table")
    if any(a >= b for a, b in zip(edges, edges[1:])) or not isinstance(document.get("players"), dict):
        raise ValueError("not a resale table")
    counts: dict[tuple[str, int, int], tuple[int, int]] = {}
    for sport, players in document["players"].items():
        if not (isinstance(sport, str) and sport.isascii() and sport.isalpha() and sport.islower() and isinstance(players, dict)):
            continue
        for player_id, bands in players.items():
            if not (_plain_id(player_id) and isinstance(bands, dict)):
                continue
            for band, value in bands.items():
                counted = _count(value)
                if isinstance(band, str) and band.isascii() and band.isdigit() and len(band) <= 2 and int(band) <= len(edges) and counted:
                    counts[(sport, int(player_id), int(band))] = counted
    return Table(tuple(float(e) for e in edges), counts, _built_at(document.get("generated_at")))


def fetch_table(feed_url: str, token: str, get: Callable[[str, dict[str, str]], bytes] | None = None) -> dict:
    """The feed's resale document, as sent. Raises FeedError, holding nothing private, on any failure."""
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json", "Accept-Encoding": "gzip",
               "User-Agent": USER_AGENT}
    url = feed_url.rstrip("/") + "/resale"
    reader = get or (lambda u, h: _http_get(u, h, RESALE_TIMEOUT_S, RESALE_MAX_BYTES))
    body = reader(url, headers)
    try:
        return json.loads(body)
    except ValueError:
        raise FeedError("the feed's resale answer is not JSON") from None


class ResaleBoard:
    """The last good table. `refresh` reads it when it is due (call it from one background thread); `lookup`, `fresh`
    are safe from any thread and speak only for a table built within `RESALE_MAX_AGE_S`."""

    def __init__(self, fetch: Callable[[], dict], clock: Callable[[], float] = time.time):
        self._fetch = fetch
        self._clock = clock
        self._lock = threading.Lock()
        self._table: Table | None = None
        self._built_at = 0.0
        self._next_at = 0.0

    def __repr__(self) -> str:
        return "ResaleBoard()"  # neither the address nor the token

    def refresh(self) -> None:
        now = self._clock()
        if now < self._next_at:
            return
        try:
            table = parse(self._fetch())
        except Exception as error:  # noqa: BLE001 - a third party's table must not break us: keep the last good one
            log.info("resale table unreadable (%s)", error.__class__.__name__)
            table = None
        with self._lock:
            if table is None:
                self._next_at = now + RESALE_RETRY_S
                return
            built = table.built_at
            # Age counts from when it was built; a table stamped in the future (a wrong clock) is counted from now.
            self._built_at = now if built is None or built > now + _FUTURE_SLACK_S else min(built, now)
            self._table, self._next_at = table, now + RESALE_TTL_S

    def _current(self) -> Table | None:
        return self._table if self._table is not None and self._clock() - self._built_at <= RESALE_MAX_AGE_S else None

    def fresh(self) -> bool:
        with self._lock:
            return self._current() is not None

    def lookup(self, sport: str, player_id: int, rating: Any) -> tuple[int, int] | None:
        with self._lock:
            table = self._current()
        return None if table is None else table.get(sport, player_id, rating)


class ResaleView:
    """What a snapshot asks: a deal's player and card rating -> his counts as the page reads them, and whether there
    is a table to speak from at all. Never raises."""

    def __init__(self, board: ResaleBoard):
        self._board = board

    def __repr__(self) -> str:
        return "ResaleView()"

    def of(self, sport: str, player_id: int, name: str, rating: Any) -> dict[str, int] | None:
        try:
            counted = self._board.lookup(sport, player_id, rating)
        except Exception:  # noqa: BLE001 - a note we cannot make is no note
            log.exception("resale lookup failed for %s %s", sport, player_id)
            return None
        return None if counted is None else {"listed": counted[0], "sold": counted[1]}

    def available(self) -> bool:
        try:
            return self._board.fresh()
        except Exception:  # noqa: BLE001
            return False
