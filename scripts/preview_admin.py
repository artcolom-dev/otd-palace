"""See the admin panel on this machine only, filled with invented visits: the demo market, a fake Discord gate (its
Discord is a stand-in that answers every call itself, so nothing leaves the machine) and a visit log seeded with
made-up devices, members, sources and clicks (a fixed random seed, so each run draws the same panel).

    uv run python scripts/preview_admin.py [port]        # default port 8797, then open http://localhost:<port>/admin

It prints the admin's session cookie: send the printed `Cookie:` header (a browser extension, or Playwright's
`extra_http_headers`). Needs the front end built (`npm --prefix frontend run build`). The data lives in a temporary
directory that goes with the process; nothing is written to the data directory.
"""

import random
import secrets
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from waitress import serve  # noqa: E402

from advisor import discord_gate as dg  # noqa: E402
from advisor.clicks import ClickLog  # noqa: E402
from advisor.collector import run_collector  # noqa: E402
from advisor.members import MemberLinks  # noqa: E402
from advisor.sources.fixture import FixtureSource  # noqa: E402
from advisor.store import SnapshotStore  # noqa: E402
from advisor.activity import ActivityLog, Batch, PageEvent  # noqa: E402
from advisor.visits import Visit, VisitLog  # noqa: E402
from advisor.web import create_app  # noqa: E402
from scripts.preview_open import DEMO, STATIC, UID, fake_discord  # noqa: E402

SOURCES = [None] * 10 + ["google.com"] * 3 + ["com.discord"] * 4 + ["reddit.com"] * 2 + ["x.com"]
TAGS = [None] * 12 + ["tiktok", "launch", "discord_bio"]
FIRST = ["Deal", "Flip", "Rax", "Court", "Card", "Gold", "Slam", "Rookie", "Pass", "Dime", "Rim", "Clutch"]
LAST = ["Hunter", "King", "Queen", "Wizard", "Baron", "Fox", "Shark", "Owl", "Ace", "Boss", "Hawk", "Monk"]
CHANNELS = ["market-talk", "general", "show-your-pulls", "questions", "start-real", "feedback", "linked-lounge"]
SHEETS = ["sort-deals", "how-it-works", "your-alerts", "your-real-account", "deal-pings", "earn"]
LOOKED = ["kingcards", "slabcity", "courtvision", "bigwhale", "rimrocker", "dimebag", "clutchcity", "goatflips"]


def page_events(rng: random.Random, member: bool) -> list[tuple]:
    """A visit's worth of invented page events."""
    out: list[tuple] = [("session",)]
    for _ in range(rng.randint(0, 6)):
        kind = rng.choice(["sport", "sport", "sort", "filter", "deal", "deal", "out", "sheet", "sheet", "lookup",
                           "share", "refresh", "pings" if member else "refresh", "push", "install"])
        arg = {"sport": rng.choice(["all", "nba", "nfl", "nhl", "mlb", "soccer"]),
               "sort": rng.choice(["best", "ending", "cheapest", "under"]),
               "filter": rng.choice(["budget", "level-new", "level-pro", "pass-budget"]),
               "deal": str(rng.randint(10**8, 10**9)), "out": rng.choice(["deals", "hero", "otd", "community"]),
               "sheet": rng.choice(SHEETS), "lookup": rng.choice(LOOKED), "share": rng.choice(["deal", "profile-code"]),
               "pings": rng.choice(["on", "off"]), "push": rng.choice(["on", "off"]),
               "install": rng.choice(["accepted", "dismissed", "not-now"])}.get(kind)
        out.append((kind, arg))
    out.append(("time", None, rng.randint(20, 900)))
    return out


def seed(visits_path: Path, clicks_path: Path, links: MemberLinks, key: bytes, days: int = 84,
         activity: ActivityLog | None = None) -> VisitLog:
    """Invents `days` days of visits: a few new devices a day, each coming back less and less, a fifth signing in;
    with `activity`, what each of them did, their lookups, and our Discord around them."""
    rng = random.Random(7)
    today = datetime.now(timezone.utc).replace(hour=12, minute=0, second=0, microsecond=0)
    clock = {"at": today - timedelta(days=days)}
    act = {"t": clock["at"].timestamp()}
    if activity is not None:
        activity._clock = lambda: act["t"]  # the preview's own invented time
    visits = VisitLog(visits_path, clock=lambda: clock["at"], member_key=key)
    clicks = ClickLog(clicks_path, clock=lambda: clock["at"])
    devices: list[dict] = []
    for back in range(days, -1, -1):
        clock["at"] = today - timedelta(days=back)
        growth = 1 + (days - back) / days * 2
        for _ in range(int(rng.randint(4, 10) * growth)):
            n = len(devices)
            devices.append({
                "name": f"{rng.choice(FIRST)} {rng.choice(LAST)}",
                "id": f"{n:022d}", "cls": rng.choice(["phone"] * 7 + ["tablet"] + ["desktop"] * 2),
                "app": rng.random() < 0.18, "ref": rng.choice(SOURCES), "tag": rng.choice(TAGS),
                "life": rng.expovariate(1 / 12) if rng.random() < 0.6 else 0, "uid": f"9{n:017d}" if rng.random() < 0.22 else None, "first": back,
            })
        for d in devices:
            age = d["first"] - back
            if age > 0 and (age > d["life"] or rng.random() > 0.45):
                continue
            state = "in" if d["uid"] and age >= 1 else "anon"
            tab = rng.choice(["today", "deals", "deals", "prices", "passes", "plan"])
            visits.record(Visit(d["id"], "load", tab, d["cls"], d["app"], d["ref"] if age == 0 else None,
                                d["tag"] if age == 0 else None), state=state, uid=d["uid"] if state == "in" else None)
            for _ in range(rng.randint(0, 3)):
                visits.record(Visit(d["id"], "view", rng.choice(["deals", "prices", "passes", "plan"]), d["cls"],
                                    d["app"], None, None), state=state, uid=d["uid"] if state == "in" else None)
            if d["uid"] and age == 0:
                visits.record(Visit(d["id"], "signin", None, d["cls"], d["app"], None, None))
                visits.count("auth_start")
                visits.count("auth_ok")
            if activity is not None:
                act["t"] = (today - timedelta(days=back)).replace(hour=0).timestamp() + rng.choice(
                    [8, 12, 13, 18, 19, 20, 20, 21, 21, 22, 23]) * 3600 + rng.randint(0, 3599)
                uid = d["uid"] if state == "in" else None
                name = d.get("name") if uid else None
                source = (f"?{d['tag']}" if d["tag"] else d["ref"] or "") if age == 0 else None
                activity.add_visit(d["id"], "load", tab, d["cls"], d["app"], source, state, uid, name)
                if d["uid"] and age == 0:
                    act["t"] += 40
                    activity.add_visit(d["id"], "signin", None, d["cls"], d["app"], None, "anon", None)
                    activity.note_auth(d["uid"], d["name"])
                events = page_events(rng, uid is not None)
                activity.add_page(Batch(d["id"], d["cls"], d["app"], tuple(PageEvent(*e) for e in events)),
                                  "in" if d["uid"] else "anon", d["uid"], d["name"] if d["uid"] else None)
                for kind, *rest in events:
                    if kind == "lookup":
                        activity.note_lookup(rest[0], uid, "ok", rng.randint(20, 2500))
            if rng.random() < 0.3:
                clicks.record(rng.choice(["deals", "otd", "hero", "moves"]), "listing", "regular", "all",
                              rng.randint(0, 5), known_sports=())
        visits.note_discord_members(380 + (days - back) * 3 + rng.randint(0, 4))
        if activity is not None:
            activity.flush()
            day = (today - timedelta(days=back)).timestamp() // 86400
            talkers = [d for d in devices if d["uid"]] + [{"uid": f"8{i:017d}", "name": f"Lurker {i}"} for i in range(30)]
            counts = {}
            for d in rng.sample(talkers, min(len(talkers), rng.randint(3, 14))):
                counts[(int(day), rng.choice(CHANNELS), d["uid"])] = rng.randint(1, 12)
            counts[(int(day), "live-deals", None)] = rng.randint(4, 12)
            activity.note_messages(counts)
            for (_, _, who), _n in counts.items():
                if who and who.startswith("8"):
                    activity.note_person(who, name=f"Lurker {int(who[-3:])}", soft=True)
            if back <= 60 and rng.random() < 0.7:
                act["t"] = (today - timedelta(days=back)).timestamp() - 3600
                activity.note_post(str(10**17 + back * 1000 + 1), rng.choice(["live-deals", "live-deals", "otd-picks",
                                                                              "market-talk", "announcements"]),
                                   int(act["t"]), rng.choice(["Gone · K. Mbappe · 32% under", "LeBron James 2025 · 40% under",
                                                              "Today's OTD picks", "What's new on the site",
                                                              "Monday digest", "C. McDavid · 27% under"]),
                                   rng.randint(0, 14), rng.choice(["🔥 6 · 👍 3", "👍 2", "💰 4 · 🔥 1", None]))
            for d in devices:
                if d["uid"] and d["first"] == back:
                    act["t"] = (today - timedelta(days=back)).timestamp() - 7200
                    activity.note_join_message(d["uid"], int(act["t"]), d["name"])
    for d in devices:
        if d["uid"] and rng.random() < 0.45:
            username = f"{d['name'].split()[0].lower()}{d['id'][-4:]}"
            passes = [{"key": f"{rng.choice(['nba', 'nfl', 'nhl'])}:2025:player:{rng.randint(1, 9999)}", "rating": 5}
                      for _ in range(rng.randint(3, 400))]
            links.claim(d["uid"], username, passes, now=1.0, year=rng.choice([300, 2500, 8000, 20000, 60000, 150000]))
            links.update(d["uid"], pings=rng.random() < 0.4)
            if activity is not None:
                activity.note_link(d["uid"], username, len(passes))
                activity.note_lookup(username, d["uid"], "ok", len(passes))
    if activity is not None:
        act["t"] = today.timestamp()
        for d in devices:
            if d["uid"]:
                roles = ["Linked"] if links.get(d["uid"]) else []
                roles += rng.sample(["NBA", "NFL", "NHL", "Deal Alerts"], rng.randint(0, 2))
                activity.note_person(d["uid"], name=d["name"], roles=roles, present=rng.random() > 0.12, checked=True)
        activity.set_status({"discord": {"at": int(today.timestamp()) - 900, "members_list": "refused", "channels": 14,
                                         "messages": 41, "checked": 37, "posts": 62, "error": None}})
        activity.flush()
        activity._clock = time.time
    visits.flush()
    clicks.flush()
    return visits, clicks


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8797
    env = {
        "ADVISOR_DISCORD_CLIENT_ID": "123456789012345678",
        "ADVISOR_DISCORD_CLIENT_SECRET": "preview-client-secret-" + secrets.token_hex(8),
        "ADVISOR_DISCORD_BOT_TOKEN": "preview-bot-token-" + secrets.token_hex(8),
        "ADVISOR_DISCORD_GUILD_ID": "876543210987654321",
        "ADVISOR_SESSION_SECRET": secrets.token_urlsafe(48),
        "ADVISOR_PUBLIC_URL": f"http://localhost:{port}",
    }
    config = dg.config_from_env(env)
    gate = dg.DiscordGate(config, dg.DiscordClient(config, transport=fake_discord))
    store = SnapshotStore()
    stop = threading.Event()
    threading.Thread(target=run_collector, args=(FixtureSource(DEMO), store, stop, 5.0),
                     kwargs={"demo": True, "accounts": True}, daemon=True).start()
    where = Path(tempfile.mkdtemp(prefix="preview-admin-"))
    links = MemberLinks(where / "member-links.json")
    activity = ActivityLog(where / "activity.db")
    seeded, _ = seed(where / "visits.json", where / "clicks.json", links, secrets.token_bytes(32), activity=activity)
    visits = VisitLog(where / "visits.json", member_key=seeded._key)
    clicks = ClickLog(where / "clicks.json")
    now = int(gate._clock())
    print(f"Admin preview on http://localhost:{port}/admin (invented visits, fake Discord gate). Cookie:")
    print(f"  Cookie: {dg.SESSION_COOKIE}={gate._session(UID, 'Preview', now, now, 'in')}")
    sys.stdout.flush()
    serve(create_app(store, STATIC, gate=gate, links=links, clicks=clicks, visits=visits, activity=activity,
                      admin_ids=frozenset({UID})), host="127.0.0.1", port=port, threads=8)


if __name__ == "__main__":
    main()
