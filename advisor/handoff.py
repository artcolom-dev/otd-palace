"""The sign-in of the site on a phone's home screen, handed back to it.

An app on the home screen does not follow a link that leaves the site: iOS opens discord.com in a Safari window over
the app (Android, in a tab of the browser), Discord sends the visitor back to that window, and the session is made
there, not in the app, which stays signed out. So the app starts the login itself and keeps a secret for it: it asks
for a handoff (POST /auth/handoff), which gives it a claim cookie and the Discord address to open, with a state only
this handoff knows. When Discord sends the visitor back with that state, the session is made as usual and is also
kept for the handoff; the app, which keeps asking (POST /auth/handoff/claim) with its claim cookie, then takes it.

What stops someone from handing their own handoff's Discord address to someone else, to take that person's session:
the session is kept for the handoff only when Discord's answer comes from the network that started it (the same IPv4
address, or the same IPv6 /64), and it is taken from that network too. Elsewhere the login still works, in that window
only. Nothing here is written down: the handoffs live in memory for ten minutes at most (a deploy forgets them, and the
visitor taps Continue again).
"""

from __future__ import annotations

import hashlib
import ipaddress
import secrets
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass

HANDOFF_COOKIE = "__Host-mp_handoff"
HANDOFF_MAX_AGE_S = 10 * 60  # as long as the login's own state lasts
HANDOFF_MAX = 2000  # handoffs kept at once; the oldest leave first
IPV6_PREFIX = 64


def same_network(a: str, b: str) -> bool:
    """Whether two client addresses are the same IPv4 address or in the same IPv6 /64 (a phone's IPv6 address
    changes within its /64). Anything that is not an address matches nothing."""
    try:
        x, y = ipaddress.ip_address(a), ipaddress.ip_address(b)
    except ValueError:
        return False
    if x.version != y.version:
        return False
    if x.version == 4:
        return x == y
    return ipaddress.ip_network(f"{x}/{IPV6_PREFIX}", strict=False) == ipaddress.ip_network(
        f"{y}/{IPV6_PREFIX}", strict=False)


def _digest(claim: str) -> str:
    return hashlib.sha256(claim.encode()).hexdigest()


@dataclass
class _Handoff:
    state: str
    next: str
    address: str
    born: float
    session: str | None = None


@dataclass(frozen=True)
class Claim:
    """What a claim found: "done" with the session, "waiting" (no answer from Discord yet), or "gone" (unknown,
    out of time, or asked from another network)."""

    status: str
    session: str | None = None


class Handoffs:
    """The handoffs on their way. Safe to use from several threads at once."""

    def __init__(self, clock: Callable[[], float] = time.time, max_items: int = HANDOFF_MAX):
        self._clock = clock
        self._max = max_items
        self._lock = threading.Lock()
        self._items: OrderedDict[str, _Handoff] = OrderedDict()  # the claim's digest -> the handoff

    def _drop_old(self) -> None:
        now = self._clock()
        while self._items:
            key, item = next(iter(self._items.items()))
            if now - item.born < HANDOFF_MAX_AGE_S and len(self._items) <= self._max:
                break
            del self._items[key]

    def start(self, next_path: str, address: str) -> tuple[str, str]:
        """(the claim, kept by the app in its cookie; the state to send to Discord) for a new handoff."""
        claim = secrets.token_urlsafe(32)
        state = secrets.token_urlsafe(32)
        with self._lock:
            self._items[_digest(claim)] = _Handoff(state=state, next=next_path, address=address, born=self._clock())
            self._drop_old()
        return claim, state

    def login_state(self, state: object, address: str) -> dict | None:
        """The login's state ({"state", "next"}, as the login cookie holds it) of the handoff Discord's answer names,
        when it is still on time and the answer comes from the network that started it; else None."""
        if not isinstance(state, str) or not state:
            return None
        with self._lock:
            self._drop_old()
            for item in self._items.values():
                if secrets.compare_digest(item.state.encode(), state.encode()):
                    if item.session is None and same_network(item.address, address):
                        return {"state": item.state, "next": item.next}
                    return None
        return None

    def keep(self, state: str, session: str) -> None:
        """Keeps the session a login made for the handoff it started from."""
        with self._lock:
            for item in self._items.values():
                if item.state == state:
                    item.session = session
                    return

    def claim(self, claim: object, address: str) -> Claim:
        """The app's ask, with its claim: the session once Discord has answered (the handoff is then used up)."""
        if not isinstance(claim, str) or not claim:
            return Claim("gone")
        key = _digest(claim)
        with self._lock:
            self._drop_old()
            item = self._items.get(key)
            if item is None or not same_network(item.address, address):
                return Claim("gone")
            if item.session is None:
                return Claim("waiting")
            del self._items[key]
            return Claim("done", item.session)
