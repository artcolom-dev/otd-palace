"""The admin panel's deep tabs, computed from the activity store (advisor/activity.py), the members' links
(advisor/members.py) and the alert subscriptions: Members (one row per member who signed in, and each one's
timeline), Accounts (the Real accounts looked up), Features (what the page is used for), Sources (first touch to a
member still there at D7) and Discord. For the admin only (advisor/web.py guards every route); times are seconds
since the epoch, days are UTC days.
"""

import csv
import io
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone

from advisor.account_types import type_by_passes, type_of
from advisor.activity import DAY_S, ActivityLog, day_of
from advisor.rules import ACTIVITY_PAGE_EVENTS

WINDOW_DAYS = 30
SOURCE_DAYS = 90
TIMELINE_MAX = 600
ACCOUNTS_SHOWN = 300
SOURCES_SHOWN = 25
TOP_ARGS = 8
STATES = ("anon", "out", "in")
CLASSES = ("phone", "tablet", "desktop")
# What the Features tab counts: what the page does, and what the server sees of it (the tab views, the Discord button).
FEATURES = ("load", "tab", "signin", *(k for k in ACTIVITY_PAGE_EVENTS if k not in ("time", "session", "year")))
_AVATAR = re.compile(r"(a_)?[0-9a-f]{32}")


def avatar_url(uid: str, avatar: str | None) -> str | None:
    """Discord's address of someone's avatar, small; None without one."""
    if not avatar or not _AVATAR.fullmatch(avatar):
        return None
    return f"https://cdn.discordapp.com/avatars/{uid}/{avatar}.png?size=64"


def _day_name(day: int) -> str:
    return datetime.fromtimestamp(day * DAY_S, timezone.utc).date().isoformat()


def _source_name(source: str | None) -> str:
    return source or "direct"


def _kind_of(row: dict | None) -> tuple[str | None, int | None]:
    """(account type, yearly figure) of a member's link: the type of the figure the site reported, else the one its
    number of passes most often has (as the Discord role does)."""
    if row is None:
        return None, None
    year = row.get("year")
    if isinstance(year, int):
        return type_of(year).name, year
    return type_by_passes(row.get("summary", {}).get("passes", 0)).name, None


def _sports(row: dict | None) -> list[str]:
    sports = (row or {}).get("summary", {}).get("sports", {})
    if not isinstance(sports, dict):
        return []
    return [s for s, x in sorted(sports.items(), key=lambda kv: (-kv[1].get("n", 0), kv[0])) if isinstance(x, dict)]


def _link_of(links, uid: str) -> dict | None:
    return links.get(uid) if links is not None else None


# --- Members ------------------------------------------------------------------------------------------------------


def members_report(activity: ActivityLog, links, push_uids: set[str], now: int) -> dict:
    """One row per member who signed in on the site (see the module's docstring), most recently seen first."""
    read = activity.read
    since30 = day_of(now) - WINDOW_DAYS + 1
    agg = {m: (days, sessions, time_s, first, last) for m, days, sessions, time_s, first, last in read(
        "SELECT member, COUNT(DISTINCT ts / 86400), SUM(kind = 'session'), SUM(CASE WHEN kind = 'time' THEN n ELSE 0"
        " END), MIN(ts), MAX(ts) FROM events WHERE member IS NOT NULL GROUP BY member")}
    devices = {m: (n, first) for m, n, first in read(
        "SELECT member, COUNT(*), MIN(first) FROM devices WHERE member IS NOT NULL GROUP BY member")}
    sources = dict(read("SELECT member, source FROM devices d WHERE member IS NOT NULL AND first ="
                        " (SELECT MIN(first) FROM devices WHERE member = d.member)"))
    people = {uid: (name, avatar, roles, present) for uid, name, avatar, roles, present in read(
        "SELECT uid, name, avatar, roles, present FROM d_people")}
    messages = dict(read("SELECT uid, SUM(n) FROM d_msgs WHERE day >= ? GROUP BY uid", (since30,)))
    lookups = dict(read("SELECT member, COUNT(*) FROM lookups WHERE member IS NOT NULL GROUP BY member"))
    rows = []
    for uid, name, first, last, state in read("SELECT uid, name, first, last, state FROM members"):
        days, sessions, time_s, ev_first, ev_last = agg.get(uid, (0, 0, 0, None, None))
        n_devices, dev_first = devices.get(uid, (0, None))
        d_name, d_avatar, d_roles, present = people.get(uid, (None, None, None, None))
        link = _link_of(links, uid)
        kind, year = _kind_of(link)
        first_seen = min(x for x in (first, ev_first, dev_first) if x is not None)
        last_seen = max(x for x in (last, ev_last) if x is not None)
        rows.append({
            "uid": uid, "name": d_name or name or "?", "avatar": avatar_url(uid, d_avatar),
            "first": first_seen, "last": last_seen, "days": days or 0, "sessions": sessions or 0,
            "time_s": time_s or 0, "devices": n_devices, "source": _source_name(sources.get(uid)),
            "in_server": bool(present) if present is not None else (state == "in" if state else None),
            "state": state, "linked": link["username"] if link else None, "type": kind, "year": year,
            "passes": link["summary"].get("passes", 0) if link else None, "sports": _sports(link),
            "pings": link["pings"] if link else None, "push": uid in push_uids,
            "roles": json.loads(d_roles) if d_roles else [], "messages": messages.get(uid, 0),
            "lookups": lookups.get(uid, 0), "active_7d": last_seen >= now - 7 * DAY_S,
        })
    rows.sort(key=lambda r: -r["last"])
    return {"now": now, "members": rows}


CSV_COLUMNS = ("uid", "name", "first_seen", "last_seen", "days_active", "sessions", "minutes", "devices", "source",
               "in_server", "linked", "type", "year", "passes", "sports", "pings", "push", "roles", "messages_30d",
               "lookups")


def _cell(value: object) -> str:
    """A CSV cell a spreadsheet will not run: text starting with = + - @ or a tab is quoted with a leading '."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "yes" if value else "no"
    text = str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


def members_csv(report: dict) -> str:
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(CSV_COLUMNS)
    iso = lambda ts: datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d %H:%M")  # noqa: E731
    for r in report["members"]:
        writer.writerow([_cell(v) for v in (
            r["uid"], r["name"], iso(r["first"]), iso(r["last"]), r["days"], r["sessions"], round(r["time_s"] / 60),
            r["devices"], r["source"], r["in_server"], r["linked"], r["type"], r["year"], r["passes"],
            " ".join(r["sports"]), r["pings"], r["push"], " ".join(r["roles"]), r["messages"], r["lookups"])])
    return out.getvalue()


def member_timeline(activity: ActivityLog, uid: str, links, push_uids: set[str], now: int) -> dict | None:
    """One member's row and their timeline, newest first: what their devices did on the site (before they signed in
    too), the accounts they looked up, their link changes, their days of messages and their changes in our Discord.
    Their devices are numbered, never shown by id. None when the site never saw them."""
    member = next((r for r in members_report(activity, links, push_uids, now)["members"] if r["uid"] == uid), None)
    if member is None:
        return None
    read = activity.read
    numbers: dict[str, int] = {}
    for (device,) in read("SELECT id FROM devices WHERE member = ? ORDER BY first", (uid,)):
        numbers[device] = len(numbers) + 1
    items = []
    for ts, kind, arg, n, state, cls, device in read(
            "SELECT * FROM (SELECT ts, kind, arg, n, state, cls, device FROM events WHERE member = ?"
            " UNION ALL SELECT ts, kind, arg, n, state, cls, device FROM events WHERE device IN"
            " (SELECT id FROM devices WHERE member = ?) AND (member IS NULL OR member != ?))"
            " ORDER BY ts DESC LIMIT ?", (uid, uid, uid, TIMELINE_MAX)):
        items.append({"ts": ts, "from": "site", "kind": kind, "arg": arg, "n": n, "state": state, "cls": cls,
                      "device": numbers.get(device) if device else None})
    for ts, username, status, passes in read(
            "SELECT ts, username, status, passes FROM lookups WHERE member = ? ORDER BY ts DESC LIMIT 200", (uid,)):
        items.append({"ts": ts, "from": "lookup", "kind": status, "arg": username, "n": passes})
    for ts, kind, arg in read("SELECT ts, kind, arg FROM d_events WHERE uid = ? ORDER BY ts DESC LIMIT 200", (uid,)):
        items.append({"ts": ts, "from": "discord", "kind": kind, "arg": arg, "n": None})
    for day, channel, n in read("SELECT day, channel, n FROM d_msgs WHERE uid = ? ORDER BY day DESC LIMIT 200",
                                (uid,)):
        items.append({"ts": day * DAY_S + DAY_S - 1, "from": "messages", "kind": "messages", "arg": channel, "n": n})
    items.sort(key=lambda item: -item["ts"])
    return {"member": member, "devices": len(numbers), "items": items[:TIMELINE_MAX]}


# --- Accounts -----------------------------------------------------------------------------------------------------


def accounts_report(activity: ActivityLog, links, now: int) -> dict:
    """The Real accounts looked up (kept ones: up to 180 days), the most looked up first, with their size; and the
    members who look up the most."""
    read = activity.read
    devices = dict(read("SELECT lower(arg), COUNT(DISTINCT device) FROM events WHERE kind = 'lookup'"
                        " AND arg IS NOT NULL GROUP BY lower(arg)"))
    sizes = {key: (passes, year) for key, passes, year in read("SELECT key, passes, year FROM accounts")}
    last_status = dict(read("SELECT k, status FROM (SELECT lower(username) AS k, status, ROW_NUMBER() OVER"
                            " (PARTITION BY lower(username) ORDER BY ts DESC) AS r FROM lookups) WHERE r = 1"))
    names = dict(read("SELECT uid, name FROM members"))
    accounts = []
    for key, username, n, members, anon, first, last in read(
            "SELECT lower(username), MAX(username), COUNT(*), COUNT(DISTINCT member), SUM(member IS NULL), MIN(ts),"
            " MAX(ts) FROM lookups GROUP BY lower(username) ORDER BY COUNT(*) DESC, MAX(ts) DESC LIMIT ?",
            (ACCOUNTS_SHOWN,)):
        passes, year = sizes.get(key, (None, None))
        owner = links.owner_of(username) if links is not None else None
        link = _link_of(links, owner) if owner else None
        if link is not None and isinstance(link.get("year"), int) and year is None:
            year = link["year"]
        kind = type_of(year).name if isinstance(year, int) else (type_by_passes(passes).name if passes else None)
        accounts.append({"username": username, "lookups": n, "members": members, "anon": anon or 0,
                         "devices": devices.get(key, 0), "first": first, "last": last, "passes": passes,
                         "year": year, "type": kind, "status": last_status.get(key),
                         "linked_by": names.get(owner) or owner if owner else None})
    power = [{"uid": uid, "name": names.get(uid) or "?", "lookups": n, "accounts": distinct}
             for uid, n, distinct in read(
                 "SELECT member, COUNT(*), COUNT(DISTINCT lower(username)) FROM lookups WHERE member IS NOT NULL"
                 " GROUP BY member ORDER BY COUNT(*) DESC LIMIT 25")]
    since = now - WINDOW_DAYS * DAY_S
    (total, by_members, distinct), = read(
        "SELECT COUNT(*), SUM(member IS NOT NULL), COUNT(DISTINCT lower(username)) FROM lookups WHERE ts >= ?",
        (since,))
    daily = dict(read("SELECT ts / 86400, COUNT(*) FROM lookups WHERE ts >= ? GROUP BY ts / 86400", (since,)))
    first_day = day_of(now) - WINDOW_DAYS + 1
    return {"now": now, "accounts": accounts, "power": power,
            "totals": {"lookups": total or 0, "by_members": by_members or 0, "accounts": distinct or 0},
            "daily": [{"day": _day_name(d), "lookups": daily.get(d, 0)} for d in range(first_day, first_day + WINDOW_DAYS)]}


# --- Features -----------------------------------------------------------------------------------------------------


def features_report(activity: ActivityLog, now: int) -> dict:
    """What the page is used for over the last WINDOW_DAYS days: each feature by day, by state (anonymous, signed in
    but not in our server, member) and by class; its users (devices, or members for what the server alone saw); its
    most frequent arguments; sessions and time on screen by day; sessions by UTC hour."""
    read = activity.read
    first_day = day_of(now) - WINDOW_DAYS + 1
    since = first_day * DAY_S
    days = list(range(first_day, first_day + WINDOW_DAYS))
    marks = ",".join("?" * len(FEATURES))
    table: dict[str, dict] = {}
    for day, kind, state, cls, n in read(
            f"SELECT ts / 86400, kind, state, cls, COUNT(*) FROM events WHERE ts >= ? AND kind IN ({marks})"  # noqa: S608
            " GROUP BY 1, 2, 3, 4", (since, *FEATURES)):
        row = table.setdefault(kind, {"kind": kind, "events": 0, "users": 0, "daily": Counter(),
                                      "by_state": Counter(), "by_cls": Counter(), "top": []})
        row["events"] += n
        row["daily"][day] += n
        row["by_state"]["out" if state == "banned" else state] += n
        row["by_cls"][cls or "unknown"] += n
    for kind, users in read(f"SELECT kind, COUNT(DISTINCT COALESCE(device, member)) FROM events WHERE ts >= ?"  # noqa: S608
                            f" AND kind IN ({marks}) GROUP BY kind", (since, *FEATURES)):
        if kind in table:
            table[kind]["users"] = users
    tops: dict[str, list] = defaultdict(list)
    for kind, arg, n in read(f"SELECT kind, arg, COUNT(*) FROM events WHERE ts >= ? AND arg IS NOT NULL"  # noqa: S608
                             f" AND kind IN ({marks}) AND kind NOT IN ('lookup', 'link', 'deal') GROUP BY kind, arg"
                             " ORDER BY 3 DESC", (since, *FEATURES)):
        if len(tops[kind]) < TOP_ARGS:
            tops[kind].append({"arg": arg, "n": n})
    features = []
    for row in sorted(table.values(), key=lambda r: (-r["events"], r["kind"])):
        features.append({**row, "daily": [row["daily"].get(d, 0) for d in days],
                         "by_state": {s: row["by_state"].get(s, 0) for s in STATES},
                         "by_cls": {c: row["by_cls"].get(c, 0) for c in (*CLASSES, "unknown") if row["by_cls"].get(c)},
                         "top": tops.get(row["kind"], [])})
    sessions = dict(read("SELECT ts / 86400, COUNT(*) FROM events WHERE ts >= ? AND kind = 'session' GROUP BY 1",
                         (since,)))
    seconds = dict(read("SELECT ts / 86400, SUM(n) FROM events WHERE ts >= ? AND kind = 'time' GROUP BY 1", (since,)))
    hours = dict(read("SELECT (ts % 86400) / 3600, COUNT(*) FROM events WHERE ts >= ? AND kind = 'session'"
                      " GROUP BY 1", (since,)))
    by_state = {("out" if s == "banned" else s): n for s, n in read(
        "SELECT state, COUNT(*) FROM events WHERE ts >= ? AND kind = 'session' GROUP BY state", (since,))}
    dropped = read("SELECT COALESCE(SUM(n), 0) FROM dropped WHERE day >= ?", (first_day,))[0][0]
    total_sessions, total_s = sum(sessions.values()), sum(seconds.values())
    return {
        "now": now, "window_days": WINDOW_DAYS, "days": [_day_name(d) for d in days], "features": features,
        "sessions": {"daily": [sessions.get(d, 0) for d in days], "time_daily": [seconds.get(d, 0) for d in days],
                     "count": total_sessions, "time_s": total_s,
                     "avg_s": round(total_s / total_sessions) if total_sessions else None,
                     "by_state": {s: by_state.get(s, 0) for s in STATES}},
        "hours": [hours.get(h, 0) for h in range(24)],
        "dropped": dropped,
    }


# --- Sources ------------------------------------------------------------------------------------------------------


def sources_report(activity: ActivityLog, links, now: int) -> dict:
    """First touch to staying, by first source, over the devices first seen in the last SOURCE_DAYS days: new
    devices, signed in, linked a Real account, still active at D7 (came back 7 days after their first or later,
    counted over the devices whose day 7 has come)."""
    linked = set(links.uids()) if links is not None else set()
    since = now - SOURCE_DAYS * DAY_S
    rows: dict[str, dict] = {}
    members_by: dict[str, set] = defaultdict(set)
    for source, first, last, member in activity.read(
            "SELECT source, first, last, member FROM devices WHERE first >= ?", (since,)):
        key = _source_name(source)
        row = rows.setdefault(key, {"key": key, "devices": 0, "signed_in": 0, "linked": 0, "d7_ready": 0, "d7": 0})
        row["devices"] += 1
        row["signed_in"] += member is not None
        row["linked"] += member in linked
        if first + 7 * DAY_S <= now:
            row["d7_ready"] += 1
            row["d7"] += last >= first + 7 * DAY_S
        if member is not None:
            members_by[key].add(member)
    ordered = sorted(rows.values(), key=lambda r: (-r["devices"], r["key"]))
    shown, rest = ordered[:SOURCES_SHOWN], ordered[SOURCES_SHOWN:]
    if rest:
        other = {"key": "other", **{k: sum(r[k] for r in rest) for k in ("devices", "signed_in", "linked",
                                                                          "d7_ready", "d7")}}
        shown.append(other)
    for row in shown:
        row["members"] = len(members_by.get(row["key"], ()))
    return {"now": now, "window_days": SOURCE_DAYS, "sources": shown}


# --- Discord ------------------------------------------------------------------------------------------------------


def discord_report(activity: ActivityLog, counts: dict[str, int], links, now: int) -> dict:
    """Our Discord: the member count (one point a day, from advisor/visits.py), joins and leaves a day, messages a day
    per channel, the most active people, the bot's posts with their reactions, recent role changes, and how the
    last round of reading went."""
    read = activity.read
    first_day = day_of(now) - WINDOW_DAYS + 1
    days = list(range(first_day, first_day + WINDOW_DAYS))
    moves: dict[int, Counter] = defaultdict(Counter)
    for day, kind, n in read("SELECT ts / 86400, kind, COUNT(*) FROM d_events WHERE kind IN ('join', 'leave')"
                             " AND ts >= ? GROUP BY 1, 2", (first_day * DAY_S,)):
        moves[day][kind] += n
    channels: dict[str, Counter] = defaultdict(Counter)
    for day, channel, n in read("SELECT day, channel, n FROM d_chan WHERE day >= ?", (first_day,)):
        channels[channel][day] += n
    by_channel = sorted(({"channel": c, "total": sum(v.values()), "daily": [v.get(d, 0) for d in days]}
                         for c, v in channels.items()), key=lambda r: (-r["total"], r["channel"]))
    site = set(r[0] for r in read("SELECT uid FROM members"))
    linked = set(links.uids()) if links is not None else set()
    people = [{"uid": uid, "name": name or f"…{uid[-4:]}", "avatar": avatar_url(uid, avatar), "messages": n,
               "site": uid in site, "linked": uid in linked}
              for uid, n, name, avatar in read(
                  "SELECT m.uid, SUM(m.n), p.name, p.avatar FROM d_msgs m LEFT JOIN d_people p ON p.uid = m.uid"
                  " WHERE m.day >= ? GROUP BY m.uid ORDER BY 2 DESC LIMIT 25", (first_day,))]
    posts = [{"channel": channel, "ts": ts, "title": title, "reactions": reactions, "top": top}
             for channel, ts, title, reactions, top in read(
                 "SELECT channel, ts, title, reactions, top FROM d_posts ORDER BY ts DESC LIMIT 60")]
    post_channels = [{"channel": c, "posts": n, "reactions": r or 0, "avg": round(a or 0, 2)}
                     for c, n, r, a in read("SELECT channel, COUNT(*), SUM(reactions), AVG(reactions) FROM d_posts"
                                            " GROUP BY channel ORDER BY 3 DESC")]
    roles = [{"ts": ts, "name": name or "?", "kind": kind, "role": arg}
             for ts, kind, arg, name in read(
                 "SELECT e.ts, e.kind, e.arg, p.name FROM d_events e LEFT JOIN d_people p ON p.uid = e.uid"
                 " WHERE e.kind IN ('role+', 'role-') ORDER BY e.ts DESC LIMIT 40")]
    status = read("SELECT value FROM d_status WHERE key = 'discord'")
    (people_kept, present), = read("SELECT COUNT(*), COALESCE(SUM(present = 1), 0) FROM d_people")
    return {
        "now": now, "window_days": WINDOW_DAYS, "days": [_day_name(d) for d in days],
        "count": [{"day": day, "members": n} for day, n in sorted(counts.items())],
        "moves": [{"day": _day_name(d), "joins": moves[d]["join"], "leaves": moves[d]["leave"]} for d in days],
        "channels": by_channel, "people": people, "posts": posts, "post_channels": post_channels, "roles": roles,
        "known": {"people": people_kept, "present": present},
        "status": json.loads(status[0][0]) if status else None,
    }
