"""Import a visitor's passes from their Real username, through the private feed.

The feed's producer answers `GET <ADVISOR_FEED_URL>/passes?username=<name>` (same bearer token) with
`{"username": str, "passes": [{"key": "sport:season:kind:id", "rating": float | null, "tier": str | null,
"spent": bool, ...Real's own facts (below)}], "truncated": bool, "markets": [feed otd row], "waiting": int, "seasons_waiting": int}`; 404 when no
account has that name, 422 when it has no pass anyone can read, 429 or 503 when it cannot look now. This module checks
the name, keeps each answer IMPORT_CACHE_S, spends at most IMPORT_PER_HOUR lookups an hour for the whole site (each one
costs the producer reads; one it turns away with 429 or 503 read nothing and gives its place back), and returns only
what the page needs, checked field by field: never an id, a token or anything that names the producer.

EVERY PASS VALUED: `markets` holds a pass row (the feed's `otd` shape) for each pass the producer could value from its
season's earnings ranking, a big account's included; they are checked one by one, kept only for the account's own
passes, and sent as the snapshot sends its markets (`_pass_market_json`: rungs and all), so the page values them like
any other. While some of its seasons are still being read, `waiting` counts the passes not valued yet: such an answer is
kept only IMPORT_PENDING_CACHE_S, and the page's next asks for that name (`follow_up`) cost no lookup from the hour's
budget or the address's: the producer answers them from what it keeps, at no read (the web app gives them a limit
of their own, since each still holds a thread).

REAL'S OWN FACTS: a newer producer adds to each pass what Real itself says about it: `level` (int), `rarity` (Real's
actual rung, one of the ladder's tiers), `label` (Real's text, "Rare 1"), `mult` (its multiplier), `cap` (Real's On
This Day limit for the pass: 0 for a General, which earns nothing On This Day; an Epic player's 5000 is 500 x 10) and
`earned` (all it earned, live games included, so it can pass `cap`; the cap counts all of it: what is left On This Day
is `cap - earned`, never under 0, as measured on 123 accounts in the internal research notes, 4f),
each null when unknown. Each one is checked on its own and kept
only when it fits (`_REAL_FIELDS`); the page prefers them to what it would infer from the rating. An older producer
sends none of them and the page infers as before.

MANY AT ONCE: a lookup holds a web thread up to IMPORT_TIMEOUT_S, so at most IMPORT_MAX_CONCURRENT leave for the
producer at once; one more is answered "busy" at once, with `retry_after`, and spends nothing from the hour. Asks for a
name already on its way to the producer leave no second call: they wait for that call's answer.
"""

import dataclasses
import json
import math
import re
import threading
import time
from collections import OrderedDict, deque
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone

from advisor.model import PassMarket
from advisor.rules import (
    FEED_MAX_BYTES,
    IMPORT_CACHE_S,
    IMPORT_FOLLOW_UP_S,
    IMPORT_MAX_CONCURRENT,
    IMPORT_MAX_PASSES,
    IMPORT_MAX_WAITERS,
    IMPORT_PENDING_CACHE_S,
    IMPORT_PER_HOUR,
    IMPORT_RETRY_AFTER_S,
    IMPORT_TIMEOUT_S,
)
from advisor.sources.feed import USER_AGENT, FeedError, _http_get
from advisor.sources.fixture import parse_pass_market

_MARKET_FIELDS = frozenset(f.name for f in dataclasses.fields(PassMarket))

USERNAME = re.compile(r"[A-Za-z0-9_.]{2,30}")
_KEY = re.compile(r"[a-z][a-z0-9_-]{0,19}:\d{4}:(player|team|fighter):\d{1,12}")
_TIERS = frozenset({"general", "common", "uncommon", "rare", "epic", "legendary", "mystic", "iconic"})
_CACHE_MAX = 500
LABEL_MAX_CHARS = 24
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def _real_number(value: object, low: float, high: float, low_open: bool = False) -> float | None:
    """A finite number within [low, high) (or (low, high) with `low_open`), rounded to 2 places; else None."""
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        return None
    if value < low or (low_open and value == low) or value >= high:
        return None
    return round(float(value), 2)


def _real_label(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    text = _CONTROL.sub("", value).strip()
    return text if 0 < len(text) <= LABEL_MAX_CHARS else None


# Real's own facts about a pass: field -> its check (None: left out).
_REAL_FIELDS: dict[str, Callable[[object], object]] = {
    "level": lambda v: v if type(v) is int and 0 <= v <= 10_000 else None,
    "rarity": lambda v: v.lower() if isinstance(v, str) and v.lower() in _TIERS else None,
    "label": _real_label,
    "mult": lambda v: _real_number(v, 0, 1000, low_open=True),
    "cap": lambda v: _real_number(v, 0, 1e9),
    "earned": lambda v: _real_number(v, 0, 1e9),
}


@dataclass(frozen=True)
class Imported:
    """What a lookup found: `status` is "ok", "not_found", "private" or "busy"."""

    status: str
    username: str | None = None
    passes: tuple[dict, ...] = ()
    truncated: bool = False
    markets: tuple[dict, ...] = ()  # the account's valued passes, as the snapshot's markets
    waiting: int = 0  # passes whose season's ranking is still being read
    seasons_waiting: int = 0
    # For a "busy" answer: in how many seconds to ask again (0: no word). A hint for the response, no part of the answer.
    retry_after: int = field(default=0, compare=False)

    def json(self) -> dict:
        return {"status": self.status, "username": self.username, "passes": list(self.passes),
                "truncated": self.truncated, "markets": list(self.markets), "waiting": self.waiting,
                "seasons_waiting": self.seasons_waiting}


class _InFlight:
    """A lookup on its way to the producer: the asks for the same name wait for its answer."""

    def __init__(self):
        self.done = threading.Event()
        self.found: Imported = Imported("busy", retry_after=IMPORT_RETRY_AFTER_S)
        self.waiters = 0


class _Refused(Exception):
    def __init__(self, status: str):
        super().__init__(status)
        self.status = status


def valid_username(name: object) -> str | None:
    """The name stripped, or None when it cannot be a Real username."""
    if not isinstance(name, str):
        return None
    name = name.strip().lstrip("@")
    return name if USERNAME.fullmatch(name) else None


def _holding(row: object) -> dict | None:
    """One pass as the page stores it, or None when the row does not fit."""
    if not isinstance(row, dict) or not isinstance(row.get("key"), str) or not _KEY.fullmatch(row["key"]):
        return None
    out: dict = {"key": row["key"]}
    rating, tier = row.get("rating"), row.get("tier")
    if isinstance(rating, (int, float)) and not isinstance(rating, bool) and 0 <= rating < 1e6:
        out["rating"] = round(float(rating), 2)
    if isinstance(tier, str) and tier.lower() in _TIERS:
        out["tier"] = tier.lower()
    for name, check in _REAL_FIELDS.items():
        value = check(row.get(name))
        if value is not None:
            out[name] = value
    if "rating" not in out and "tier" not in out and "rarity" not in out:
        return None
    if row.get("spent") is True:
        out["spent"] = True
    return out


def _count(value: object) -> int:
    return value if type(value) is int and 0 <= value <= 1_000_000 else 0


def _markets(rows: object, keys: set[str], now: datetime) -> tuple[dict, ...]:
    """The account's valued passes as the snapshot sends markets; a row that does not fit, or is not one of the
    account's passes, is left out alone."""
    from advisor.snapshot import _pass_market_json

    today = now.astimezone(timezone.utc).date()
    out, seen = [], set()
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or row.get("key") not in keys or row["key"] in seen or set(row) - _MARKET_FIELDS:
            continue
        try:
            market = parse_pass_market(row)
            if not _KEY.fullmatch(market.key):
                continue
            out.append(_pass_market_json(market, today, now))
        except Exception:  # noqa: BLE001 - one row that does not fit the model is left out, the rest stay
            continue
        seen.add(row["key"])
    return tuple(out)


def _parse(body: bytes, now: datetime | None = None) -> Imported:
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise _Refused("busy") from None
    if not isinstance(data, dict) or not isinstance(data.get("passes"), list):
        raise _Refused("busy")
    name = valid_username(data.get("username"))
    seen, passes = set(), []
    for row in data["passes"]:
        holding = _holding(row)
        if holding is not None and holding["key"] not in seen:
            seen.add(holding["key"])
            passes.append(holding)
    truncated = data.get("truncated") is True or len(passes) > IMPORT_MAX_PASSES
    passes = passes[:IMPORT_MAX_PASSES]
    if not passes:
        return Imported("private", name)
    markets = _markets(data.get("markets"), {p["key"] for p in passes}, now or datetime.now(timezone.utc))
    return Imported("ok", name, tuple(passes), truncated, markets, _count(data.get("waiting")),
                    _count(data.get("seasons_waiting")))


class PassImporter:
    def __init__(self, feed_url: str, token: str, get: Callable[[str, dict[str, str]], bytes] | None = None,
                 clock: Callable[[], float] = time.monotonic, per_hour: int = IMPORT_PER_HOUR,
                 max_concurrent: int = IMPORT_MAX_CONCURRENT):
        self._url = feed_url.rstrip("/") + "/passes"
        self._headers = {"Authorization": f"Bearer {token}", "Accept": "application/json",
                         "Accept-Encoding": "gzip", "User-Agent": USER_AGENT}
        self._get = get or (lambda url, headers: _http_get(url, headers, IMPORT_TIMEOUT_S, FEED_MAX_BYTES))
        self._clock = clock
        self._per_hour = per_hour
        self._spent: deque[float] = deque()
        self._cache: OrderedDict[str, tuple[float, Imported]] = OrderedDict()
        self._waiting: dict[str, float] = {}  # name -> when its first answer still waiting came
        self._in_flight: dict[str, _InFlight] = {}  # name -> the lookup on its way for it
        self._max_concurrent = max_concurrent
        self._lock = threading.Lock()

    def __repr__(self) -> str:
        return "PassImporter()"  # neither the address nor the token

    @staticmethod
    def _fresh(hit: tuple[float, Imported], now: float) -> bool:
        return now - hit[0] < (IMPORT_PENDING_CACHE_S if hit[1].waiting > 0 else IMPORT_CACHE_S)

    def cached(self, username: str) -> Imported | None:
        """The answer kept for `username` (checked with `valid_username`), while it is fresh; None otherwise."""
        with self._lock:
            hit = self._cache.get(username.lower())
            if hit is not None and self._fresh(hit, self._clock()):
                return hit[1]
        return None

    def follow_up(self, username: str) -> bool:
        """The page asking again for an account whose answer still waited on a season's ranking, within
        IMPORT_FOLLOW_UP_S of that first answer: the producer answers from what it keeps, at no read, so it costs
        neither the hour's lookups nor the address's."""
        with self._lock:
            since = self._waiting.get(username.lower())
            return since is not None and self._clock() - since < IMPORT_FOLLOW_UP_S

    def lookup(self, username: str) -> Imported:
        """The passes of `username` (already checked with `valid_username`). An ask for a name already on its way
        waits for that lookup's answer; with IMPORT_MAX_CONCURRENT lookups out already, or the hour's spent, the answer
        is "busy" with the seconds to wait in `retry_after`."""
        key = username.lower()
        now = self._clock()
        with self._lock:
            hit = self._cache.get(key)
            if hit is not None and self._fresh(hit, now):
                return hit[1]
            flight = self._in_flight.get(key)
            if flight is not None:  # a waiter holds a server thread until the answer: bounded across all names
                if sum(f.waiters for f in self._in_flight.values()) >= IMPORT_MAX_WAITERS:
                    return Imported("busy", retry_after=IMPORT_RETRY_AFTER_S)
                flight.waiters += 1
            else:
                if len(self._in_flight) >= self._max_concurrent:
                    return Imported("busy", retry_after=IMPORT_RETRY_AFTER_S)
                since = self._waiting.get(key)
                free = since is not None and now - since < IMPORT_FOLLOW_UP_S
                spent = not free
                if spent:
                    while self._spent and now - self._spent[0] >= 3600:
                        self._spent.popleft()
                    if len(self._spent) >= self._per_hour:
                        return Imported("busy", retry_after=max(1, math.ceil(3600 - (now - self._spent[0]))))
                    self._spent.append(now)
                mine = self._in_flight[key] = _InFlight()
        if flight is not None:  # another ask is fetching this name: its answer is this one's
            flight.done.wait(IMPORT_TIMEOUT_S + 5)
            return flight.found
        try:
            mine.found = self._fetch(username, key, now, spent)
        finally:
            with self._lock:
                self._in_flight.pop(key, None)
            mine.done.set()
        return mine.found

    def _fetch(self, username: str, key: str, now: float, spent: bool) -> Imported:
        turned_away = False  # the producer said it cannot look now (429, 503): it read nothing
        try:
            body = self._get(f"{self._url}?username={username}", dict(self._headers))
            found = _parse(body)
        except _Refused as refused:
            found = Imported(refused.status)
        except FeedError as error:
            text = str(error)
            found = Imported("not_found" if "404" in text else "private" if "422" in text else "busy")
            turned_away = text.endswith((" 429", " 503"))
        with self._lock:
            if turned_away and spent and now in self._spent:
                self._spent.remove(now)  # a lookup that cost the producer no read gives the hour's back
            if found.status == "ok" and found.waiting > 0:
                self._waiting.setdefault(key, now)
            elif found.status != "busy":
                self._waiting.pop(key, None)
            for name in [n for n, t in self._waiting.items() if now - t >= IMPORT_FOLLOW_UP_S]:
                del self._waiting[name]
            if found.status in ("ok", "not_found", "private"):
                self._cache[key] = (now, found)
                self._cache.move_to_end(key)
                while len(self._cache) > _CACHE_MAX:
                    self._cache.popitem(last=False)
        return found


class DemoImporter:
    """The sample data's stand-in for the producer: any username links a sample account, made the same every time
    for that name from the passes the current snapshot lists (players only), with Real's own facts filled in as a
    newer producer sends them, one or more of them maxed (cap 0). Never reaches the network; nothing is real."""

    def __init__(self, store):
        self._store = store

    def __repr__(self) -> str:
        return "DemoImporter()"

    def cached(self, username: str) -> Imported | None:
        return None

    def follow_up(self, username: str) -> bool:
        return False

    def lookup(self, username: str) -> Imported:
        import hashlib
        import random

        from advisor.rules import OTD_LADDERS, OTD_PLAYER_LIMIT_PER_MULT

        current = self._store.current()
        markets = json.loads(current[0]).get("otd", {}).get("markets", []) if current else []
        keys = sorted(m["key"] for m in markets if isinstance(m, dict) and m.get("kind") == "player"
                      and isinstance(m.get("key"), str) and _KEY.fullmatch(m["key"]))
        if not keys:
            return Imported("busy", retry_after=IMPORT_RETRY_AFTER_S)
        rng = random.Random(hashlib.sha256(username.lower().encode()).digest())
        picked = rng.sample(keys, min(len(keys), rng.randint(8, 24)))
        passes = []
        for i, key in enumerate(picked):
            tier, entry, mult = rng.choice(OTD_LADDERS["player"][1:5])
            limit = OTD_PLAYER_LIMIT_PER_MULT * mult
            earned = limit if i == 0 else round(rng.uniform(0, limit * 0.8), 2)
            if i == 0:  # a General, as Real reports one: its limit On This Day is 0
                tier, entry, mult, limit = "general", 0, 1, 0
            passes.append({"key": key, "rating": float(entry + rng.randint(0, 9)), "level": 1, "rarity": tier,
                           "label": tier.capitalize(), "mult": float(mult), "cap": float(limit),
                           "earned": float(earned)})
        passes.sort(key=lambda p: -p["rating"])
        return Imported("ok", username, tuple(passes))
