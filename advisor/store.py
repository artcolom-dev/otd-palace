"""The latest snapshot, ready to serve: its bytes (plain and gzipped, whole and without its passes, for members and for
the free site's visitors), its ETags and how fresh it is."""

import gzip
import json
import logging
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from datetime import datetime

from advisor.public import PUBLIC_TAG, bare_snapshot, public_snapshot
from advisor.rules import GZIP_LEVEL, SHARE_ENDED_KEEP, STALE_AFTER_S

log = logging.getLogger(__name__)

ENDED_KEEP = SHARE_ENDED_KEEP  # deals that went away remembered at most (see `SnapshotStore.ended`)
GZIP_TAG = "-gz"  # what tells the gzipped body's ETag from the plain one's: "7" and "7-gz"


def compress(body: bytes, level: int = GZIP_LEVEL) -> bytes:
    """`body` gzipped at `level`; the same body always gives the same bytes (no timestamp in the header)."""
    return gzip.compress(body, compresslevel=level, mtime=0)


def etags(version: object) -> tuple[str, str]:
    """The ETags of one snapshot version, quoted: its plain body's and its gzipped body's. A strong validator must
    differ by content coding, or a cache could pair a 304 with the wrong body."""
    return f'"{version}"', f'"{version}{GZIP_TAG}"'


class SnapshotStore:
    """Holds the newest published snapshot; safe to use from the collector and the web threads at once.

    `clock` returns seconds on any monotonic scale; it measures the age of a snapshot whose data names no moment.
    `wall` is the time of day in Unix seconds: a snapshot's age is counted from its "as_of" (the moment its data
    describes) when it carries one.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic, wall: Callable[[], float] = time.time):
        self._clock = clock
        self._wall = wall
        self._as_of: float | None = None  # the snapshot's "as_of" in Unix seconds, when it has a readable one
        self._lock = threading.Lock()
        # (plain, gzipped) for the whole snapshot, and for the snapshot without its "otd" section
        self._whole: tuple[bytes, bytes] | None = None
        self._lean: tuple[bytes, bytes] | None = None
        self._otd_version: str | None = None
        self._etags: tuple[str, str] | None = None
        # The same three for the free site's snapshot (advisor/public.py): what a visitor who is not a member gets.
        self._public: tuple[bytes, bytes] | None = None
        self._public_lean: tuple[bytes, bytes] | None = None
        self._public_otd_version: str | None = None
        self._public_etags: tuple[str, str] | None = None
        self._version: int | None = None
        self._published_at: float | None = None
        self._last_error: str | None = None
        self._tried = False  # a first refresh finished, published or failed
        self._ended: OrderedDict[int, dict] = OrderedDict()  # listing id -> its "gone" row, the newest last

    def publish(self, snapshot: dict) -> None:
        """Serve this snapshot from now on; it must carry its "version". Clears the last recorded error.

        Every variant is made and compressed here, once, so no request ever builds or compresses one again: the whole
        snapshot and the free site's (`advisor.public`), each also without its passes when it names them with an
        "otd_version"."""
        whole, lean, otd_version = self._variants(snapshot)
        try:
            free = public_snapshot(snapshot)
        except Exception:  # noqa: BLE001 - a visitor then sees no market, never the whole one, and the round goes on
            log.exception("the free site's snapshot could not be made; visitors get one with no market")
            free = bare_snapshot(snapshot)
        public, public_lean, public_otd_version = self._variants(free)
        as_of = _unix(snapshot.get("as_of"))
        with self._lock:
            self._remember_ended(snapshot.get("gone"))
            self._whole, self._lean, self._otd_version = whole, lean, otd_version
            self._public, self._public_lean, self._public_otd_version = public, public_lean, public_otd_version
            self._etags = etags(snapshot["version"])
            self._public_etags = etags(f"{snapshot['version']}{PUBLIC_TAG}")
            self._version = snapshot["version"]
            self._published_at = self._clock()
            self._as_of = as_of
            self._last_error = None

    def _remember_ended(self, rows: object) -> None:
        """Keeps the "gone" rows of a snapshot beyond the 45 seconds it serves them, so a shared link to a deal that
        went away can still say so. The newest row of a listing wins; the table holds ENDED_KEEP listings at most.
        Called with the lock held."""
        for row in rows if isinstance(rows, list) else ():
            listing_id = row.get("listing_id") if isinstance(row, dict) else None
            if type(listing_id) is int:
                self._ended.pop(listing_id, None)
                self._ended[listing_id] = row
        while len(self._ended) > ENDED_KEEP:
            self._ended.popitem(last=False)

    def ended(self, listing_id: int) -> dict | None:
        """The "gone" row of a deal that went away (as served, with its reason), or None when it is not remembered."""
        with self._lock:
            return self._ended.get(listing_id)

    @classmethod
    def _variants(cls, snapshot: dict) -> tuple[tuple[bytes, bytes], tuple[bytes, bytes] | None, str | None]:
        """(the snapshot's bodies, its bodies without "otd" or None, the "otd_version" that names the passes or None).
        The variant without the passes exists only when the snapshot names them with an "otd_version"."""
        otd_version = snapshot.get("otd_version")
        lean = None
        if isinstance(otd_version, str) and "otd" in snapshot:
            lean = cls._bodies({key: value for key, value in snapshot.items() if key != "otd"})
        return cls._bodies(snapshot), lean, otd_version if lean is not None else None

    @staticmethod
    def _bodies(snapshot: dict) -> tuple[bytes, bytes]:
        body = json.dumps(snapshot, separators=(",", ":")).encode()
        return body, compress(body)

    def current(self, gzipped: bool = False, otd: str | None = None, public: bool = False) -> tuple[bytes, str] | None:
        """The snapshot's JSON bytes and the ETag of that encoding, or None before the first publish.

        The free site's snapshot (`advisor.public`) when `public`, else the whole one. Gzipped when asked. Without the
        "otd" section when `otd` is that snapshot's own "otd_version" (the client holds those passes already); any other
        `otd` gets the whole document. The ETag is the document's version either way ("7", or "7p" for the free
        site's): a response that can carry either encoding must say it varies by Accept-Encoding."""
        with self._lock:
            if self._whole is None:
                return None
            if public:
                whole, lean_bodies, version, tags = self._public, self._public_lean, self._public_otd_version, self._public_etags
            else:
                whole, lean_bodies, version, tags = self._whole, self._lean, self._otd_version, self._etags
            lean = lean_bodies is not None and otd is not None and otd == version
            plain, packed = lean_bodies if lean else whole
            return (packed, tags[1]) if gzipped else (plain, tags[0])

    def record_error(self, message: str) -> None:
        """Remember why the latest refresh failed (a short name, never served); the last snapshot keeps being
        served."""
        with self._lock:
            self._last_error = message
            self._tried = True

    def health(self) -> dict:
        """The snapshot's version and age in seconds, whether it is fresh enough, and the last error. The age is the
        data's (from its "as_of", never below 0) when the snapshot says it, else the time since it was published."""
        with self._lock:
            if self._published_at is None:
                age_s = None
            elif self._as_of is not None:
                age_s = max(0.0, float(self._wall() - self._as_of))
            else:
                age_s = float(self._clock() - self._published_at)
            return {
                "version": self._version,
                "age_s": age_s,
                "ok": age_s is not None and age_s <= STALE_AFTER_S,
                "last_error": self._last_error,
                "ready": self._version is not None or self._tried,
            }


def _unix(text: object) -> float | None:
    """An ISO 8601 time with its zone ("2026-11-15T10:00:00Z") in Unix seconds, or None when it is not one."""
    if not isinstance(text, str):
        return None
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00", 1) if text.endswith("Z") else text)
    except ValueError:
        return None
    return moment.timestamp() if moment.tzinfo is not None else None
