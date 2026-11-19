"""The admin panel's figures, computed from the visit log (advisor/visits.py), the click counts (advisor/clicks.py)
and what the member stores hold (links, deal pings, alert subscriptions), all as of one UTC day.

Nothing here names anyone: devices and members are counted, never listed, and the report carries no device id and
no member hash. Every figure is over UTC days.

- Active devices: DAU (today), WAU (the last 7 days, today included), MAU (the last 30).
- New and returning: a device is new on its first day, returning on any later day it was active.
- Retention cohorts: devices grouped by the week (Monday to Sunday) of their first day. Dn is the share of a cohort
  that came back on day n after its first day or any day later, counted only over the devices whose day n has come
  (None when none has).
- Funnel, over devices active in the last 30 days: visited; pressed "Continue with Discord"; seen signed in; seen in
  our server; their member has a linked Real account; their member has deal pings or phone alerts on. Each step
  counts the devices that reached it by any path (a member signed in from before never presses the button again).
"""

from bisect import bisect_left
from collections import Counter
from collections.abc import Iterable

from advisor.rules import VISIT_TABS
from advisor.visits import DIRECT, IN_SERVER, SIGNED_IN, SIGNIN, day_name

WINDOW_DAYS = 30
WEEKS = 12
RETENTION_DAYS = (1, 7, 14, 30)
SOURCES_SHOWN = 15


def _monday(day: int) -> int:
    """The Monday that starts the week of `day` (1970-01-01, day 0, was a Thursday)."""
    return day - (day + 3) % 7


def _active(rows: Iterable[dict], first: int, last: int) -> int:
    """How many rows were active on a day from `first` to `last`; their days are kept sorted, so a binary search."""
    count = 0
    for row in rows:
        days = row["d"]
        at = bisect_left(days, first)
        count += at < len(days) and days[at] <= last
    return count


def _cohorts(rows: list[dict], today: int) -> list[dict]:
    this_week = _monday(today)
    out = []
    for back in range(WEEKS - 1, -1, -1):
        start = this_week - 7 * back
        members = [row for row in rows if start <= row["f"] < start + 7]
        cohort: dict = {"week": day_name(start), "size": len(members)}
        for n in RETENTION_DAYS:
            ready = [row for row in members if row["f"] + n <= today]
            back_again = sum(1 for row in ready if row["d"][-1] >= row["f"] + n)
            cohort[f"d{n}"] = round(back_again / len(ready), 4) if ready else None
        out.append(cohort)
    return out


def _share(rows: list[dict], n: int, today: int) -> float | None:
    ready = [row for row in rows if row["f"] + n <= today]
    if not ready:
        return None
    return round(sum(1 for row in ready if row["d"][-1] >= row["f"] + n) / len(ready), 4)


def _ranked(counts: Counter, name: str, limit: int = SOURCES_SHOWN) -> list[dict]:
    return [{"key": key, name: n} for key, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]]


def _actives(rows: list[dict], today: int) -> dict:
    return {"dau": _active(rows, today, today), "wau": _active(rows, today - 6, today),
            "mau": _active(rows, today - WINDOW_DAYS + 1, today), "kept": len(rows)}


def build_report(data: dict, today: int, clicks: dict, *, linked: set[str], pings: set[str], push: set[str]) -> dict:
    """The panel's figures as of UTC day `today`. `data` is `VisitLog.data()`; `clicks` is `ClickLog.totals()`;
    `linked`, `pings` and `push` are the member hashes with a linked account, deal pings on, alert subscriptions."""
    devices = list(data["devices"].values())
    members = list(data["members"].values())
    days = data["days"]
    since = today - WINDOW_DAYS + 1
    window = [day_name(day) for day in range(since, today + 1)]

    clicks_by_day: Counter = Counter()
    by_panel: Counter = Counter()
    for day, rows in clicks.get("days", {}).items():
        if window[0] <= day <= window[-1]:
            for row in rows:
                clicks_by_day[day] += row["count"]
                by_panel[row["panel"]] += row["count"]

    active_on: Counter = Counter()
    new_on: Counter = Counter()
    for row in devices:
        for day in row["d"]:
            if day >= since:
                active_on[day] += 1
        if row["f"] >= since:
            new_on[row["f"]] += 1
    members_on: Counter = Counter(day for row in members for day in row["d"] if day >= since)

    daily = []
    for number, name in zip(range(since, today + 1), window, strict=True):
        counts = days.get(name, {})
        daily.append({
            "day": name, "active": active_on[number], "new": new_on[number],
            "returning": active_on[number] - new_on[number], "members": members_on[number],
            "loads": counts.get("loads", 0), "clicks": clicks_by_day[name], "signin": counts.get("signin", 0),
            "discord": data["discord"].get(name), "over": counts.get("over", 0),
        })

    this_week = _monday(today)
    weekly = [{"week": day_name(start), "active": _active(devices, start, min(start + 6, today))}
              for start in (this_week - 7 * back for back in range(WEEKS - 1, -1, -1))]

    recent = [row for row in devices if row["d"][-1] >= since]
    alerted = pings | push
    funnel_counts = {
        "visit": len(recent),
        "signin": sum(1 for row in recent if row["x"] & SIGNIN),
        "signed_in": sum(1 for row in recent if row["x"] & SIGNED_IN),
        "in_server": sum(1 for row in recent if row["x"] & IN_SERVER),
        "linked": sum(1 for row in recent if row.get("m") in linked),
        "alerts": sum(1 for row in recent if row.get("m") in alerted),
    }

    views: Counter = Counter()
    refs: Counter = Counter()
    tags: Counter = Counter()
    logins = {"signin": 0, "started": 0, "finished": 0}
    for name in window:
        counts = days.get(name, {})
        views.update(counts.get("views", {}))
        refs.update(counts.get("ref", {}))
        tags.update(counts.get("tag", {}))
        logins["signin"] += counts.get("signin", 0)
        logins["started"] += counts.get("auth_start", 0)
        logins["finished"] += counts.get("auth_ok", 0)

    by_source: dict[str, list[dict]] = {}
    for row in devices:
        if row["f"] >= since:
            by_source.setdefault(row["s"] or DIRECT, []).append(row)
    new_by_source = sorted(
        ({"key": key, "new": len(rows), "d1": _share(rows, 1, today), "d7": _share(rows, 7, today)}
         for key, rows in by_source.items()),
        key=lambda row: (-row["new"], row["key"]))[:SOURCES_SHOWN]

    kinds = Counter(row["k"] for row in recent)
    return {
        "today": day_name(today),
        "window_days": WINDOW_DAYS,
        "active": {**_actives(devices, today), "over": sum(row["over"] for row in daily)},
        "members": _actives(members, today),
        "daily": daily,
        "weekly": weekly,
        "cohorts": _cohorts(devices, today),
        "member_cohorts": _cohorts(members, today),
        "funnel": [{"key": key, "count": n} for key, n in funnel_counts.items()],
        "logins": logins,
        "totals": {"linked": len(linked), "pings": len(pings), "push": len(push)},
        "tabs": [{"tab": tab, "views": n} for tab, n in sorted(views.items(), key=lambda kv: (-kv[1], kv[0]))
                 if tab in VISIT_TABS],
        "devices": {"phone": kinds["phone"], "tablet": kinds["tablet"], "desktop": kinds["desktop"],
                    "app": sum(1 for row in recent if row["a"]), "total": len(recent)},
        "sources": {"ref": _ranked(refs, "loads"), "tag": _ranked(tags, "loads"), "new": new_by_source},
        "clicks": {"total": sum(by_panel.values()),
                   "by_panel": [{"panel": p, "count": n} for p, n in sorted(by_panel.items(),
                                                                             key=lambda kv: (-kv[1], kv[0]))]},
        "discord": [{"day": day, "members": n} for day, n in sorted(data["discord"].items())],
    }
