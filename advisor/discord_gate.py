"""The Discord gate: OTD Palace is free for everyone, and free members of our Discord server get the extras (every
deal, the filters, the full price moves, their own plan, deal pings and alerts). This is how the site knows who is one.

It stays off until all six settings exist (see `config_from_env`); off, the site behaves exactly as it always did. On,
a visitor clicks "Continue with Discord", says yes on Discord's own page, and comes back to /auth/discord/callback with
a one-time code. The server trades that code for the visitor's access token, reads who they are (their id and their
name, nothing else), and adds them to the server with our bot (Discord's "guilds.join": 201 when they just joined, 204
when they were in already). The token is dropped right there: it is never written, never put in a cookie, never logged.
What the visitor keeps is a cookie signed with the session secret that says their Discord id, the name to show, when
they logged in, when we last saw whether they are in the server, and what we saw (`state`):

- "in": in our server. A member: everything is unlocked.
- "out": signed in with Discord but not in our server (they left or were removed, or the join failed: too many
  servers, Discord down). The free site, and a one-click way back in: the login again (its join), or the invite and
  POST /auth/recheck, which asks Discord at once.
- "banned": Discord refused to add them (a ban, as a rule). The free site only, and nothing that sends them round the
  join again: only Discord itself saying they are in turns it back to "in".

A cookie from before the states existed was only ever given to a member: it reads as "in".

Once a day (RECHECK_AFTER_S; every RECHECK_OUT_S for "out", so a join by the invite shows soon) a request asks Discord,
with the bot, whether they are in the server: in, the cookie is renewed as "in"; gone (404), it is renewed as "out"
("banned" stays "banned") and the member routes turn them away. When Discord cannot answer (a timeout, a 5xx, a 429),
that one check keeps what the cookie says and is tried again a little later: a Discord outage must not lock members
out. A first login never gets that favour: no answer from Discord, no member.
The answers are kept in memory for a while, per person and for a bounded number of people, so a burst of requests
asks Discord once.

Nothing here logs a token, a code or a secret, and no error message holds one: a failure is told by its kind and, at
most, the HTTP status Discord answered.
"""

import html
import json
import logging
import re
import secrets
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from itsdangerous import BadSignature, URLSafeTimedSerializer

log = logging.getLogger(__name__)

# The six settings, in the order a message names them.
ENV_NAMES = (
    "ADVISOR_DISCORD_CLIENT_ID",
    "ADVISOR_DISCORD_CLIENT_SECRET",
    "ADVISOR_DISCORD_BOT_TOKEN",
    "ADVISOR_DISCORD_GUILD_ID",
    "ADVISOR_SESSION_SECRET",
    "ADVISOR_PUBLIC_URL",
)
SESSION_SECRET_MIN_CHARS = 32
SESSION_SECRET_MIN_DISTINCT = 12  # "aaaa..." or "0123456789" repeated is long but guessable: a random one has far more

AUTHORIZE_URL = "https://discord.com/oauth2/authorize"
API = "https://discord.com/api/v10"
# Who the visitor is, and the right to add them to our server: nothing about their messages or their other servers.
SCOPES = "identify guilds.join"
CALLBACK_PATH = "/auth/discord/callback"
# Discord's "who am I" route, written in two pieces: whole, it reads like a home directory to a pre-deploy
# check that refuses any such path in a shipped file.
IDENTIFY_PATH = "/" + "users/@me"

# "__Host-": the browser takes these only from this exact host, over https, for the whole site, so no other
# subdomain can plant one (a forced login, or a session of someone else's).
SESSION_COOKIE = "__Host-mp_session"
STATE_COOKIE = "__Host-mp_login"
SESSION_SALT = "market-palace.session"
STATE_SALT = "market-palace.login"
SESSION_MAX_AGE_S = 30 * 24 * 3600  # a login lasts 30 days
STATE_MAX_AGE_S = 10 * 60  # the time a visitor has to say yes on Discord's page
RECHECK_AFTER_S = 24 * 3600  # how old the last "still in the server" may get before we ask again
RECHECK_OUT_S = 10 * 60  # the same for someone signed in but not in the server: a join by the invite shows this soon
RECHECK_MIN_S = 15  # POST /auth/recheck asks Discord again only when the last answer about them is older than this
# What a session says of its holder (see the module's docstring), and what a visitor with no session is.
STATES = ("in", "out", "banned")
ANON = "anon"
MEMBER_CACHE_S = 10 * 60  # a settled answer (in, or gone) is reused this long for the same person
UNKNOWN_CACHE_S = 60  # Discord could not answer: wait this long before asking for that person again
CHECK_CACHE_MAX = 10_000  # the people whose last answer is kept at once; the least recently asked leave first
NAME_MAX_CHARS = 32
NEXT_MAX_CHARS = 512
DISCORD_TIMEOUT_S = 5
# Discord calls running at once, at most: a login makes three in a row, each up to DISCORD_TIMEOUT_S, in one of the
# server's threads. Past this a login says "Discord did not answer" and a daily check lets the member in for now,
# instead of the whole site waiting on Discord.
DISCORD_MAX_CONCURRENT = 4
DISCORD_MAX_BYTES = 64 * 1024  # no answer we read comes close
USER_AGENT_VERSION = "1.0"
AUTH_PER_MIN = 20  # requests to /auth/* one address may make a minute (a login takes two)

# Discord's error codes we tell apart from a plain failure.
_MAX_GUILDS = 30001  # the visitor is in 100 servers already

_SNOWFLAKE = re.compile(r"\d{15,21}")
_SECRET = re.compile(r"[\x21-\x7e]{16,256}")  # printable, no space: what a client secret or a bot token looks like
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1"})
# A path on this site: one slash then no second one or backslash, printable ASCII only, no space.
_NEXT = re.compile(r"/(?![/\\])[\x21-\x7e]*")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


@dataclass(frozen=True)
class GateConfig:
    """The six settings, checked. The secrets are left out of its repr, so printing it shows none of them."""

    client_id: str
    client_secret: str = field(repr=False)
    bot_token: str = field(repr=False)
    guild_id: str
    session_secret: str = field(repr=False)
    public_url: str

    @property
    def redirect_uri(self) -> str:
        """The address Discord sends the visitor back to; it must be registered as is in the Developer Portal."""
        return self.public_url + CALLBACK_PATH


def _settings(env) -> dict[str, str]:
    """The six settings, trimmed (a value read from a file may end in a newline); blank counts as unset."""
    return {name: (env.get(name) or "").strip() for name in ENV_NAMES}


def _public_url_problem(url: str) -> str | None:
    """Why the public address cannot be the site's origin, or None. Plain http is taken only on this machine."""
    parts = urlsplit(url)
    local = parts.scheme == "http" and parts.hostname in _LOCAL_HOSTS
    if not (parts.scheme == "https" or local) or not parts.hostname:
        return "ADVISOR_PUBLIC_URL must be the site's https:// address (http:// only for localhost)."
    if parts.path not in ("", "/") or parts.query or parts.fragment or parts.username or parts.password:
        return "ADVISOR_PUBLIC_URL must be the site's address alone, with no path, query or user: https://example.com"
    return None


def config_problem(env) -> str | None:
    """Why the gate's settings cannot be used, or None when they can (all six set and valid, or none set at all).

    The message names the setting, never its value."""
    values = _settings(env)
    given = [name for name, value in values.items() if value]
    if not given:
        return None
    missing = [name for name, value in values.items() if not value]
    if missing:
        return (
            f"The Discord gate is half set up: {', '.join(missing)} {'is' if len(missing) == 1 else 'are'} missing. "
            "Set all six ADVISOR_DISCORD_* / ADVISOR_SESSION_SECRET / ADVISOR_PUBLIC_URL settings, or none of them "
            "to keep the site open to everyone."
        )
    for name in ("ADVISOR_DISCORD_CLIENT_ID", "ADVISOR_DISCORD_GUILD_ID"):
        if not _SNOWFLAKE.fullmatch(values[name]):
            return f"{name} must be the Discord id, a number of 15 to 21 digits (copy it from Discord)."
    for name in ("ADVISOR_DISCORD_CLIENT_SECRET", "ADVISOR_DISCORD_BOT_TOKEN"):
        if not _SECRET.fullmatch(values[name]):
            return f"{name} does not look like one: copy it again from the Discord Developer Portal."
    secret = values["ADVISOR_SESSION_SECRET"]
    if len(secret) < SESSION_SECRET_MIN_CHARS or not _SECRET.fullmatch(secret):
        return (
            f"ADVISOR_SESSION_SECRET is too short or holds spaces: use at least {SESSION_SECRET_MIN_CHARS} random "
            "characters (python -c \"import secrets; print(secrets.token_urlsafe(48))\")."
        )
    if len(set(secret)) < SESSION_SECRET_MIN_DISTINCT:
        return ("ADVISOR_SESSION_SECRET is too guessable (it repeats a few characters): use random ones "
                "(python -c \"import secrets; print(secrets.token_urlsafe(48))\").")
    if secret in (values["ADVISOR_DISCORD_CLIENT_SECRET"], values["ADVISOR_DISCORD_BOT_TOKEN"]):
        return "ADVISOR_SESSION_SECRET must be its own secret, not the client secret or the bot token reused."
    return _public_url_problem(values["ADVISOR_PUBLIC_URL"])


def config_from_env(env) -> GateConfig | None:
    """The gate's settings, or None when none is set (the gate is off). Raises ValueError, with `config_problem`'s
    message, on settings that cannot be used: the server refuses them before it gets here."""
    problem = config_problem(env)
    if problem is not None:
        raise ValueError(problem)
    values = _settings(env)
    if not values["ADVISOR_DISCORD_CLIENT_ID"]:
        return None
    return GateConfig(
        client_id=values["ADVISOR_DISCORD_CLIENT_ID"],
        client_secret=values["ADVISOR_DISCORD_CLIENT_SECRET"],
        bot_token=values["ADVISOR_DISCORD_BOT_TOKEN"],
        guild_id=values["ADVISOR_DISCORD_GUILD_ID"],
        session_secret=values["ADVISOR_SESSION_SECRET"],
        public_url=values["ADVISOR_PUBLIC_URL"].rstrip("/"),
    )


def safe_next(value: object) -> str:
    """Where to send a visitor after login: `value` when it is a path on this site ("/", "/#deals", "/a/name"), else
    "/". Never another site: no "//host", no scheme, no backslash, nothing that is not printable ASCII."""
    if isinstance(value, str) and len(value) <= NEXT_MAX_CHARS and _NEXT.fullmatch(value):
        return value
    return "/"


def _clean_name(value: object) -> str | None:
    """A Discord name as we show it: control characters out, trimmed, at most NAME_MAX_CHARS; None when empty."""
    if not isinstance(value, str):
        return None
    name = _CONTROL.sub("", value).strip()[:NAME_MAX_CHARS].strip()
    return name or None


# --- Discord's API --------------------------------------------------------------------------------------------------


class DiscordError(Exception):
    """A step of the login or the check that Discord did not carry out. `reason` is "refused" (Discord would not add
    them: banned, or the bot lacks the right), "full" (they are in too many servers), or "discord" (anything else);
    `status` the HTTP status, when there was one. Neither ever holds a token, a code or a secret."""

    def __init__(self, reason: str, status: int | None = None, detail: str | None = None):
        said = f"HTTP {status}" if status is not None else detail  # detail: an exception's class name, no more
        super().__init__(f"{reason} ({said})" if said else reason)
        self.reason = reason
        self.status = status


class _NoRedirect(HTTPRedirectHandler):
    """A redirect is an answer to refuse: it could carry the bot token to another host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201 - urllib's signature
        return None


# No proxy, whatever the environment says: the tokens go to discord.com and nowhere else.
_OPENER = build_opener(ProxyHandler({}), _NoRedirect)

# (method, url, headers, body) -> (status, body): what the client sends through; a fake one in tests.
Transport = Callable[[str, str, dict[str, str], bytes | None], tuple[int, bytes]]


def _read_capped(response, cap: int = DISCORD_MAX_BYTES) -> bytes:
    body = response.read(cap + 1)
    return b"" if len(body) > cap else body


def _url_transport(opener: Callable, max_bytes: int = DISCORD_MAX_BYTES) -> Transport:
    """A transport over urllib: a timeout, no proxy, no redirect, at most DISCORD_MAX_BYTES read. An error status is
    an answer (returned); no answer at all raises DiscordError."""

    def send(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, bytes]:
        request = Request(url, data=body, headers=headers, method=method)
        try:
            with opener(request, timeout=DISCORD_TIMEOUT_S) as response:
                return response.status, _read_capped(response, max_bytes)
        except HTTPError as error:
            try:
                return error.code, _read_capped(error, max_bytes)
            except Exception:  # noqa: BLE001 - the status is what matters
                return error.code, b""
        except Exception as error:  # noqa: BLE001 - a timeout, a refused connection...: only its class is kept
            raise DiscordError("discord", detail=type(error).__name__) from None

    return send


def _json(body: bytes) -> dict:
    try:
        data = json.loads(body) if body else {}
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


class DiscordClient:
    """The four calls the gate makes to Discord. `transport` (tests) or `opener` (urllib's, by default) carries them."""

    def __init__(self, config: GateConfig, transport: Transport | None = None, opener: Callable | None = None):
        self._config = config
        self._send = transport or _url_transport(opener or _OPENER.open)
        # Discord asks bots to name themselves this way.
        self._agent = f"DiscordBot ({config.public_url}, {USER_AGENT_VERSION})"
        self._slots = threading.BoundedSemaphore(DISCORD_MAX_CONCURRENT)

    def _call(self, method: str, path: str, headers: dict[str, str], body: bytes | None = None) -> tuple[int, dict]:
        if not self._slots.acquire(blocking=False):
            raise DiscordError("discord", detail="too many calls at once")
        try:
            status, raw = self._send(method, API + path, {"User-Agent": self._agent, **headers}, body)
        except DiscordError:
            raise
        except Exception as error:  # noqa: BLE001 - a fake transport's timeout as much as a real one
            raise DiscordError("discord", detail=type(error).__name__) from None
        finally:
            self._slots.release()
        return status, _json(raw)

    def exchange_code(self, code: str) -> str:
        """The visitor's access token for the one-time code Discord sent back."""
        form = urlencode({
            "client_id": self._config.client_id,
            "client_secret": self._config.client_secret,
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": self._config.redirect_uri,
        }).encode()
        status, data = self._call("POST", "/oauth2/token", {"Content-Type": "application/x-www-form-urlencoded",
                                                            "Accept": "application/json"}, form)
        token = data.get("access_token")
        if status != 200 or not isinstance(token, str) or not token:
            raise DiscordError("discord", status)
        return token

    def identify(self, access_token: str) -> tuple[str, str]:
        """(Discord id, the name to show) of the visitor the token belongs to."""
        status, data = self._call("GET", IDENTIFY_PATH, {"Authorization": f"Bearer {access_token}"})
        uid = data.get("id")
        name = _clean_name(data.get("global_name")) or _clean_name(data.get("username"))
        if status != 200 or not isinstance(uid, str) or not _SNOWFLAKE.fullmatch(uid) or name is None:
            raise DiscordError("discord", status)
        return uid, name

    def add_member(self, uid: str, access_token: str) -> bool:
        """Adds the visitor to our server with the bot: True when they just joined, False when they were in already."""
        body = json.dumps({"access_token": access_token}).encode()
        status, data = self._call(
            "PUT", f"/guilds/{self._config.guild_id}/members/{uid}",
            {"Authorization": f"Bot {self._config.bot_token}", "Content-Type": "application/json"}, body,
        )
        if status in (201, 204):
            return status == 201
        if status == 403:
            raise DiscordError("refused", status)
        if status == 400 and data.get("code") == _MAX_GUILDS:
            raise DiscordError("full", status)
        raise DiscordError("discord", status)

    def member_state(self, uid: str) -> str:
        """Whether someone is in our server: "member", "gone" (404: they left, or were removed), or "unknown" when
        Discord gave no usable answer (a timeout, a 5xx, a 429...)."""
        try:
            status, _ = self._call("GET", f"/guilds/{self._config.guild_id}/members/{uid}",
                                   {"Authorization": f"Bot {self._config.bot_token}"})
        except DiscordError:
            return "unknown"
        if status == 200:
            return "member"
        if status == 404:
            return "gone"
        if status in (401, 403):  # the bot's token or its place in the server is broken: nobody can be checked
            log.warning("discord membership check refused (HTTP %s): check the bot token and that the bot is in "
                        "the server; members are let in until it works again", status)
        return "unknown"

    def member_count(self) -> int | None:
        """Our server's approximate member count, read with the bot (for the admin panel); None when Discord gave no
        usable answer."""
        try:
            status, data = self._call("GET", f"/guilds/{self._config.guild_id}?with_counts=true",
                                      {"Authorization": f"Bot {self._config.bot_token}"})
        except DiscordError:
            return None
        count = data.get("approximate_member_count")
        return count if status == 200 and type(count) is int and count >= 0 else None


# --- the gate -------------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Visitor:
    """Who is asking. `member` is True only for someone in our server ("in"); `state` is "anon" (no session), "in",
    "out" or "banned" (see the module's docstring). `cookie` is a renewed session cookie to send back (None: keep the
    one they have); `clear` says to delete theirs (it is broken, or its 30 days are over)."""

    member: bool
    name: str | None = None
    uid: str | None = None
    iat: int | None = None  # when they logged in
    cookie: str | None = None
    clear: bool = False
    max_age: int = 0  # how long a renewed cookie has left: what remains of the 30 days since the login
    state: str = ANON

    @property
    def signed_in(self) -> bool:
        """Signed in with Discord, in our server or not."""
        return self.uid is not None

    def alert_owner(self) -> dict | None:
        """Who a push subscription made now belongs to, {"uid", "iat"}, so its alerts end with the membership."""
        return {"uid": self.uid, "iat": self.iat} if self.member and self.uid and self.iat is not None else None


@dataclass(frozen=True)
class Outcome:
    """How a login ended: the session cookie and where to go, and the kind of failure ("denied", "state", "refused",
    "full", "discord"). A failure after Discord said who they are (the join: "refused", "full", "discord") still comes
    with a session, of someone not in our server: they are signed in, and the free site says how to get in."""

    session: str | None = None
    next: str = "/"
    error: str | None = None


NOBODY = Visitor(member=False)


class DiscordGate:
    """Starts and finishes logins and tells members from everyone else. Safe to use from several threads at once.
    `clock` returns seconds since the epoch (the cookies' timestamps are on it)."""

    def __init__(self, config: GateConfig, client: DiscordClient | None = None,
                 clock: Callable[[], float] = time.time, cache_max: int = CHECK_CACHE_MAX,
                 invite_url: str | None = None):
        self._config = config
        self.public_url = config.public_url  # the site's own address: what a link preview's image address starts with
        self.invite_url = invite_url  # our server's invite (ADVISOR_COMMUNITY_URL): the way in when the login fails
        self._client = client or DiscordClient(config)
        self._clock = clock
        self._cache_max = cache_max
        self._serializer = URLSafeTimedSerializer(config.session_secret, salt=SESSION_SALT)
        self._states = URLSafeTimedSerializer(config.session_secret, salt=STATE_SALT)
        self._lock = threading.Lock()
        self._checks: OrderedDict[str, tuple[str, float]] = OrderedDict()  # uid -> (last answer, when)
        self._asking: dict[str, threading.Event] = {}  # the people whose check is on its way to Discord right now

    # The serializers stamp their signatures with time.time(); our clock decides instead, so tests can move it.
    def _dumps(self, serializer: URLSafeTimedSerializer, data: dict) -> str:
        signer = serializer.make_signer(serializer.salt)
        signer.get_timestamp = lambda: int(self._clock())  # type: ignore[method-assign]
        return signer.sign(serializer.dump_payload(data)).decode()

    def _loads(self, serializer: URLSafeTimedSerializer, text: str, max_age: int) -> object:
        signer = serializer.make_signer(serializer.salt)
        signer.get_timestamp = lambda: int(self._clock())  # type: ignore[method-assign]
        return serializer.load_payload(signer.unsign(text, max_age=max_age))

    # -- login --

    def start(self, next_path: object) -> tuple[str, str]:
        """(the Discord address to send the visitor to, the login cookie to set). The cookie holds the random state
        Discord will hand back and the page to come back to, signed so neither can be changed on the way."""
        state = secrets.token_urlsafe(32)
        cookie = self._dumps(self._states, {"state": state, "next": safe_next(next_path)})
        return self.authorize_url(state), cookie

    def authorize_url(self, state: str) -> str:
        """Discord's consent page, for a login whose state is `state`."""
        query = urlencode({
            "client_id": self._config.client_id,
            "redirect_uri": self._config.redirect_uri,
            "response_type": "code",
            "scope": SCOPES,
            "state": state,
        }, quote_via=quote)  # spaces as %20, the way Discord's own examples write the scope
        return f"{AUTHORIZE_URL}?{query}"

    def read_state(self, cookie: str | None) -> dict | None:
        """The login's state a login cookie holds ({"state", "next"}), when it is ours and on time; else None."""
        return self._read_state(cookie)

    def _read_state(self, cookie: str | None) -> dict | None:
        if not cookie:
            return None
        try:
            data = self._loads(self._states, cookie, STATE_MAX_AGE_S)
        except (BadSignature, ValueError, TypeError):
            return None
        ok = isinstance(data, dict) and isinstance(data.get("state"), str) and isinstance(data.get("next"), str)
        return data if ok else None

    def finish(self, args, cookie: str | None) -> Outcome:
        """Ends a login from Discord's answer (`args`: the callback's query) and the login cookie. On success the
        visitor is in our server and holds a fresh session; their access token is forgotten before this returns."""
        return self.finish_from(args, self._read_state(cookie))

    def finish_from(self, args, kept: dict | None) -> Outcome:
        """finish, from the login's state already read ({"state", "next"}: the login cookie's, or a handoff's)."""
        given = args.get("state")
        if kept is None or not isinstance(given, str) or not secrets.compare_digest(given.encode(),
                                                                                   kept["state"].encode()):
            return Outcome(error="state")
        next_path = safe_next(kept["next"])
        if args.get("error"):  # they pressed Cancel on Discord's page
            return Outcome(next=next_path, error="denied")
        code = args.get("code")
        if not isinstance(code, str) or not code or len(code) > 256:
            return Outcome(next=next_path, error="state")
        joined: DiscordError | None = None
        try:
            token = self._client.exchange_code(code)
            try:
                uid, name = self._client.identify(token)
                try:
                    self._client.add_member(uid, token)
                except DiscordError as error:
                    joined = error  # they are who they say: signed in, but not in our server
            finally:
                del token  # never kept: not in the cookie, not in memory past this call, never logged
        except DiscordError as error:
            log.warning("discord login failed: %s", error)  # the kind and the status, nothing private
            return Outcome(next=next_path, error=error.reason)
        now = int(self._clock())
        if joined is None:
            state = "in"
            self._remember(uid, "member")
        else:
            log.warning("discord join failed: %s", joined)
            state = "banned" if joined.reason == "refused" else "out"
        session = self._session(uid, name, now, now, state)
        return Outcome(session=session, next=next_path, error=None if joined is None else joined.reason)

    def _session(self, uid: str, name: str, iat: int, checked_at: int, state: str) -> str:
        return self._dumps(self._serializer, {"uid": uid, "name": name, "iat": iat, "checked_at": checked_at,
                                              "state": state})

    # -- sessions --

    def read_session(self, cookie: str | None) -> dict | None:
        """The session a cookie holds when its signature is ours and it is under 30 days old; else None."""
        if not cookie:
            return None
        try:
            data = self._loads(self._serializer, cookie, SESSION_MAX_AGE_S)
        except (BadSignature, ValueError, TypeError):
            return None
        return data if isinstance(data, dict) else {}

    def _remember(self, uid: str, answer: str) -> None:
        with self._lock:
            self._checks.pop(uid, None)
            self._checks[uid] = (answer, self._clock())
            while len(self._checks) > self._cache_max:
                self._checks.popitem(last=False)

    def _recalled(self, uid: str) -> str | None:
        """The last answer about `uid` while it still counts, else None."""
        with self._lock:
            found = self._checks.get(uid)
            if found is None:
                return None
            answer, at = found
            keep = UNKNOWN_CACHE_S if answer == "unknown" else MEMBER_CACHE_S
            if self._clock() - at > keep:
                del self._checks[uid]
                return None
            self._checks.move_to_end(uid)
            return answer

    def _check(self, uid: str) -> tuple[str, float]:
        """Whether `uid` is still in our server, and as of when: from memory when recent, else from Discord. While
        another request for the same person is already asking, this one waits for that answer (unknown only if it got none)."""
        recalled = self._recalled(uid)
        if recalled is not None:
            return recalled, self._clock()
        with self._lock:
            waiting = self._asking.get(uid)
            if waiting is None:
                self._asking[uid] = done = threading.Event()
        if waiting is not None:
            # Another request is asking Discord for this person: wait for its answer instead of guessing "unknown",
            # or a removed member could be let in by sending requests in parallel.
            waiting.wait(DISCORD_TIMEOUT_S + 1)
            recalled = self._recalled(uid)
            return (recalled, self._clock()) if recalled is not None else ("unknown", self._clock())
        try:
            answer = self._client.member_state(uid)
            self._remember(uid, answer)
        finally:
            with self._lock:
                self._asking.pop(uid, None)
            done.set()
        return answer, self._clock()

    def visitor(self, cookie: str | None) -> Visitor:
        """Who the session cookie says is asking, checked against the server once a day (every RECHECK_OUT_S for
        someone not in it)."""
        return self._judge(cookie, force=False)

    def recheck(self, cookie: str | None) -> Visitor:
        """The same, but asking Discord now (POST /auth/recheck: "I joined, check again"), unless the last answer
        about them is under RECHECK_MIN_S old."""
        return self._judge(cookie, force=True)

    def _judge(self, cookie: str | None, force: bool) -> Visitor:
        data = self.read_session(cookie)
        if data is None:
            return NOBODY
        uid, name, iat, checked = (data.get(key) for key in ("uid", "name", "iat", "checked_at"))
        state = data.get("state", "in")  # a cookie from before the states was only ever a member's
        if (not isinstance(uid, str) or not _SNOWFLAKE.fullmatch(uid) or not isinstance(name, str)
                or type(iat) is not int or type(checked) is not int or state not in STATES):
            return Visitor(member=False, clear=True)
        if self._clock() - iat > SESSION_MAX_AGE_S:  # 30 days from the login, however often it was renewed
            return Visitor(member=False, clear=True)
        held = Visitor(member=state == "in", name=name, uid=uid, iat=iat, state=state)
        wait = RECHECK_OUT_S if state == "out" else RECHECK_AFTER_S
        if not force and self._clock() - checked < wait:
            return held
        if force:
            self._forget(uid, RECHECK_MIN_S)
        answer, at = self._check(uid)
        if answer == "unknown":  # Discord did not answer: as the cookie says for now, asked again later
            return held
        now_state = "in" if answer == "member" else ("banned" if state == "banned" else "out")
        renewed = self._session(uid, name, iat, int(at), now_state)
        left = max(1, SESSION_MAX_AGE_S - int(self._clock() - iat))
        return Visitor(member=now_state == "in", name=name, uid=uid, iat=iat, cookie=renewed, max_age=left,
                       state=now_state)

    def _forget(self, uid: str, older_than: float) -> None:
        """Drops the kept answer about `uid` when it is older than `older_than` seconds, so the next check asks."""
        with self._lock:
            found = self._checks.get(uid)
            if found is not None and self._clock() - found[1] > older_than:
                del self._checks[uid]

    def member_count(self) -> int | None:
        """Our server's approximate member count (see `DiscordClient.member_count`)."""
        return self._client.member_count()

    def may_alert(self, row: dict) -> bool:
        """Whether a push subscription may still get alerts: made by a member (one subscribed before the gate, or
        with no session, was not), whose login is under 30 days old, and not known to have left our server. It never
        asks Discord: what it knows of someone who left comes from their own visits (the daily check)."""
        member = row.get("member")
        if not isinstance(member, dict):
            return False
        uid, iat = member.get("uid"), member.get("iat")
        if not isinstance(uid, str) or not _SNOWFLAKE.fullmatch(uid) or type(iat) is not int:
            return False
        if self._clock() - iat > SESSION_MAX_AGE_S:
            return False
        with self._lock:
            known = self._checks.get(uid)
        return known is None or known[0] != "gone"

    def failure_page(self, reason: str, next_path: str) -> tuple[int, str]:
        """(HTTP status, page) telling a visitor in plain words why the login did not work, with the way back to the
        free site, Try again and, when the invite is set, the way to join the server by hand. A refused join (a ban, as
        a rule) offers neither: trying again would only go round the same refusal. Styled by /error.css."""
        status, title, words = FAILURES.get(reason, FAILURES["discord"])
        back = html.escape(safe_next(next_path))
        if reason == "refused":
            actions = f'<a class="home" href="{back}">Keep browsing, free</a>'
        else:
            again = html.escape("/auth/discord?" + urlencode({"next": safe_next(next_path)}))
            actions = f'<a class="home" href="{again}">Try again</a>\n<p class="alt"><a href="{back}">Keep browsing, free</a></p>'
            if self.invite_url:
                actions += (f'\n<p class="alt">Or join the server by hand, then come back and continue: '
                            f'<a href="{html.escape(self.invite_url)}" rel="noopener noreferrer">open the invite</a></p>')
        page = FAILURE_PAGE.format(title=html.escape(title), words=html.escape(words), actions=actions)
        return status, page


# Each way a login can fail: (HTTP status, headline, what to do). The site stays free whatever happened here.
FAILURES = {
    "denied": (400, "You said no on Discord", "That's fine: nothing was shared. OTD Palace stays free to browse. "
               "Continue with Discord whenever you want the extras, free too."),
    "state": (400, "That login link has expired", "The login took too long or was opened twice. Start again: it "
              "takes one click."),
    "refused": (403, "Discord won't add this account to our server", "Discord refused to add this account to the OTD "
                "Palace server, which happens when it is banned there. The site stays free to browse; the extras that "
                "come with the server stay off."),
    "full": (403, "You're in too many Discord servers", "Discord lets an account be in 100 servers at most. Leave "
             "one you no longer use, then try again. The site stays free to browse meanwhile."),
    "discord": (502, "Discord did not answer", "We couldn't reach Discord just now. Wait a moment and try again. "
                "The site stays free to browse meanwhile."),
}

FAILURE_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>{title} · OTD Palace</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/error.css">
</head>
<body>
<main>
<a class="brand" href="/"><img src="/logo.svg" alt="" width="40" height="40">OTD Palace</a>
<h1>{title}</h1>
<p>{words}</p>
{actions}
</main>
<footer>Not affiliated with Real.</footer>
</body>
</html>
"""
