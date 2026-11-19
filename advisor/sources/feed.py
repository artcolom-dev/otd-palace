"""The live market feed: one private JSON document over https, read every collector round.

The document is the demo fixture's shape (see `advisor.sources.fixture`, whose row parsers this source reuses) plus
`feed_version` (1), `generated_at` (when it was built) and `coverage` (what it covers). Times in its rows are offsets
from `generated_at`, so a document is read as of the moment it was built, not the moment it was fetched: the snapshot
carries that time, and a document older than `stale_after_s` is refused, so the site goes Paused instead of showing
an old market as live.

Everything about the request is strict. Only https is spoken (plain http to this machine only, for tests), with the
token as a bearer header, no proxy, no redirect, a short timeout, gzip accepted, JSON only and a size limit that
holds for the unzipped body too. Every failure is raised as a `FeedError` whose text is written here and holds
neither the token, the address nor anything the far end said, so it is safe in a log and in the store; the original
exception is dropped, not chained, for the same reason.
"""

import json
import logging
import math
import re
import time
import zlib
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from advisor.model import Challenge, RawData
from advisor.rules import FEED_FUTURE_TOLERANCE_S, FEED_MAX_BYTES, FEED_TIMEOUT_S, FEED_TOKEN_MIN_CHARS, STALE_AFTER_S
from advisor.snapshot import iso_z
from advisor.sources.fixture import parse_fmv, parse_listing, parse_pass_market, parse_sale
from advisor.sources.memory import FeedMemory

FEED_VERSION = 1
LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost"})  # the only hosts plain http may name
USER_AGENT = "advisor-feed/1"
SECTIONS = ("listings", "sales", "fmv", "otd")
_CHUNK = 64 * 1024
_PRINTABLE = re.compile(r"[\x21-\x7e]+")  # no space, no control character, nothing outside ASCII
_SPORT = re.compile(r"[a-z][a-z0-9_-]{0,19}")
MAX_COVERED_SPORTS = 40
MAX_WINDOW_H = 24 * 366
MAX_CHALLENGES = 20
MAX_CHALLENGE_KEY = 64
MAX_CHALLENGE_TITLE = 120
MAX_CHALLENGE_REWARD = 80
log = logging.getLogger(__name__)


class FeedError(RuntimeError):
    """The feed could not be read. The text never holds the token, the address or anything the far end sent."""


class FeedStale(FeedError):
    """The document is older than the site accepts as live."""


class _NoRedirect(HTTPRedirectHandler):
    """A redirect is an answer to refuse: it could lead off the host the token was meant for."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201 - urllib's signature
        return None


# No proxy, whatever the environment says: the token goes to the feed's host and nowhere else.
_OPENER = build_opener(ProxyHandler({}), _NoRedirect)


def config_problem(url: object, token: object) -> str | None:
    """Why this address and token cannot be used, or None when they can. The text names the setting, never its value."""
    if not isinstance(url, str) or not _PRINTABLE.fullmatch(url):
        return "ADVISOR_FEED_URL is missing or not a plain address: set it to the feed's https:// address."
    try:
        parts = urlsplit(url)
        parts.port  # noqa: B018 - raises ValueError for a port that is not a number
    except ValueError:
        return "ADVISOR_FEED_URL is not a valid address: set it to the feed's https:// address."
    if parts.username is not None or parts.password is not None:
        return "ADVISOR_FEED_URL must not carry a user name or password: the token has its own setting."
    if not parts.hostname:
        return "ADVISOR_FEED_URL has no host: set it to the feed's https:// address."
    if parts.scheme != "https" and not (parts.scheme == "http" and parts.hostname in LOCAL_HOSTS):
        return "ADVISOR_FEED_URL must be an https:// address (plain http is for this machine only)."
    if not isinstance(token, str) or not _PRINTABLE.fullmatch(token) or len(token) < FEED_TOKEN_MIN_CHARS:
        return (
            f"ADVISOR_FEED_TOKEN is missing or unusable: it must be at least {FEED_TOKEN_MIN_CHARS} characters, "
            "all visible ASCII, with no space."
        )
    return None


def _read(response, limit: int, deadline: float) -> bytes:
    """The rest of a response, refusing a body past `limit` bytes or past `deadline` (a monotonic time)."""
    body = bytearray()
    while chunk := response.read(min(_CHUNK, limit + 1 - len(body))):
        body += chunk
        if len(body) > limit:
            raise FeedError("the feed's answer is too big")
        if time.monotonic() > deadline:
            raise FeedError("the feed took too long to answer")
    return bytes(body)


def _unzip(body: bytes, limit: int) -> bytes:
    """A gzip body unpacked, refused when it unpacks to more than `limit` bytes (a few kilobytes can hold gigabytes)."""
    unpacker = zlib.decompressobj(wbits=31)
    try:
        out = unpacker.decompress(body, limit + 1)
        if len(out) > limit or unpacker.unconsumed_tail:
            raise FeedError("the feed's answer is too big")
        out += unpacker.flush()
    except zlib.error:
        raise FeedError("the feed's answer is not valid gzip") from None
    if len(out) > limit or not unpacker.eof:
        raise FeedError("the feed's answer is too big" if len(out) > limit else "the feed's answer is cut short")
    return out


def _http_get(url: str, headers: dict[str, str], timeout_s: float, max_bytes: int) -> bytes:
    """The body of a 200 JSON answer, unzipped. Any other outcome raises a FeedError that holds nothing private."""
    request = Request(url, headers=headers, method="GET")
    deadline = time.monotonic() + timeout_s
    failure = None
    try:
        with _OPENER.open(request, timeout=timeout_s) as response:
            if response.status != 200:
                raise FeedError(f"the feed answered {response.status}, not 200")
            declared = response.headers.get("Content-Length", "")
            if declared.isdigit() and int(declared) > max_bytes:
                raise FeedError("the feed's answer is too big")
            if response.headers.get_content_type() != "application/json":
                raise FeedError("the feed did not answer with JSON")
            encoding = (response.headers.get("Content-Encoding") or "identity").strip().lower()
            if encoding not in ("identity", "gzip"):
                raise FeedError("the feed used an encoding that was not asked for")
            body = _read(response, max_bytes, deadline)
            return _unzip(body, max_bytes) if encoding == "gzip" else body
    except FeedError:
        raise
    except HTTPError as error:
        failure = f"the feed answered {error.code}"
    except Exception as error:  # noqa: BLE001 - whatever it was, only its class is kept
        failure = f"the feed could not be reached ({type(error).__name__})"
    raise FeedError(failure)  # outside the handler, so nothing chains the original, whose text may hold the address


def _instant(value: object, what: str) -> datetime:
    """An ISO-8601 time that names its zone, as UTC; anything else is refused."""
    try:
        moment = datetime.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        moment = None
    if moment is None or moment.tzinfo is None or moment.utcoffset() is None:
        raise FeedError(f"the feed's {what} is not a time with a zone")
    return moment.astimezone(timezone.utc)


def _coverage(value: object) -> dict:
    """The document's coverage, checked and cut to its four fields."""
    if not isinstance(value, dict):
        raise FeedError("the feed's coverage is missing")
    sports, complete, window, as_of = (value.get(key) for key in ("sports", "listings_complete", "sales_window_h", "otd_as_of"))
    if (
        not isinstance(sports, list)
        or len(sports) > MAX_COVERED_SPORTS
        or not all(isinstance(sport, str) and _SPORT.fullmatch(sport) for sport in sports)
    ):
        raise FeedError("the feed's coverage does not name its sports")
    if type(complete) is not bool:
        raise FeedError("the feed's coverage does not say whether its listings are complete")
    if type(window) is not int or not 0 < window <= MAX_WINDOW_H:
        raise FeedError("the feed's coverage does not say how many hours of sales it holds")
    return {
        "sports": list(sports),
        "listings_complete": complete,
        "sales_window_h": window,
        "bids": _bids(value.get("watch")),
        # null = the producer has no pass figures on hand (checked against `otd` in `_parse`)
        "otd_as_of": None if as_of is None else iso_z(_instant(as_of, "coverage otd_as_of")),
    }


def _parse(body: bytes, now: datetime, stale_after_s: float) -> RawData:
    """The document as the market of the moment it was built."""
    try:
        document = json.loads(body.decode("utf-8"), parse_constant=_no_constant)
    except (UnicodeDecodeError, ValueError):
        raise FeedError("the feed's answer is not JSON") from None
    if not isinstance(document, dict):
        raise FeedError("the feed's answer is not a JSON object")
    version = document.get("feed_version")
    if type(version) is not int or version != FEED_VERSION:
        raise FeedError(f"the feed's version is not {FEED_VERSION}")
    built = _instant(document.get("generated_at"), "generated_at")
    if built > now + timedelta(seconds=FEED_FUTURE_TOLERANCE_S):
        raise FeedError("the feed's document is dated in the future")
    built = min(built, now)  # a little skew never makes a document fresher than the fetch
    age_s = (now - built).total_seconds()
    if age_s > stale_after_s:
        raise FeedStale(f"the feed's document is {math.ceil(age_s)} s old, past the {stale_after_s:g} s the site accepts")
    if not all(isinstance(document.get(name), list) for name in SECTIONS):
        raise FeedError("the feed's document lacks one of its four sections")
    coverage = _coverage(document.get("coverage"))
    challenges = _challenges(document.get("challenges"), built)
    if coverage["otd_as_of"] is None and document["otd"]:
        raise FeedError("the feed's pass figures do not say when they were measured")
    dropped: list[str] = []
    try:
        raw = RawData(
            fetched_at=built,
            listings=tuple(parse_listing(row, built) for row in document["listings"]),
            fmv=parse_fmv(document["fmv"]),
            sales=tuple(parse_sale(row, built) for row in document["sales"]),
            otd=tuple(parse_pass_market(row, dropped) for row in document["otd"]),
            coverage=coverage,
            challenges=challenges,
        )
    except Exception:  # noqa: BLE001 - a row that does not fit the model: which one is not worth saying
        raise FeedError("the feed has a row that does not match the contract") from None
    if dropped:
        counts = {name: dropped.count(name) for name in sorted(set(dropped))}
        log.warning("the feed's pass rows: fields left out as they do not fit the contract: %s",
                    ", ".join(f"{name} x{n}" for name, n in counts.items()))
    return raw


def _count(value: object) -> int | None:
    return value if type(value) is int and 0 <= value < 10_000_000 else None


def _bids(watch: object) -> dict:
    """The live bid counts per sport from the coverage's optional `watch.bids`; a sport whose figures do not fit is
    left out, never fatal (a side figure, not the market)."""
    bids = watch.get("bids") if isinstance(watch, dict) else None
    if not isinstance(bids, dict):
        return {}
    out = {}
    for sport, row in list(bids.items())[:MAX_COVERED_SPORTS]:
        if not (isinstance(sport, str) and _SPORT.fullmatch(sport) and isinstance(row, dict)):
            continue
        n, who, live = _count(row.get("bids_10m")), _count(row.get("bidders_10m")), row.get("live")
        if n is None or who is None or type(live) is not bool:
            continue
        out[sport] = {"bids_10m": n, "bidders_10m": who, "live": live}
    return out


def _text(value: object, longest: int) -> str | None:
    """A stripped, non-empty string no longer than `longest`, else None."""
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    return text if 0 < len(text) <= longest else None


def _challenges(value: object, built: datetime) -> tuple[Challenge, ...]:
    """The optional `challenges` section: absent is none; a row that does not fit is dropped, never fatal (it is a
    side panel, not the market)."""
    if value is None:
        return ()
    if not isinstance(value, list):
        raise FeedError("the feed's challenges are not a list")
    out = []
    for row in value[:MAX_CHALLENGES]:
        if not isinstance(row, dict):
            continue
        key, title = _text(row.get("key"), MAX_CHALLENGE_KEY), _text(row.get("title"), MAX_CHALLENGE_TITLE)
        reward_raw, ends = row.get("reward"), row.get("ends_in_s")
        reward = None if reward_raw is None else _text(reward_raw, MAX_CHALLENGE_REWARD)
        if key is None or title is None or (reward_raw is not None and reward is None):
            continue
        if ends is not None and (type(ends) is not int or ends < 0):
            continue
        out.append(Challenge(key=key, title=title, reward=reward,
                             ends_at=None if ends is None else built + timedelta(seconds=ends)))
    return tuple(out)


def _no_constant(name: str):
    raise ValueError(name)  # NaN and Infinity are not JSON


class FeedSource:
    """Reads the private feed at `url` with the bearer `token` (see the module's docstring).

    `get(url, headers)` returns the body of the answer, already unzipped; by default it is a real request. A bad `url`
    or `token` raises a ValueError that names the setting, never its value (see `config_problem`).
    """

    def __init__(
        self,
        url: str,
        token: str,
        get: Callable[[str, dict[str, str]], bytes] | None = None,
        *,
        stale_after_s: float = STALE_AFTER_S,
        timeout_s: float = FEED_TIMEOUT_S,
        max_bytes: int = FEED_MAX_BYTES,
        memory: FeedMemory | None = None,
    ):
        problem = config_problem(url, token)
        if problem is not None:
            raise ValueError(problem)
        self._url = url
        self._headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
            "User-Agent": USER_AGENT,
        }
        self._stale_after_s = stale_after_s
        self._max_bytes = max_bytes
        self._memory = memory
        self._get = get or (lambda url, headers: _http_get(url, headers, timeout_s, max_bytes))

    def __repr__(self) -> str:
        return "FeedSource()"  # neither the address nor the token

    def flush(self) -> None:
        """Saves the feed's memory now (the server stopping); nothing without one."""
        if self._memory is not None:
            self._memory.flush()

    @property
    def memory_path(self):
        """Where the feed's memory is kept (see `advisor.sources.memory`), or None without one."""
        return None if self._memory is None else self._memory.path

    def fetch(self, now: datetime) -> RawData:
        """The market as the feed's document describes it, as of the moment the document was built. Raises a FeedError
        (a FeedStale when the document is too old) for anything else, which the collector answers by keeping the last
        snapshot."""
        body = self._get(self._url, dict(self._headers))
        if len(body) > self._max_bytes:
            raise FeedError("the feed's answer is too big")
        raw = _parse(body, now, self._stale_after_s)
        return raw if self._memory is None else self._memory.merge(raw)
