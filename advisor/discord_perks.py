"""What linking a Real account unlocks for a member of our Discord: roles, two members-only channels and personal
deal pings, all done by the gate's bot.

ROLES: "Linked" for any linked account, one role per sport with at least SPORT_ROLE_MIN passes in it ("NBA",
"NFL"...), and an account-type role ("Not earning yet", "Starter", "Steady", "Strong", "Big" or "Giant", see
advisor/account_types.py) from the yearly On This Day figure the site reported for the member's account; until it has
reported one, from the number of passes (`advisor.members.roles_for`). The earlier size roles (Rookie, Collector, Big
Account) are taken back from a member at their next refresh, and the bot sweeps every linked member at start, in turns as its queue has room. They are set again on every link, refresh and unlink, by a
background thread (`PerkWorker`), so Discord being slow or down never slows or breaks a link. A role missing from the
server is made once, by name, with no permission at all. Anyone can type any username on the site, so these roles say
nothing proven about anyone: they are cosmetic, and must never be given a permission (nor be used to grant one).
A sport's role is also something a member picks for themselves (the buttons in #welcome and the onboarding question,
`PerkBot.toggle_role`): so a refresh of a linked account only ever adds sport roles, it never takes one back; an unlink
takes them all back with the rest.

CHANNELS: #linked-lounge, seen only by the Linked role, and #big-accounts, seen only by Big and Giant (and both by the
"Palace Team" role when it exists), under the MARKET category. Made once, found by name after that
(`PerkBot.ensure_channels`, run by the worker at start, or by hand: `uv run python -m advisor.discord_perks --setup`).

PINGS: on each fresh snapshot of the live market, a deal that passes the #live-deals quality bar
(`advisor.discord_post.pick_deals`) on a player a member holds or follows on the site goes to that member by DM: each
listing once per member, at most LINK_PINGS_PER_DAY a member in any 24 hours and LINK_PINGS_PER_ROUND from one
snapshot. Members turn them off on the site. A member whose DMs refuse the bot (Discord's 50007, or any 403) is
remembered and gets no more until they turn pings on again.

INVITES: the same worker reads the server's invites for the invite board (advisor/discord_invites.py, /invites) and
gives its two roles; those are not among the roles a refresh or an unlink takes back (`managed_roles`). Reading the
invites needs Manage Server.

The bot needs Manage Roles (its own role above the ones it gives) and Manage Channels for this, on top of the gate's
and the posts' permissions. Turn it all off with ADVISOR_DISCORD_PERKS=0. When Discord says to wait (429) the bot waits
retry_after; when it does not answer (a timeout, a 5xx) it waits DISCORD_BACKOFF_S, doubled each time, up to
DISCORD_BACKOFF_CAP_S. Nothing here logs the token or what Discord said beyond its HTTP status and error code.
"""

import argparse
import json
import logging
import os
import queue
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from advisor.discord_gate import _OPENER, API, USER_AGENT_VERSION, Transport, _url_transport
from advisor.discord_gate import config_from_env as gate_config_from_env
from advisor.discord_post import (
    _DECORATION,
    _SNOWFLAKE,
    DAY,
    _number,
    _parse,
    deal_message,
    pick_deals,
)
from advisor.members import LEGACY_SIZE_ROLES, ROLE_LINKED, SIZE_ROLES, roles_for, sport_role
from advisor.rules import (
    DISCORD_BACKOFF_CAP_S,
    DISCORD_BACKOFF_S,
    DISCORD_POST_CHECK_S,
    DISCORD_RETRY_AFTER_CAP_S,
    LINK_PINGS_PER_DAY,
    LINK_PINGS_PER_ROUND,
    LINK_QUEUE_MAX,
    OTD_SPORT_MONTHS,
)

log = logging.getLogger(__name__)

SWITCH_ENV = "ADVISOR_DISCORD_PERKS"  # "0" turns roles, lounges and pings off
BIG_ACCOUNT_ROLES = ("Big", "Giant")  # the two top account types see #big-accounts
TEAM_ROLE = "palace team"  # compared without case
CATEGORY = "market"  # compared without case
LOUNGES = (("linked-lounge", (ROLE_LINKED,)), ("big-accounts", BIG_ACCOUNT_ROLES))  # channel, the roles that see it
VIEW_CHANNEL = "1024"  # Discord's VIEW_CHANNEL permission bit
DM_PATH = "/" + "users/@me/channels"  # in two pieces, as advisor/discord_gate.IDENTIFY_PATH says why
PING_WORDS = "A deal on one of your players. Turn these off on the site."
_CLOSED = 50007  # Discord: "Cannot send messages to this user"
CHANNELS_RETRY_S = 1800  # a lounge setup that failed is tried again this often
ROLES_CACHE_S = 300  # the server's roles are read again when what we hold is older than this
SYNC_RETRY_S = 30  # a member's role refresh that fails is tried again after this, doubling each time ...
SYNC_RETRY_CAP_S = 300  # ... up to this; it is never given up (the number waiting is bounded by the queue's size)


@dataclass(frozen=True)
class PerkConfig:
    """What the bot needs: its token (left out of the repr), our server and the site's address."""

    bot_token: str = field(repr=False)
    guild_id: str
    public_url: str


def config_from_env(env) -> PerkConfig | None:
    """The perks' settings: the gate's, when they are all set and ADVISOR_DISCORD_PERKS is not "0"; else None."""
    if (env.get(SWITCH_ENV) or "").strip() == "0":
        return None
    gate = gate_config_from_env(env)
    return None if gate is None else PerkConfig(gate.bot_token, gate.guild_id, gate.public_url)


def managed_roles(wanted=()) -> set[str]:
    """Every role the bot gives and takes back: Linked, the account types, the sizes they replaced (taken back, never
    given) and a role per sport."""
    return {ROLE_LINKED, *SIZE_ROLES, *LEGACY_SIZE_ROLES, *(sport_role(s) for s in OTD_SPORT_MONTHS), *wanted}


def perks_state(row: dict | None) -> dict:
    """What the site shows a member of their perks, from their linked account (None: nothing linked)."""
    roles = roles_for(row["summary"], row.get("year")) if row else []
    return {"linked": row is not None, "roles": roles, "lounge": ROLE_LINKED in roles,
            "big_accounts": any(r in roles for r in BIG_ACCOUNT_ROLES),
            "pings": bool(row and row["pings"]), "dm_closed": bool(row and row["dm_closed"])}


class PerkBot:
    """The bot's calls for the perks. Used from one thread (the worker), or by hand; nothing here raises."""

    def __init__(self, config: PerkConfig, transport: Transport | None = None, clock: Callable[[], float] = time.time):
        self._config = config
        self._send = transport or _url_transport(_OPENER.open)
        self._clock = clock
        self._agent = f"DiscordBot ({config.public_url}, {USER_AGENT_VERSION})"
        self._role_ids: dict[str, str] | None = None  # role name (casefolded) -> id, once read
        self._roles_at = 0.0  # when the roles were last read
        self._blocked: set[str] = set()  # role names held by a role with permissions: never given nor taken
        self._every_role: dict[str, str] = {}  # every role's id by name (casefolded), as last read: read only
        self._wait_until = 0.0
        self._fails = 0
        self.last_gone = False  # whether the last `sync_member` found the member out of the server (a 404)
        # The worker's thread and the web's (a member's button or command) both use the bot: one at a time.
        self._lock = threading.RLock()

    @property
    def public_url(self) -> str:
        return self._config.public_url

    def paused(self) -> bool:
        return self._clock() < self._wait_until

    def _call(self, method: str, path: str, body: dict | None = None) -> tuple[int | None, object]:
        """(status, parsed answer); (None, {}) when Discord did not answer, or while it said to wait. A 429, a 5xx or
        no answer at all makes the bot wait before its next call."""
        now = self._clock()
        if now < self._wait_until:
            return None, {}
        headers = {"User-Agent": self._agent, "Authorization": f"Bot {self._config.bot_token}"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()
        try:
            status, raw = self._send(method, API + path, headers, data)
        except Exception as error:  # noqa: BLE001 - a timeout, a refused connection, a fake's error: only its class
            log.warning("Discord perks: Discord did not answer (%s)", type(error).__name__)
            status, raw = None, b""
        answer = _parse(raw)
        if status == 429:
            retry = answer.get("retry_after") if isinstance(answer, dict) else None
            self._wait_until = now + (min(float(retry), DISCORD_RETRY_AFTER_CAP_S)
                                      if _number(retry) and retry >= 0 else DISCORD_BACKOFF_S)
        elif status is None or status >= 500:
            self._fails += 1
            self._wait_until = now + min(DISCORD_BACKOFF_S * 2 ** (self._fails - 1), DISCORD_BACKOFF_CAP_S)
        else:
            self._fails = 0
        return status, answer

    def _roles(self, create=()) -> dict[str, str] | None:
        """The server's roles by name (casefolded), the missing ones of `create` made first; None when they cannot
        be read."""
        g = self._config.guild_id
        # A role we are about to make may have been made since we read the roles (the setup script, a person): read
        # them again first, once, so a name is never made twice.
        if self._role_ids is not None and any(n.casefold() not in self._role_ids and n.casefold() not in self._blocked
                                              for n in create):
            self._role_ids = None
        if self._role_ids is not None and self._clock() - self._roles_at >= ROLES_CACHE_S:
            self._role_ids = None  # a role given a permission since must not go on being handed out
        if self._role_ids is None:
            status, answer = self._call("GET", f"/guilds/{g}/roles")
            if status != 200 or not isinstance(answer, list):
                if status is not None:
                    log.warning("Discord perks: the server's roles could not be read (HTTP %s)", status)
                return None
            ids, blocked = {}, set()  # built aside and set whole: another thread never sees a half-made table
            every = {}  # every role's id by name, whatever it carries: to know a role, never to give one
            for r in answer:
                if not isinstance(r, dict) or not isinstance(r.get("name"), str) or not _SNOWFLAKE.fullmatch(str(r.get("id"))):
                    continue
                name = r["name"].strip().casefold()
                every.setdefault(name, str(r["id"]))
                # A role of that name is the bot's to give and take only while it carries no permission and no
                # integration owns it; any other is left alone (and none is made beside it).
                if str(r.get("permissions", "0")) == "0" and not r.get("managed"):
                    ids.setdefault(name, str(r["id"]))
                else:
                    blocked.add(name)
            self._role_ids, self._blocked, self._roles_at = ids, blocked, self._clock()
            self._every_role = every
            for name in blocked:
                if name not in ids:
                    log.warning("Discord perks: the %r role carries permissions, so the bot leaves it alone", name)
        for name in create:
            if name.casefold() in self._role_ids or name.casefold() in self._blocked:
                continue
            # No permission at all, never mentionable: a cosmetic role anyone can earn by typing a username.
            status, answer = self._call("POST", f"/guilds/{g}/roles",
                                        {"name": name, "permissions": "0", "mentionable": False, "hoist": False})
            if status not in (200, 201) or not isinstance(answer, dict) or not _SNOWFLAKE.fullmatch(str(answer.get("id"))):
                log.warning("Discord perks: the %r role could not be made (HTTP %s)", name, status)
                continue
            self._role_ids[name.casefold()] = str(answer["id"])
        return self._role_ids

    def sync_member(self, uid: str, wanted) -> bool:
        """Gives the member the roles `wanted` and takes back every other role the bot manages (a sport's role only
        when `wanted` is empty, an unlink: a member may have picked it); True once done."""
        with self._lock:
            self.last_gone = False
            return self._sync_member(uid, list(wanted))

    def _sync_member(self, uid: str, wanted: list[str]) -> bool:
        ids = self._roles(create=wanted)
        if ids is None:
            return False
        g = self._config.guild_id
        status, member = self._call("GET", f"/guilds/{g}/members/{uid}")
        if status == 404:
            self.last_gone = True
        if status != 200 or not isinstance(member, dict):
            return False  # left the server (404), or Discord did not answer: the next link asks again
        have = {str(r) for r in member.get("roles", [])} if isinstance(member.get("roles"), list) else set()
        want = {name.casefold() for name in wanted}
        picked = {sport_role(s).casefold() for s in OTD_SPORT_MONTHS} if wanted else set()  # kept, never taken back
        ok = True
        for name in sorted(managed_roles(wanted)):
            rid = ids.get(name.casefold())
            if rid is None:
                continue
            if name.casefold() in want and rid not in have:
                status, _ = self._call("PUT", f"/guilds/{g}/members/{uid}/roles/{rid}")
            elif name.casefold() not in want and name.casefold() not in picked and rid in have:
                status, _ = self._call("DELETE", f"/guilds/{g}/members/{uid}/roles/{rid}")
            else:
                continue
            if status != 204:
                ok = False
                log.warning("Discord perks: a role could not be changed (HTTP %s)", status)
                if status == 404:
                    self._role_ids = None  # a role deleted by hand: read the roles again next time
                if status is None or status == 404 or status == 429:
                    break
        return ok

    def toggle_role(self, uid: str, name: str, held) -> bool | None:
        """A member's own button: gives them the role `name` unless the role's id is among `held` (the roles Discord
        says they have), in which case it is taken back. The role is made first, with no permission, when it is
        missing. True: they have it now; False: they lack it now; None: it could not be done (Discord, or a role that
        carries permissions, which the bot leaves alone)."""
        with self._lock:
            self._role_ids = None  # read the roles fresh: a role given a permission since must not be handed out
            ids = self._roles(create=[name])
            rid = None if ids is None else ids.get(name.casefold())
            if rid is None:
                return None
            on = rid not in {str(r) for r in held}
            g = self._config.guild_id
            status, _ = self._call("PUT" if on else "DELETE", f"/guilds/{g}/members/{uid}/roles/{rid}")
            if status == 404:
                self._role_ids = None  # a role deleted by hand: read the roles again next time
            return on if status == 204 else None

    # -- the invite board (advisor/discord_invites.py) --

    def invites(self) -> list | None:
        """Discord's list of the server's invites (each with who made it and how many times it was used), or None
        when it cannot be read. It needs Manage Server on the bot's role."""
        with self._lock:
            status, answer = self._call("GET", f"/guilds/{self._config.guild_id}/invites")
            if status != 200 or not isinstance(answer, list):
                if status == 403:
                    log.warning("Discord invites: the invites could not be read (HTTP 403): the bot's role needs "
                                "Manage Server")
                elif status is not None:
                    log.warning("Discord invites: the invites could not be read (HTTP %s)", status)
                return None
            return answer

    def role_ids(self, names) -> dict[str, str] | None:
        """The ids of the server's roles called `names` (by casefolded name; a missing one is left out), whatever they
        carry: to know who holds one, never to give it. None when the roles cannot be read."""
        with self._lock:
            if self._roles() is None:
                return None
            wanted = {name.casefold() for name in names}
            return {name: rid for name, rid in self._every_role.items() if name in wanted}

    def member_roles(self, uid: str) -> tuple[str, frozenset[str]]:
        """("ok", the ids of the roles the member holds), ("gone", none) when they are not in the server, or
        ("wait", none) when Discord did not say."""
        with self._lock:
            status, member = self._call("GET", f"/guilds/{self._config.guild_id}/members/{uid}")
            if status == 404:
                return "gone", frozenset()
            if status != 200 or not isinstance(member, dict):
                return "wait", frozenset()
            held = member.get("roles") if isinstance(member.get("roles"), list) else []
            return "ok", frozenset(str(r) for r in held)

    def give_role(self, uid: str, name: str) -> bool | None:
        """Gives the member the role `name`, made first with no permission when it is missing; never takes anything.
        True: they hold it now; None: it could not be done (Discord, a member who left, or a role of that name that
        carries permissions, which the bot leaves alone)."""
        with self._lock:
            self._role_ids = None  # read the roles fresh: a role given a permission since must not be handed out
            ids = self._roles(create=[name])
            rid = None if ids is None else ids.get(name.casefold())
            if rid is None:
                return None
            status, _ = self._call("PUT", f"/guilds/{self._config.guild_id}/members/{uid}/roles/{rid}")
            if status == 404:
                self._role_ids = None  # a role deleted by hand, or a member gone: read the roles again next time
            return True if status == 204 else None

    def take_role(self, uid: str, name: str) -> bool:
        """Takes the role `name` back from the member; True once they do not hold it (taken, no such role to take, or
        the member gone), False when it is to be asked again. A role that carries permissions is left alone (True)."""
        with self._lock:
            ids = self._roles()
            if ids is None:
                return False
            rid = ids.get(name.casefold())
            if rid is None:
                return True
            status, _ = self._call("DELETE", f"/guilds/{self._config.guild_id}/members/{uid}/roles/{rid}")
            if status == 404:
                self._role_ids = None
            return status in (204, 404)

    def ensure_channels(self) -> bool:
        """Makes #linked-lounge and #big-accounts under MARKET, each seen by its role alone (and the team), unless
        a channel of that name exists already. True when both exist after."""
        with self._lock:
            return self._ensure_channels()

    def _ensure_channels(self) -> bool:
        ids = self._roles(create=[name for _, roles in LOUNGES for name in roles])
        if ids is None:
            return False
        g = self._config.guild_id
        status, channels = self._call("GET", f"/guilds/{g}/channels")
        if status != 200 or not isinstance(channels, list):
            return False
        names = {_DECORATION.sub("", c["name"].casefold()) for c in channels
                 if isinstance(c, dict) and isinstance(c.get("name"), str)}
        category = next((str(c["id"]) for c in channels if isinstance(c, dict) and c.get("type") == 4
                         and isinstance(c.get("name"), str) and _DECORATION.sub("", c["name"].casefold()) == CATEGORY
                         and _SNOWFLAKE.fullmatch(str(c.get("id")))), None)
        ok = True
        for channel, seen_by in LOUNGES:
            if channel in names:
                # Found by name: only opened to the roles that lack the right (#big-accounts was Big Account's alone
                # before the account types). Added, never taken away.
                found = next((c for c in channels if isinstance(c, dict) and isinstance(c.get("name"), str)
                              and _DECORATION.sub("", c["name"].casefold()) == channel
                              and _SNOWFLAKE.fullmatch(str(c.get("id")))), None)
                for role in seen_by:
                    rid = ids.get(role.casefold())
                    have = {str(o.get("id")): o for o in (found or {}).get("permission_overwrites") or [] if isinstance(o, dict)}
                    allowed = int(str((have.get(rid) or {}).get("allow", "0")) or 0) & int(VIEW_CHANNEL)
                    if found is None or rid is None or allowed:
                        continue
                    status, _ = self._call("PUT", f"/channels/{found['id']}/permissions/{rid}",
                                           {"type": 0, "allow": VIEW_CHANNEL, "deny": "0"})
                    if status not in (200, 204):
                        log.warning("Discord perks: #%s could not be opened to %s (HTTP %s)", channel, role, status)
                        ok = False
                continue
            rids = [ids.get(role.casefold()) for role in seen_by]
            if category is None or None in rids:
                log.warning("Discord perks: #%s not made (no MARKET category or no %s role)", channel, "/".join(seen_by))
                ok = False
                continue
            overwrites = [{"id": g, "type": 0, "allow": "0", "deny": VIEW_CHANNEL}]  # @everyone's role id is the guild's
            overwrites += [{"id": rid, "type": 0, "allow": VIEW_CHANNEL, "deny": "0"} for rid in rids]
            team = ids.get(TEAM_ROLE)
            if team is not None:
                overwrites.append({"id": team, "type": 0, "allow": VIEW_CHANNEL, "deny": "0"})
            status, _ = self._call("POST", f"/guilds/{g}/channels", {"name": channel, "type": 0, "parent_id": category,
                                                                     "permission_overwrites": overwrites})
            if status not in (200, 201):
                log.warning("Discord perks: #%s could not be made (HTTP %s)", channel, status)
                ok = False
        return ok

    def dm(self, uid: str, channel: str | None, message: dict, again: bool = True) -> tuple[str, str | None]:
        with self._lock:
            return self._dm(uid, channel, message, again)

    def _dm(self, uid: str, channel: str | None, message: dict, again: bool = True) -> tuple[str, str | None]:
        """Sends `message` to the member by DM: ("ok", the DM channel), ("closed", None) when their DMs refuse the
        bot, ("wait", None) when Discord said to wait or did not answer, ("fail", None) for any other refusal. A DM
        channel kept from before that Discord no longer knows (404) is opened again, once."""
        if channel is None:
            status, answer = self._call("POST", DM_PATH, {"recipient_id": uid})
            if status is None or status == 429 or status >= 500:
                return "wait", None
            if status != 200 or not isinstance(answer, dict) or not _SNOWFLAKE.fullmatch(str(answer.get("id"))):
                return ("closed" if status == 403 else "fail"), None
            channel = str(answer["id"])
        status, answer = self._call("POST", f"/channels/{channel}/messages", message)
        if status is None or status == 429 or status >= 500:
            return "wait", None
        if 200 <= status < 300:
            return "ok", channel
        code = answer.get("code") if isinstance(answer, dict) else None
        if status == 403 or code == _CLOSED:
            return "closed", None
        if status == 404 and again:
            return self._dm(uid, None, message, again=False)
        log.warning("Discord perks: a DM was refused (HTTP %d, code %s)", status, code)
        return "fail", None


class PerkWorker:
    """Refreshes members' roles when asked (`request_sync`, from the web app's link routes) and sends the personal
    deal pings of each new snapshot (`run`). `drain` and `ping_round` do one step each, for tests and by hand."""

    def __init__(self, bot: PerkBot, links, clock: Callable[[], float] = time.time, queue_max: int = LINK_QUEUE_MAX):
        self.bot = bot
        self.links = links
        self._clock = clock
        self._queue: queue.Queue[str] = queue.Queue(maxsize=queue_max)
        self._queued: set[str] = set()
        self._tries: dict[str, int] = {}  # uid -> failed refreshes in a row
        self._later: dict[str, float] = {}  # uid -> when its failed refresh is tried again
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._queue_max = queue_max
        self._sweep_todo: list[str] | None = None  # members the start-up sweep has still to ask for
        self.invites = None  # the invite board (advisor/discord_invites.InviteBoard), read in this loop; None: off

    def sweep(self) -> int:
        """At start: asks for a refresh of every linked member's roles, so the earlier size roles leave them even if they
        never open the site again. The queue holds only so many at once, so a call asks for as many as fit and the rest
        wait for the next call (each loop of `run`); how many were asked for this time (0 once all were)."""
        if self._sweep_todo is None:
            self._sweep_todo = list(self.links.uids())
        asked = 0
        while self._sweep_todo and self._queue.qsize() < self._queue_max:
            self.request_sync(self._sweep_todo.pop(0), wake=False)
            asked += 1
        return asked

    def request_sync(self, uid: str, wake: bool = True) -> None:
        """Asks for the member's roles to be set again from their link; never blocks, never raises."""
        with self._lock:
            if uid in self._queued:
                return
            try:
                self._queue.put_nowait(uid)
            except queue.Full:
                return
            self._queued.add(uid)
        if wake:
            self._wake.set()

    def drain(self) -> int:
        """Refreshes the roles of every member asked for; says how many. A refresh that failed is asked for again after
        a growing delay (SYNC_RETRY_S, doubling to SYNC_RETRY_CAP_S), with no hard give-up; while Discord says to
        wait the bot is not called at all."""
        done = 0
        now = self._clock()
        for uid in [u for u, due in self._later.items() if due <= now]:
            del self._later[uid]
            self.request_sync(uid, wake=False)
        failed: list[str] = []
        while not self.bot.paused():
            try:
                uid = self._queue.get_nowait()
            except queue.Empty:
                break
            with self._lock:
                self._queued.discard(uid)
            row = self.links.get(uid)
            try:
                ok = self.bot.sync_member(uid, roles_for(row["summary"], row.get("year")) if row else [])
            except Exception:  # noqa: BLE001 - one member's roles are never worth the thread
                log.exception("Discord perks: a role refresh failed")
                ok = False
            done += 1
            gone = not ok and self.bot.last_gone
            if row is not None:
                self.links.note_gone(uid, gone)
            if ok or gone:  # out of the server: not retried, the next sweep or link asks again (a rejoin gets its roles)
                self._tries.pop(uid, None)
                self._later.pop(uid, None)
            else:  # half done or not at all (a 429, Discord down): again later, a little later each time
                failed.append(uid)
        now = self._clock()
        for uid in failed:
            tries = self._tries.get(uid, 0) + 1
            if uid not in self._later and len(self._later) >= self._queue_max:
                self._tries.pop(uid, None)  # too many waiting: the next link or the next start asks again
                continue
            self._tries[uid] = tries
            self._later[uid] = now + min(SYNC_RETRY_S * 2 ** (tries - 1), SYNC_RETRY_CAP_S)
        return done

    def ping_round(self, snapshot: dict | None, fresh: bool) -> int:
        """DMs each member the new deals on their players (see the module's docstring); says how many went out."""
        now = self._clock()
        if not fresh or not isinstance(snapshot, dict) or self.bot.paused():
            return 0
        picks = pick_deals(snapshot, now)  # none on sample data
        if not picks:
            return 0
        rules = snapshot.get("rules") if isinstance(snapshot.get("rules"), dict) else {}
        sports = rules.get("photo_sports") if isinstance(rules.get("photo_sports"), list) else []
        photo_sports = {s for s in sports if isinstance(s, str)}
        sent = 0
        for uid, row in self.links.pingable():
            room = LINK_PINGS_PER_DAY - sum(1 for _, at in row["pinged"] if 0 <= now - at < DAY)
            done = {lid for lid, _ in row["pinged"]}
            mine = set(row["players"]) | set(row["follows"])
            channel = row["dm_channel"]
            for deal in picks:
                if room <= 0 or sent >= LINK_PINGS_PER_ROUND:
                    break
                if deal["listing_id"] in done or f"{deal['sport']}:{deal['player_id']}" not in mine:
                    continue
                held = row["owned"].get(f"{deal['sport']}:{deal['season']}:{deal['player_id']}")
                if held is not None and held >= deal["rarity"]:
                    continue  # a card of a pass they hold at its rarity or higher: they own it already
                message = deal_message(deal, self.bot.public_url, photo_sports) | {"content": PING_WORDS}
                outcome, opened = self.bot.dm(uid, channel, message)
                if outcome == "wait":
                    return sent
                if outcome == "closed":
                    self.links.note_dm(uid, closed=True)
                    break
                self.links.note_ping(uid, deal["listing_id"], now)  # sent, or refused for good: never again
                if outcome == "ok":
                    if opened != channel:
                        self.links.note_dm(uid, channel=opened)
                        channel = opened
                    room -= 1
                    sent += 1
            if sent >= LINK_PINGS_PER_ROUND:
                break
        return sent

    def invites_round(self) -> None:
        """Reads Discord's invites into the board when a read is due (the board decides); never raises."""
        if self.invites is None:
            return
        try:
            self.invites.refresh(self.bot)
        except Exception:  # noqa: BLE001 - the board is never worth the thread
            log.exception("Discord invites: a read failed")

    def run(self, store, stop: threading.Event, check_s: float = DISCORD_POST_CHECK_S) -> None:
        """Makes the lounges (until it works), then refreshes roles as asked and pings on each new snapshot until
        `stop` is set. A failure is logged and the loop goes on; nothing here stops the server."""
        channels_ok = False
        channels_next = 0.0  # a failed setup (no MARKET category, no right) is tried again every CHANNELS_RETRY_S
        seen = None
        while not stop.is_set():
            try:
                self.sweep()
                if not channels_ok and not self.bot.paused() and self._clock() >= channels_next:
                    channels_ok = self.bot.ensure_channels()
                    channels_next = self._clock() + CHANNELS_RETRY_S
                self.drain()
                self.invites_round()
                health = store.health()
                version = health.get("version")
                if version is not None and version != seen:
                    current = store.current()
                    if current is not None:
                        seen = version
                        self.ping_round(json.loads(current[0]), bool(health.get("ok")))
            except Exception:  # noqa: BLE001 - the next round is tried all the same
                log.exception("a Discord perks round failed")
            self._wake.wait(check_s)
            self._wake.clear()  # a request made from here on wakes the next wait; one made before is in the queue


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Makes #linked-lounge and #big-accounts in our Discord, once.")
    parser.add_argument("--setup", action="store_true", required=True, help="make the lounges and their roles")
    parser.parse_args(argv)
    config = config_from_env(os.environ)
    if config is None:
        print("The Discord gate's settings are not set (or ADVISOR_DISCORD_PERKS=0): nothing to do.", file=sys.stderr)
        return 2
    ok = PerkBot(config).ensure_channels()
    print("The lounges are there." if ok else "The lounges could not all be made: see the log above.")
    return 0 if ok else 1


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    sys.exit(main())
