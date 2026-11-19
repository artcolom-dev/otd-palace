"""The invite board of our Discord server (/invites): how many people joined through each member's own invite links.

THE COUNT is Discord's own and nothing else: the server's invites (`GET /guilds/{id}/invites`, which needs Manage
Server on the bot's role), each with who made it and how many times it was used. A member's count is the sum over the
links they made. It is "joins through your invite links": it includes people who left since, and nobody who came in
another way (the site's one-click join adds a member with no link at all, so it counts for nobody). Discord forgets
a link's joins when the link expires or is deleted, so the highest count ever seen for a member is what is kept and
shown: the board never goes down.

THE BOARD lists the INVITES_TOP highest. Bots are never counted. The staff (STAFF_ROLES) and members who left the
server are counted but left off the board, so an inviter is listed only once Discord said who they are: the bot asks
about at most INVITES_CHECKS_PER_ROUND inviters a read, the highest counts first, and again every
INVITES_MEMBER_CHECK_S.

THE ROLES (advisor/rules.py INVITE_ROLES) are for show. The count is easy to inflate with second accounts, so they
carry no right and must never be given one: the bot makes them with no permission and leaves alone a role of that name
that carries any (advisor/discord_perks.PerkBot). A role is given once, when its threshold is first reached; the board
never takes one back, and never gives again one the staff took back by hand. The staff get none.

WHAT IS KEPT (invites.json, listed in the privacy notice): per Discord id, the highest count seen, the invite roles
given, and whether they are on the staff or out of the server; no name, no invite code. "Delete my data"
(advisor/privacy.py) drops the member's row, takes the invite roles back (the one time the bot does) and keeps a
dated mark, so nothing is kept under them again until they type /invites themselves.

Read by the perks worker in its own loop (`InviteBoard.refresh`, at most every INVITES_REFRESH_S); the command only
reads what the board holds, so Discord being slow never slows an answer. Nothing here logs a token, a name or what
Discord said beyond its HTTP status.
"""

import json
import logging
import os
import tempfile
import threading
import time
from collections.abc import Callable
from pathlib import Path

from advisor.discord_post import _SNOWFLAKE, _number
from advisor.rules import (
    INVITE_ROLES,
    INVITERS_MAX,
    INVITES_CHECKS_PER_ROUND,
    INVITES_GRANTS_PER_ROUND,
    INVITES_MEMBER_CHECK_S,
    INVITES_REFRESH_S,
    INVITES_TOP,
)

log = logging.getLogger(__name__)

SWITCH_ENV = "ADVISOR_DISCORD_INVITES"  # "0" turns the board off (the perks stay on)
# The roles of the people who run the server (scripts/discord_setup.py STAFF_ROLES; a test keeps them equal).
STAFF_ROLES = ("Palace Team", "Admin", "Moderator", "Helper")
ROLE_NAMES = tuple(name for name, _ in INVITE_ROLES)
USES_MAX = 10_000_000  # a count beyond this is no count

RESTING = "The invite board is resting. Try again in a few minutes."
BACK = "You had deleted your data: your invites are counted again from the next read, in a few minutes."
HOW_TO = ("**Your own link:** tap the server's name, then Invite People, then Edit invite link. Set Expire After to "
          "Never and Max Number of Uses to No Limit, and copy the link. Only joins through a link you made count for you.")
FINE_PRINT = (f"-# Discord's count: joins through a link, including people who left since. "
              f"Read every {INVITES_REFRESH_S // 60} minutes.")


def tally(invites: object) -> dict[str, int]:
    """Joins by inviter (a Discord id) from Discord's list of the server's invites: each link's `uses` summed over
    the links a member made. A link with no maker (the vanity link, a widget's), a bot's link and anything misshapen
    are left out."""
    found: dict[str, int] = {}
    for item in invites if isinstance(invites, list) else ():
        inviter = item.get("inviter") if isinstance(item, dict) else None
        if not isinstance(inviter, dict) or inviter.get("bot") is True:
            continue
        uid, uses = inviter.get("id"), item.get("uses")
        if not isinstance(uid, str) or not _SNOWFLAKE.fullmatch(uid) or type(uses) is not int or not 0 <= uses <= USES_MAX:
            continue
        found[uid] = min(found.get(uid, 0) + uses, USES_MAX)
    return found


def _joins(n: int) -> str:
    return f"{n:,} join" if n == 1 else f"{n:,} joins"


def earned(count: int) -> list[str]:
    """The invite roles `count` joins earn, lowest first."""
    return [name for name, needed in INVITE_ROLES if count >= needed]


def _row(value: object) -> dict | None:
    """A kept row as it must be, or None: {"best": joins, "given": [role names], "out": None | "staff" | "gone",
    "checked": when Discord last said who they are, or None}."""
    if not isinstance(value, dict):
        return None
    best, given, out, checked = value.get("best"), value.get("given"), value.get("out"), value.get("checked")
    if type(best) is not int or not 0 <= best <= USES_MAX or out not in (None, "staff", "gone"):
        return None
    if checked is not None and not _number(checked):
        return None
    given = [name for name in given if name in ROLE_NAMES] if isinstance(given, list) else []
    return {"best": best, "given": sorted(set(given), key=ROLE_NAMES.index), "out": out, "checked": checked}


class InviteBoard:
    """The counts, by Discord id, kept in one small file. Safe to use from several threads at once (the worker
    writes, the command reads): every change is made under one lock and written whole before the lock is let go."""

    def __init__(self, path: Path, clock: Callable[[], float] = time.time, max_inviters: int = INVITERS_MAX):
        self.path = path
        self._clock = clock
        self._max = max_inviters
        self._lock = threading.Lock()
        self._rows: dict[str, dict] = {}
        self._erased: dict[str, float] = {}  # uid -> when they deleted their data: nothing is kept under them
        self._take_back: list[str] = []  # erased members whose invite roles are still to be taken back
        self._read_at: float | None = None  # when Discord's invites were last read
        self._staff: frozenset[str] = frozenset()  # the staff roles' ids, as last read (memory only)
        self._next = 0.0  # no read before this
        self._load()

    def __repr__(self) -> str:
        return "InviteBoard()"

    # -- the file --

    def _load(self) -> None:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except (OSError, ValueError) as error:
            log.warning("invite board: %s could not be read (%s); starting empty", self.path.name, type(error).__name__)
            self._set_aside()
            return
        rows = data.get("inviters") if isinstance(data, dict) else None
        if not isinstance(rows, dict):
            self._set_aside()
            return
        gone = data.get("erased")
        for uid, at in (gone.items() if isinstance(gone, dict) else ()):
            if isinstance(uid, str) and _SNOWFLAKE.fullmatch(uid) and _number(at) and len(self._erased) < self._max:
                self._erased[uid] = float(at)
        for uid, value in rows.items():
            row = _row(value)
            if not isinstance(uid, str) or not _SNOWFLAKE.fullmatch(uid) or row is None or uid in self._erased:
                continue
            self._rows[uid] = row
            if len(self._rows) >= self._max:
                break
        back = data.get("take_back")
        self._take_back = [uid for uid in (back if isinstance(back, list) else ()) if uid in self._erased]
        self._read_at = float(data["read_at"]) if _number(data.get("read_at")) else None

    def _set_aside(self) -> None:
        try:
            os.replace(self.path, self.path.with_name(self.path.name + ".corrupt"))
        except OSError:
            pass

    def _save(self) -> bool:
        """Writes the file through a temporary one next to it (call with the lock held); says whether it worked."""
        tmp_name = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=self.path.parent,
                                             prefix=f".{self.path.name}.", suffix=".tmp", delete=False) as tmp:
                tmp_name = tmp.name
                json.dump({"inviters": self._rows, "erased": self._erased, "take_back": self._take_back,
                           "read_at": self._read_at}, tmp, separators=(",", ":"))
            os.replace(tmp_name, self.path)
            return True
        except OSError as error:
            log.warning("invite board: %s could not be written (%s)", self.path.name, type(error).__name__)
            if tmp_name is not None:
                try:
                    os.unlink(tmp_name)
                except OSError:
                    pass
        return False

    # -- what the command reads --

    def ready(self) -> bool:
        """Whether Discord's invites were ever read (now or before a restart)."""
        with self._lock:
            return self._read_at is not None

    def count(self, uid: str) -> int:
        """The highest number of joins seen through the member's links; 0 for anyone unknown."""
        with self._lock:
            row = self._rows.get(uid)
            return row["best"] if row else 0

    def _listed(self) -> list[tuple[str, int]]:
        """Everyone on the board, highest first (the older Discord id first among equals); call with the lock held."""
        rows = [(uid, row["best"]) for uid, row in self._rows.items()
                if row["best"] >= 1 and row["checked"] is not None and row["out"] is None]
        return sorted(rows, key=lambda item: (-item[1], int(item[0])))

    def top(self, n: int = INVITES_TOP) -> list[tuple[str, int]]:
        """The first `n` of the board as (Discord id, joins)."""
        with self._lock:
            return self._listed()[:n]

    def is_staff(self, uid: str, held: object) -> bool:
        """Whether the member is on the staff: by the roles Discord says they hold (`held`, role ids) when the staff
        roles' ids are known, else by what the last check found."""
        with self._lock:
            if self._staff:
                return bool(self._staff & {r for r in (held if isinstance(held, list) else ()) if isinstance(r, str)})
            row = self._rows.get(uid)
            return row is not None and row["out"] == "staff"

    def rank(self, uid: str) -> int | None:
        """The member's place on the board (1 is the top), counted among the listed; None with no join."""
        with self._lock:
            row = self._rows.get(uid)
            if row is None or row["best"] < 1:
                return None
            mine = (-row["best"], int(uid))
            return 1 + sum(1 for other, best in self._listed() if other != uid and (-best, int(other)) < mine)

    # -- delete my data --

    def erase(self, uid: str) -> bool:
        """"Delete my data": drops the member's row, asks for the invite roles they were given to be taken back, and
        keeps a dated mark so nothing is kept under them again; says whether a row was dropped. A failed write is
        logged: what is in memory is erased all the same."""
        if not isinstance(uid, str) or not _SNOWFLAKE.fullmatch(uid):
            return False
        with self._lock:
            row = self._rows.pop(uid, None)
            if uid not in self._erased and len(self._erased) >= self._max:
                self._erased.pop(next(iter(self._erased)))  # the oldest mark makes room
            self._erased[uid] = self._clock()
            if row is not None and row["given"] and uid not in self._take_back:
                self._take_back.append(uid)
            self._save()
            return row is not None

    def erased(self, uid: str) -> bool:
        with self._lock:
            return uid in self._erased

    def back(self, uid: str) -> None:
        """The member asked for their invites themselves: they are counted again from the next read."""
        with self._lock:
            if self._erased.pop(uid, None) is not None:
                self._take_back = [u for u in self._take_back if u != uid]
                self._save()

    # -- the read --

    def record(self, found: dict[str, int]) -> bool:
        """Takes one read's counts in: each member's highest stays. A newcomer is kept while there is room, the highest
        counts first; nobody kept is ever dropped. Says whether anything changed."""
        changed = False
        with self._lock:
            for uid, uses in sorted(found.items(), key=lambda item: (-item[1], item[0])):
                if uid in self._erased:
                    continue
                row = self._rows.get(uid)
                if row is None:
                    if uses < 1 or len(self._rows) >= self._max:
                        continue
                    self._rows[uid] = {"best": uses, "given": [], "out": None, "checked": None}
                    changed = True
                elif uses > row["best"]:
                    row["best"] = uses
                    changed = True
        return changed

    def refresh(self, bot) -> bool:
        """One read of Discord's invites when one is due (every INVITES_REFRESH_S) and the bot is not waiting: the
        counts, then who the highest unknown inviters are, then the roles earned, then the roles an erased member
        must lose. True when the invites were read. `bot` is the perks' (advisor/discord_perks.PerkBot)."""
        now = self._clock()
        if now < self._next or bot.paused():
            return False
        self._next = now + INVITES_REFRESH_S
        invites = bot.invites()
        if invites is None:
            return False
        self.record(tally(invites))
        with self._lock:
            self._read_at = now
        staff = bot.role_ids(STAFF_ROLES)
        if staff is not None:
            with self._lock:
                self._staff = frozenset(staff.values())
            self._check_members(bot, now)
            self._give_roles(bot)
        self._take_roles_back(bot)
        with self._lock:
            self._save()
        return True

    def _check_members(self, bot, now: float) -> None:
        with self._lock:
            due = [(uid, row["best"]) for uid, row in self._rows.items()
                   if row["best"] >= 1 and (row["checked"] is None or now - row["checked"] >= INVITES_MEMBER_CHECK_S)]
            staff = self._staff
        due.sort(key=lambda item: (-item[1], int(item[0])))
        for uid, _ in due[:INVITES_CHECKS_PER_ROUND]:
            state, held = bot.member_roles(uid)
            if state == "wait":
                return
            with self._lock:
                row = self._rows.get(uid)
                if row is not None:
                    row["out"] = "gone" if state == "gone" else "staff" if staff & held else None
                    row["checked"] = now

    def _give_roles(self, bot) -> None:
        with self._lock:
            owed = [(uid, name) for uid, _ in self._listed() for name in earned(self._rows[uid]["best"])
                    if name not in self._rows[uid]["given"]]
        for uid, name in owed[:INVITES_GRANTS_PER_ROUND]:
            if bot.give_role(uid, name) is not True:
                continue  # Discord, a member just gone, or a role that carries rights: asked again at the next read
            with self._lock:
                row = self._rows.get(uid)
                if row is not None and name not in row["given"]:
                    row["given"] = sorted([*row["given"], name], key=ROLE_NAMES.index)

    def _take_roles_back(self, bot) -> None:
        with self._lock:
            todo = list(self._take_back)
        for uid in todo[:INVITES_GRANTS_PER_ROUND]:
            if all(bot.take_role(uid, name) for name in ROLE_NAMES):
                with self._lock:
                    self._take_back = [u for u in self._take_back if u != uid]


def answer(board: InviteBoard | None, uid: str, held: object) -> str:
    """What /invites says to the member `uid`, who holds the roles `held` (ids, from Discord's own payload): their
    count and place, the roles, the board, how to make a link that lasts, and what the number is."""
    if board is None or not uid or not board.ready():
        return RESTING
    lines = []
    if board.erased(uid):
        board.back(uid)
        lines.append(BACK)
    count, staff = board.count(uid), board.is_staff(uid, held)
    if staff:
        mine = f"{_joins(count)} through your invite links" if count else "no join through your invite links yet"
        lines.append(f"**Your invites:** {mine}. The team is left off the board.")
    elif count < 1:
        lines.append("**Your invites:** no join through your invite links yet.")
    else:
        rank = board.rank(uid)
        lines.append(f"**Your invites:** {_joins(count)} through your invite links · #{rank} on the board")
    if not staff:
        have = earned(count)
        ahead = [(name, needed) for name, needed in INVITE_ROLES if name not in have]
        if not have:
            steps = ", ".join(f"**{name}** {'comes ' if i == 0 else ''}at {needed}{' joins' if i == 0 else ''}"
                              for i, (name, needed) in enumerate(ahead))
            lines.append(f"{steps}. {'Both' if len(ahead) == 2 else 'They'} are for show: they unlock nothing.")
        elif ahead:
            lines.append(f"You have earned **{have[-1]}**. Next: **{ahead[0][0]}** at {ahead[0][1]} joins.")
        else:
            lines.append(f"You have earned **{have[-1]}**, the top invite role.")
    lines.append("**Top inviters**")
    top = board.top()
    if top:
        lines.extend(f"{place}. <@{other}> · {_joins(joins)}" for place, (other, joins) in enumerate(top, 1))
    else:
        lines.append("Nobody is on the board yet: the first join through a member's own link takes the top spot.")
    return "\n".join([*lines, HOW_TO, FINE_PRINT])
