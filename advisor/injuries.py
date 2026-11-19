"""Who is hurt: ESPN's public injury list, read by our own server for the leagues whose rosters give an exact id.
A hurt player's headshot carries the same ESPN athlete id as the roster's (see `photos`), so a deal's player is
joined to the list by that id and never by a name two athletes may share. A name ESPN does not list says nothing
about health (it is "no note", never "healthy"), a status we do not know is not guessed at, and a list that could not
be refreshed for `INJURY_MAX_AGE_S` stops speaking: an old injury is not news.
Every request goes through `_get`: https only, to the hosts of `PHOTO_HOSTS` only, no redirect followed, with a
timeout and a size cap; the request names a league and nothing else. Nothing here raises into a request.
"""
import json
import logging
import re
import threading
import time
import zlib
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from typing import Any
from urllib.request import Request

from advisor.photos import _OPENER as _NO_REDIRECT_OPENER
from advisor.photos import allowed, espn_id_of
from advisor.rules import (
    INJURY_MAX_AGE_S,
    INJURY_MAX_BYTES,
    INJURY_PATHS,
    INJURY_RETRY_S,
    INJURY_TIMEOUT_S,
    INJURY_TTL_S,
    PHOTO_ESPN_API,
    PHOTO_USER_AGENT,
)

log = logging.getLogger(__name__)

_OPENER = _NO_REDIRECT_OPENER
_CHUNK = 64 * 1024
# What ESPN calls it -> our word, strictest first. A status not here is not shown.
_STATUS = {
    "Out": "out",
    "Injured Reserve": "out",
    "Suspension": "suspended",
    "Doubtful": "doubtful",
    "Questionable": "questionable",
    "Day-To-Day": "day",
}
_SEVERITY = {word: rank for rank, word in enumerate(["out", "suspended", "doubtful", "questionable", "day"])}
_UNKNOWN_SEEN: set[str] = set()  # the statuses ESPN used that we do not map, each logged once
_PART = re.compile(r"[A-Za-z][A-Za-z ,'-]{0,23}")

# What asks the network: (url, most bytes) -> (body, content type), or None for any failure.
Getter = Callable[[str, int], tuple[bytes, str] | None]


@dataclass(frozen=True)
class Injury:
    status: str  # out, suspended, doubtful, questionable or day
    part: str | None  # what hurts, in plain words ("Knee"), when ESPN says
    back: str | None  # the day ESPN expects them back, "YYYY-MM-DD", when it says

    def as_json(self) -> dict[str, str | None]:
        return {"status": self.status, "part": self.part, "back": self.back}


_LABEL = {"out": "Out", "suspended": "Suspended", "doubtful": "Doubtful", "questionable": "Questionable", "day": "Day-to-day"}


def injury_words(note: Any) -> tuple[str, str] | None:
    """(label, line) for a served injury note, in plain English ("Out", "Out · knee · back about Nov 18"), or None
    when it is not a note we understand: no status, an unknown one, or not a dict. What hurts and the day back are kept
    only when they are plain words and a real day. Mirrors the page's `injuryWords`."""
    status = note.get("status") if isinstance(note, dict) else None
    label = _LABEL.get(status) if isinstance(status, str) else None
    if label is None:
        return None
    part, back = _part(note.get("part")), _day(note.get("back"))
    parts = [label, part.lower() if part else None, f"back about {date.fromisoformat(back):%b} {date.fromisoformat(back).day}" if back else None]
    return label, " · ".join(p for p in parts if p)


BENCHED = frozenset({"out", "suspended", "doubtful"})


def benched(injury: Any) -> bool:
    """Whether a served injury note (the dict a snapshot carries, or None) says the player most likely misses the next
    game: out, suspended or doubtful. The level that wants the safest deals does not show such a deal: a price that far
    under the usual one is often the injury, and the usual price is from before it. No note is not benched."""
    status = injury.get("status") if isinstance(injury, dict) else None
    return isinstance(status, str) and status in BENCHED  # a status that is no word (a list...) is no note


def _day(value: Any) -> str | None:
    """A real calendar day, "YYYY-MM-DD", or None."""
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}.*", value):
        return None
    try:
        return date.fromisoformat(value[:10]).isoformat()
    except ValueError:
        return None


def _part(value: Any) -> str | None:
    """A body part in plain words ("Left Ankle"), or None."""
    text = value.strip() if isinstance(value, str) else ""
    return text if _PART.fullmatch(text) else None


def parse(payload: Any) -> dict[str, Injury]:
    """The hurt players of one league's payload by ESPN athlete id. Players listed as active (they only tell two of
    one name apart), a status we do not know, and a row with no headshot id are left out; one listed twice keeps its
    strictest status. Anything that is not the shape ESPN sends gives nothing."""
    found: dict[str, Injury] = {}
    groups = payload.get("injuries") if isinstance(payload, dict) else None
    for group in groups if isinstance(groups, list) else []:
        rows = group.get("injuries") if isinstance(group, dict) else None
        for item in rows if isinstance(rows, list) else []:
            if not isinstance(item, dict):
                continue
            athlete = item.get("athlete")
            headshot = athlete.get("headshot") if isinstance(athlete, dict) else None
            href = headshot.get("href") if isinstance(headshot, dict) else headshot
            raw = item.get("status")
            athlete_id, status = espn_id_of(href), _STATUS.get(raw) if isinstance(raw, str) else None
            if status is None and isinstance(raw, str) and raw not in ("", "Active") and raw not in _UNKNOWN_SEEN:
                _UNKNOWN_SEEN.add(raw)  # not shown, but never silent: this is how the vocabulary is learned
                log.info("injury status %r is not mapped, so those players show no note", raw)
            if athlete_id is None or status is None:
                continue
            details = item.get("details")
            details = details if isinstance(details, dict) else {}
            injury = Injury(status, _part(details.get("type")), _day(details.get("returnDate")))
            known = found.get(athlete_id)
            if known is None or _SEVERITY[injury.status] < _SEVERITY[known.status]:
                found[athlete_id] = injury
    return found


def _get(url: str, max_bytes: int = INJURY_MAX_BYTES) -> tuple[bytes, str] | None:
    """The body and content type of a 200 answer from an allowed host, or None: another host, a redirect, an error,
    more than `max_bytes` once decoded, or longer than `INJURY_TIMEOUT_S` in all. Asks for gzip: the list is mostly
    team logos, and shrinks about tenfold."""
    if not allowed(url):
        log.warning("injury request refused: %s is not an allowed host", url.split("/")[2] if "//" in url else "?")
        return None
    request = Request(url, headers={"User-Agent": PHOTO_USER_AGENT, "Accept": "application/json", "Accept-Encoding": "gzip"})
    deadline = time.monotonic() + INJURY_TIMEOUT_S
    try:
        with _OPENER.open(request, timeout=INJURY_TIMEOUT_S) as response:
            if response.status != 200:
                return None
            squeezed = response.headers.get("Content-Encoding", "").lower() == "gzip"
            inflate = zlib.decompressobj(16 + zlib.MAX_WBITS) if squeezed else None
            body = bytearray()
            while chunk := response.read(_CHUNK):
                body += inflate.decompress(chunk, max_bytes + 1 - len(body)) if inflate else chunk
                if len(body) > max_bytes or time.monotonic() > deadline:
                    return None
            return bytes(body), response.headers.get_content_type()
    except Exception as error:  # noqa: BLE001 - any failure out there is "no list", never an error in a request
        log.info("injury request failed (%s)", error.__class__.__name__)
        return None


class InjuryBoard:
    """The hurt players of each covered league, as of their last good read.
    `refresh` reads every league that is due (one read per league per `INJURY_TTL_S`, a failed one retried after
    `INJURY_RETRY_S`) and keeps the last good list when a read fails; call it from one background thread.
    `lookup` and `sports` are safe from any thread and speak only for a list read within `INJURY_MAX_AGE_S`."""

    def __init__(self, get: Getter | None = None, clock: Callable[[], float] = time.time):
        self._get = _get if get is None else get
        self._clock = clock
        self._lock = threading.Lock()
        self._lists: dict[str, dict[str, Injury]] = {}  # sport -> hurt players, from the last good read
        self._good_at: dict[str, float] = {}  # sport -> when that read was made
        self._next_at: dict[str, float] = {}  # sport -> the earliest moment to read it again

    def refresh(self) -> None:
        for sport, path in INJURY_PATHS.items():
            now = self._clock()
            if now < self._next_at.get(sport, 0.0):
                continue
            hurt = self._read(f"{PHOTO_ESPN_API}{path}/injuries")
            with self._lock:
                if hurt is None:
                    self._next_at[sport] = now + INJURY_RETRY_S
                else:
                    self._lists[sport], self._good_at[sport], self._next_at[sport] = hurt, now, now + INJURY_TTL_S

    def _read(self, url: str) -> dict[str, Injury] | None:
        try:
            got = self._get(url, INJURY_MAX_BYTES)
            data = json.loads(got[0]) if got is not None else None
            if not isinstance(data, dict) or not isinstance(data.get("injuries"), list):
                return None  # valid JSON of another shape (an error page) is no list either
            return parse(data)
        except Exception:  # noqa: BLE001 - not JSON, not readable, or a row we cannot read: no list, retried later
            log.info("injury list unreadable for %s", url.rsplit("/", 2)[-2])
            return None

    def _fresh(self, sport: str) -> bool:
        good_at = self._good_at.get(sport)
        return good_at is not None and self._clock() - good_at <= INJURY_MAX_AGE_S

    def sports(self) -> list[str]:
        """The leagues whose list is fresh enough to speak for them."""
        with self._lock:
            return [sport for sport in self._lists if self._fresh(sport)]

    def lookup(self, sport: str, espn_id: str | None) -> Injury | None:
        """What ESPN says about this athlete, or None: no note, an unknown league, or a list too old to trust."""
        if espn_id is None:
            return None
        with self._lock:
            return self._lists[sport].get(espn_id) if sport in self._lists and self._fresh(sport) else None


class InjuryView:
    """What a snapshot asks: for a deal's player (sport, name as the live feed writes it), what ESPN says, as the page
    reads it; and the sports whose list is fresh enough to speak. `photos` joins a name to the ESPN athlete id (see
    `PhotoStore.espn_id`). Never raises: a snapshot must not depend on a third party."""

    def __init__(self, board: InjuryBoard, photos: Any):
        self._board = board
        self._photos = photos

    def of(self, sport: str, player_id: int, name: str, position: str | None = None) -> dict[str, str | None] | None:
        try:
            injury = self._board.lookup(sport, self._photos.espn_id(sport, name, position))
        except Exception:  # noqa: BLE001 - a note we cannot make is no note
            log.exception("injury lookup failed for %s %s", sport, player_id)
            return None
        return None if injury is None else injury.as_json()

    def sports(self) -> list[str]:
        """The sports it can speak for: a fresh list AND a roster map to join a deal's player to it. Right after a
        restart the maps can take a minute to build: the page then claims nothing it cannot do."""
        try:
            return [sport for sport in self._board.sports() if self._photos.has_map(sport)]
        except Exception:  # noqa: BLE001 - see `of`
            log.exception("injury sports failed")
            return []


def run_injuries(
    board: Any, stop: threading.Event, every_s: float = 60.0, wait: Callable[[float], bool] | None = None
) -> None:
    """Keeps `board` fresh until `stop` is set: it asks the board to refresh every `every_s` seconds (the board
    itself reads a league only when its list is due, see `InjuryBoard.refresh`). An error never ends the loop."""
    wait = stop.wait if wait is None else wait
    while True:
        try:
            board.refresh()
        except Exception:  # noqa: BLE001 - a third party's list must not stop its own refresh
            log.exception("injury refresh failed")
        if wait(every_s):
            return
