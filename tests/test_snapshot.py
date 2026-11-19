import json
import logging
import re
from datetime import datetime, timedelta, timezone

import pytest

from advisor.links import listing_url
from advisor.rules import BID_DEAL_MAX_LEFT_MIN, LEVELS, MAX_DEALS, OTD_SHELF_KEEP, community_url, support_url
from advisor.model import Challenge
from advisor.snapshot import build_snapshot
from tests.factories import DEAL_KEYS, NOW, five_sales, make_listing, make_pass, make_raw, make_sale

FORBIDDEN = ("user", "bidder", "seller", "owner", "username")

MOVE_KEYS = {
    "sport", "season", "player_id", "player_name", "bucket", "median_recent", "median_base", "change",
    "sales_recent",
}
PASS_KEYS = {
    "key", "sport", "season", "season_label", "season_state", "player_id", "player_name", "team_id", "position",
    "kind", "base_1x", "season_progress", "game_days", "game_days_measured", "month_share", "month_share_estimated",
    "rate_traded", "rate_sales", "shelf", "shelf_count", "mint_cost", "mintable", "rungs", "best", "weak", "on_sale",
}
RUNG_KEYS = {
    "tier", "rating", "mult", "limit", "limit_estimated", "rating_to_add", "cost", "route", "year_rax", "year_capped",
    "projected", "per_game_day", "years_to_limit", "year_per_rax", "lifetime_per_rax", "pays_back", "payback_months",
    "payback_month",
}
OTD_RULE_KEYS = {
    "claims_per_sport_day", "ladders", "player_limit_per_mult", "no_limit", "team_limits", "fighter_limits", "limit_estimated_kinds",
    "limit_estimated_sports", "no_limit_horizon_years", "mint_cost", "sport_months", "sport_days",
    "weekly_days", "same_weekdays",
    "projection_below", "full_at", "ignore_ask_above", "ignore_ask_min_sales", "starter_tiers", "top",
    "payback_horizon_years", "budget_presets", "no_otd_tiers", "later",
}


def all_keys(node):
    if isinstance(node, dict):
        for k, v in node.items():
            yield k
            yield from all_keys(v)
    elif isinstance(node, list):
        for v in node:
            yield from all_keys(v)


def test_shape_and_rules():
    snap = build_snapshot(make_raw(listings=[make_listing(target_price=300)], sales=five_sales()), NOW, 7)
    assert set(snap) == {
        "version", "generated_at", "sports", "deals", "moves", "otd", "otd_version", "levels", "rules", "pulse",
        "links", "challenges", "bidding",
    }
    assert (snap["version"], snap["generated_at"], snap["sports"]) == (7, "2026-11-12T18:00:00Z", ["nba"])
    assert {name: value for name, value in snap["rules"].items() if name != "otd"} == {
        "stale_after_s": 30, "poll_s": 5, "fee": 0.1, "listing_fee": 10, "quicksell_per_point": 1.0,
        "after_fees_min_ref": 200,
        "budget_presets": [50, 200, 1000, None], "demo": False,
        "sell_curve": [[0.95, 0.99], [1.05, 0.9], [1.2, 0.29]], "twins": {"price_band": 0.25, "max": 3},
        "photo_sports": ["cbb", "cfb", "golf", "mlb", "nba", "nfl", "nhl", "ufc", "wnba"],
    }
    assert set(snap["rules"]["otd"]) == OTD_RULE_KEYS
    json.dumps(snap)


def test_rules_ship_what_the_browser_pass_planner_needs():
    otd = build_snapshot(make_raw(), NOW, 1)["rules"]["otd"]
    assert otd["ladders"]["player"][5] == ["legendary", 380, 25]
    assert otd["ladders"]["team"][-1] == ["iconic", 10140, 6]
    assert (otd["claims_per_sport_day"], otd["player_limit_per_mult"], otd["no_limit_horizon_years"]) == (2, 500, 3)
    assert otd["no_limit"] == {"fighter": ["iconic"], "player": ["iconic"]}
    assert (otd["fighter_limits"]["common"], otd["fighter_limits"]["mystic"]) == (1500, 48000)
    assert otd["team_limits"]["iconic"] == 128000
    assert (otd["limit_estimated_kinds"], otd["limit_estimated_sports"]) == ([], ["soccer"])
    assert otd["sport_months"]["nba"] == [10, 11, 12, 1, 2, 3, 4, 5, 6]
    assert otd["sport_days"]["golf"] == [180, 20]
    assert otd["weekly_days"] == {"nfl": [18, 0.78], "cfb": [14, 0.8], "golf": [43, 1.0]}
    assert otd["same_weekdays"] == {"golf": 0.7}
    assert (otd["projection_below"], otd["full_at"], otd["starter_tiers"]) == (0.9, 0.85, ["common", "uncommon"])
    assert otd["mint_cost"] == {"player": 200, "team": 800, "fighter": 800}
    assert otd["payback_horizon_years"] == 5
    assert otd["no_otd_tiers"] == ["general"]
    assert otd["later"] == {"window_months": 3, "share_below": 0.1, "start_share": 0.02}
    assert "general" not in otd["team_limits"] and "general" not in otd["fighter_limits"]
    json.dumps(otd)


def test_a_snapshot_of_sample_data_says_so():
    # The screens show a "Sample data" tag while the server runs on the fixture or its replay.
    assert build_snapshot(make_raw(), NOW, 1, demo=True)["rules"]["demo"] is True
    assert build_snapshot(make_raw(), NOW, 1)["rules"]["demo"] is False


def test_sample_data_links_every_deal_to_reals_home_never_to_an_invented_listing():
    raw = make_raw(listings=[make_listing(id=810001, target_price=300)], sales=five_sales())
    [demo] = build_snapshot(raw, NOW, 1, demo=True)["deals"]
    [live] = build_snapshot(raw, NOW, 1)["deals"]
    assert demo["url"] == "https://www.realapp.com/"
    assert live["url"] == listing_url(810001) != demo["url"]
    assert {name: value for name, value in demo.items() if name != "url"} == {
        name: value for name, value in live.items() if name != "url"
    }


def test_the_passes_carry_a_short_version_that_changes_only_with_them():
    raw = make_raw(otd=[make_pass()])
    first = build_snapshot(raw, NOW, 1)
    later = build_snapshot(raw, NOW + timedelta(minutes=5), 2)  # a later round, the same day
    assert re.fullmatch(r"[0-9a-f]{12}", first["otd_version"])
    assert first["otd"]["as_of"] != later["otd"]["as_of"]
    assert later["otd_version"] == first["otd_version"]
    # The page reads the day off as_of, so a new day is a new version.
    assert build_snapshot(raw, NOW + timedelta(days=1), 3)["otd_version"] != first["otd_version"]
    moved = build_snapshot(make_raw(otd=[make_pass(rate_traded=12.0)]), NOW, 4)
    assert moved["otd_version"] != first["otd_version"]
    # Nothing outside the passes moves it.
    busier = build_snapshot(make_raw(otd=[make_pass()], listings=[make_listing(target_price=300)], sales=five_sales()),
                            NOW, 5)
    assert busier["otd_version"] == first["otd_version"]


def test_no_identity_field_anywhere():
    snap = build_snapshot(
        make_raw(listings=[make_listing(target_price=300)], sales=five_sales(), otd=[make_pass()]), NOW, 1
    )
    assert not [k for k in all_keys(snap) if any(f in k.lower() for f in FORBIDDEN)]


def test_deals_are_capped(monkeypatch):
    monkeypatch.setattr("advisor.deals.MAX_DEALS_PER_PLAYER", 1000)  # one test player owns every listing here
    listings = [make_listing(id=i, card_id=100, target_price=300) for i in range(MAX_DEALS + 5)]
    assert len(build_snapshot(make_raw(listings=listings, sales=five_sales()), NOW, 1)["deals"]) == MAX_DEALS


def test_a_deal_is_served_with_exactly_its_whitelisted_fields():
    listing = make_listing(target_price=300, ends_at=NOW + timedelta(hours=1, microseconds=123456))
    [deal] = build_snapshot(make_raw(listings=[listing], sales=five_sales()), NOW, 1)["deals"]
    assert set(deal) == DEAL_KEYS
    assert (deal["listing_id"], deal["kind"], deal["price"], deal["reference"], deal["ref_tier"]) == (
        1, "target", 300, 420, None,
    )
    assert deal["ends_at"] == "2026-11-12T19:00:00Z"
    assert (deal["listed_at"], deal["falling"], deal["flip_margin"]) == ("2026-11-12T17:00:00Z", False, 68)
    assert (deal["per_point"], deal["ref_per_point"]) == (71.4, 100.0)  # 300 and 420 over a 4.2 rating


def test_a_deal_says_when_its_listing_was_last_read():
    seen = make_listing(target_price=300, seen_at=NOW - timedelta(minutes=12))
    [deal] = build_snapshot(make_raw(listings=[seen], sales=five_sales()), NOW, 1)["deals"]
    assert deal["seen_at"] == "2026-11-12T17:48:00Z"
    [fresh] = build_snapshot(make_raw(listings=[make_listing(target_price=300)], sales=five_sales()), NOW, 1)["deals"]
    assert fresh["seen_at"] is None  # read at the snapshot's own moment


def test_a_deal_with_no_listing_time_serves_null_and_a_cheap_card_still_serves_its_margin():
    listing = make_listing(target_price=100, created_at=None)
    snap = build_snapshot(make_raw(listings=[listing], sales=five_sales((140, 145, 150, 155, 160))), NOW, 1)
    [deal] = snap["deals"]
    # Under after_fees_min_ref the margin is thin, but it is still a number: the screens grey it, they do not hide it.
    assert (deal["reference"], deal["listed_at"], deal["flip_margin"]) == (150, None, 25)  # floor(135) - 10 - 100
    assert '"listed_at": null' in json.dumps(deal)
    assert snap["rules"]["after_fees_min_ref"] == 200


def test_moves_are_served_with_exactly_their_whitelisted_fields():
    base = [make_sale(price=100, sold_at=NOW - timedelta(days=3, hours=i)) for i in range(5)]
    recent = [make_sale(price=150, sold_at=NOW - timedelta(hours=i + 1)) for i in range(5)]
    moves = build_snapshot(make_raw(sales=base + recent), NOW, 1)["moves"]
    assert set(moves) == {"risers", "fallers"}
    assert moves["fallers"] == []
    [riser] = moves["risers"]
    assert set(riser) == MOVE_KEYS
    assert (riser["median_recent"], riser["median_base"], riser["change"]) == (150, 100, 0.5)


def test_snapshot_otd_schema_whitelist():
    markets = [
        make_pass(sport="nfl", player_id=2, shelf=((5.0, 100), (2.0, 30)), shelf_count=2),
        make_pass(sport="nba", player_id=3, kind="team", rate_traded=None, rate_sales=0, mint_cost=800),
        make_pass(sport="nba", player_id=1),
    ]
    otd = build_snapshot(make_raw(otd=markets), NOW, 1)["otd"]
    assert set(otd) == {"as_of", "sports", "markets", "current_markets", "picks", "starters"}
    assert otd["as_of"] == "2026-11-12T18:00:00Z"
    assert otd["sports"] == {
        "nba": {"claim_days": 210, "months": [10, 11, 12, 1, 2, 3, 4, 5, 6]},
        "nfl": {"claim_days": 62, "months": [9, 10, 11, 12, 1, 2]},
    }
    assert [market["key"] for market in otd["markets"]] == ["nba:2025:player:1", "nba:2025:team:3", "nfl:2025:player:2"]
    assert all(set(market) == PASS_KEYS for market in otd["markets"])
    assert all(set(rung) == RUNG_KEYS for market in otd["markets"] for rung in market["rungs"])
    # Ranks only: the numbers live on the markets. Nobody trades or sells the team pass's cards, so it is never
    # picked.
    assert otd["picks"] == {"nba": ["nba:2025:player:1"], "nfl": ["nfl:2025:player:2"]}
    assert otd["starters"] == {"nba": "nba:2025:player:1", "nfl": "nfl:2025:player:2"}

    _, team, nfl = otd["markets"]
    # A past season's General pays nothing at all, so the team's ladder starts at Common; team cards have no traded
    # rate, so no rung is priced or best, and there is nothing to build.
    assert (team["best"], team["weak"], team["on_sale"]) == (None, [], None)
    assert team["rungs"][0]["tier"] == "common"
    assert all(rung["cost"] is None and rung["pays_back"] is None for rung in team["rungs"])
    assert nfl["shelf"] == [[2.0, 30], [5.0, 100]]  # cheapest a point first
    assert (nfl["month_share"], nfl["rate_traded"], nfl["mint_cost"]) == ([1 / 12] * 12, 10.0, 200)
    assert nfl["month_share_estimated"] is False
    assert (nfl["best"], nfl["weak"]) == ("common", ["rare"])
    # Common needs 10 rating; the shelf holds 7 of it, for 130.
    assert nfl["on_sale"] == {"on_sale_rating": 7.0, "on_sale_cost": 130, "enough": False}
    # 600 a year at 50 a month; from 12 November (19 of its 30 days left) the 300 is back in May. No General first: a
    # past season's General pays nothing.
    assert nfl["rungs"][0] == {
        "tier": "common", "rating": 10, "mult": 2, "limit": 1000, "limit_estimated": False, "rating_to_add": 10,
        "cost": 300, "route": "mint+cards", "year_rax": 600, "year_capped": False, "projected": False,
        "per_game_day": 7.5, "years_to_limit": 1.67, "year_per_rax": 2.0, "lifetime_per_rax": 3.33,
        "pays_back": True, "payback_months": 6.0, "payback_month": "2027-05",
    }
    json.dumps(otd)


def _measured(name: str, **over):
    from advisor.pass_rates import clean_extra
    from tests.pass_scenes import extra

    fields, _ = clean_extra({"rate_traded": over.get("rate_traded", 10.0), **extra(name)})
    return make_pass(**{**fields, **over})


def test_a_pass_with_the_feeds_new_fields_serves_its_build_rate_offers_and_live_auctions():
    from tests.pass_scenes import READ_AT

    read = datetime.fromisoformat(READ_AT.replace("Z", "+00:00"))
    wemby = _measured("wemby", player_id=1, rate_traded=38.46, rate_sales=100,
                      shelf=((5.7, 300), (2.9, 160)), shelf_count=694)
    plain = make_pass(player_id=2)
    otd = build_snapshot(make_raw(otd=[wemby, plain], fetched_at=read + timedelta(minutes=10)),
                         read + timedelta(minutes=10), 1)["otd"]
    served, old = otd["markets"]
    assert set(old) == PASS_KEYS  # a row without the fields: served exactly as before
    assert set(served) == PASS_KEYS | {"rate_bucket", "rate_build", "rate_build_from", "offers", "auctions"}
    assert (served["rate_bucket"], served["rate_build"]) == ("5-7", 30.36)
    assert served["rate_build_from"] == {"bucket": "5-7", "rarity": "common", "sales": 11}
    assert served["offers"][5] == ["5-7", "common", 8.93, 23, 30.36]
    assert served["auctions"][0] == [2.9, 110, 1] and len(served["auctions"]) == 9  # the 5.7 had ended
    assert served["shelf"] == [[5.7, 300], [2.9, 160]]  # the old field keeps its meaning (cheapest a point first)
    assert "rates_by_bucket" not in served and "shelf_auctions" not in served  # the raw fields stay home
    common = served["rungs"][0]
    assert (common["tier"], common["cost"]) == ("common", round(200 + 10 * 30.36))
    assert served["on_sale"]["firm"] is True and set(served["on_sale"]) == {"on_sale_rating", "on_sale_cost", "enough", "firm"}
    assert set(old["on_sale"] or {}) <= {"on_sale_rating", "on_sale_cost", "enough"}


def test_a_thin_pass_serves_a_null_build_rate_and_no_auctions_without_a_reading():
    thin = _measured("thin", rate_traded=22.0, rate_sales=6)
    [served] = build_snapshot(make_raw(otd=[thin]), NOW, 1)["otd"]["markets"]
    assert served["rate_build"] is None and served["rate_bucket"] == "3-5"
    assert "rate_build_from" not in served and "auctions" not in served and "offers" not in served
    assert served["rungs"][0]["cost"] == round(200 + 10 * 22.0)


def test_a_market_without_usable_month_shares_is_flagged():
    markets = [make_pass(player_id=1, month_share=()), make_pass(player_id=2)]
    served = build_snapshot(make_raw(otd=markets), NOW, 1)["otd"]["markets"]
    assert [market["month_share_estimated"] for market in served] == [True, False]
    assert served[0]["month_share"] == []  # served as given; the flag says the sport's months stood in


def test_a_pass_best_as_the_mint_alone_has_nothing_on_sale_to_build():
    # A season being played, with live games left: its General, the 200 mint alone, pays them and can be best. There
    # is no rating to buy toward it. Half played, 600 so far: 600 of live games left at 1x.
    live = make_pass(season_state="current", season_progress=0.5, base_1x=600.0, rate_traded=90.0,
                     shelf=((5.0, 100),), shelf_count=1)
    [market] = build_snapshot(make_raw(otd=[live]), NOW, 1)["otd"]["current_markets"]
    assert (market["best"], market["rungs"][0]["route"], market["rungs"][0]["limit"]) == ("general", "mint", 0)
    assert market["on_sale"] is None


def test_this_seasons_passes_are_served_apart_and_never_picked():
    # The feed sends the current-season pass of each player with a deal. Those rows are
    # for Deals and for a member's own passes only: served in "current_markets", never in "markets" (what the Passes
    # tab, the plan, Today's moves and the Discord picks read), never a pick or a starter, even when they would rank first.
    past = make_pass(sport="nba", player_id=1, rate_traded=20.0)
    live = make_pass(sport="nba", season=2026, season_label="2025-26", season_state="current", season_progress=0.5,
                     player_id=2, base_1x=3000.0, rate_traded=1.0)
    nfl = make_pass(sport="nfl", season=2026, season_state="current", season_progress=0.5, player_id=3, base_1x=3000.0)
    otd = build_snapshot(make_raw(otd=[live, past, nfl]), NOW, 1)["otd"]
    assert [m["key"] for m in otd["markets"]] == ["nba:2025:player:1"]
    assert [m["key"] for m in otd["current_markets"]] == ["nba:2026:player:2", "nfl:2026:player:3"]
    assert all(set(m) == PASS_KEYS and m["season_state"] == "current" for m in otd["current_markets"])
    assert otd["picks"] == {"nba": ["nba:2025:player:1"]} and otd["starters"] == {"nba": "nba:2025:player:1"}
    # Their sports' calendars still come along: the browser walks their pay with them.
    assert set(otd["sports"]) == {"nba", "nfl"}


def test_a_long_shelf_is_served_cheapest_first_and_bounded():
    shelf = tuple((1.0, 100 - i) for i in range(OTD_SHELF_KEEP + 5))
    [market] = build_snapshot(make_raw(otd=[make_pass(shelf=shelf, shelf_count=len(shelf))]), NOW, 1)["otd"]["markets"]
    assert len(market["shelf"]) == OTD_SHELF_KEEP and market["shelf"][0] == [1.0, 100 - OTD_SHELF_KEEP - 4]
    assert market["shelf_count"] == OTD_SHELF_KEEP + 5


def test_sports_are_the_sorted_unique_sports_of_the_listings():
    listings = [make_listing(id=1, sport="nfl"), make_listing(id=2, sport="nba"), make_listing(id=3, sport="nfl")]
    assert build_snapshot(make_raw(listings=listings), NOW, 1)["sports"] == ["nba", "nfl"]


def test_an_empty_market_still_gives_a_full_snapshot():
    snap = build_snapshot(make_raw(), NOW, 0)
    assert (snap["sports"], snap["deals"], snap["moves"], snap["otd"], snap["pulse"]) == (
        [], [], {"risers": [], "fallers": []},
        {"as_of": "2026-11-12T18:00:00Z", "sports": {}, "markets": [], "current_markets": [], "picks": {},
         "starters": {}},
        {"window_min": 60, "sales": []},
    )


def test_levels_are_a_copy_of_the_constant():
    snap = build_snapshot(make_raw(), NOW, 1)
    assert snap["levels"] == LEVELS
    snap["levels"]["new"]["confidence"].append("low")
    snap["levels"]["pro"]["label"] = "changed"
    assert LEVELS["new"]["confidence"] == ["high"]
    assert LEVELS["pro"]["label"] == "Pro"


def test_times_are_utc_with_a_z_whatever_the_input_offset():
    paris = timezone(timedelta(hours=1))
    now = datetime(2026, 11, 12, 19, 0, 30, 999, tzinfo=paris)
    snap = build_snapshot(make_raw(), now, 1)
    assert snap["generated_at"] == "2026-11-12T18:00:30Z"


def sales_ago(sport, count, ago):
    return [make_sale(sport=sport, sold_at=NOW - ago) for _ in range(count)]


def test_pulse_counts_last_hour_by_sport_sorted():
    sales = (
        sales_ago("nfl", 3, timedelta(minutes=5))
        + sales_ago("mlb", 5, timedelta(minutes=59, seconds=59))
        + sales_ago("nba", 2, timedelta(minutes=30)) + sales_ago("nba", 1, timedelta(0))  # this very instant counts
        + sales_ago("nba", 4, timedelta(minutes=60))  # exactly an hour old: outside
        + sales_ago("nhl", 6, timedelta(hours=3))  # older: outside, so nhl is left out
        + sales_ago("soccer", 2, -timedelta(minutes=1))  # from the future: not counted
    )
    pulse = build_snapshot(make_raw(sales=sales), NOW, 1)["pulse"]
    # Busiest first; nba and nfl tie on 3 and go by name.
    assert pulse == {"window_min": 60, "sales": [["mlb", 5], ["nba", 3], ["nfl", 3]]}


def test_sports_ordered_by_24h_sales():
    listings = [make_listing(id=i, sport=sport) for i, sport in enumerate(["nhl", "nba", "soccer", "nfl", "mlb", "golf"])]
    sales = (
        sales_ago("nba", 2, timedelta(hours=1)) + sales_ago("nba", 9, timedelta(days=2))  # old sales do not count
        + sales_ago("nfl", 3, timedelta(hours=23)) + sales_ago("mlb", 3, timedelta(minutes=2))
        + sales_ago("golf", 1, timedelta(hours=24))  # exactly a day old: outside, so golf has no sales today
    )
    # Most sales today first, ties by name; the sports with none come last, alphabetically.
    assert build_snapshot(make_raw(listings=listings, sales=sales), NOW, 1)["sports"] == [
        "mlb", "nfl", "nba", "golf", "nhl", "soccer",
    ]


def test_levels_carry_bid_window_and_default_budget():
    levels = build_snapshot(make_raw(), NOW, 1)["levels"]
    assert {name: (level["bid_max_left_min"], level["default_budget"]) for name, level in levels.items()} == {
        "new": (0, 200), "regular": (30, 1000), "pro": (120, None),
    }
    assert {name: level["min_discount"] for name, level in levels.items()} == {"new": 0.25, "regular": 0.20, "pro": 0.20}
    assert (levels["new"]["kinds"], levels["regular"]["confidence"]) == (["target"], ["high", "medium"])
    assert levels["pro"]["bid_max_left_min"] == BID_DEAL_MAX_LEFT_MIN  # Pro sees every bid deal the engine finds


def test_levels_carry_the_pass_budget_each_starts_with():
    levels = build_snapshot(make_raw(), NOW, 1)["levels"]
    # A pass costs far more than a deal's card: New starts at 1,000, Regular at 5,000, Pro at any budget.
    assert {name: level["otd_default_budget"] for name, level in levels.items()} == {
        "new": 1000, "regular": 5000, "pro": None,
    }


def test_rules_ship_the_pass_budget_presets():
    otd = build_snapshot(make_raw(), NOW, 1)["rules"]["otd"]
    assert otd["budget_presets"] == [1000, 5000, 20000, None]
    # Every level's pass budget is one of the presets, so the budget control always shows it chosen.
    assert all(level["otd_default_budget"] in otd["budget_presets"] for level in LEVELS.values())


def test_rules_name_the_sports_that_have_photos_so_the_page_asks_for_no_other():
    sports = build_snapshot(make_raw(), NOW, 1)["rules"]["photo_sports"]
    assert sports == ["cbb", "cfb", "golf", "mlb", "nba", "nfl", "nhl", "ufc", "wnba"]
    assert "soccer" not in sports


def test_only_new_hides_falling_deals():
    levels = build_snapshot(make_raw(), NOW, 1)["levels"]
    assert {name: level["hide_falling"] for name, level in levels.items()} == {
        "new": True, "regular": False, "pro": False,
    }


SUPPORT = {"account": "otdpalace", "url": None}  # where a gift of Rax goes; no card linked unless the setting names one


def test_snapshot_links_community(monkeypatch):
    assert build_snapshot(make_raw(), NOW, 1)["links"] == {"community": None, "push": None, "accounts": False, "support": SUPPORT}
    monkeypatch.setattr("advisor.snapshot.COMMUNITY_URL", "https://discord.gg/market-palace")
    snap = build_snapshot(make_raw(), NOW, 1)
    assert snap["links"] == {"community": "https://discord.gg/market-palace", "push": None, "accounts": False, "support": SUPPORT}
    json.dumps(snap)


def test_snapshot_links_support_names_the_account_and_its_card_when_set(monkeypatch):
    monkeypatch.setattr("advisor.snapshot.SUPPORT_URL", "https://www.realapp.com/D5h7FRFWPOKGR")
    assert build_snapshot(make_raw(), NOW, 1)["links"]["support"] == {"account": "otdpalace", "url": "https://www.realapp.com/D5h7FRFWPOKGR"}


@pytest.mark.parametrize("url", ["https://www.realapp.com/D5h7FRFWPOKGR", "https://www.realapp.com/abc123"])
def test_support_url_accepts_real_share_links(url, caplog):
    with caplog.at_level(logging.WARNING):
        assert support_url(url) == url
    assert caplog.records == []


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example/D5h7FRFWPOKGR",
        "https://www.realapp.com.evil.example/D5h7FRFWPOKGR",
        "http://www.realapp.com/D5h7FRFWPOKGR",  # not https
        "https://realapp.com/D5h7FRFWPOKGR",  # not the host Real's links use
        "https://www.realapp.com/",  # the home page, no card
        "https://www.realapp.com/D5h7FRFWPOKGR/extra",
        "https://www.realapp.com/D5h7FRFWPOKGR?x=1",
        "https://www.realapp.com/D5h7FRFWPOKGR\n",
        "javascript:alert(1)",
    ],
)
def test_support_url_validation(url, caplog):
    with caplog.at_level(logging.WARNING):
        assert support_url(url) is None
    assert len(caplog.records) == 1 and caplog.records[0].levelno == logging.WARNING
    # The log names the setting, never its value (the home page is the message's own example of the shape).
    assert url == "https://www.realapp.com/" or url not in caplog.text


def test_support_url_unset_is_none_and_quiet(caplog):
    with caplog.at_level(logging.WARNING):
        assert support_url(None) is None and support_url("") is None
    assert caplog.records == []


def test_snapshot_links_push_only_while_push_is_on():
    link = {"public_key": "BPublicKey", "check_s": 10}
    assert build_snapshot(make_raw(), NOW, 1, push=link)["links"]["push"] == link
    assert build_snapshot(make_raw(), NOW, 1, push=None)["links"]["push"] is None
    assert build_snapshot(make_raw(), NOW, 1, push={**link, "private": "x"})["links"]["push"] == link


@pytest.mark.parametrize(
    "url",
    ["https://discord.gg/abc123", "https://discord.com/invite/Market-Palace", "https://discord.gg/ab", "https://discord.gg/" + "a" * 32],
)
def test_community_url_accepts_discord_invites(url, caplog):
    with caplog.at_level(logging.WARNING):
        assert community_url(url) == url
    assert caplog.records == []


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example/abc123",  # another host
        "https://discord.gg.evil.example/abc123",
        "https://evil.example/https://discord.gg/abc123",
        "javascript:alert(1)",
        "http://discord.gg/abc123",  # not https
        "https://discord.com/abc123",  # discord.com, but not an invite
        "https://discord.gg/a",  # code too short
        "https://discord.gg/" + "a" * 33,  # code too long
        "https://discord.gg/abc123/extra",
        "https://discord.gg/abc123?x=1",
        "https://discord.gg/abc 123",
        "https://discord.gg/abc123\n",
        " https://discord.gg/abc123",
        "HTTPS://DISCORD.GG/abc123",
    ],
)
def test_community_url_validation(url, caplog):
    with caplog.at_level(logging.WARNING):
        assert community_url(url) is None
    assert len(caplog.records) == 1  # said once, and the rest of the site carries on without the link
    assert caplog.records[0].levelno == logging.WARNING


def test_community_url_unset_is_none_and_quiet(caplog):
    with caplog.at_level(logging.WARNING):
        assert community_url(None) is None
        assert community_url("") is None
    assert caplog.records == []


def test_a_source_that_says_what_it_covers_has_it_in_the_rules_with_its_four_fields_only():
    coverage = {"sports": ["nba", "nfl"], "listings_complete": False, "sales_window_h": 168,
                "otd_as_of": "2026-11-12T17:40:00Z", "account": "never served"}
    rules = build_snapshot(make_raw(coverage=coverage), NOW, 1)["rules"]
    assert rules["coverage"] == {"sports": ["nba", "nfl"], "listings_complete": False, "sales_window_h": 168,
                                 "otd_as_of": "2026-11-12T17:40:00Z"}
    assert "coverage" not in build_snapshot(make_raw(), NOW, 1)["rules"]  # the demo sources say nothing of the kind


def test_live_challenges_are_served_soonest_ending_first_and_ended_ones_go():
    challenges = (
        Challenge(key="hr", title="Watch every home run", reward="250 Rax + MLB pack", ends_at=NOW + timedelta(hours=5)),
        Challenge(key="gone", title="Old one", reward=None, ends_at=NOW - timedelta(minutes=1)),
        Challenge(key="goal", title="Watch the goals", reward="Rax per goal", ends_at=NOW + timedelta(hours=1)),
        Challenge(key="open", title="Profile badge", reward=None, ends_at=None),
    )
    snap = build_snapshot(make_raw(challenges=challenges), NOW, 1)
    assert snap["challenges"] == [
        {"title": "Watch the goals", "reward": "Rax per goal", "ends_at": "2026-11-12T19:00:00Z"},
        {"title": "Watch every home run", "reward": "250 Rax + MLB pack", "ends_at": "2026-11-12T23:00:00Z"},
        {"title": "Profile badge", "reward": None, "ends_at": None},
    ]
    assert build_snapshot(make_raw(), NOW, 1)["challenges"] == []


def test_live_bidding_is_served_for_the_sports_whose_socket_is_live():
    coverage = {"sports": ["nba"], "listings_complete": False, "sales_window_h": 168, "otd_as_of": None,
                "bids": {"nba": {"bids_10m": 131, "bidders_10m": 11, "live": True},
                         "nhl": {"bids_10m": 3, "bidders_10m": 1, "live": False}}}
    snap = build_snapshot(make_raw(coverage=coverage), NOW, 1)
    assert snap["bidding"] == {"nba": {"bids_10m": 131, "bidders_10m": 11}}
    assert set(snap["rules"]["coverage"]) == {"sports", "listings_complete", "sales_window_h", "otd_as_of"}
    assert build_snapshot(make_raw(), NOW, 1)["bidding"] == {}


class FakeInjuries:
    """What `build_snapshot` asks of an injury view: `of(sport, player_id, name)` and `sports()`."""

    def __init__(self, hurt: dict[int, dict], sports=("nba", "nfl")):
        self.hurt, self._sports = hurt, list(sports)

    def of(self, sport, player_id, name):
        return self.hurt.get(player_id)

    def sports(self):
        return self._sports


OUT = {"status": "out", "part": "Knee", "back": "2026-11-18"}


def test_a_deal_of_a_hurt_player_carries_what_espn_says_and_the_others_carry_no_note_at_all():
    listings = [make_listing(id=1, card_id=100, player_id=7, target_price=300), make_listing(id=2, card_id=101, player_id=8, target_price=300)]
    sales = five_sales(card_id=100, player_id=7) + five_sales(card_id=101, player_id=8)
    deals = build_snapshot(make_raw(listings=listings, sales=sales), NOW, 1, injuries=FakeInjuries({7: OUT}))["deals"]
    by_player = {d["player_id"]: d for d in deals}
    assert by_player[7]["injury"] == OUT
    assert "injury" not in by_player[8]  # no note is not "healthy": the key is simply not there
    assert set(by_player[8]) == DEAL_KEYS


def test_a_player_who_moved_in_price_carries_the_note_too():
    base = [make_sale(price=100, sold_at=NOW - timedelta(days=3, hours=i)) for i in range(5)]
    recent = [make_sale(price=40, sold_at=NOW - timedelta(hours=i + 1)) for i in range(5)]
    raw = make_raw(sales=base + recent)
    [faller] = build_snapshot(raw, NOW, 1)["moves"]["fallers"]
    hurt = FakeInjuries({faller["player_id"]: OUT})
    [noted] = build_snapshot(raw, NOW, 1, injuries=hurt)["moves"]["fallers"]
    assert noted["injury"] == OUT
    assert set(noted) == MOVE_KEYS | {"injury"}


def test_the_rules_name_the_sports_whose_injury_list_is_fresh_only_when_there_is_a_view():
    raw = make_raw(listings=[make_listing(target_price=300)], sales=five_sales())
    assert "injury_sports" not in build_snapshot(raw, NOW, 1)["rules"]
    assert build_snapshot(raw, NOW, 1, injuries=FakeInjuries({}, sports=("nfl", "nba")))["rules"]["injury_sports"] == ["nba", "nfl"]
    assert build_snapshot(raw, NOW, 1, injuries=FakeInjuries({}, sports=()))["rules"]["injury_sports"] == []


def test_a_view_that_raises_never_breaks_the_snapshot():
    class Broken(FakeInjuries):
        def of(self, sport, player_id, name):
            raise RuntimeError("boom")

        def sports(self):
            raise RuntimeError("boom")

    raw = make_raw(listings=[make_listing(target_price=300)], sales=five_sales())
    snap = build_snapshot(raw, NOW, 1, injuries=Broken({}))
    assert [set(d) for d in snap["deals"]] == [DEAL_KEYS]
    assert snap["rules"]["injury_sports"] == []


def test_only_new_hides_deals_of_hurt_players():
    levels = build_snapshot(make_raw(), NOW, 1)["levels"]
    assert {name: level["hide_hurt"] for name, level in levels.items()} == {"new": True, "regular": False, "pro": False}


class FakeResale:
    """What `build_snapshot` asks of a resale view: `of(sport, player_id, name, rating)` and `available()`."""

    def __init__(self, counts: dict[int, dict], available=True):
        self.counts, self._available, self.asked = counts, available, []

    def of(self, sport, player_id, name, rating):
        self.asked.append((sport, player_id, name, rating))
        return self.counts.get(player_id)

    def available(self):
        return self._available


def test_a_deal_carries_how_many_recent_listings_of_its_player_sold_and_the_others_carry_nothing():
    listings = [make_listing(id=1, card_id=100, player_id=7, target_price=300), make_listing(id=2, card_id=101, player_id=8, target_price=300)]
    sales = five_sales(card_id=100, player_id=7) + five_sales(card_id=101, player_id=8)
    snap = build_snapshot(make_raw(listings=listings, sales=sales), NOW, 1, resale=FakeResale({7: {"listed": 40, "sold": 28}}))
    by_player = {d["player_id"]: d for d in snap["deals"]}
    assert by_player[7]["resale"] == {"listed": 40, "sold": 28}
    assert "resale" not in by_player[8] and set(by_player[8]) == DEAL_KEYS
    assert snap["rules"]["resale"] is True


def test_the_rules_say_whether_there_is_a_resale_table_only_when_there_is_a_view():
    raw = make_raw(listings=[make_listing(target_price=300)], sales=five_sales())
    assert "resale" not in build_snapshot(raw, NOW, 1)["rules"]
    assert build_snapshot(raw, NOW, 1, resale=FakeResale({}, available=False))["rules"]["resale"] is False


def test_a_resale_view_that_raises_never_breaks_the_snapshot():
    class Broken(FakeResale):
        def of(self, sport, player_id, name, rating):
            raise RuntimeError("boom")

        def available(self):
            raise RuntimeError("boom")

    raw = make_raw(listings=[make_listing(target_price=300)], sales=five_sales())
    snap = build_snapshot(raw, NOW, 1, resale=Broken({}))
    assert [set(d) for d in snap["deals"]] == [DEAL_KEYS]
    assert snap["rules"]["resale"] is False


def test_injury_and_resale_notes_sit_side_by_side_on_one_deal():
    raw = make_raw(listings=[make_listing(target_price=300)], sales=five_sales())
    snap = build_snapshot(raw, NOW, 1, injuries=FakeInjuries({10: OUT}), resale=FakeResale({10: {"listed": 12, "sold": 3}}))
    [deal] = snap["deals"]
    assert deal["injury"] == OUT and deal["resale"] == {"listed": 12, "sold": 3}


def test_the_card_rating_of_the_deal_is_what_the_resale_view_is_asked_so_it_can_pick_the_band():
    listing = make_listing(target_price=300, player_id=7, rating=4.2)
    resale = FakeResale({7: {"listed": 40, "sold": 28}})
    build_snapshot(make_raw(listings=[listing], sales=five_sales(player_id=7)), NOW, 1, resale=resale)
    assert resale.asked == [("nba", 7, "Test Player", 4.2)]


def test_the_snapshot_says_when_a_real_account_can_be_linked():
    assert build_snapshot(make_raw(), NOW, 1, accounts=True)["links"]["accounts"] is True
