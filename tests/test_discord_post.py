"""The Discord poster: which deals go to #live-deals, how often, when the Deal Alerts role is pinged, what a post looks
like, the daily pass picks in #otd-picks, what it remembers across restarts and how it behaves when Discord says no.
Discord is a scripted fake here and the clock a number: no test ever reaches the network or waits."""

import json
from datetime import datetime, timezone

import pytest

from advisor import discord_post as dp
from advisor.rules import (
    DISCORD_DEALS_PER_DAY,
    DISCORD_DEALS_PER_HOUR,
    DISCORD_DEALS_PER_ROUND,
    DISCORD_PINGS_PER_DAY,
    DISCORD_POSTED_KEPT,
)
from tests.test_discord_gate import BOT_TOKEN, GUILD_ID
from tests.test_discord_gate import ENV as GATE_ENV

PUBLIC = "https://palace.example.test"
DEALS_CH = "100000000000000001"
OTD_CH = "100000000000000002"
OTHER_CH = "100000000000000003"
NEWS_CH = "100000000000000004"
TALK_CH = "100000000000000005"
ROLE = "200000000000000001"
# 2026-11-16 12:00:00 UTC
NOON = datetime(2026, 11, 16, 12, 0, tzinfo=timezone.utc).timestamp()
DAY = 86400


def iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def deal(listing_id=101, **over):
    """A deal the New level shows: high confidence, 30 % under, 50 Rax of profit after fees, hours left. Each listing
    is its own player (22 + its id), so the per-player cap never gets in the way; pass `player_id=` to share one."""
    row = {
        "listing_id": listing_id, "card_id": listing_id, "sport": "nba", "season": 2026, "player_id": 22 + listing_id,
        "player_name": "Nikola Jokic", "card_label": "x", "rarity": 3, "rating": 7.4, "bucket": "7-9", "mint": 12,
        "kind": "target", "price": 300, "reference": 430, "ref_source": "sales", "ref_tier": None, "ref_sample": 12,
        "confidence": "high", "discount": 0.302, "gap": 130, "flip_margin": 77, "num_bids": 0,
        "ends_at": iso(NOON + 2 * DAY), "url": "https://www.realapp.com/abc", "per_point": 40.5,
        "ref_per_point": 58.1, "listed_at": iso(NOON - 600), "falling": False, "seen_at": None,
    }
    return {**row, **over}


def big(listing_id=500, **over):
    """An exceptional deal: 50 % under, 200 Rax of profit after fees."""
    return deal(listing_id, **{"price": 500, "reference": 1000, "discount": 0.5, "gap": 500, "flip_margin": 390, **over})


def gone_row(listing_id, reason="ended", **over):
    return {**deal(listing_id, **over), "reason": reason, "gone_at": iso(NOON)}


def snapshot(deals=(), gone=(), demo=False, generated=NOON, otd=None, coverage=None):
    rules = {"demo": demo, "photo_sports": ["mlb", "nba", "nfl"]}
    if coverage is not None:
        rules["coverage"] = coverage
    return {"version": 1, "generated_at": iso(generated), "deals": list(deals), "gone": list(gone),
            "rules": rules, "otd": otd if otd is not None else {"markets": [], "picks": {}}}


class Clock:
    def __init__(self, t: float = NOON):
        self.t = t

    def __call__(self) -> float:
        return self.t


class FakeDiscord:
    """Discord as a script: the guild's channels and roles, and an answer per call that can be set ahead."""

    def __init__(self, channels=None, roles=None):
        self.calls: list[tuple[str, str, dict, dict | None]] = []
        self.channels = channels if channels is not None else [
            {"id": DEALS_CH, "name": "live-deals", "type": 0},
            {"id": OTD_CH, "name": "otd-picks", "type": 0},
            {"id": OTHER_CH, "name": "general", "type": 0},
        ]
        self.roles = roles if roles is not None else [{"id": ROLE, "name": "Deal Alerts", "mentionable": True}]
        self.queue: list = []  # answers to give before the defaults: (status, body) or an exception
        self.next_id = 900000000000000000

    def __call__(self, method, url, headers, body):
        path = url.removeprefix(dp.API)
        sent = json.loads(body) if body else None
        self.calls.append((method, path, headers, sent))
        if self.queue:
            answer = self.queue.pop(0)
            if isinstance(answer, Exception):
                raise answer
            status, data = answer
            return status, json.dumps(data).encode()
        if path == f"/guilds/{GUILD_ID}/channels":
            return 200, json.dumps(self.channels).encode()
        if path == f"/guilds/{GUILD_ID}/roles":
            return 200, json.dumps(self.roles).encode()
        if method == "POST":
            self.next_id += 1
            return 200, json.dumps({"id": str(self.next_id)}).encode()
        return 200, b"{}"

    def posts(self, channel=DEALS_CH):
        return [sent for method, path, _, sent in self.calls if method == "POST" and path == f"/channels/{channel}/messages"]

    def edits(self):
        return [(path, sent) for method, path, _, sent in self.calls if method == "PATCH"]


def config(**env):
    return dp.config_from_env({**GATE_ENV, **env})


def poster(tmp_path, fake=None, clock=None, **env):
    fake = fake or FakeDiscord()
    return dp.Poster(config(**env), tmp_path / "discord-posts.json", transport=fake, clock=clock or Clock()), fake


# --- settings -------------------------------------------------------------------------------------------------------


def test_the_poster_runs_with_the_gate_settings_and_not_without_them():
    assert dp.config_from_env({}) is None
    on = config()
    assert on.guild_id == GUILD_ID and on.public_url == PUBLIC
    assert BOT_TOKEN not in repr(on)


def test_the_poster_can_be_turned_off_with_its_own_switch():
    assert config(ADVISOR_DISCORD_POST="0") is None
    assert config(ADVISOR_DISCORD_POST="1") is not None


def test_channel_and_role_overrides_are_taken_when_they_are_discord_ids_and_ignored_otherwise():
    cfg = config(ADVISOR_DISCORD_DEALS_CHANNEL=f" {OTHER_CH}\n", ADVISOR_DISCORD_OTD_CHANNEL="otd-picks",
                 ADVISOR_DISCORD_ALERTS_ROLE=ROLE)
    assert cfg.deals_channel == OTHER_CH and cfg.otd_channel is None and cfg.alerts_role == ROLE


# --- which deals ----------------------------------------------------------------------------------------------------


def pick(*rows, **kw):
    return [row["listing_id"] for row in dp.pick_deals(snapshot(rows, **kw), NOON)]


def test_a_good_deal_is_picked_and_the_best_discount_comes_first():
    assert pick(deal(1), deal(2, discount=0.45), deal(3, discount=0.26)) == [2, 1, 3]


@pytest.mark.parametrize("over", [
    {"flip_margin": 0},  # no profit once both fees are paid
    {"flip_margin": -5},
    {"reference": 150, "price": 100, "discount": 0.333, "flip_margin": 25},  # a thin usual price, under 200
    {"discount": 0.22},  # under the New level's 25 %
    {"confidence": "medium"},
    {"kind": "bid"},
    {"falling": True},
    {"injury": {"status": "day-to-day", "detail": "Ankle"}},  # any note at all
    {"injury": {"status": "out"}},
    {"ends_at": iso(NOON + 300)},  # five minutes left
    {"ends_at": iso(NOON - 60)},
    {"seen_at": iso(NOON - 3600)},  # read an hour ago: its price may have moved
    {"listing_id": "101"},  # not a readable row
    {"price": None},
])
def test_a_deal_that_is_not_good_for_a_player_is_left_out(over):
    assert pick({**deal(1), **over}) == []


def test_a_deal_read_a_little_before_the_snapshot_is_still_picked():
    assert pick(deal(1, seen_at=iso(NOON - 300))) == [1]


def test_a_gone_row_is_never_picked_and_one_listing_counts_once():
    assert pick(deal(1), deal(1, discount=0.4), gone=[gone_row(2)]) == [1]


def test_sample_data_is_never_picked():
    assert pick(deal(1), demo=True) == []


def test_resale_words_follow_the_sites_clear_cases_only():
    assert dp.resale_tag({"listed": 20, "sold": 12}) == "Resells well"
    assert dp.resale_tag({"listed": 20, "sold": 5}) == "Slow to resell"
    assert dp.resale_tag({"listed": 20, "sold": 8}) is None
    assert dp.resale_tag({"listed": 10, "sold": 10}) is None  # too few to say
    assert dp.resale_tag({"listed": 20, "sold": 21}) is None
    assert dp.resale_tag("lots") is None


def test_an_exceptional_deal_is_far_under_with_a_big_profit_and_not_slow_to_resell():
    assert dp.exceptional(big())
    assert not dp.exceptional(deal())  # 30 % under
    assert not dp.exceptional(big(flip_margin=60))
    assert not dp.exceptional(big(resale={"listed": 40, "sold": 4}))
    assert dp.exceptional(big(resale={"listed": 40, "sold": 30}))


# --- the post -------------------------------------------------------------------------------------------------------


def test_a_deal_post_says_who_what_price_value_and_profit_and_links_to_its_page():
    message = dp.deal_message(deal(resale={"listed": 30, "sold": 20}), PUBLIC, {"nba"}, role=None)
    assert message["allowed_mentions"] == {"parse": []} and "content" not in message
    (embed,) = message["embeds"]
    assert embed["title"] == "Nikola Jokic · 30% under"
    assert embed["url"] == f"{PUBLIC}/d/101"
    assert embed["description"] == "NBA 2025-26 · 7.4 rating · 🟠 Rare"
    fields = {field["name"]: field["value"] for field in embed["fields"]}
    assert fields == {"Price": "300 Rax", "Usual price": "430 Rax", "Under": "30%",
                      "Profit after fees": "+77 Rax", "Resale": "Resells well"}
    assert embed["footer"] == {"text": "Prices move fast. Check before you buy."}
    assert embed["thumbnail"] == {"url": f"{PUBLIC}/img/players/nba/123"}
    assert "casino" not in json.dumps(message).lower()


def test_a_post_has_no_photo_off_https_or_for_a_sport_without_photos():
    assert "thumbnail" not in dp.deal_message(deal(), "http://localhost:8795", {"nba"}, role=None)["embeds"][0]
    assert "thumbnail" not in dp.deal_message(deal(sport="soccer"), PUBLIC, {"nba"}, role=None)["embeds"][0]
    assert "thumbnail" not in dp.deal_message(deal(sport="../x"), PUBLIC, {"../x"}, role=None)["embeds"][0]


def test_a_post_without_resale_words_has_no_resale_field_and_a_name_cannot_ping_or_format():
    row = deal(player_name="**@everyone**\x00 <@&1>", resale={"listed": 20, "sold": 9})
    message = dp.deal_message(row, PUBLIC, set(), role=None)
    embed = message["embeds"][0]
    assert "Resale" not in {field["name"] for field in embed["fields"]}
    assert "\x00" not in embed["title"] and "**" not in embed["title"].replace("\\*", "")
    assert message["allowed_mentions"] == {"parse": []}


def test_a_ping_names_the_role_and_allows_that_role_alone():
    message = dp.deal_message(big(), PUBLIC, set(), role=ROLE)
    assert message["content"] == f"<@&{ROLE}>"
    assert message["allowed_mentions"] == {"parse": [], "roles": [ROLE]}


def test_a_gone_post_says_so_and_why():
    embed = dp.deal_message(gone_row(7, reason="outbid"), PUBLIC, set(), role=None, gone="outbid")["embeds"][0]
    assert embed["title"].startswith("Gone · ")
    assert embed["description"].startswith("Gone: It was outbid.")
    assert embed["color"] == dp.GONE_COLOR


# --- posting --------------------------------------------------------------------------------------------------------


def test_the_channels_and_the_role_are_found_by_name_once(tmp_path):
    p, fake = poster(tmp_path)
    p.round(snapshot([deal(1)]), fresh=True)
    p.round(snapshot([deal(2)]), fresh=True)
    gets = [path for method, path, _, _ in fake.calls if method == "GET"]
    assert gets == [f"/guilds/{GUILD_ID}/channels", f"/guilds/{GUILD_ID}/roles"]
    assert len(fake.posts()) == 2
    _, _, headers, _ = fake.calls[-1]
    assert headers["Authorization"] == f"Bot {BOT_TOKEN}" and headers["Content-Type"] == "application/json"


def test_overrides_skip_the_lookup(tmp_path):
    p, fake = poster(tmp_path, ADVISOR_DISCORD_DEALS_CHANNEL=OTHER_CH, ADVISOR_DISCORD_OTD_CHANNEL=OTD_CH,
                     ADVISOR_DISCORD_ANNOUNCE_CHANNEL=NEWS_CH, ADVISOR_DISCORD_TALK_CHANNEL=TALK_CH,
                     ADVISOR_DISCORD_ALERTS_ROLE=ROLE)
    p._news = []  # nothing to announce here
    p.round(snapshot([big(1)]), fresh=True)
    assert [method for method, *_ in fake.calls] == ["POST"]
    assert fake.posts(OTHER_CH)[0]["content"] == f"<@&{ROLE}>"


def test_a_channel_name_with_a_decoration_in_front_is_found(tmp_path):
    fake = FakeDiscord(channels=[{"id": DEALS_CH, "name": "📈-live-deals", "type": 0},
                                 {"id": OTD_CH, "name": "otd-picks", "type": 2}])  # a voice channel: not it
    p, _ = poster(tmp_path, fake)
    p.round(snapshot([deal(1)]), fresh=True)
    assert len(fake.posts()) == 1
    assert p.channels == {"deals": DEALS_CH}


def test_each_deal_is_posted_once_even_after_a_restart(tmp_path):
    clock = Clock()
    p, fake = poster(tmp_path, clock=clock)
    p.round(snapshot([deal(1)]), fresh=True)
    clock.t += 60
    p.round(snapshot([deal(1)]), fresh=True)
    again, fake2 = poster(tmp_path, clock=clock)
    clock.t += 60
    again.round(snapshot([deal(1), deal(2)]), fresh=True)
    assert len(fake.posts()) == 1
    assert [post["embeds"][0]["url"] for post in fake2.posts()] == [f"{PUBLIC}/d/2"]


def test_a_first_round_posts_the_best_few_only(tmp_path):
    p, fake = poster(tmp_path)
    p.round(snapshot([deal(i, discount=0.3 + i / 100) for i in range(1, 9)]), fresh=True)
    assert len(fake.posts()) == DISCORD_DEALS_PER_ROUND == 3
    assert [post["embeds"][0]["url"].rsplit("/", 1)[1] for post in fake.posts()] == ["8", "7", "6"]


def test_no_more_than_six_deals_an_hour_and_forty_a_day(tmp_path):
    clock = Clock()
    p, fake = poster(tmp_path, clock=clock)
    listing = 1
    hour_counts = []
    while clock.t < NOON + DAY:  # a round every 10 minutes for a day, five new deals each
        p.round(snapshot([deal(listing + i) for i in range(5)]), fresh=True)
        listing += 5
        clock.t += 600
        if clock.t == NOON + 3600:
            hour_counts.append(len(fake.posts()))
    assert hour_counts == [DISCORD_DEALS_PER_HOUR] == [6]
    assert len(fake.posts()) == DISCORD_DEALS_PER_DAY == 40


def test_the_caps_survive_a_restart(tmp_path):
    clock = Clock()
    p, fake = poster(tmp_path, clock=clock)
    for round_ in range(2):
        p.round(snapshot([deal(round_ * 10 + i) for i in range(3)]), fresh=True)
        clock.t += 60
    assert len(fake.posts()) == 6
    again, fake2 = poster(tmp_path, clock=clock)
    again.round(snapshot([deal(100 + i) for i in range(3)]), fresh=True)
    assert fake2.posts() == []
    clock.t += 3600
    again.round(snapshot([deal(100 + i) for i in range(3)]), fresh=True)
    assert len(fake2.posts()) == 3


def test_stale_data_posts_no_deal(tmp_path):
    p, fake = poster(tmp_path)
    p.round(snapshot([deal(1)]), fresh=False)
    assert fake.posts() == []


def test_only_an_exceptional_deal_pings_and_at_most_three_a_day(tmp_path):
    clock = Clock()
    p, fake = poster(tmp_path, clock=clock)
    p.round(snapshot([deal(1), big(2)]), fresh=True)
    first = fake.posts()
    assert [post.get("content") for post in first] == [f"<@&{ROLE}>", None]
    for i in range(5):
        clock.t += 3600
        p.round(snapshot([big(10 + i)]), fresh=True)
    pinged = [post for post in fake.posts() if post.get("content")]
    assert len(pinged) == DISCORD_PINGS_PER_DAY == 3
    assert len(fake.posts()) == 7  # past the third ping, exceptional deals still go out, quietly
    assert all(post["allowed_mentions"] == {"parse": []} for post in fake.posts() if not post.get("content"))


def test_no_role_found_means_no_ping(tmp_path):
    p, fake = poster(tmp_path, FakeDiscord(roles=[{"id": ROLE, "name": "Members"}]))
    p.round(snapshot([big(1)]), fresh=True)
    assert fake.posts()[0].get("content") is None


def test_a_posted_deal_that_goes_away_gets_gone_on_its_post_once(tmp_path):
    clock = Clock()
    p, fake = poster(tmp_path, clock=clock)
    p.round(snapshot([deal(1), deal(2)]), fresh=True)
    message_id = str(fake.next_id - 1)  # deal 1 went first (the same discount: the lower id first)
    clock.t += 30
    p.round(snapshot([deal(2)], gone=[gone_row(1, reason="ended")]), fresh=True)
    clock.t += 30
    p.round(snapshot([deal(2)], gone=[gone_row(1, reason="ended")]), fresh=True)
    (edit,) = fake.edits()
    assert edit[0] == f"/channels/{DEALS_CH}/messages/{message_id}"
    assert edit[1]["embeds"][0]["title"].startswith("Gone · ")


def test_gone_is_also_learnt_from_the_stores_memory(tmp_path):
    clock = Clock()
    p, fake = poster(tmp_path, clock=clock)
    p.round(snapshot([deal(1)]), fresh=True)
    clock.t += 300
    remembered = {1: gone_row(1, reason="countdown_started")}
    p.round(snapshot([]), fresh=True, ended=remembered.get)
    (edit,) = fake.edits()
    assert "Someone started the countdown." in edit[1]["embeds"][0]["description"]


def test_the_posted_list_is_bounded_and_an_unreadable_file_starts_empty(tmp_path):
    path = tmp_path / "discord-posts.json"
    log = dp.PostLog(path)
    for i in range(DISCORD_POSTED_KEPT + 50):
        log.add(i, "1", "deals", NOON, ping=False)
    log.save()
    assert len(dp.PostLog(path).posted) == DISCORD_POSTED_KEPT
    assert 0 not in dp.PostLog(path).posted and DISCORD_POSTED_KEPT + 49 in dp.PostLog(path).posted
    path.write_text("{not json")
    assert len(dp.PostLog(path).posted) == 0
    assert path.with_name(path.name + ".corrupt").exists()
    path.write_text(json.dumps({"posted": [["x", 1], [5, "9", "deals", NOON, False]], "deal_times": ["a", NOON],
                                "ping_times": None, "otd_day": 7}))
    log = dp.PostLog(path)
    assert list(log.posted) == [5] and log.deal_times == [NOON] and log.ping_times == [] and log.otd_day is None


# --- errors ---------------------------------------------------------------------------------------------------------


def test_a_429_waits_for_retry_after_and_the_deal_goes_out_later(tmp_path):
    clock = Clock()
    p, fake = poster(tmp_path, clock=clock)
    p.round(snapshot([]), fresh=True)  # find the channels first
    fake.queue.append((429, {"retry_after": 12.5, "global": False}))
    p.round(snapshot([deal(1)]), fresh=True)
    calls = len(fake.calls)
    clock.t += 5
    p.round(snapshot([deal(1)]), fresh=True)
    assert len(fake.calls) == calls  # still waiting
    clock.t += 10
    p.round(snapshot([deal(1)]), fresh=True)
    assert len(fake.posts()) == 2 and fake.posts()[0] == fake.posts()[1]  # the refused one, then the one that went


def test_a_429_while_deals_go_out_stops_the_rest_of_the_round_the_daily_post_included(tmp_path):
    clock = Clock(NOON + 3 * 3600)  # 15:00: the daily post is due too
    p, fake = poster(tmp_path, clock=clock)
    p.round(snapshot([]), fresh=False)  # find the channels first; stale data posts nothing
    fake.queue.append((429, {"retry_after": 30, "global": False}))
    p.round(snapshot([deal(1), deal(2)], otd=otd_section()), fresh=True)
    assert len(fake.posts()) == 1 and fake.posts(OTD_CH) == []
    clock.t += 31
    p.round(snapshot([deal(1), deal(2)], otd=otd_section()), fresh=True)
    assert len(fake.posts()) == 3 and len(fake.posts(OTD_CH)) == 1


def test_discord_down_backs_off_and_never_raises(tmp_path):
    clock = Clock()
    p, fake = poster(tmp_path, clock=clock)
    fake.queue.append(TimeoutError("slow"))
    p.round(snapshot([deal(1)]), fresh=True)  # the channel lookup times out
    assert len(fake.calls) == 1
    clock.t += 10
    p.round(snapshot([deal(1)]), fresh=True)
    assert len(fake.calls) == 1  # backing off
    clock.t += 30
    fake.queue.append((502, {}))
    p.round(snapshot([deal(1)]), fresh=True)
    assert len(fake.calls) == 2
    clock.t += 45  # the second failure doubled the wait to 60 s
    p.round(snapshot([deal(1)]), fresh=True)
    assert len(fake.calls) == 2
    clock.t += 30
    p.round(snapshot([deal(1)]), fresh=True)
    assert len(fake.posts()) == 1


@pytest.mark.parametrize("status,code", [(403, 50013), (404, 10003)])
def test_a_channel_refused_or_deleted_stops_its_posts_until_restart_and_logs_once(tmp_path, caplog, status, code):
    clock = Clock()
    p, fake = poster(tmp_path, clock=clock)
    p.round(snapshot([]), fresh=True)
    fake.queue.append((status, {"code": code, "message": "nope"}))
    p.round(snapshot([deal(1)]), fresh=True)
    for i in range(3):
        clock.t += 600
        p.round(snapshot([deal(2 + i)]), fresh=True)
    assert len(fake.posts()) == 1
    warnings = [r for r in caplog.records if "live-deals" in r.getMessage()]
    assert len(warnings) == 1 and str(status) in warnings[0].getMessage()


def test_a_lookup_refused_turns_the_poster_off_until_restart(tmp_path, caplog):
    p, fake = poster(tmp_path)
    fake.queue.append((401, {"code": 0}))
    p.round(snapshot([deal(1)]), fresh=True)
    p.round(snapshot([deal(2)]), fresh=True)
    assert len(fake.calls) == 1
    assert sum("off until" in r.getMessage() for r in caplog.records) == 1


def test_a_post_discord_refuses_as_malformed_is_not_tried_again(tmp_path):
    clock = Clock()
    p, fake = poster(tmp_path, clock=clock)
    p.round(snapshot([]), fresh=True)
    fake.queue.append((400, {"code": 50035}))
    p.round(snapshot([deal(1)]), fresh=True)
    clock.t += 60
    p.round(snapshot([deal(1)]), fresh=True)
    assert len(fake.posts()) == 1


def test_no_log_line_ever_holds_the_token(tmp_path, caplog):
    caplog.set_level("DEBUG")
    p, fake = poster(tmp_path)
    fake.queue.extend([(500, {"message": BOT_TOKEN})])
    p.round(snapshot([deal(1)]), fresh=True)
    assert BOT_TOKEN not in caplog.text


def test_a_message_deleted_by_hand_is_not_edited_again(tmp_path):
    clock = Clock()
    p, fake = poster(tmp_path, clock=clock)
    p.round(snapshot([deal(1)]), fresh=True)
    fake.queue.append((404, {"code": 10008}))  # Unknown Message
    clock.t += 30
    p.round(snapshot([deal(2)], gone=[gone_row(1)]), fresh=True)
    clock.t += 30
    p.round(snapshot([deal(3)], gone=[gone_row(1)]), fresh=True)
    assert len(fake.edits()) == 1
    assert len(fake.posts()) == 3  # the channel still works


# --- the daily pass picks -------------------------------------------------------------------------------------------


def market(key, sport, name, *, year_per_rax, year_rax, cost, months, tier="rare", season=2025):
    rung = {"tier": tier, "rating": 80, "cost": cost, "year_rax": year_rax, "year_per_rax": year_per_rax,
            "pays_back": True, "payback_months": months}
    return {"key": key, "sport": sport, "season": season, "season_label": str(season), "player_id": hash(key) % 1000,
            "player_name": name, "kind": "player", "rungs": [{"tier": "general", "cost": 200, "year_rax": 10,
                                                               "year_per_rax": 0.05, "pays_back": False,
                                                               "payback_months": None}, rung], "best": tier}


def otd_section():
    markets = [
        market("a", "nba", "Player A", year_per_rax=0.9, year_rax=900, cost=1000, months=13.2),
        market("b", "nba", "Player B", year_per_rax=0.8, year_rax=800, cost=1000, months=15),
        market("c", "nba", "Player C", year_per_rax=0.7, year_rax=700, cost=1000, months=17),  # third NBA: out
        market("d", "nfl", "Player D", year_per_rax=0.6, year_rax=1200, cost=2000, months=20),
        market("e", "mlb", "Player E", year_per_rax=0.5, year_rax=250, cost=500, months=24, tier="epic"),
        market("f", "mlb", "Player F", year_per_rax=0.4, year_rax=400, cost=1000, months=30),
        market("g", "nhl", "Player G", year_per_rax=0.3, year_rax=300, cost=1000, months=40),
        market("z", "nhl", "Not picked", year_per_rax=5.0, year_rax=5000, cost=1000, months=2),
    ]
    picks = {"nba": ["a", "b", "c"], "nfl": ["d"], "mlb": ["e", "f"], "nhl": ["g", "missing"]}
    return {"as_of": iso(NOON), "markets": markets, "picks": picks}


def test_the_daily_picks_are_the_sites_picks_best_first_with_two_of_a_sport_at_most():
    names = [pick["player_name"] for pick in dp.otd_picks(snapshot(otd=otd_section()), NOON)]
    assert names == ["Player A", "Player B", "Player D", "Player E", "Player F"]


def test_picks_measured_long_ago_or_from_sample_data_are_none():
    old = {"otd_as_of": iso(NOON - 9 * DAY)}
    assert dp.otd_picks(snapshot(otd=otd_section(), coverage=old), NOON) == []
    assert dp.otd_picks(snapshot(otd=otd_section(), demo=True), NOON) == []
    assert dp.otd_picks(snapshot(otd={"markets": "x", "picks": None}), NOON) == []
    fresh = {"otd_as_of": iso(NOON - 7 * DAY)}
    assert len(dp.otd_picks(snapshot(otd=otd_section(), coverage=fresh), NOON)) == 5


def test_the_daily_post_is_one_compact_embed_linking_to_the_passes():
    picks = dp.otd_picks(snapshot(otd=otd_section()), NOON)
    message = dp.otd_message(picks, PUBLIC, datetime.fromtimestamp(NOON, timezone.utc))
    (embed,) = message["embeds"]
    assert message["allowed_mentions"] == {"parse": []}
    assert embed["title"] == "On This Day picks · Nov 16"
    assert embed["url"] == f"{PUBLIC}/#passes"
    first = embed["description"].split("\n")[0]
    assert first == "**1. Player A** · NBA 2025 · 🟠 Rare pass · 1,000 Rax · about 900 Rax a year · pays back in 13 months"
    assert "Epic pass" in embed["description"]
    assert len(embed["description"]) < 1500


def test_the_daily_post_goes_out_at_15_utc_once_and_not_again_after_a_restart(tmp_path):
    clock = Clock(NOON)
    p, fake = poster(tmp_path, clock=clock)
    snap = snapshot(otd=otd_section())
    p.round(snap, fresh=True)
    assert fake.posts(OTD_CH) == []  # noon: too early
    clock.t = NOON + 3 * 3600  # 15:00
    p.round(snap, fresh=True)
    p.round(snap, fresh=True)
    assert len(fake.posts(OTD_CH)) == 1
    again, fake2 = poster(tmp_path, clock=clock)
    clock.t += 1800
    again.round(snap, fresh=True)
    assert fake2.posts(OTD_CH) == []
    clock.t = NOON + DAY + 3 * 3600 + 60  # the next day, 15:01
    again.round(snap, fresh=True)
    assert len(fake2.posts(OTD_CH)) == 1


def test_a_server_down_at_15_posts_later_that_afternoon_but_not_at_night(tmp_path):
    clock = Clock(NOON + 7 * 3600)  # 19:00
    p, fake = poster(tmp_path, clock=clock)
    p.round(snapshot(otd=otd_section()), fresh=True)
    assert len(fake.posts(OTD_CH)) == 1
    clock2 = Clock(NOON + 10 * 3600)  # 22:00, another data dir
    q, fake2 = poster(tmp_path / "other", clock=clock2)
    q.round(snapshot(otd=otd_section()), fresh=True)
    assert fake2.posts(OTD_CH) == []


def test_the_daily_post_waits_for_fresh_picks_within_its_window(tmp_path):
    clock = Clock(NOON + 3 * 3600)
    p, fake = poster(tmp_path, clock=clock)
    p.round(snapshot(otd=otd_section()), fresh=False)  # stale data
    p.round(snapshot(), fresh=True)  # no picks
    assert fake.posts(OTD_CH) == []
    clock.t += 600
    p.round(snapshot(otd=otd_section()), fresh=True)
    assert len(fake.posts(OTD_CH)) == 1


# --- the thread -----------------------------------------------------------------------------------------------------


class FakeStore:
    def __init__(self):
        self.snap = None
        self.version = None
        self.ok = True

    def publish(self, snap):
        self.snap, self.version = snap, (self.version or 0) + 1

    def health(self):
        return {"version": self.version, "ok": self.ok}

    def current(self, gzipped=False, otd=None):
        return None if self.snap is None else (json.dumps(self.snap).encode(), "etag")

    def ended(self, listing_id):
        return None


class Recorder:
    def __init__(self, fail=False):
        self.rounds = []
        self.fail = fail

    def round(self, snapshot, fresh, ended=None):
        self.rounds.append((snapshot["version"] if snapshot else None, fresh))
        if self.fail:
            raise RuntimeError("boom")


class Stop:
    """Stops after `n` waits."""

    def __init__(self, n):
        self.n = n

    def is_set(self):
        return self.n <= 0

    def wait(self, _seconds):
        self.n -= 1
        return self.n <= 0


def test_the_thread_hands_each_new_snapshot_over_once_and_survives_a_failing_round():
    store = FakeStore()
    rec = Recorder(fail=True)
    store.publish(snapshot([deal(1)]) | {"version": 7})
    dp.run_poster(rec, store, Stop(3))
    assert len(rec.rounds) == 1
    store.publish(snapshot() | {"version": 8})
    store.ok = False
    dp.run_poster(rec, store, Stop(2))
    assert rec.rounds[-1] == (8, False)


def test_the_thread_waits_for_a_first_snapshot():
    rec = Recorder()
    dp.run_poster(rec, FakeStore(), Stop(3))
    assert rec.rounds == []


# --- review fixes ---------------------------------------------------------------------------------------------------


def test_each_post_carries_a_nonce_so_a_retry_after_a_lost_answer_is_not_a_second_message(tmp_path):
    clock = Clock(NOON + 3 * 3600)
    p, fake = poster(tmp_path, clock=clock)
    p.round(snapshot([deal(1)], otd=otd_section()), fresh=True)
    (post,) = fake.posts()
    assert post["nonce"] == "d1" and post["enforce_nonce"] is True
    (otd,) = fake.posts(OTD_CH)
    assert otd["nonce"] == "otd2026-11-16" and len(otd["nonce"]) <= 25


def test_a_post_is_remembered_the_moment_it_went_out(tmp_path):
    p, fake = poster(tmp_path)
    p.round(snapshot([]), fresh=True)
    fake.queue.extend([(200, {"id": "900000000000000123"}), TimeoutError("slow")])
    p.round(snapshot([deal(1), deal(2)]), fresh=True)
    saved = json.loads((tmp_path / "discord-posts.json").read_text())
    assert [row[0] for row in saved["posted"]] == [1] and len(saved["deal_times"]) == 1


def test_a_post_that_went_out_without_an_id_still_counts_toward_the_caps(tmp_path):
    p, fake = poster(tmp_path)
    p.round(snapshot([]), fresh=True)
    fake.queue.append((200, {}))
    p.round(snapshot([big(1)]), fresh=True)
    assert len(p.log.deal_times) == 1 and len(p.log.ping_times) == 1
    assert p.log.posted[1][0] is None


def test_a_channel_list_too_big_to_read_turns_the_poster_off_and_names_the_overrides(tmp_path, caplog):
    p, fake = poster(tmp_path)
    fake.queue.append((200, {}))  # what the transport gives for an answer past its cap
    p.round(snapshot([deal(1)]), fresh=True)
    p.round(snapshot([deal(1)]), fresh=True)
    assert len(fake.calls) == 1 and "ADVISOR_DISCORD_DEALS_CHANNEL" in caplog.text


def test_a_role_that_is_not_mentionable_is_said_once(tmp_path, caplog):
    p, fake = poster(tmp_path, FakeDiscord(roles=[{"id": ROLE, "name": "Deal Alerts", "mentionable": False}]))
    p.round(snapshot([big(1)]), fresh=True)
    assert "not mentionable" in caplog.text and p.role == ROLE


def test_fewer_than_three_picks_make_no_daily_post(tmp_path):
    section = otd_section()
    section["picks"] = {"nba": ["a", "b"]}
    clock = Clock(NOON + 3 * 3600)
    p, fake = poster(tmp_path, clock=clock)
    p.round(snapshot(otd=section), fresh=True)
    assert fake.posts(OTD_CH) == [] and p.log.otd_day is None


def test_an_error_that_names_the_token_is_logged_by_its_class_only(tmp_path, caplog):
    caplog.set_level("DEBUG")
    p, fake = poster(tmp_path)
    fake.queue.append(RuntimeError(f"bad header Authorization: Bot {BOT_TOKEN}"))
    p.round(snapshot([deal(1)]), fresh=True)
    assert "RuntimeError" in caplog.text and BOT_TOKEN not in caplog.text


def test_the_daily_picks_are_ranked_by_how_soon_they_pay_back_from_today_not_by_the_yearly_return():
    """An idle sport's pass can return more a year per rax and still pay back later (its pay opens in spring): the post
    ranks as the site's "Pays back soonest" does."""
    otd = {"as_of": iso(NOON), "picks": {"mlb": ["idle"], "cfb": ["now"], "nhl": ["mid"]}, "markets": [
        market("idle", "mlb", "Idle MLB", year_per_rax=9.0, year_rax=9000, cost=1000, months=5.2),
        market("now", "cfb", "Paying now", year_per_rax=3.0, year_rax=3000, cost=1000, months=0.8),
        market("mid", "nhl", "Mid way", year_per_rax=6.0, year_rax=6000, cost=1000, months=2.1),
    ]}
    names = [pick["player_name"] for pick in dp.otd_picks(snapshot(otd=otd), NOON)]
    assert names == ["Paying now", "Mid way", "Idle MLB"]
