"""The admin panel's figures (advisor/admin_stats.py), computed from the visit log, the click counts and what the
member stores hold, for a day picked by the test."""

from datetime import date

from advisor.admin_stats import build_report
from advisor.visits import day_name, day_number

from datetime import datetime, timezone

TODAY = day_number(datetime(2026, 11, 18, 9, 0, tzinfo=timezone.utc))  # a Wednesday
MONDAY = TODAY - 2  # 2026-11-16


def device(first, days, x=0, k="phone", a=0, s="", m=None):
    row = {"f": first, "d": list(days), "x": x, "k": k, "a": a, "s": s}
    if m:
        row["m"] = m
    return row


def data(devices=None, members=None, days=None, discord=None):
    return {"devices": devices or {}, "members": members or {}, "days": days or {}, "discord": discord or {}}


def report(d, clicks=None, linked=(), pings=(), push=(), today=TODAY):
    return build_report(d, today, clicks or {"days": {}}, linked=set(linked), pings=set(pings), push=set(push))


def test_an_empty_log_gives_zeros_not_errors():
    r = report(data())
    assert r["today"] == "2026-11-18"
    assert r["active"] == {"dau": 0, "wau": 0, "mau": 0, "kept": 0, "over": 0}
    assert len(r["daily"]) == 30 and r["daily"][-1]["day"] == "2026-11-18"
    assert all(row["active"] == 0 for row in r["daily"])
    assert [c["size"] for c in r["cohorts"]] == [0] * 12
    assert r["funnel"][0] == {"key": "visit", "count": 0}


def test_daily_weekly_and_monthly_active_devices():
    r = report(data(devices={
        "a": device(TODAY, [TODAY]),
        "b": device(TODAY - 3, [TODAY - 3, TODAY]),
        "c": device(TODAY - 10, [TODAY - 10]),
        "d": device(TODAY - 40, [TODAY - 40]),
    }))
    assert r["active"] == {"dau": 2, "wau": 2, "mau": 3, "kept": 4, "over": 0}
    last = r["daily"][-1]
    assert (last["active"], last["new"], last["returning"]) == (2, 1, 1)
    assert r["daily"][-4]["day"] == day_name(TODAY - 3) and r["daily"][-4]["new"] == 1
    weeks = {w["week"]: w["active"] for w in r["weekly"]}
    assert weeks["2026-11-16"] == 2  # this week, from Monday, so far
    assert weeks[day_name(MONDAY - 7)] == 1  # "b" first came on 11-15, a Sunday
    assert len(r["weekly"]) == 12


def test_retention_cohorts_by_week_of_first_visit_come_back_on_day_n_or_later():
    first = MONDAY - 35  # a cohort old enough for D30
    r = report(data(devices={
        "a": device(first, [first, first + 1, first + 31]),
        "b": device(first, [first, first + 8]),
        "c": device(first + 2, [first + 2]),
        "d": device(first + 3, [first + 3, first + 3 + 14]),
    }))
    cohort = next(c for c in r["cohorts"] if c["week"] == day_name(first))
    assert cohort["size"] == 4
    assert cohort["d1"] == 0.75 and cohort["d7"] == 0.75 and cohort["d14"] == 0.5 and cohort["d30"] == 0.25
    this_week = r["cohorts"][-1]
    assert this_week["week"] == "2026-11-16" and this_week["size"] == 0 and this_week["d1"] is None


def test_a_cohort_too_young_for_a_day_has_no_figure_for_it():
    r = report(data(devices={"a": device(TODAY - 1, [TODAY - 1, TODAY]), "b": device(TODAY, [TODAY])}))
    cohort = r["cohorts"][-1]
    assert cohort["size"] == 2
    assert cohort["d1"] == 1.0  # only "a" can have come back a day later yet, and it did
    assert cohort["d7"] is None


def test_the_funnel_follows_devices_and_member_hashes_with_server_side_truth():
    r = report(data(devices={
        "a": device(TODAY, [TODAY]),
        "b": device(TODAY, [TODAY], x=1),
        "c": device(TODAY, [TODAY], x=1 | 2, m="m" * 20),
        "d": device(TODAY - 5, [TODAY], x=1 | 2 | 4, m="n" * 20),
        "e": device(TODAY - 5, [TODAY], x=2 | 4, m="o" * 20),
        "old": device(TODAY - 60, [TODAY - 60], x=7, m="p" * 20),  # outside the 30 days
    }), linked={"n" * 20, "o" * 20, "p" * 20}, pings={"n" * 20}, push={"o" * 20})
    assert [(s["key"], s["count"]) for s in r["funnel"]] == [
        ("visit", 5), ("signin", 3), ("signed_in", 3), ("in_server", 2), ("linked", 2), ("alerts", 2)]
    assert r["totals"] == {"linked": 3, "pings": 1, "push": 1}


def test_views_devices_sources_and_logins_over_the_window():
    days = {
        day_name(TODAY): {"loads": 3, "views": {"deals": 4, "today": 2}, "ref": {"direct": 2, "google.com": 1},
                          "tag": {"launch": 1}, "signin": 2, "auth_start": 2, "auth_ok": 1},
        day_name(TODAY - 2): {"loads": 1, "views": {"deals": 1}, "ref": {"google.com": 1}},
        day_name(TODAY - 45): {"loads": 9, "views": {"plan": 9}},  # outside the window
    }
    r = report(data(devices={
        "a": device(TODAY, [TODAY], k="phone", a=1, s="google.com"),
        "b": device(TODAY - 2, [TODAY - 2, TODAY - 1], k="desktop", s="?launch"),
        "c": device(TODAY - 2, [TODAY - 2], k="phone"),
    }, days=days))
    assert r["tabs"] == [{"tab": "deals", "views": 5}, {"tab": "today", "views": 2}]
    assert r["devices"] == {"phone": 2, "tablet": 0, "desktop": 1, "app": 1, "total": 3}
    assert {"key": "google.com", "loads": 2} in r["sources"]["ref"]
    assert {"key": "direct", "loads": 2} in r["sources"]["ref"]
    assert r["sources"]["tag"] == [{"key": "launch", "loads": 1}]
    news = {row["key"]: row for row in r["sources"]["new"]}
    assert news["google.com"]["new"] == 1 and news["?launch"]["new"] == 1 and news["direct"]["new"] == 1
    assert news["?launch"]["d1"] == 1.0 and news["direct"]["d1"] == 0.0 and news["google.com"]["d1"] is None
    assert r["logins"] == {"signin": 2, "started": 2, "finished": 1}
    assert r["daily"][-1]["loads"] == 3


def test_outbound_clicks_by_day_and_panel():
    clicks = {"days": {
        day_name(TODAY): [{"panel": "deals", "target": "listing", "level": "new", "sport": "all", "pos": 0, "count": 3},
                          {"panel": "otd", "target": "card", "level": "new", "sport": "all", "pos": 1, "count": 1}],
        day_name(TODAY - 31): [{"panel": "deals", "target": "listing", "level": "new", "sport": "all", "pos": 0,
                                "count": 50}],
    }}
    r = report(data(), clicks=clicks)
    assert r["clicks"] == {"total": 4, "by_panel": [{"panel": "deals", "count": 3}, {"panel": "otd", "count": 1}]}
    assert r["daily"][-1]["clicks"] == 4


def test_members_retention_and_discord_counts():
    members = {"a" * 20: {"f": TODAY - 3, "d": [TODAY - 3, TODAY]}, "b" * 20: {"f": TODAY, "d": [TODAY]}}
    discord = {day_name(TODAY - 1): 410, day_name(TODAY): 415, day_name(TODAY - 200): 12}
    r = report(data(members=members, discord=discord))
    assert r["members"] == {"dau": 2, "wau": 2, "mau": 2, "kept": 2}
    assert r["member_cohorts"][-1]["size"] == 1
    assert r["discord"][-2:] == [{"day": day_name(TODAY - 1), "members": 410},
                                 {"day": day_name(TODAY), "members": 415}]
    assert r["daily"][-1]["discord"] == 415 and r["daily"][-3]["discord"] is None
    assert len(r["discord"]) == 3  # every kept point, oldest first


def test_the_report_names_nobody():
    r = report(data(devices={"a" * 22: device(TODAY, [TODAY], x=7, m="f" * 20)},
                    members={"f" * 20: {"f": TODAY, "d": [TODAY]}}), linked={"f" * 20})
    text = repr(r)
    assert "a" * 22 not in text and "f" * 20 not in text  # no device id, no member hash, in what the panel gets
    assert date.fromisoformat(r["today"])


def test_devices_past_the_limit_are_shown_so_a_full_table_is_noticed():
    r = report(data(days={day_name(TODAY): {"loads": 5, "over": 3}, day_name(TODAY - 1): {"over": 2}}))
    assert r["daily"][-1]["over"] == 3 and r["active"]["over"] == 5


def test_a_full_table_is_reported_quickly():
    import time

    rows = {f"{i:022d}": device(TODAY - 89 + i % 60, list(range(TODAY - 89 + i % 60, TODAY + 1, 1 + i % 3)), x=i % 8)
            for i in range(30_000)}
    started = time.perf_counter()
    r = report(data(devices=rows))
    assert r["active"]["kept"] == 30_000
    assert time.perf_counter() - started < 3  # a worst case: every device active every other day for 90 days
