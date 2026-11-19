"""Alerts by web push: opt-in per device and per category, with no account.

A device subscribes from the page with its push endpoint, the endpoint's two keys and its rules: level, budget,
followed players (`sport:player_id`), the listings it opened (for "last call"), the categories it turned on, the
digest hour, quiet hours and its clock's offset from UTC. The store keeps exactly that, plus counters, last-sent
times and the day it last heard from the device: never a name, an e-mail address, an IP address or a user agent.
Rules with every category off keep nothing, and a row not heard from for PUSH_ROW_TTL_DAYS is dropped.

The collector hands the dispatcher each new snapshot (with its gone rows). The dispatcher only queues it; its own
thread compares the snapshot with the one before (new listing ids, deals ending, price moves), matches every
subscription's rules and sends. The collector never waits on a push service, and nothing raised here ever reaches it;
one subscription that breaks never stops the others. Test sends are counted in memory, per endpoint and for the whole
server, so deleting a subscription and making it again starts no new count.

Only the push services of PUSH_ALLOWED_HOSTS are ever sent to, over https, never through a redirect: checked when a
device subscribes, when the store is read back, and again before every send.

Without the three VAPID variables the feature does not exist: no dispatcher, the routes answer 404 and the snapshot
says `links.push: null`. Rotating the keypair unsubscribes every device (each subscription was made for the old public
key): every visitor has to turn alerts on again.
"""

import base64
import binascii
import copy
import hashlib
import json
import logging
import os
import queue
import re
import tempfile
import threading
import time
from collections import Counter, OrderedDict, deque
from collections.abc import Callable, Mapping
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import NamedTuple, Protocol
from urllib.parse import urlsplit

import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from py_vapid import Vapid
from pywebpush import WebPushException, webpush

from advisor.injuries import benched
from advisor.rules import (
    LEVELS,
    PUSH_ALLOWED_HOSTS,
    PUSH_ANNOUNCED_KEPT,
    PUSH_BACKOFF_CAP_S,
    PUSH_BACKOFF_S,
    PUSH_DEFAULT_DIGEST_HOUR,
    PUSH_DEFAULT_QUIET,
    PUSH_DIGEST_SIZE,
    PUSH_LAST_CALL_S,
    PUSH_MAX_DEAD,
    PUSH_MAX_ENDPOINT,
    PUSH_MAX_FAILS,
    PUSH_MAX_FOLLOWS,
    PUSH_MAX_OPENED,
    PUSH_MAX_SUBS,
    PUSH_MOVE_MIN,
    PUSH_PER_HOUR,
    PUSH_QUEUE,
    PUSH_ROW_TTL_DAYS,
    PUSH_TAG_COOLDOWN_S,
    PUSH_TEST_GLOBAL_PER_HOUR,
    PUSH_TEST_KEYS_MAX,
    PUSH_TESTS_PER_HOUR,
    PUSH_TIMEOUT_S,
    PUSH_TTL_S,
)

log = logging.getLogger(__name__)

CATEGORIES = ("deals", "last_call", "moves", "digest", "routine")
ICON = "/icon-192.png"
VAPID_VARS = ("ADVISOR_VAPID_PRIVATE", "ADVISOR_VAPID_PUBLIC", "ADVISOR_VAPID_SUBJECT")
_FOLLOW = re.compile(r"[a-z]{2,12}:[0-9]{1,12}")
_HOST = re.compile(r"[a-z0-9-]+(\.[a-z0-9-]+)+")
_B64URL = re.compile(r"[A-Za-z0-9_-]+={0,2}")
_HASH = re.compile(r"[0-9a-f]{64}")
_MAILTO = re.compile(r"mailto:[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+")
_LAST_CALLS_KEPT = 100  # listings a device was told "last call" about, remembered so it is told once
_BODY_MAX = 240  # characters in an alert's text at most


# --- what may be sent to -------------------------------------------------------------------------------------------

def _host_allowed(host: str) -> bool:
    for pattern in PUSH_ALLOWED_HOSTS:
        if pattern.startswith("*."):
            if host.endswith(pattern[1:]) and len(host) > len(pattern) - 1:
                return True
        elif host == pattern:
            return True
    return False


def endpoint_allowed(endpoint: object) -> bool:
    """Whether `endpoint` is an https URL on one of the push services of PUSH_ALLOWED_HOSTS, plainly written: no
    user name or password, no other port, no fragment, nothing but printable ASCII, a path, and a host name (never an
    address) that is exactly the allowed one or, for a "*." pattern, a name under it."""
    if not isinstance(endpoint, str) or not 0 < len(endpoint) <= PUSH_MAX_ENDPOINT:
        return False
    if any(not 0x21 <= ord(ch) <= 0x7E or ch in "\\#" for ch in endpoint):
        return False
    try:
        parts = urlsplit(endpoint)
        port = parts.port
    except ValueError:
        return False
    host = parts.hostname or ""
    if parts.scheme != "https" or port not in (None, 443) or len(parts.path) < 2:
        return False
    if parts.netloc.lower() not in (host, f"{host}:443"):  # a user name, a password, brackets: not a plain host
        return False
    return _HOST.fullmatch(host) is not None and _host_allowed(host)


# --- what a subscription may hold ----------------------------------------------------------------------------------

def _b64url_bytes(value: object) -> bytes | None:
    if not isinstance(value, str) or len(value) > 256 or not _B64URL.fullmatch(value):
        return None
    bare = value.rstrip("=")
    try:
        return base64.urlsafe_b64decode(bare + "=" * (-len(bare) % 4))
    except (binascii.Error, ValueError):
        return None


def _clean_keys(keys: object) -> dict | None:
    """The endpoint's two keys when they are what a browser sends: a P-256 public key and a 16-byte secret."""
    if not isinstance(keys, dict):
        return None
    p256dh, auth = _b64url_bytes(keys.get("p256dh")), _b64url_bytes(keys.get("auth"))
    if p256dh is None or len(p256dh) != 65 or auth is None or len(auth) != 16:
        return None
    try:
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), p256dh)
    except ValueError:
        return None
    return {"p256dh": keys["p256dh"], "auth": keys["auth"]}


def _int_in(value: object, low: int, high: int) -> bool:
    return type(value) is int and low <= value <= high


def _clean_rules(rules: object) -> dict | None:
    """The rules a device sent, checked field by field, with every other field dropped; None when one is wrong.

    level, budget and follows are required; opened, categories, digest_hour, quiet and utc_offset_min fall back to
    none, all off, PUSH_DEFAULT_DIGEST_HOUR, PUSH_DEFAULT_QUIET and UTC. `quiet: null` means no quiet hours."""
    if not isinstance(rules, dict):
        return None
    level, budget, follows = rules.get("level"), rules.get("budget"), rules.get("follows")
    opened = rules.get("opened", [])
    categories = rules.get("categories", {})
    digest_hour = rules.get("digest_hour", PUSH_DEFAULT_DIGEST_HOUR)
    quiet = rules.get("quiet", list(PUSH_DEFAULT_QUIET))
    offset = rules.get("utc_offset_min", 0)
    if not (isinstance(level, str) and level in LEVELS):
        return None
    if budget is not None and not _int_in(budget, 1, 10**9):
        return None
    if not (isinstance(follows, list) and len(follows) <= PUSH_MAX_FOLLOWS
            and all(isinstance(f, str) and _FOLLOW.fullmatch(f) for f in follows)):
        return None
    if not (isinstance(opened, list) and len(opened) <= PUSH_MAX_OPENED and all(_int_in(o, 1, 10**15) for o in opened)):
        return None
    if not (isinstance(categories, dict) and all(isinstance(categories.get(c, False), bool) for c in CATEGORIES)):
        return None
    if not _int_in(digest_hour, 0, 23) or not _int_in(offset, -720, 840):
        return None
    if quiet is not None and not (isinstance(quiet, list) and len(quiet) == 2 and all(_int_in(h, 0, 23) for h in quiet)):
        return None
    return {
        "level": level,
        "budget": budget,
        "follows": list(dict.fromkeys(follows)),
        "opened": list(dict.fromkeys(opened)),
        "categories": {c: categories.get(c, False) for c in CATEGORIES},
        "digest_hour": digest_hour,
        "quiet": None if quiet is None else list(quiet),
        "utc_offset_min": offset,
    }


def _json_object(data: bytes) -> dict | None:
    try:
        payload = json.loads(data)
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


def normalize_endpoint(endpoint: object) -> str | None:
    """An allowed endpoint written one way (host in lower case, no default port), so one device is one row; None
    for an endpoint that is not allowed. The path and the query keep their case: they are the push service's own."""
    if not endpoint_allowed(endpoint):
        return None
    parts = urlsplit(endpoint)  # type: ignore[arg-type]
    query = f"?{parts.query}" if parts.query else ""
    return f"https://{parts.hostname}{parts.path}{query}"


def parse_subscription(data: bytes) -> tuple[dict, dict] | None:
    """`{subscription: {endpoint, keys}, rules}` as the page sends it, cleaned; None when anything is wrong."""
    payload = _json_object(data)
    sub = payload.get("subscription") if payload else None
    endpoint = normalize_endpoint(sub.get("endpoint")) if isinstance(sub, dict) else None
    if endpoint is None:
        return None
    keys, rules = _clean_keys(sub.get("keys")), _clean_rules(payload.get("rules"))
    if keys is None or rules is None:
        return None
    return {"endpoint": endpoint, "keys": keys}, rules


def parse_endpoint(data: bytes) -> str | None:
    """The endpoint of `{endpoint}`, written the way the store keeps it, or None when the body is not that."""
    payload = _json_object(data)
    endpoint = payload.get("endpoint") if payload else None
    if not (isinstance(endpoint, str) and 0 < len(endpoint) <= PUSH_MAX_ENDPOINT):
        return None
    return normalize_endpoint(endpoint) or endpoint  # an endpoint off the allowlist is in no row anyway


# --- the store -----------------------------------------------------------------------------------------------------

def _new_state() -> dict:
    return {"sent": [], "tags": {}, "announced": [], "last_calls": [], "moves": {}, "digest_day": None,
            "routine_day": None, "fails": 0, "retry_at": 0}


def _clean_state(state: object) -> dict:
    """Counters read back from disk: each one kept when it is the right shape, else started afresh."""
    clean = _new_state()
    if not isinstance(state, dict):
        return clean
    num = (int, float)
    if isinstance(state.get("sent"), list):
        clean["sent"] = [t for t in state["sent"] if isinstance(t, num)][-PUSH_PER_HOUR:]
    if isinstance(state.get("announced"), list):
        clean["announced"] = [i for i in state["announced"] if type(i) is int][-PUSH_ANNOUNCED_KEPT:]
    if isinstance(state.get("tags"), dict):
        clean["tags"] = {k: v for k, v in state["tags"].items() if isinstance(k, str) and isinstance(v, num)}
    if isinstance(state.get("last_calls"), list):
        clean["last_calls"] = [i for i in state["last_calls"] if type(i) is int][-_LAST_CALLS_KEPT:]
    if isinstance(state.get("moves"), dict):
        clean["moves"] = {k: v for k, v in state["moves"].items() if isinstance(k, str) and isinstance(v, str)}
    if isinstance(state.get("digest_day"), str):
        clean["digest_day"] = state["digest_day"]
    if isinstance(state.get("routine_day"), str):
        clean["routine_day"] = state["routine_day"]
    if type(state.get("fails")) is int and state["fails"] >= 0:
        clean["fails"] = state["fails"]
    if isinstance(state.get("retry_at"), num):
        clean["retry_at"] = state["retry_at"]
    return clean


def _hash(endpoint: str) -> str:
    return hashlib.sha256(endpoint.encode()).hexdigest()


def _day(epoch_s: float) -> str:
    return datetime.fromtimestamp(epoch_s, timezone.utc).date().isoformat()


def _in_quiet(hour: int, quiet: list[int] | None) -> bool:
    """Whether `hour` (0-23) falls in the quiet hours [start, end), which may wrap over midnight."""
    if not quiet or quiet[0] == quiet[1]:
        return False
    start, end = quiet
    return start <= hour < end if start < end else hour >= start or hour < end


def _prune(state: dict, now_s: float) -> None:
    state["sent"] = [t for t in state["sent"] if t > now_s - 3600]
    state["tags"] = {tag: t for tag, t in state["tags"].items() if t > now_s - PUSH_TAG_COOLDOWN_S}


_MEMBER_UID = re.compile(r"\d{15,21}")


def _clean_member(value: object) -> dict | None:
    """Who subscribed while the Discord gate was on, {"uid": their Discord id, "iat": when they logged in}, as the
    gate wrote it; None for anything else."""
    if not isinstance(value, dict):
        return None
    uid, iat = value.get("uid"), value.get("iat")
    if not isinstance(uid, str) or not _MEMBER_UID.fullmatch(uid) or type(iat) is not int:
        return None
    return {"uid": uid, "iat": iat}


class PushStore:
    """The subscriptions, kept in a JSON file: safe to use from the web threads and the dispatcher at once.

    Each row is `{endpoint, keys, rules, state, last_seen}`, plus `member` when the Discord gate is on (who subscribed:
    their Discord id and when they logged in, so the alerts stop with their membership). A new, changed or removed subscription is written at
    once; a device sending the same rules again only moves `last_seen`, and that is written at most once a day per
    row. Counters are written by `flush()`, which the dispatcher calls after each round. Every write goes to a
    temporary file that is then renamed over the old one, so the file on disk is always whole. At most `max_subs`
    subscriptions are kept, and a row its device has not sent for PUSH_ROW_TTL_DAYS is dropped (on load, and by
    `expire()` each round), so a full store empties itself of what nobody uses. Endpoints the push service said are
    gone are remembered as hashes (at most PUSH_MAX_DEAD), so a device that syncs one is told it was unsubscribed.
    `clock` gives the time in seconds since the epoch.
    """

    def __init__(self, path: Path, max_subs: int = PUSH_MAX_SUBS, clock: Callable[[], float] = time.time):
        self._path = path
        self._max_subs = max_subs
        self._clock = clock
        self._lock = threading.RLock()
        self._subs: dict[str, dict] = {}
        self._dead: dict[str, None] = {}  # endpoint hashes, oldest first
        self._dirty = False
        self._load()

    def __len__(self) -> int:
        with self._lock:
            return len(self._subs)

    def get(self, endpoint: str) -> dict | None:
        with self._lock:
            row = self._subs.get(endpoint)
            return None if row is None else copy.deepcopy(row)

    def rows(self) -> list[dict]:
        with self._lock:
            return copy.deepcopy(list(self._subs.values()))

    def upsert(self, subscription: dict, rules: dict, member: dict | None = None) -> str:
        """Adds the subscription or updates its keys and rules (its counters stay). Rules with every category off keep
        nothing: the row goes, if there was one. Says "ok", "full" when there is no room for a new one, or "dead" when
        the push service said this endpoint is gone. `member` (the Discord gate on): who sends it, kept with it."""
        member = _clean_member(member)
        endpoint, keys = subscription["endpoint"], dict(subscription["keys"])
        now_s = self._clock()
        with self._lock:
            if _hash(endpoint) in self._dead:
                return "dead"
            row = self._subs.get(endpoint)
            if not any(rules["categories"].values()):
                if row is not None:
                    del self._subs[endpoint]
                    self._write()
                return "ok"
            if row is None:
                if len(self._subs) >= self._max_subs:
                    return "full"
                row = self._subs[endpoint] = {"endpoint": endpoint, "state": _new_state()}
            elif (row["keys"] == keys and row["rules"] == rules and _day(row["last_seen"]) == _day(now_s)
                  and row.get("member") == member and not self._dirty):
                return "ok"  # nothing new today and nothing waiting to be saved: the file is left alone
            row["keys"], row["rules"], row["last_seen"] = keys, copy.deepcopy(rules), now_s
            if member is not None:
                row["member"] = member
            self._write()
            return "ok"

    def expire(self, now_s: float) -> int:
        """Drops the rows not sent by their device for PUSH_ROW_TTL_DAYS; says how many went."""
        cutoff = now_s - PUSH_ROW_TTL_DAYS * 86400
        with self._lock:
            stale = [endpoint for endpoint, row in self._subs.items() if row["last_seen"] < cutoff]
            for endpoint in stale:
                del self._subs[endpoint]
            if stale:
                self._dirty = True
            return len(stale)

    def delete(self, endpoint: str) -> bool:
        """Forgets the subscription; says whether there was one."""
        with self._lock:
            if self._subs.pop(endpoint, None) is None:
                return False
            self._write()
            return True

    def delete_member(self, uid: str) -> int:
        """Forgets every subscription made under the Discord id `uid` ("Delete my data"); says how many went. Raises
        OSError when the file could not be written (the rows are gone from memory and the store is dirty: a retry, or
        the next flush, writes it again)."""
        with self._lock:
            mine = [e for e, row in self._subs.items() if (row.get("member") or {}).get("uid") == uid]
            for endpoint in mine:
                del self._subs[endpoint]
            if (mine or self._dirty) and not self._write():
                raise OSError("the alert subscriptions could not be written")
            return len(mine)

    def bury(self, endpoint: str) -> None:
        """Forgets a subscription the push service said is gone (or that may no longer be sent to), and remembers
        its endpoint's hash."""
        with self._lock:
            self._subs.pop(endpoint, None)
            key = _hash(endpoint)
            self._dead.pop(key, None)
            self._dead[key] = None
            while len(self._dead) > PUSH_MAX_DEAD:
                del self._dead[next(iter(self._dead))]
            self._dirty = True

    def claim(self, endpoint: str, tag: str, now_s: float, *, local_hour: int, quiet: list[int] | None,
              cooldown: bool = True, mark: Callable[[dict], None] | None = None) -> dict | None:
        """The endpoint's keys if an alert tagged `tag` may go now, with the send counted (`mark` is applied by `landed`,
        once the send went through); None when it may not: the device is waiting after failures, it is quiet time there, it had
        PUSH_PER_HOUR alerts in the last hour, or (with `cooldown`) the same tag went in the last PUSH_TAG_COOLDOWN_S."""
        with self._lock:
            row = self._subs.get(endpoint)
            if row is None:
                return None
            state = row["state"]
            _prune(state, now_s)
            if state["retry_at"] > now_s or _in_quiet(local_hour, quiet) or len(state["sent"]) >= PUSH_PER_HOUR:
                return None
            if cooldown and tag in state["tags"]:
                return None
            state["sent"].append(now_s)
            state["tags"][tag] = now_s
            self._dirty = True
            return dict(row["keys"])

    def landed(self, endpoint: str, tag: str, sent: bool, mark: Callable[[dict], None] | None) -> None:
        """Ends a claim once its send is settled: a send that landed applies `mark` (the alert is not sent again); one
        that failed lets the tag go, so the alert may be tried again when the device's wait is over."""
        with self._lock:
            row = self._subs.get(endpoint)
            if row is None:
                return
            if sent:
                if mark is not None:
                    mark(row["state"])
            else:
                row["state"]["tags"].pop(tag, None)
            self._dirty = True

    def keys(self, endpoint: str) -> dict | None:
        """The endpoint's two keys, or None when it is not subscribed."""
        with self._lock:
            row = self._subs.get(endpoint)
            return None if row is None else dict(row["keys"])

    def settle(self, endpoint: str, status: int, now_s: float) -> str:
        """Records how a send went: "sent" (2xx), "gone" (404 or 410: the subscription is dropped), or "failed"
        (anything else: the device waits PUSH_BACKOFF_S, doubled for each failure in a row up to PUSH_BACKOFF_CAP_S,
        and is dropped after PUSH_MAX_FAILS)."""
        with self._lock:
            row = self._subs.get(endpoint)
            if 200 <= status < 300:
                if row is not None:
                    row["state"]["fails"], row["state"]["retry_at"] = 0, 0
                    self._dirty = True
                return "sent"
            if status in (404, 410):
                self.bury(endpoint)
                return "gone"
            if row is not None:
                fails = row["state"]["fails"] + 1
                if fails >= PUSH_MAX_FAILS:
                    self.bury(endpoint)
                else:
                    row["state"]["fails"] = fails
                    row["state"]["retry_at"] = now_s + min(PUSH_BACKOFF_S * 2 ** (fails - 1), PUSH_BACKOFF_CAP_S)
                    self._dirty = True
            return "failed"

    def flush(self) -> None:
        """Writes the counters if any changed since the last write."""
        with self._lock:
            if self._dirty:
                self._write()

    def _write(self) -> bool:
        """Writes the file whole; says whether it worked (a failure leaves the store dirty, to be written again)."""
        data = {"subs": list(self._subs.values()), "dead": list(self._dead)}
        tmp_name = None
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                "w", encoding="utf-8", dir=self._path.parent, prefix=f".{self._path.name}.", suffix=".tmp", delete=False
            ) as tmp:
                tmp_name = tmp.name
                json.dump(data, tmp, separators=(",", ":"))
                tmp.flush()
                os.fsync(tmp.fileno())
            os.replace(tmp_name, self._path)
            tmp_name = None
            self._dirty = False
            return True
        except OSError as error:
            self._dirty = True  # what is in memory is not on disk: the next flush, and the next PUT, write it again
            log.warning("push subscriptions could not be written to %s: %s", self._path, error)
            return False
        finally:
            if tmp_name is not None:
                try:
                    os.unlink(tmp_name)
                except OSError:
                    pass

    def _set_aside(self) -> None:
        aside = self._path.with_name(self._path.name + ".corrupt")
        try:
            os.replace(self._path, aside)
        except OSError as error:
            log.warning("unreadable push subscriptions in %s could not be moved aside: %s", self._path, error)
        else:
            log.warning("unreadable push subscriptions moved to %s", aside)

    def _load(self) -> None:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except ValueError as error:
            log.warning("push subscriptions in %s could not be read (%s); starting with none", self._path, error)
            self._set_aside()
            return
        except OSError as error:
            log.warning("push subscriptions in %s could not be read (%s); starting with none", self._path, error)
            return
        if not isinstance(data, dict) or not isinstance(data.get("subs"), list):
            log.warning("push subscriptions in %s are not in the expected shape; starting with none", self._path)
            self._set_aside()
            return
        now_s = self._clock()
        cutoff = now_s - PUSH_ROW_TTL_DAYS * 86400
        for row in data["subs"]:
            if len(self._subs) >= self._max_subs:
                break
            endpoint = normalize_endpoint(row.get("endpoint")) if isinstance(row, dict) else None
            if endpoint is None:
                continue
            keys, rules = _clean_keys(row.get("keys")), _clean_rules(row.get("rules"))
            if keys is None or rules is None:
                continue
            seen = row.get("last_seen")
            seen = seen if isinstance(seen, (int, float)) and seen <= now_s else now_s  # a row from before: from now
            if seen < cutoff:
                self._dirty = True
                continue
            self._subs[endpoint] = {"endpoint": endpoint, "keys": keys, "rules": rules,
                                    "state": _clean_state(row.get("state")), "last_seen": seen}
            member = _clean_member(row.get("member"))
            if member is not None:
                self._subs[endpoint]["member"] = member
        dead = data.get("dead")
        if isinstance(dead, list):
            for key in dead[-PUSH_MAX_DEAD:]:
                if isinstance(key, str) and _HASH.fullmatch(key):
                    self._dead[key] = None


# --- what an alert says --------------------------------------------------------------------------------------------

class Note(NamedTuple):
    kind: str  # a key of PUSH_TTL_S
    title: str
    body: str
    tag: str
    url: str
    urgency: str = "normal"

    def payload(self) -> bytes:
        return json.dumps(
            {"title": self.title, "body": self.body[:_BODY_MAX], "tag": self.tag, "url": self.url, "icon": ICON},
            separators=(",", ":"), ensure_ascii=False,
        ).encode()

    @property
    def ttl(self) -> int:
        return PUSH_TTL_S[self.kind]


def _rax(amount: float) -> str:
    return f"{round(amount):,} Rax"


def _pct(share: float) -> int:
    return int(abs(share) * 100 + 0.5)


def _deal_note(deal: dict) -> Note:
    what = f"{_rax(deal['price'])} to start" if deal["kind"] == "target" else f"{_rax(deal['price'])} top bid"
    return Note(
        "deal", "New deal on a player you follow", f"{deal['player_name']} · {what}, {_pct(deal['discount'])}% under usual",
        f"deal:{deal['sport']}:{deal['player_id']}", f"/?open={deal['listing_id']}#deals",
    )


def _last_call_note(deal: dict) -> Note:
    what = f"{_rax(deal['price'])} to start" if deal["kind"] == "target" else f"top bid {_rax(deal['price'])}"
    body = f"{deal['player_name']} · ends in under {PUSH_LAST_CALL_S // 60} min, {what}"
    listing = deal["listing_id"]
    return Note("last_call", "Last call", body, f"last:{listing}", f"/?open={listing}#deals", urgency="high")


def _move_note(key: str, name: str, change: float) -> Note:
    way = "up" if change > 0 else "down"
    return Note("move", "Price move", f"{name} prices are {way} {_pct(change)}% today", f"move:{key}", "/#prices")


def _digest_note(best: list[dict]) -> Note:
    title = "Today's best deal for you" if len(best) == 1 else f"Today's {len(best)} best deals for you"
    body = " · ".join(f"{deal['player_name']} {_pct(deal['discount'])}% under" for deal in best)
    return Note("digest", title, body, "digest", "/#today")


def _routine_note() -> Note:
    return Note("routine", "Your daily checklist", "A few small things to do today, about five minutes.", "routine",
                "/#today")


TEST_NOTE = Note("test", "Alerts are on", "This is a test. OTD Palace alerts will look like this.", "test", "/#today")


# --- matching ------------------------------------------------------------------------------------------------------

def _time(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else None


def _deal_ok(deal: object) -> bool:
    if not isinstance(deal, dict):
        return False
    num = (int, float)
    return (
        type(deal.get("listing_id")) is int and isinstance(deal.get("sport"), str)
        and type(deal.get("player_id")) is int and isinstance(deal.get("player_name"), str)
        and deal.get("kind") in ("target", "bid") and isinstance(deal.get("price"), num)
        and isinstance(deal.get("discount"), num) and isinstance(deal.get("confidence"), str)
        and _time(deal.get("ends_at")) is not None
    )


def fits(deal: dict, rules: dict, now: datetime) -> bool:
    """Whether a deal is one the device's level and budget show at `now`, as the page itself filters them."""
    level = LEVELS[rules["level"]]
    ends = _time(deal["ends_at"])
    if ends is None or ends <= now:
        return False
    if rules["budget"] is not None and deal["price"] > rules["budget"]:
        return False
    if deal["discount"] < level["min_discount"] or deal["confidence"] not in level["confidence"]:
        return False
    if deal["kind"] not in level["kinds"] or (level["hide_falling"] and deal.get("falling") is True):
        return False
    if level["hide_hurt"] and benched(deal.get("injury")):
        return False
    return deal["kind"] != "bid" or (ends - now).total_seconds() <= level["bid_max_left_min"] * 60


def _player_moves(moves: object) -> dict[str, tuple[str, float]]:
    """Each player's biggest move today of at least PUSH_MOVE_MIN, by `sport:player_id`: (name, change)."""
    found: dict[str, tuple[str, float]] = {}
    if not isinstance(moves, dict):
        return found
    for group in ("risers", "fallers"):
        rows = moves.get(group)
        for row in rows if isinstance(rows, list) else ():
            if not (isinstance(row, dict) and isinstance(row.get("sport"), str) and type(row.get("player_id")) is int
                    and isinstance(row.get("player_name"), str) and isinstance(row.get("change"), (int, float))):
                continue
            if abs(row["change"]) < PUSH_MOVE_MIN:
                continue
            key = f"{row['sport']}:{row['player_id']}"
            if key not in found or abs(row["change"]) > abs(found[key][1]):
                found[key] = (row["player_name"], row["change"])
    return found


# --- sending -------------------------------------------------------------------------------------------------------

class Sender(Protocol):
    """Sends one encrypted alert; answers the push service's HTTP status, or 0 when it could not be asked."""

    def __call__(self, endpoint: str, keys: Mapping[str, str], payload: bytes, ttl: int, urgency: str) -> int: ...


class PushConfig(NamedTuple):
    vapid: Vapid  # the private key, parsed once
    public_key: str  # its public half, raw base64url, as the page hands it to the browser
    subject: str  # the contact push services see in each signature: the site's origin, or a mailto: of the site


def _public_b64(vapid: Vapid) -> str:
    raw = vapid.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _subject(value: str) -> str | None:
    """The contact push services are shown in each signature: the site's https:// origin (taken from any https:// URL
    of it), or a mailto: address of the site as written; None for anything else."""
    if len(value) > 200:
        return None
    if _MAILTO.fullmatch(value):
        return value
    try:
        parts = urlsplit(value)
        host, port = parts.hostname or "", parts.port
    except ValueError:
        return None
    if parts.scheme != "https" or "@" in parts.netloc or port is not None or not _HOST.fullmatch(host):
        return None
    return f"https://{host}"


def config_from_env(environ: Mapping[str, str]) -> PushConfig | None:
    """The VAPID keypair and subject from ADVISOR_VAPID_PRIVATE (the raw 32-byte key in base64url, as
    scripts/gen_vapid.py writes it; never PEM), ADVISOR_VAPID_PUBLIC (its public half) and ADVISOR_VAPID_SUBJECT (the
    site's https:// address, of which only the origin is used, or a mailto: address of the site; never a person's).
    None, silently, when none is set; None with a warning when the set is incomplete or wrong."""
    private, public, raw_subject = (environ.get(name, "").strip() for name in VAPID_VARS)
    if not (private or public or raw_subject):
        return None
    if not (private and public and raw_subject):
        log.warning("web push stays off: set all of %s", ", ".join(VAPID_VARS))
        return None
    subject = _subject(raw_subject)
    if subject is None:
        log.warning("web push stays off: ADVISOR_VAPID_SUBJECT must be the site's https:// address or a mailto: "
                    "address of the site")
        return None
    raw = _b64url_bytes(private)
    if raw is None or len(raw) != 32:
        log.warning("web push stays off: ADVISOR_VAPID_PRIVATE must be the raw 32-byte key in base64url "
                    "(scripts/gen_vapid.py writes one); a PEM key is not taken")
        return None
    try:
        vapid = Vapid.from_raw(private.rstrip("=").encode())
        derived = _public_b64(vapid)
    except Exception as error:  # noqa: BLE001 - any bad key turns the feature off, never the server
        log.warning("web push stays off: ADVISOR_VAPID_PRIVATE is not a usable key (%s)", type(error).__name__)
        return None
    if derived != public.rstrip("="):
        log.warning("web push stays off: ADVISOR_VAPID_PUBLIC is not the public half of ADVISOR_VAPID_PRIVATE")
        return None
    return PushConfig(vapid, derived, subject)


class _NoRedirectSession(requests.Session):
    """A session that never follows a redirect (a push service answering with one gets no second request) and reads
    nothing from the environment (no proxy, no .netrc)."""

    def __init__(self) -> None:
        super().__init__()
        self.trust_env = False

    def request(self, method, url, *args, **kwargs):  # type: ignore[override]
        kwargs["allow_redirects"] = False
        return super().request(method, url, *args, **kwargs)


class WebPushSender:
    """Encrypts an alert for one subscription (aes128gcm), signs it with VAPID (RFC 8292) and posts it, once.

    `session_factory` makes the HTTP session for each send; the default never follows a redirect."""

    def __init__(self, config: PushConfig, timeout: float = PUSH_TIMEOUT_S,
                 session_factory: Callable[[], requests.Session] = _NoRedirectSession):
        self._config = config
        self._timeout = timeout
        self._session_factory = session_factory

    def __call__(self, endpoint: str, keys: Mapping[str, str], payload: bytes, ttl: int, urgency: str) -> int:
        if not endpoint_allowed(endpoint):
            return 0
        session = self._session_factory()
        try:
            response = webpush(
                {"endpoint": endpoint, "keys": dict(keys)},
                data=payload,
                vapid_private_key=self._config.vapid,
                vapid_claims={"sub": self._config.subject},
                ttl=ttl,
                headers={"Urgency": urgency},
                timeout=self._timeout,
                requests_session=session,
            )
            return response.status_code
        except WebPushException as error:
            return error.response.status_code if error.response is not None else 0
        except Exception as error:  # noqa: BLE001 - a send that breaks is a failed send
            log.warning("a push send failed: %s", type(error).__name__)
            return 0
        finally:
            session.close()


# --- the dispatcher ------------------------------------------------------------------------------------------------

def _remember(items: list, item, keep: int) -> None:
    if item not in items:
        items.append(item)
    del items[:-keep]


class TestBudget:
    """How many test sends went out in the last hour, in memory only: per endpoint (by a hash of it, so deleting a
    subscription and making it again starts no new count), at most PUSH_TEST_KEYS_MAX endpoints, and for the whole
    server. Safe to use from several threads at once."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._per_endpoint: OrderedDict[str, list[float]] = OrderedDict()
        self._all: deque[float] = deque()

    def take(self, endpoint: str, now_s: float) -> bool:
        """Counts one test for `endpoint` if it is within PUSH_TESTS_PER_HOUR for it and PUSH_TEST_GLOBAL_PER_HOUR for
        the server; says whether it was."""
        key, since = _hash(endpoint), now_s - 3600
        with self._lock:
            while self._all and self._all[0] <= since:
                self._all.popleft()
            mine = [t for t in self._per_endpoint.pop(key, []) if t > since]
            allowed = len(mine) < PUSH_TESTS_PER_HOUR and len(self._all) < PUSH_TEST_GLOBAL_PER_HOUR
            if allowed:
                mine.append(now_s)
                self._all.append(now_s)
            self._per_endpoint[key] = mine
            while len(self._per_endpoint) > PUSH_TEST_KEYS_MAX:
                self._per_endpoint.popitem(last=False)
            return allowed


class Dispatcher:
    """Matches each snapshot against every subscription and sends what is due, on its own thread.

    `notify()` only queues (at most PUSH_QUEUE snapshots; past that the newest is dropped and the next one catches
    up). `allowed`, set while the Discord gate is on, says of each row whether it may still be served: a row it turns
    down (no member, a login over 30 days old, someone who left our server) is forgotten before anything is sent. `process()` is one round, run by the thread, or directly by a test. `link` is what the snapshot publishes
    as `links.push`: the public key, and how often the server checks (`check_s`, the collector's interval). `clock`
    gives the time in seconds since the epoch: a last call is checked against it right before it goes.
    """

    def __init__(self, store: PushStore, sender: Sender, public_key: str, check_s: float,
                 clock: Callable[[], float] = time.time):
        self.store = store
        self._sender = sender
        self._clock = clock
        self.link = {"public_key": public_key, "check_s": max(1, round(check_s))}
        self._queue: queue.Queue = queue.Queue(maxsize=PUSH_QUEUE)
        self._previous: set[int] | None = None  # the listing ids of the last round's deals; None before it
        self._tests = TestBudget()
        self._thread: threading.Thread | None = None
        self.allowed: Callable[[dict], bool] | None = None

    # The thread.

    def notify(self, snapshot, now) -> None:
        """Queues a snapshot (with its gone rows) and its moment; never blocks, never raises."""
        try:
            self._queue.put_nowait((snapshot, now))
        except queue.Full:
            log.warning("push alerts are behind: a snapshot was skipped")
        except Exception:  # noqa: BLE001
            log.exception("push alerts could not take a snapshot")

    def queued(self) -> int:
        return self._queue.qsize()

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="push-dispatcher", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5) -> None:
        if self._thread is None:
            return
        self._queue.put(None)
        self._thread.join(timeout)
        self._thread = None

    def wait_idle(self, timeout: float) -> bool:
        """Waits until every queued snapshot has been handled; says whether it happened within `timeout`."""
        done = self._queue.all_tasks_done
        deadline = threading.TIMEOUT_MAX if timeout is None else timeout
        with done:
            return done.wait_for(lambda: self._queue.unfinished_tasks == 0, deadline)

    def _run(self) -> None:
        while True:
            item = self._queue.get()
            try:
                if item is None:
                    return
                self.process(*item)
            except Exception:  # noqa: BLE001
                log.exception("a push round failed")
            finally:
                self._queue.task_done()

    # One round.

    def process(self, snapshot, now: datetime) -> None:
        """Sends what this snapshot makes due; never raises."""
        try:
            self._round(snapshot, now)
        except Exception:  # noqa: BLE001
            log.exception("a push round failed")
        finally:
            try:
                self.store.flush()
            except Exception:  # noqa: BLE001
                log.exception("push counters could not be written")

    def _round(self, snapshot, now: datetime) -> None:
        self.store.expire(now.timestamp())
        raw_deals = snapshot.get("deals")
        if isinstance(raw_deals, list):
            deals = [deal for deal in raw_deals if _deal_ok(deal)]
            ids = {deal["listing_id"] for deal in deals}
            new = [] if self._previous is None else [deal for deal in deals if deal["listing_id"] not in self._previous]
            self._previous = ids
        else:  # a snapshot without its deals says nothing about what is new
            deals, new = [], []
        new.sort(key=lambda deal: -deal["discount"])
        moves = _player_moves(snapshot.get("moves"))
        listed = {deal["listing_id"]: deal for deal in deals}
        rows = self.store.rows()
        if self.allowed is not None:
            kept = []
            for row in rows:
                if self.allowed(row):
                    kept.append(row)
                else:  # deleted, not buried: a member back in the server subscribes again
                    self.store.delete(row["endpoint"])
            rows = kept
        failed: Counter[str] = Counter()
        first: Exception | None = None
        for row in rows:
            try:
                self._serve(row, deals, new, listed, moves, now)
            except Exception as error:  # noqa: BLE001 - one row that breaks never stops the others
                failed[type(error).__name__] += 1
                first = first or error
        if first is not None:  # one line for the round, however many rows broke: counts per class, one traceback
            counts = ", ".join(f"{name} x{count}" for name, count in sorted(failed.items()))
            log.error("push round: %d of %d subscriptions could not be served (%s)", sum(failed.values()), len(rows),
                      counts, exc_info=first)

    def _serve(self, row: dict, deals: list[dict], new: list[dict], listed: dict[int, dict], moves: dict,
               now: datetime) -> None:
        endpoint, rules, state = row["endpoint"], row["rules"], row["state"]
        on = rules["categories"]
        local = now + timedelta(minutes=rules["utc_offset_min"])
        hour, day = local.hour, local.date().isoformat()
        follows = set(rules["follows"])

        def deliver(note: Note, cooldown: bool = True, mark: Callable[[dict], None] | None = None) -> None:
            self._deliver(endpoint, note, now, hour, rules["quiet"], cooldown=cooldown, mark=mark)

        if on["deals"] and follows:
            for deal in new:
                lid = deal["listing_id"]
                if (f"{deal['sport']}:{deal['player_id']}" in follows and lid not in state["announced"]
                        and fits(deal, rules, now)):
                    deliver(_deal_note(deal), mark=lambda s, lid=lid: _remember(s["announced"], lid, PUSH_ANNOUNCED_KEPT))
        if on["last_call"]:
            # Only a deal still on the list: a listing that left it is never announced as open.
            for listing_id in rules["opened"]:
                deal = listed.get(listing_id)
                if deal is None or listing_id in state["last_calls"]:
                    continue
                ends = _time(deal["ends_at"])
                if not 0 < (ends - now).total_seconds() <= PUSH_LAST_CALL_S:
                    continue
                if ends.timestamp() <= self._clock():  # the round ran late and it ended meanwhile
                    continue
                deliver(_last_call_note(deal),
                        mark=lambda s, lid=listing_id: _remember(s["last_calls"], lid, _LAST_CALLS_KEPT))
        if on["moves"] and follows:
            for key, (name, change) in moves.items():
                if key in follows and state["moves"].get(key) != day:
                    deliver(_move_note(key, name, change), mark=lambda s, key=key: _moved(s, key, day))
        if on["digest"] and hour == rules["digest_hour"] and state["digest_day"] != day:
            best = sorted((deal for deal in deals if fits(deal, rules, now)), key=lambda deal: -deal["discount"])
            if best:
                deliver(_digest_note(best[:PUSH_DIGEST_SIZE]), cooldown=False,
                        mark=lambda s: s.__setitem__("digest_day", day))
        # The checklist reminder: once a day at the same hour, whatever the deals are (it is not about them).
        if on.get("routine") and hour == rules["digest_hour"] and state["routine_day"] != day:
            deliver(_routine_note(), cooldown=False, mark=lambda s: s.__setitem__("routine_day", day))

    def _deliver(self, endpoint: str, note: Note, now: datetime, hour: int, quiet, *, cooldown: bool,
                 mark: Callable[[dict], None] | None) -> str | None:
        now_s = now.timestamp()
        if not endpoint_allowed(endpoint):
            self.store.bury(endpoint)
            return "gone"
        keys = self.store.claim(endpoint, note.tag, now_s, local_hour=hour, quiet=quiet, cooldown=cooldown, mark=mark)
        if keys is None:
            return None
        result = self.store.settle(endpoint, self._send(endpoint, keys, note), now_s)
        self.store.landed(endpoint, note.tag, result == "sent", mark)
        return result

    def _send(self, endpoint: str, keys: dict, note: Note) -> int:
        try:
            return int(self._sender(endpoint, keys, note.payload(), note.ttl, note.urgency))
        except Exception as error:  # noqa: BLE001 - a sender that breaks is a failed send
            log.warning("a push send failed: %s", type(error).__name__)
            return 0

    # "Send a test".

    def send_test(self, endpoint: str, now: datetime | None = None) -> str:
        """Sends the test alert to a subscribed endpoint: "sent", "limited" (PUSH_TESTS_PER_HOUR an hour for this
        endpoint, or PUSH_TEST_GLOBAL_PER_HOUR for the server), "unknown" (not subscribed), "gone" (the push service
        said it is gone, or it may no longer be sent to), or "failed"."""
        now = now or datetime.now(timezone.utc)
        now_s = now.timestamp()
        try:
            keys = self.store.keys(endpoint)
            if keys is None:
                return "unknown"
            if not endpoint_allowed(endpoint):
                self.store.bury(endpoint)
                return "gone"
            if not self._tests.take(endpoint, now_s):
                return "limited"
            return self.store.settle(endpoint, self._send(endpoint, keys, TEST_NOTE), now_s)
        finally:
            self.store.flush()


def _moved(state: dict, key: str, day: str) -> None:
    """Remembers that `key`'s move went out on `day`, forgetting the days before (so the record stays small)."""
    state["moves"] = {k: d for k, d in state["moves"].items() if d == day}
    state["moves"][key] = day
