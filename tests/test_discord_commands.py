"""The slash commands: Discord's signature check, the PING, each command's answer from a snapshot, the autocomplete,
the limits, the settings and the registration. No network: the snapshot is built by hand, Discord's key is made here
and the registration goes through a fake transport."""

import json
import re
from pathlib import Path

import pytest

from advisor import rules
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from advisor import discord_commands as dc
from advisor.deals import _flip_margin
from advisor.rules import LISTING_FEE
from advisor.store import SnapshotStore
from tests.test_discord_gate import BOT_TOKEN, ENV as GATE_ENV, GUILD_ID, Clock
from tests.test_share import deal

ROOT = Path(__file__).resolve().parent.parent
PRIVATE = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
PUBLIC_HEX = PRIVATE.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw).hex()
ENV = {**GATE_ENV, "ADVISOR_DISCORD_PUBLIC_KEY": PUBLIC_HEX}
SITE = "https://palace.example.test"
USER_ID = "222233334444555566"
NOW = 1_800_000_000.0  # tests.test_discord_gate.Clock's start: 2027-01-15


def market(key, name, year_per_rax, *, cost=308, year_rax=1000, payback_month="2027-05", tier="common", **over):
    sport, season, kind, player_id = key.split(":")
    rung = {"tier": tier, "rating": 10, "cost": cost, "year_rax": year_rax, "year_per_rax": year_per_rax,
            "pays_back": True, "payback_months": 5.7, "payback_month": payback_month}
    row = {"key": key, "sport": sport, "season": int(season), "season_label": season, "player_id": int(player_id),
           "player_name": name, "kind": kind, "best": tier, "rungs": [{**rung, "tier": "general", "cost": 200}, rung]}
    return {**row, **over}


def snap(deals=(), **over):
    base = {
        "version": 7,
        "generated_at": "2027-01-15T07:59:50Z",
        "sports": ["nba", "nfl", "nhl"],
        "deals": list(deals),
        "gone": [],
        "levels": {},
        "rules": {"demo": False, "after_fees_min_ref": 200},
        "moves": {"risers": [], "fallers": []},
        "otd": {"markets": [], "picks": {}},
    }
    return {**base, **over}


GOOD = [
    deal(1, player_name="Connor Bedard", sport="nhl", price=569, reference=1078, discount=0.472, flip_margin=391,
         player_id=31, season=2026, rarity=5, ends_at="2027-01-16T01:00:00Z"),
    deal(2, player_name="Nikola Jokić", price=260, reference=477, discount=0.455, flip_margin=159, player_id=22,
         ends_at="2027-01-16T01:00:00Z", recent_sales=[[470, 100], [480, 2000], [500, 9000]]),
    deal(3, player_name="Cale Makar", sport="nhl", price=193, reference=302, discount=0.361,
         flip_margin=68, player_id=33, ends_at="2027-01-15T09:00:00Z"),
]
LOSS = deal(4, player_name="Loss Leader", price=300, reference=320, discount=0.3, flip_margin=-22, player_id=40,
            ends_at="2027-01-16T01:00:00Z")
FALLING = deal(5, player_name="Falling Star", price=200, reference=400, discount=0.5, flip_margin=150,
               falling=True, player_id=41, ends_at="2027-01-16T01:00:00Z")
THIN = deal(6, player_name="Thin Ref", price=50, reference=150, discount=0.66, flip_margin=75, player_id=42,
            ends_at="2027-01-16T01:00:00Z")
ENDED = deal(7, player_name="Ended Auction", kind="bid", price=100, reference=300, discount=0.66, flip_margin=160,
             player_id=43, ends_at="2027-01-15T07:00:00Z")
BID = deal(11, player_name="Far Auction", kind="bid", price=100, reference=300, discount=0.66, flip_margin=160,
          player_id=45, ends_at="2027-01-18T07:00:00Z")
UNSURE = deal(12, player_name="Unsure Ref", price=100, reference=300, discount=0.66, flip_margin=160, player_id=46,
             confidence="medium", ends_at="2027-01-16T01:00:00Z")
NO_END = deal(13, player_name="No End", price=100, reference=300, discount=0.66, flip_margin=160, player_id=47,
              ends_at=None)
HURT = deal(8, player_name="Hurt Guy", price=100, reference=300, discount=0.66, flip_margin=160, player_id=44,
            ends_at="2027-01-16T01:00:00Z", injury={"status": "out"})


def make(snapshot=None, clock=None, **kw):
    """The interactions over a store holding `snapshot`; the clock returned moves the store's time (the data's age)
    and the limits', while Discord's timestamps keep to NOW."""
    clock = clock or Clock(NOW)
    store = SnapshotStore(clock=clock, wall=clock)
    if snapshot is not None:
        store.publish(snapshot)
    config = dc.config_from_env(ENV)
    return dc.Interactions(config, store, clock=lambda: NOW, monotonic=clock, **kw), store, clock


def sign(body: bytes, timestamp: str | None = None, key=PRIVATE) -> tuple[str, str]:
    timestamp = timestamp if timestamp is not None else str(int(NOW))
    return key.sign(timestamp.encode() + body).hex(), timestamp


def call(interactions, payload):
    body = json.dumps(payload).encode()
    return interactions.handle(*sign(body), body)


def command(name, guild=GUILD_ID, user=USER_ID, **options):
    data = {"id": "1", "name": name, "type": 1}
    if options:
        data["options"] = [{"name": key, "type": dc.OPTION_TYPES[key], "value": value}
                           for key, value in options.items()]
    payload = {"type": 2, "id": "9", "application_id": GATE_ENV["ADVISOR_DISCORD_CLIENT_ID"], "token": "tok",
               "data": data, "member": {"user": {"id": user, "username": "someone"}}}
    if guild is not None:
        payload["guild_id"] = guild
    return payload


def typing(text, user=USER_ID):
    return {"type": 4, "guild_id": GUILD_ID, "member": {"user": {"id": user}},
            "data": {"name": "price", "type": 1,
                     "options": [{"name": "player", "type": 3, "value": text, "focused": True}]}}


def reply(interactions, name, **options):
    status, answer = call(interactions, command(name, **options))
    assert status == 200 and answer["type"] == 4
    return answer["data"]


def content(interactions, name, **options):
    return reply(interactions, name, **options)["content"]


# --- the signature ---------------------------------------------------------------------------------------------------


def test_a_ping_signed_by_discord_gets_a_pong():
    interactions, _, _ = make()
    assert call(interactions, {"type": 1}) == (200, {"type": 1})


@pytest.mark.parametrize("tamper", ["body", "signature", "timestamp", "key"])
def test_anything_not_signed_by_discord_gets_401_and_nothing_else(tamper):
    interactions, _, _ = make()
    body = b'{"type":1}'
    signature, timestamp = sign(body, key=Ed25519PrivateKey.generate() if tamper == "key" else PRIVATE)
    if tamper == "body":
        body = b'{"type":1 }'
    elif tamper == "signature":
        signature = ("0" if signature[0] != "0" else "1") + signature[1:]
    elif tamper == "timestamp":
        timestamp = str(int(NOW) + 1)
    assert interactions.handle(signature, timestamp, body) == (401, None)


@pytest.mark.parametrize("signature, timestamp", [
    (None, str(int(NOW))), ("ab" * 64, None), ("", ""), ("zz" * 64, str(int(NOW))), ("ab" * 63, str(int(NOW))),
    ("ab" * 64, "12.5"), ("ab" * 64, "-1"), ("ab" * 64, "9" * 40),
])
def test_missing_or_malformed_signature_headers_get_401(signature, timestamp):
    interactions, _, _ = make()
    assert interactions.handle(signature, timestamp, b'{"type":1}') == (401, None)


@pytest.mark.parametrize("offset, ok", [(-299, True), (299, True), (-301, False), (301, False)])
def test_a_timestamp_more_than_five_minutes_off_is_refused_even_when_signed(offset, ok):
    interactions, _, _ = make()
    body = b'{"type":1}'
    status, _ = interactions.handle(*sign(body, str(int(NOW) + offset)), body)
    assert status == (200 if ok else 401)


@pytest.mark.parametrize("body", [b"not json", b"[1]", b'{"type": 5}', b'{"type": "1"}'])
def test_a_signed_body_that_is_no_interaction_we_answer_gets_400(body):
    interactions, _, _ = make()
    assert interactions.handle(*sign(body), body) == (400, None)


# --- every reply -----------------------------------------------------------------------------------------------------


def test_replies_are_ephemeral_without_link_previews_or_pings_and_end_with_the_site():
    interactions, _, _ = make(snap(GOOD))
    data = reply(interactions, "fees", price=1000)
    assert data["flags"] == dc.EPHEMERAL | dc.SUPPRESS_EMBEDS
    assert data["allowed_mentions"] == {"parse": []}
    assert data["content"].rstrip().endswith(SITE)


def test_share_posts_the_reply_for_everyone():
    interactions, _, _ = make(snap(GOOD))
    data = reply(interactions, "fees", price=1000, share=True)
    assert data["flags"] == dc.SUPPRESS_EMBEDS


@pytest.mark.parametrize("name, options", [("deals", {}), ("price", {"player": "Jokić"}), ("otd", {}),
                                           ("fees", {"price": 99}), ("start", {})])
def test_every_command_answers_in_plain_short_text_with_the_site_link(name, options):
    interactions, _, _ = make(snap(GOOD))
    text = content(interactions, name, **options)
    assert len(text) <= dc.CONTENT_MAX_CHARS and text.rstrip().endswith(SITE)
    assert not re.search(r"jackpot|casino|bet\b|gambl|win big", text, re.I)


def test_outside_our_server_the_commands_say_where_they_work():
    interactions, _, _ = make(snap(GOOD))
    for guild in ("999988887777666655", None):
        text = content(interactions, "deals", guild=guild)
        assert "only in the OTD Palace Discord server" in text and "Connor" not in text


def test_a_command_we_no_longer_have_says_so():
    interactions, _, _ = make(snap(GOOD))
    assert "not a command" in content(interactions, "account").lower()


def test_one_member_asking_too_fast_is_told_to_wait_and_others_still_get_answers():
    interactions, _, clock = make(snap(GOOD))
    texts = [content(interactions, "fees", price=100) for _ in range(dc.USER_PER_MIN + 1)]
    assert all("you keep" in t.lower() for t in texts[:-1])
    assert "try again in a minute" in texts[-1].lower()
    assert "you keep" in content(interactions, "fees", user="777788889999000011", price=100).lower()
    clock.t += 60
    assert "you keep" in content(interactions, "fees", price=100).lower()


def test_the_whole_server_has_a_budget_too():
    interactions, _, _ = make(snap(GOOD))
    texts = [content(interactions, "fees", user=str(10**17 + i), price=100) for i in range(dc.GUILD_PER_MIN + 1)]
    assert "try again in a minute" in texts[-1].lower() and "you keep" in texts[-2].lower()


def test_odd_signed_input_never_fails_the_interaction():
    interactions, _, _ = make(snap(GOOD, otd={"markets": [{"key": ["x"]}], "picks": {"nba": [["x"], {"a": 1}]}}))
    weird = command("deals")
    weird["data"]["name"] = ["deals"]
    status, answer = call(interactions, weird)
    assert status == 200 and "not a command" in answer["data"]["content"]
    assert "No pass" in content(interactions, "otd")
    deep = b"[" * 5000 + b"]" * 5000
    assert interactions.handle(*sign(deep), deep) == (400, None)
    weird = command("fees")
    weird["data"]["options"] = [{"name": "price", "value": "1000"}, {"name": "margin", "value": 10**30}, "x"]
    assert "from 1 to" in call(interactions, weird)[1]["data"]["content"]


def test_rows_with_numbers_that_are_not_finite_are_left_out():
    # json writes NaN and reads it back, as a feed's document could carry it
    interactions, _, _ = make(snap([{**GOOD[0], "price": float("nan")}, GOOD[1]]))
    deals_text = content(interactions, "deals")
    assert "/d/2" in deals_text and "/d/1" not in deals_text
    assert "No current deal" in content(interactions, "price", player="Connor Bedard")


def test_a_failing_answer_still_replies_and_the_site_link_survives_a_long_reply(monkeypatch):
    interactions, _, _ = make(snap(GOOD))
    monkeypatch.setattr(interactions, "_answers", {**interactions._answers, "start": lambda options: 1 / 0})
    text = content(interactions, "start")
    assert "went wrong" in text and text.endswith(SITE)
    monkeypatch.setattr(interactions, "_answers", {**interactions._answers, "start": lambda options: "x" * 5000})
    text = content(interactions, "start")
    assert len(text) == dc.CONTENT_MAX_CHARS and text.endswith(SITE)


# --- /deals ----------------------------------------------------------------------------------------------------------


def test_deals_lists_only_live_deals_that_leave_rax_after_fees_best_first():
    interactions, _, _ = make(snap([*GOOD, LOSS, FALLING, THIN, ENDED, HURT, BID, UNSURE, NO_END]))
    text = content(interactions, "deals")
    lines = [line for line in text.splitlines() if "/d/" in line]
    assert [re.search(r"/d/(\d+)", line).group(1) for line in lines] == ["1", "2", "3"]
    first = lines[0]
    for part in ("Connor Bedard", "NHL", "569", "1,078", "47% under", "+391 after fees", f"{SITE}/d/1"):
        assert part in first
    for name in ("Loss Leader", "Falling Star", "Thin Ref", "Ended Auction", "Hurt Guy", "Far Auction", "Unsure Ref",
                 "No End"):
        assert name not in text


def test_deals_ranks_by_margin_per_rax_and_keeps_one_per_player_and_season():
    rows = [
        deal(20, player_name="Big Margin", price=1000, reference=1500, discount=0.33, flip_margin=340, player_id=60,
             ends_at="2027-01-16T01:00:00Z"),
        deal(21, player_name="Small Spend", price=200, reference=400, discount=0.5, flip_margin=150, player_id=61,
             ends_at="2027-01-16T01:00:00Z"),
        deal(22, player_name="Small Spend", price=250, reference=400, discount=0.375, flip_margin=100, player_id=61,
             ends_at="2027-01-16T01:00:00Z"),
        deal(21, player_name="Small Spend", price=200, reference=400, discount=0.5, flip_margin=150, player_id=61,
             ends_at="2027-01-16T01:00:00Z"),
    ]
    interactions, _, _ = make(snap(rows))
    links = re.findall(r"/d/(\d+)", content(interactions, "deals"))
    assert links == ["21", "20"]


def test_deals_shows_five_at_most():
    rows = [deal(100 + i, player_name=f"Player {i}", price=300, reference=600, discount=0.5, flip_margin=230,
                 player_id=100 + i, ends_at="2027-01-16T01:00:00Z") for i in range(8)]
    interactions, _, _ = make(snap(rows))
    assert content(interactions, "deals").count("/d/") == dc.TOP_DEALS == 5


def test_deals_filters_by_sport_and_by_price():
    interactions, _, _ = make(snap(GOOD))
    nhl = content(interactions, "deals", sport="nhl")
    assert "Connor" in nhl and "Makar" in nhl and "Jokić" not in nhl
    cheap = content(interactions, "deals", max_price=300)  # Makar's 193 and Jokić's 260
    assert "Connor" not in cheap and "Jokić" in cheap and "Makar" in cheap
    none = content(interactions, "deals", sport="mlb")
    assert "/d/" not in none and "No MLB deal" in none


def test_deals_filters_by_rarity_that_rarity_or_rarer():
    """/deals rarity: the deals of that rarity and every rarer one (Bedard is Legendary, the other two Rare), with the
    choice offered as Real's eight rarities by name."""
    from advisor.real import RARITY_NAMES
    interactions, _, _ = make(snap(GOOD))
    assert {row["rarity"] for row in GOOD} == {3, 5}
    legendary = content(interactions, "deals", rarity=5)
    assert "Connor" in legendary and "Jokić" not in legendary and "Makar" not in legendary
    rare_up = content(interactions, "deals", rarity=3)
    assert all(name in rare_up for name in ("Connor", "Jokić", "Makar"))
    both = content(interactions, "deals", rarity=5, sport="nba")
    assert "/d/" not in both and "No NBA deal of Legendary or rarer" in both
    alone = content(interactions, "deals", rarity=7)
    assert "/d/" not in alone and "No deal of Iconic leaves Rax" in alone
    option = next(o for o in next(c for c in dc.COMMANDS if c["name"] == "deals")["options"] if o["name"] == "rarity")
    assert option["type"] == dc.INTEGER and option["description"] == "Only this rarity or rarer"
    assert option["choices"] == [{"name": name, "value": i} for i, name in enumerate(RARITY_NAMES)]


@pytest.mark.parametrize("odd", [8, -1, "5", True, 2.5])
def test_deals_reads_a_rarity_that_is_not_one_of_reals_as_none(odd):
    interactions, _, _ = make(snap(GOOD))
    weird = command("deals")
    weird["data"]["options"] = [{"name": "rarity", "value": odd}]
    text = call(interactions, weird)[1]["data"]["content"]
    assert all(name in text for name in ("Connor", "Jokić", "Makar"))


def test_deals_say_when_the_data_is_missing_stale_or_sample():
    interactions, _, _ = make(None)
    assert "not ready yet" in content(interactions, "deals")
    interactions, _, clock = make(snap(GOOD))
    clock.t += 600
    stale = content(interactions, "deals")
    assert "paused" in stale.lower() and "10 minutes old" in stale and "/d/" not in stale
    interactions, _, _ = make(snap(GOOD, rules={"demo": True, "after_fees_min_ref": 200}))
    assert "Sample data" in content(interactions, "deals")


def test_names_from_the_data_cannot_format_or_mention():
    row = deal(9, player_name="**Bold** @everyone <@1> _x_", price=300, reference=600, discount=0.5,
               flip_margin=230, player_id=50, ends_at="2027-01-16T01:00:00Z")
    interactions, _, _ = make(snap([row]))
    text = content(interactions, "deals")
    assert "**Bold**" not in text and r"\*\*Bold\*\*" in text and r"\<@1\>" in text and r"\_x\_" in text


# --- /price and its autocomplete -------------------------------------------------------------------------------------


def priced_snap():
    moves = {"risers": [{"sport": "nba", "season": 2026, "player_id": 22, "player_name": "Nikola Jokić",
                         "bucket": "7-9", "median_recent": 520, "median_base": 400, "change": 0.3, "sales_recent": 7}],
             "fallers": []}
    initialled = deal(10, player_name="N. Jokić", price=400, reference=477, discount=0.16, flip_margin=19,
                      player_id=22, ends_at="2027-01-16T01:00:00Z")
    otd = {"markets": [market("nfl:2025:player:2001", "Josh Allen", 3.0)], "picks": {}}
    return snap([*GOOD, initialled], moves=moves, otd=otd)


def test_price_gives_the_cheapest_deal_its_usual_price_and_recent_sales():
    interactions, _, _ = make(priced_snap())
    text = content(interactions, "price", player="Nikola Jokić")
    assert "Nikola Jokić" in text and "NBA" in text
    assert "260 Rax" in text and f"{SITE}/d/2" in text and "/d/10" not in text  # the cheaper of his two deals
    assert "usual price" in text.lower() and "477" in text and "12 sales" in text
    assert "3 recent sales" in text and "median 480" in text
    assert "Price move, 2026 cards rated 7-9: median 520 Rax over 7 recent sales, up 30%" in text


def test_price_takes_the_autocomplete_value_and_loose_text():
    interactions, _, _ = make(priced_snap())
    by_key = content(interactions, "price", player="nba:22")
    assert "Nikola Jokić" in by_key and "/d/2" in by_key
    loose = content(interactions, "price", player="jokic")
    assert "/d/2" in loose
    assert "no longer in the market data" in content(interactions, "price", player="nba:999")


def test_price_without_a_deal_says_so_and_unknown_names_say_so():
    interactions, _, _ = make(priced_snap())
    allen = content(interactions, "price", player="Josh Allen")
    assert "Josh Allen" in allen and "no current deal" in allen.lower()
    nobody = content(interactions, "price", player="Zzz Nobody")
    assert "no player" in nobody.lower()


def test_price_lists_the_names_when_several_players_match():
    interactions, _, _ = make(priced_snap())
    text = content(interactions, "price", player="o")
    assert "several players" in text.lower() and "Connor Bedard" in text


def test_autocomplete_suggests_names_from_the_snapshot_accents_and_case_aside():
    interactions, _, _ = make(priced_snap())
    status, answer = call(interactions, typing("jok"))
    assert status == 200 and answer["type"] == 8
    assert answer["data"]["choices"] == [{"name": "Nikola Jokić · NBA", "value": "nba:22"}]
    _, answer = call(interactions, typing("al"))
    names = [choice["name"] for choice in answer["data"]["choices"]]
    assert names[0] == "Josh Allen · NFL"  # a word that starts with it comes before one that holds it


def test_autocomplete_gives_25_names_at_most_and_nothing_outside_our_server():
    rows = [deal(200 + i, player_name=f"Player {i:02}", player_id=200 + i) for i in range(40)]
    interactions, _, _ = make(snap(rows))
    _, answer = call(interactions, typing(""))
    assert len(answer["data"]["choices"]) == dc.AUTOCOMPLETE_MAX == 25
    payload = typing("Player")
    payload["guild_id"] = "999988887777666655"
    assert call(interactions, payload) == (200, {"type": 8, "data": {"choices": []}})


def test_autocomplete_before_any_snapshot_suggests_nothing():
    interactions, _, _ = make(None)
    assert call(interactions, typing("jo")) == (200, {"type": 8, "data": {"choices": []}})


# --- /otd ------------------------------------------------------------------------------------------------------------


def otd_snap():
    markets = [
        market("mlb:2025:player:4001", "Shohei Ohtani", 3.25),
        market("mlb:2026:player:4003", "Aaron Judge", 4.0, cost=524, year_rax=2096, payback_month="2027-04",
               tier="uncommon"),
        market("nba:2025:player:1006", "Victor Wembanyama", 2.0),
        market("nfl:2025:player:2008", "Josh Allen", 5.0, cost=200, year_rax=1000, tier="general"),
    ]
    picks = {"mlb": ["mlb:2026:player:4003", "mlb:2025:player:4001"], "nba": ["nba:2025:player:1006"],
             "nfl": ["nfl:2025:player:2008"]}
    return snap(otd={"markets": markets, "picks": picks})


def test_otd_ranks_the_sites_picks_across_sports_with_cost_and_payback():
    interactions, _, _ = make(otd_snap())
    text = content(interactions, "otd")
    lines = [line for line in text.splitlines() if re.match(r"\d\. ", line)]
    assert [re.search(r"\*\*(.+?)\*\*", line).group(1) for line in lines] == [
        "Josh Allen", "Aaron Judge", "Shohei Ohtani", "Victor Wembanyama"]
    judge = lines[1]
    for part in ("MLB 2026", "Uncommon", "524 Rax", "2,096 Rax a year", "pays back by end of April 2027"):
        assert part in judge


def test_otd_says_what_a_pass_is_and_that_offers_build_it_for_less():
    interactions, _, _ = make(otd_snap())
    text = content(interactions, "otd")
    assert "A pass pays you Rax again on the anniversaries of its player's games (On This Day)" in text
    one_in = round(1 / rules.OFFER_ACCEPTED)
    assert (f"Cheaper with offers: offer about 20% under the usual price on many cards of these passes. Most are refused "
            f"(about 1 in {one_in} is accepted in what we measured), so send many: the ones accepted are the cheapest "
            "rating you will get.") in text
    assert len(text) < 2000


def test_deals_say_a_pass_usually_gives_back_more_over_a_year():
    interactions, _, _ = make(snap([*GOOD]))
    text = content(interactions, "deals")
    assert "•" in text  # the scene has deals
    assert text.splitlines()[-2] == "Over a year, a pass that pays back usually gives more than a deal: see /otd."  # then the footer


def test_otd_for_one_sport_keeps_its_order_and_says_when_there_is_none():
    interactions, _, _ = make(otd_snap())
    mlb = content(interactions, "otd", sport="mlb")
    assert mlb.index("Aaron Judge") < mlb.index("Shohei Ohtani") and "Josh Allen" not in mlb
    assert "No NHL pass" in content(interactions, "otd", sport="nhl")


def test_otd_never_suggests_this_seasons_pass_the_feed_sends_for_deals():
    # Built the way the collector builds it: a season being played that would rank first (cheap rating, big pay) is
    # served apart for Deals, so /otd, which reads the site's picks and "markets", never names it.
    from advisor.snapshot import build_snapshot
    from tests.factories import NOW as BUILT, make_pass, make_raw
    past = make_pass(sport="nba", player_id=1, player_name="Past Season Pick")
    live = make_pass(sport="nba", season=2026, season_label="2025-26", season_state="current", season_progress=0.5,
                     player_id=2, player_name="Live Season Player", base_1x=3000.0, rate_traded=1.0)
    built = build_snapshot(make_raw(otd=[live, past]), BUILT, 1)
    interactions, _, _ = make(snap(otd=built["otd"]))
    text = content(interactions, "otd")
    assert "Past Season Pick" in text and "Live Season Player" not in text


# --- /fees -----------------------------------------------------------------------------------------------------------


def test_fees_compares_a_normal_listing_with_quick_list_and_gives_the_break_even():
    interactions, _, _ = make()
    text = content(interactions, "fees", price=1000)
    assert "you keep 890 rax" in text.lower()
    assert "Quick List" in text and "900 Rax" in text
    assert "break even" in text.lower() and "890" in text


def test_fees_with_a_margin_gives_the_most_to_pay():
    interactions, _, _ = make()
    text = content(interactions, "fees", price=1000, margin=10)
    assert "809 Rax" in text and "818 Rax" in text and "10%" in text


def test_fees_at_a_tiny_price_says_a_normal_listing_leaves_nothing():
    interactions, _, _ = make()
    text = content(interactions, "fees", price=11)
    assert "nothing" in text.lower() and "Quick List" in text


def test_fees_follow_the_deal_margin_of_the_site():
    for price, usual in ((150, 228), (569, 1078), (1, 11)):
        assert dc.kept(usual) - price == _flip_margin(price, usual)
        assert dc.kept(usual, listing_fee=False) == dc.kept(usual) + LISTING_FEE


# --- /start ----------------------------------------------------------------------------------------------------------


def test_start_gives_the_three_first_moves_of_the_site_in_its_own_words():
    interactions, _, _ = make()
    text = content(interactions, "start")
    earn = (ROOT / "frontend" / "src" / "content" / "earn.ts").read_text(encoding="utf-8")
    assert len(dc.FIRST_MOVES) == 3
    for step in dc.FIRST_MOVES:
        assert json.dumps(step) in earn  # the site's copy, word for word: change both together
        assert step in text


# --- the settings ----------------------------------------------------------------------------------------------------


def test_without_the_public_key_the_commands_are_off():
    assert dc.config_problem(GATE_ENV) is None and dc.config_from_env(GATE_ENV) is None
    assert dc.config_problem({}) is None and dc.config_from_env({}) is None


def test_with_the_key_and_the_gate_the_commands_are_on():
    config = dc.config_from_env({**ENV, "ADVISOR_DISCORD_PUBLIC_KEY": PUBLIC_HEX.upper() + "\n"})
    assert config.guild_id == GUILD_ID and config.public_url == SITE and config.public_key == PUBLIC_HEX


@pytest.mark.parametrize("key", ["abc", "g" * 64, PUBLIC_HEX + "00", "key " + PUBLIC_HEX[4:]])
def test_a_key_that_is_no_public_key_is_refused(key):
    problem = dc.config_problem({**ENV, "ADVISOR_DISCORD_PUBLIC_KEY": key})
    assert "ADVISOR_DISCORD_PUBLIC_KEY" in problem and "64 hex" in problem
    with pytest.raises(ValueError):
        dc.config_from_env({**ENV, "ADVISOR_DISCORD_PUBLIC_KEY": key})


def test_the_key_without_the_gate_is_refused():
    problem = dc.config_problem({"ADVISOR_DISCORD_PUBLIC_KEY": PUBLIC_HEX})
    assert "ADVISOR_DISCORD_PUBLIC_KEY" in problem and "gate" in problem


# --- the commands and their registration -----------------------------------------------------------------------------


def test_the_command_list_is_what_discord_takes():
    names = [c["name"] for c in dc.COMMANDS]
    assert names == ["deals", "price", "otd", "fees", "start", "link", "unlink", "me", "invites", "help"]
    for c in dc.COMMANDS:
        assert c["type"] == 1 and 1 <= len(c["description"]) <= 100
        options = c.get("options", [])
        required = [o.get("required", False) for o in options]
        assert required == sorted(required, reverse=True)  # Discord wants the required options first
        if c["name"] in ("deals", "price", "otd", "fees", "start"):
            assert options[-1]["name"] == "share" and options[-1]["type"] == 5
        else:  # the member's own commands are answered to them alone: no share option
            assert all(o["name"] != "share" for o in options)
        for o in options:
            assert re.fullmatch(r"[a-z_]{1,32}", o["name"]) and 1 <= len(o["description"]) <= 100
            assert dc.OPTION_TYPES[o["name"]] == o["type"]
    sports = next(o for o in dc.COMMANDS[0]["options"] if o["name"] == "sport")["choices"]
    assert {"name": "NBA", "value": "nba"} in sports and {"name": "Golf", "value": "golf"} in sports
    assert len(sports) <= 25
    player = dc.COMMANDS[1]["options"][0]
    assert player["autocomplete"] is True and player["required"] is True


class FakeTransport:
    def __init__(self, status=200, answer=None):
        self.status, self.answer, self.calls = status, answer, []

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, headers, body))
        answer = self.answer if self.answer is not None else [{"id": str(i), **c} for i, c in
                                                             enumerate(json.loads(body or b"[]"))]
        return self.status, json.dumps(answer).encode()


def test_register_overwrites_the_servers_commands_with_the_bot_token():
    fake = FakeTransport()
    found = dc.register(GATE_ENV, transport=fake)
    method, url, headers, body = fake.calls[0]
    app_id = GATE_ENV["ADVISOR_DISCORD_CLIENT_ID"]
    assert method == "PUT"
    assert url == f"https://discord.com/api/v10/applications/{app_id}/guilds/{GUILD_ID}/commands"
    assert headers["Authorization"] == f"Bot {BOT_TOKEN}" and headers["Content-Type"] == "application/json"
    assert headers["User-Agent"].startswith("DiscordBot (")
    assert json.loads(body) == dc.COMMANDS
    assert [c["name"] for c in found] == ["deals", "price", "otd", "fees", "start", "link", "unlink", "me", "invites", "help"]


def test_a_refused_registration_stops_with_discords_message_and_never_the_token():
    fake = FakeTransport(status=403, answer={"message": "Missing Access", "code": 50001})
    with pytest.raises(SystemExit) as stop:
        dc.register(GATE_ENV, transport=fake)
    assert "HTTP 403" in str(stop.value) and "Missing Access" in str(stop.value) and BOT_TOKEN not in str(stop.value)


def test_register_needs_the_app_the_server_and_the_bot_token():
    env = {key: value for key, value in GATE_ENV.items() if key != "ADVISOR_DISCORD_BOT_TOKEN"}
    with pytest.raises(SystemExit) as stop:
        dc.register(env, transport=FakeTransport())
    assert "ADVISOR_DISCORD_BOT_TOKEN" in str(stop.value)


def test_the_cli_prints_what_discord_kept(capsys):
    assert dc.main(["register"], GATE_ENV, transport=FakeTransport()) == 0
    out = capsys.readouterr().out
    assert "/deals" in out and "/start" in out and BOT_TOKEN not in out
    assert dc.main(["show"], GATE_ENV, transport=FakeTransport(answer=[{"id": "5", "name": "deals"}])) == 0
    assert "/deals" in capsys.readouterr().out
    assert dc.main(["nonsense"], GATE_ENV, transport=FakeTransport()) == 2


# --- the route -------------------------------------------------------------------------------------------------------


def client(tmp_path, with_commands=True, gate=False):
    from tests.test_gate_web import make as make_site

    interactions = make(snap(GOOD))[0] if with_commands else None
    test_client, _, _ = make_site(tmp_path, gate=gate, snap=snap(GOOD), interactions=interactions)
    return test_client


def post(test_client, body: bytes, headers=None):
    signature, timestamp = sign(body)
    sent = {"X-Signature-Ed25519": signature, "X-Signature-Timestamp": timestamp, "Content-Type": "application/json"}
    return test_client.post(dc.INTERACTIONS_PATH, data=body, headers=headers if headers is not None else sent)


def test_the_route_answers_a_signed_ping_and_refuses_the_rest_with_401(tmp_path):
    site = client(tmp_path)
    ok = post(site, b'{"type":1}')
    assert ok.status_code == 200 and ok.get_json() == {"type": 1} and ok.headers["Cache-Control"] == "no-store"
    bad = post(site, b'{"type":1}', headers={"X-Signature-Ed25519": "ab" * 64, "X-Signature-Timestamp": str(int(NOW))})
    assert bad.status_code == 401 and bad.get_data() == b""
    assert post(site, b'{"type":1}', headers={}).status_code == 401


def test_the_route_answers_commands_even_with_the_gate_on_and_no_cookie(tmp_path):
    site = client(tmp_path, gate=True)
    answer = post(site, json.dumps(command("deals")).encode())
    assert answer.status_code == 200 and "Connor Bedard" in answer.get_json()["data"]["content"]
    assert "Set-Cookie" not in answer.headers


def test_the_route_refuses_a_body_past_its_limit(tmp_path):
    from advisor.rules import DISCORD_INTERACTION_MAX_BYTES

    site = client(tmp_path)
    assert post(site, b" " * (DISCORD_INTERACTION_MAX_BYTES + 1)).status_code == 413


def test_without_the_commands_the_route_does_not_exist(tmp_path):
    site = client(tmp_path, with_commands=False)
    assert post(site, b'{"type":1}').status_code == 404
    assert site.get(dc.INTERACTIONS_PATH).status_code in (404, 405)


def test_otd_says_offers_need_real_pro_plainly():
    # The owner (11-18): making an offer in Real needs Real Pro. Said once, plainly, as on the site's offer lines.
    assert dc.OFFERS_LINE.endswith("Offers need Real Pro.")
    interactions, _, _ = make(otd_snap())
    text = content(interactions, "otd")
    assert "Offers need Real Pro." in text and "both sides" not in text and "seller's" not in text
