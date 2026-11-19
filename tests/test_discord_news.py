"""The poster's once-only posts and its flood guards: "What's new" in #announcements (quiet first run, once per entry,
even after a wiped disk), the weekly digest and the season-clock heads-ups in #market-talk, and the per-player cap of
#live-deals. Discord is a scripted fake with a memory of what each channel holds; the clock is a number."""

import json
from datetime import datetime, timezone

from advisor import discord_digest as dd
from advisor import discord_post as dp
from advisor import season_clock, whatsnew
from advisor.rules import DISCORD_PLAYER_PER_DAY, DISCORD_WHATSNEW_PER_ROUND
from tests.test_discord_gate import GUILD_ID
from tests.test_discord_post import (
    DAY,
    DEALS_CH,
    NOON,
    OTD_CH,
    PUBLIC,
    Clock,
    FakeDiscord,
    config,
    deal,
    iso,
    snapshot,
)

NEWS_CH = "100000000000000004"
TALK_CH = "100000000000000005"
CHANNELS = [
    {"id": DEALS_CH, "name": "live-deals", "type": 0},
    {"id": OTD_CH, "name": "otd-picks", "type": 0},
    {"id": NEWS_CH, "name": "announcements", "type": 5},
    {"id": TALK_CH, "name": "market-talk", "type": 0},
]
MONDAY_2PM = datetime(2026, 11, 16, 14, 0, tzinfo=timezone.utc).timestamp()


class Server(FakeDiscord):
    """A FakeDiscord whose channels remember their posts, so a second poster (a restart, a wiped disk) can read them."""

    def __init__(self):
        super().__init__(channels=CHANNELS)
        self.history: dict[str, list] = {}

    def __call__(self, method, url, headers, body):
        path = url.removeprefix(dp.API)
        if self.queue:  # scripted answers first, as the base class gives them
            return super().__call__(method, url, headers, body)
        if method == "GET" and path.startswith("/channels/") and "/messages" in path:
            channel = path.split("/")[2]
            self.calls.append((method, path, headers, None))
            return 200, json.dumps(list(reversed(self.history.get(channel, [])))).encode()
        status, raw = super().__call__(method, url, headers, body)
        if method == "POST" and path.startswith("/channels/") and path.endswith("/messages") and status == 200:
            sent = json.loads(body)
            self.history.setdefault(path.split("/")[2], []).append(
                {"id": json.loads(raw)["id"], "author": {"id": "1", "bot": True}, "embeds": sent.get("embeds", [])})
        return status, raw

    def texts(self, channel):
        return [m["embeds"][0].get("title") for m in self.history.get(channel, [])]


def entry(ident, day, **over):
    return {"id": ident, "date": day, "title": ident.title(), "body": "A short, plain body.", "link": None,
            "announce": False, **over}


def make(tmp_path, server=None, clock=None, news=None, **env):
    server = server or Server()
    clock = clock or Clock(NOON)
    poster = dp.Poster(config(**env), tmp_path / "discord-posts.json", transport=server, clock=clock,
                       news=[] if news is None else news)
    return poster, server, clock


def board(*rows):
    return snapshot(rows)


def with_moves(snap, risers=(), fallers=()):
    return {**snap, "moves": {"risers": list(risers), "fallers": list(fallers)}}


def move(name, change, sport="nba"):
    return {"sport": sport, "season": 2026, "player_id": 5, "player_name": name, "bucket": "7-9",
            "median_recent": 120, "median_base": 100, "change": change, "sales_recent": 6}


def otd_snapshot(base):
    market = {"key": "nba:2026:player:9", "sport": "nba", "season": 2026, "season_label": "2026", "player_id": 9,
              "player_name": "Jayson Tatum", "kind": "player", "best": "common",
              "rungs": [{"tier": "common", "cost": 300, "year_rax": 1500, "year_per_rax": 5.0, "pays_back": True,
                         "payback_months": 2.4, "payback_month": "2027-02"}]}
    return {**base, "otd": {"markets": [market], "picks": {"nba": ["nba:2026:player:9"]}}}


# --- the per-player cap and the repeats ------------------------------------------------------------------------------


def test_one_player_is_posted_at_most_twice_a_day_and_comes_back_when_the_day_has_room(tmp_path):
    p, server, clock = make(tmp_path)
    rows = [deal(i, player_id=7, price=300 + i, discount=0.4 - i / 1000) for i in (1, 2, 3)]
    p.round(board(*rows), fresh=True)
    assert len(server.posts()) == DISCORD_PLAYER_PER_DAY == 2
    p.round(board(*rows), fresh=True)
    assert len(server.posts()) == 2  # the third is held back, not lost
    clock.t += DAY + 60
    p.round(board(*[deal(i, player_id=7, price=300 + i, discount=0.4 - i / 1000,
                         ends_at=iso(clock.t + DAY)) for i in (1, 2, 3)]), fresh=True)
    assert [m["embeds"][0]["url"].rsplit("/", 1)[1] for m in server.posts()] == ["1", "2", "3"]


def test_the_held_back_deal_does_not_use_the_rounds_room(tmp_path):
    p, server, _ = make(tmp_path)
    rows = [deal(i, player_id=7, price=300 + i, discount=0.5 - i / 100) for i in (1, 2, 3)]
    rows += [deal(i, discount=0.3 - i / 1000) for i in (10, 11, 12)]  # three other players
    p.round(board(*rows), fresh=True)
    assert len(server.posts()) == dp.DISCORD_DEALS_PER_ROUND  # 3: the two of player 7, then the best of the others
    urls = [m["embeds"][0]["url"].rsplit("/", 1)[1] for m in server.posts()]
    assert urls == ["1", "2", "10"]


def test_the_same_card_at_the_same_price_listed_again_is_not_posted_twice(tmp_path):
    p, server, clock = make(tmp_path)
    p.round(board(deal(1, player_id=7)), fresh=True)
    p.round(board(deal(2, player_id=7)), fresh=True)  # a new listing id, the same card, the same price
    assert len(server.posts()) == 1
    p.round(board(deal(3, player_id=7, price=310)), fresh=True)  # a different price is news
    assert len(server.posts()) == 2


def test_the_caps_survive_a_restart(tmp_path):
    p, server, clock = make(tmp_path)
    p.round(board(deal(1, player_id=7, price=301), deal(2, player_id=7, price=302)), fresh=True)
    again, _, _ = make(tmp_path, server=server, clock=clock)
    again.round(board(deal(3, player_id=7, price=303)), fresh=True)
    assert len(server.posts()) == 2


# --- What's new ------------------------------------------------------------------------------------------------------


def test_the_first_run_is_quiet_except_for_what_is_flagged_or_newer_than_the_poster(tmp_path):
    old, flagged, fresh_one = entry("old-one", "2026-11-10"), entry("flagged", "2026-11-12", announce=True), entry(
        "newer-one", "2026-11-17")
    p, server, clock = make(tmp_path, news=[old, flagged, fresh_one])
    p.round(board(), fresh=True)
    assert server.texts(NEWS_CH) == ["Flagged"]  # newer-one is dated tomorrow: it waits
    clock.t += DAY
    p.round(board(), fresh=True)
    assert server.texts(NEWS_CH) == ["Flagged", "Newer-One"]


def test_an_entry_is_announced_once_across_restarts_and_news_added_later_goes_out(tmp_path):
    p, server, clock = make(tmp_path, news=[entry("old-one", "2026-11-10")])
    p.round(board(), fresh=True)
    assert server.texts(NEWS_CH) == []
    clock.t += DAY
    later = [entry("old-one", "2026-11-10"), entry("added", "2026-11-16")]  # dated before today but after the start
    again, _, _ = make(tmp_path, server=server, clock=clock, news=later)
    again.round(board(), fresh=True)
    again.round(board(), fresh=True)
    assert server.texts(NEWS_CH) == []  # 11-16 is not after the poster's first day (11-16): quiet, as designed
    later.append(entry("tomorrow", "2026-11-17"))
    clock.t += DAY
    again.round(board(), fresh=True)
    assert server.texts(NEWS_CH) == ["Tomorrow"]
    again.round(board(), fresh=True)
    third, _, _ = make(tmp_path, server=server, clock=clock, news=later)
    third.round(board(), fresh=True)
    assert server.texts(NEWS_CH) == ["Tomorrow"]


def test_a_wiped_disk_never_announces_an_entry_twice(tmp_path):
    news = [entry("flagged", "2026-11-12", announce=True)]
    p, server, _ = make(tmp_path, news=news)
    p.round(board(), fresh=True)
    assert len(server.posts(NEWS_CH)) == 1
    other = tmp_path / "wiped"
    other.mkdir()
    again, _, _ = make(other, server=server, news=news)
    again.round(board(), fresh=True)
    assert len(server.posts(NEWS_CH)) == 1  # found in the channel's last posts, only noted as seen


def test_at_most_two_announcements_go_out_in_a_round(tmp_path):
    news = [entry(f"flag-{n}", "2026-11-12", announce=True) for n in range(5)]
    p, server, _ = make(tmp_path, news=news)
    p.round(board(), fresh=True)
    assert len(server.posts(NEWS_CH)) == DISCORD_WHATSNEW_PER_ROUND
    p.round(board(), fresh=True)
    p.round(board(), fresh=True)
    assert len(server.posts(NEWS_CH)) == 5


def test_an_announcement_is_one_embed_that_pings_nobody_and_links_to_the_site(tmp_path):
    p, server, _ = make(tmp_path, news=[entry("flagged", "2026-11-12", announce=True, link="/#passes")])
    p.round(board(), fresh=True)
    (post,) = server.posts(NEWS_CH)
    (embed,) = post["embeds"]
    assert post["allowed_mentions"] == {"parse": []} and "content" not in post
    assert embed["url"] == f"{PUBLIC}/#passes" and embed["footer"]["text"] == "What's new · flagged"
    assert post["enforce_nonce"] is True and len(post["nonce"]) <= 25


def test_sample_data_and_a_missing_channel_announce_nothing(tmp_path):
    p, server, _ = make(tmp_path, news=[entry("flagged", "2026-11-12", announce=True)])
    p.round(snapshot(demo=True), fresh=True)
    assert server.posts(NEWS_CH) == []
    no_channel = Server()
    no_channel.channels = [c for c in CHANNELS if c["name"] != "announcements"]
    q, _, _ = make(tmp_path, server=no_channel, news=[entry("flagged", "2026-11-12", announce=True)])
    q.round(board(), fresh=True)
    assert no_channel.posts(NEWS_CH) == []


def test_a_channel_the_bot_may_not_post_in_is_dropped_once_and_the_market_goes_on(tmp_path, caplog):
    p, server, _ = make(tmp_path, news=[entry("flagged", "2026-11-12", announce=True)])
    assert p._resolve(NOON)
    server.queue = [(200, []), (403, {"code": 50013})]  # the scan reads nothing; the post is refused
    for _ in range(3):
        p.round(board(deal(1)), fresh=True)
    assert "announce" not in p.channels and len(server.posts(DEALS_CH)) == 1
    assert caplog.text.count("no more posts in #announcements") == 1


def test_a_429_on_the_announcement_waits_and_it_goes_out_after(tmp_path):
    p, server, clock = make(tmp_path, news=[entry("flagged", "2026-11-12", announce=True)])
    assert p._resolve(NOON)
    server.queue = [(200, []), (429, {"retry_after": 20})]
    p.round(board(), fresh=True)
    assert server.history.get(NEWS_CH, []) == []  # told to wait: nothing went out, nothing is lost
    clock.t += 30
    p.round(board(), fresh=True)
    assert len(server.history[NEWS_CH]) == 1


def test_the_news_file_is_valid_unique_and_plain():
    entries = whatsnew.load()
    raw = json.loads(whatsnew.PATH.read_text(encoding="utf-8"))
    assert len(entries) == len(raw) >= 6 and len({e["id"] for e in entries}) == len(entries)
    text = json.dumps(raw).lower()
    for word in ("casino", "jackpot"):
        assert word not in text
    assert any(e["announce"] for e in entries)


def test_entries_that_do_not_fit_are_left_out_one_by_one(tmp_path, caplog):
    path = tmp_path / "n.json"
    good = entry("good-one", "2026-11-16")
    path.write_text(json.dumps([good, {"id": "Bad Id", "date": "2026-11-16", "title": "t", "body": "b"},
                                {**good, "id": "no-date", "date": "soon"}, {**good, "id": "long", "title": "x" * 81},
                                {**good, "id": "bad-link", "link": "https://elsewhere.example"},
                                {**good, "id": "bad-flag", "announce": "yes"}, "text", {**good}]))
    assert [e["id"] for e in whatsnew.load(path)] == ["good-one"]
    assert "left out" in caplog.text
    assert whatsnew.load(tmp_path / "missing.json") == []
    path.write_text("{}")
    assert whatsnew.load(path) == []


# --- the weekly digest -----------------------------------------------------------------------------------------------


def rich(clock_t=MONDAY_2PM):
    rows = [deal(i, price=300 + i, discount=0.4 - i / 100, ends_at=iso(clock_t + 2 * DAY), listed_at=iso(clock_t - 600))
            for i in (1, 2, 3, 4)]
    snap = snapshot(rows, generated=clock_t)
    return otd_snapshot(with_moves(snap, risers=[move("Rising Star", 0.31)], fallers=[move("Falling Star", -0.22)]))


def test_the_digest_goes_out_monday_afternoon_once_with_deals_moves_a_pick_and_the_season_line(tmp_path):
    p, server, clock = make(tmp_path, clock=Clock(MONDAY_2PM))
    snap = rich()
    p.round(snap, fresh=True)
    assert server.texts(TALK_CH) == ["This week in the market"]
    description = server.history[TALK_CH][0]["embeds"][0]["description"]
    assert description.count("/d/") == 3  # the three best deals, linked to their pages
    assert "Rising Star" in description and "Falling Star" in description and "+31%" in description
    assert "Jayson Tatum" in description and "Common pass" in description
    assert "Season clock" in description and "mid-season" in description  # November's line
    assert "Week 2026-W47" in server.history[TALK_CH][0]["embeds"][0]["footer"]["text"]
    clock.t += 3600
    p.round(rich(clock.t), fresh=True)
    assert len(server.history[TALK_CH]) == 1  # once a week
    clock.t += 7 * DAY
    p.round(rich(clock.t), fresh=True)
    assert len(server.history[TALK_CH]) == 2


def test_the_digest_waits_for_monday_14_utc_and_never_sends_on_stale_data(tmp_path):
    monday_1pm = MONDAY_2PM - 3600
    p, server, clock = make(tmp_path, clock=Clock(monday_1pm))
    p.round(rich(), fresh=True)
    clock.t = MONDAY_2PM + DAY  # Tuesday
    p.round(rich(), fresh=True)
    clock.t = MONDAY_2PM + 9 * 3600  # Monday 23:00, past the window
    p.round(rich(), fresh=True)
    assert server.history.get(TALK_CH, []) == []
    clock.t = MONDAY_2PM
    p.round(rich(), fresh=False)  # stale: the digest would say old prices
    assert server.history.get(TALK_CH, []) == []
    p.round(rich(), fresh=True)
    assert len(server.history[TALK_CH]) == 1


def test_a_restart_late_on_monday_still_sends_and_a_wiped_disk_does_not_send_twice(tmp_path):
    p, server, clock = make(tmp_path, clock=Clock(MONDAY_2PM + 5 * 3600))
    p.round(rich(), fresh=True)
    assert len(server.history[TALK_CH]) == 1
    wiped = tmp_path / "wiped"
    wiped.mkdir()
    again, _, _ = make(wiped, server=server, clock=clock)
    again.round(rich(), fresh=True)
    assert len(server.history[TALK_CH]) == 1
    third, _, _ = make(tmp_path, server=server, clock=clock)  # the same disk: remembered
    third.round(rich(), fresh=True)
    assert len(server.history[TALK_CH]) == 1


def test_a_wiped_disk_does_not_send_the_week_twice_when_the_footers_words_changed_since(tmp_path):
    """The marker of a digest is its week ("Week 2026-W47"), not its whole footer: the footer's own words changed on
    2026-11-16 and will again, and a post made with the old words must still count as this week's."""
    moment = datetime.fromtimestamp(MONDAY_2PM, timezone.utc)
    message = dd.digest_message(dd.digest_parts(rich(), MONDAY_2PM, PUBLIC), PUBLIC, moment)
    assert dd.marker_of(message) == "Week 2026-W47"
    p, server, clock = make(tmp_path, clock=Clock(MONDAY_2PM))
    p.round(rich(), fresh=True)
    assert len(server.history[TALK_CH]) == 1
    server.history[TALK_CH][0]["embeds"][0]["footer"]["text"] = "Week 2026-W47 · Words of an older version. Check before you buy."
    wiped = tmp_path / "wiped"
    wiped.mkdir()
    again, _, _ = make(wiped, server=server, clock=clock)
    again.round(rich(), fresh=True)
    assert len(server.history[TALK_CH]) == 1


def test_a_week_with_too_little_to_say_is_skipped_not_padded(tmp_path):
    p, server, clock = make(tmp_path, clock=Clock(MONDAY_2PM))
    only_deals = snapshot([deal(1, ends_at=iso(MONDAY_2PM + DAY), listed_at=iso(MONDAY_2PM - 600))], generated=MONDAY_2PM)
    p.round(only_deals, fresh=True)
    assert server.history.get(TALK_CH, []) == []
    p.round(otd_snapshot(only_deals), fresh=True)  # a pass pick makes two parts
    assert len(server.history[TALK_CH]) == 1


def test_the_footers_say_what_a_yearly_figure_assumes_not_that_people_collect_less():
    """the internal research notes, 4a: no shortfall was measured; the figure is a ceiling by construction."""
    from advisor.discord_post import OTD_FOOTER
    moment = datetime.fromtimestamp(MONDAY_2PM, timezone.utc)
    digest = dd.digest_message(dd.digest_parts(rich(), MONDAY_2PM, PUBLIC), PUBLIC, moment)["embeds"][0]["footer"]["text"]
    for text in (OTD_FOOTER, digest):
        assert "usually lower" not in text and "every claim day" in text
    assert digest.startswith("Week 2026-W47 · ")
    assert "Cheaper with offers: offer under the usual price on many cards" in OTD_FOOTER  # the owner's OTD weapon
    assert "Offers need Real Pro." in OTD_FOOTER  # the owner, 11-18


def test_the_digest_names_no_one_and_pings_nobody():
    parts = dd.digest_parts(rich(), MONDAY_2PM, PUBLIC)
    message = dd.digest_message(parts, PUBLIC, datetime.fromtimestamp(MONDAY_2PM, timezone.utc))
    assert message["allowed_mentions"] == {"parse": []} and "content" not in message
    assert dd.digest_message({"deals": [], "moves": [], "otd": ["x"]}, PUBLIC,
                             datetime.fromtimestamp(MONDAY_2PM, timezone.utc)) is None
    odd = with_moves(rich(), risers=[{"player_name": 5}, "x", move("[Bad](http://x) @everyone", 0.5)])
    line = dd.digest_parts(odd, MONDAY_2PM, PUBLIC)["moves"][0]
    assert "\\[Bad\\]" in line  # Markdown from the data is escaped


# --- season clock ----------------------------------------------------------------------------------------------------


def test_a_season_alert_goes_out_a_week_ahead_once_and_never_after_its_date(tmp_path):
    cba = datetime(2026, 12, 1, 12, tzinfo=timezone.utc).timestamp()
    p, server, clock = make(tmp_path, clock=Clock(cba - 8 * DAY))
    p.round(board(), fresh=True)
    assert server.history.get(TALK_CH, []) == []  # eight days ahead: too early
    clock.t = cba - 7 * DAY
    p.round(board(), fresh=True)
    p.round(board(), fresh=True)
    (post,) = server.history[TALK_CH]
    assert post["embeds"][0]["title"] == "Season clock · MLB's labour deal ends on December 1"
    assert "lockout" in post["embeds"][0]["description"].lower()
    again, _, _ = make(tmp_path, server=server, clock=clock)
    again.round(board(), fresh=True)
    assert len(server.history[TALK_CH]) == 1
    late, server2, _ = make(tmp_path / "late", clock=Clock(cba + DAY))
    late.round(board(), fresh=True)
    assert server2.history.get(TALK_CH, []) == []


def test_the_season_table_covers_every_month_and_every_event_is_dated_in_the_future_of_the_research():
    for month in range(1, 13):
        assert season_clock.tip_for(datetime(2026, month, 5).date())
    ids = [e[0] for e in season_clock.EVENTS]
    assert len(set(ids)) == len(ids)
    assert datetime(2026, 12, 1).date() in [e[1] for e in season_clock.EVENTS]
    text = json.dumps([season_clock.TIPS, [e[2:] for e in season_clock.EVENTS]]).lower()
    for word in ("casino",):
        assert word not in text
    assert season_clock.due_events(datetime(2026, 11, 24).date(), 7, set())[0][0] == "mlb-labour-deal-2026"
    assert season_clock.due_events(datetime(2026, 11, 24).date(), 7, {"mlb-labour-deal-2026"}) == []


def test_a_step_that_breaks_never_stops_the_others_or_raises(tmp_path, caplog):
    p, server, _ = make(tmp_path, news=[entry("flagged", "2026-11-12", announce=True)])

    def boom(*_):
        raise RuntimeError("bug")

    p._post_news = boom
    p.round(board(deal(1)), fresh=True)
    assert len(server.posts(DEALS_CH)) == 1 and "a Discord post step failed" in caplog.text
