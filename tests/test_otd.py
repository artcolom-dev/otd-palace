import json
from dataclasses import replace
from datetime import date
from pathlib import Path

import pytest

from advisor.model import PassMarket
from advisor.otd import OnSale, best_rung, is_liquid, on_sale, pass_picks, rungs, starters, weak_rungs
from advisor.rules import (
    OTD_IGNORE_ASK_MIN_SALES,
    OTD_LADDERS,
    OTD_NO_LIMIT_HORIZON_YEARS,
    OTD_PAYBACK_HORIZON_YEARS,
    OTD_PLAYER_LIMIT_PER_MULT,
    OTD_TEAM_LIMITS,
    OTD_FIGHTER_LIMITS,
    OTD_TOP,
)
from tests.factories import FLAT_MONTHS, make_pass

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "otd_vectors.json").read_text(encoding="utf-8"))
TODAY = date(2026, 11, 1)
NBA_MONTHS = tuple(1 / 9 if month in (10, 11, 12, 1, 2, 3, 4, 5, 6) else 0.0 for month in range(1, 13))


def by_tier(market: PassMarket, today: date = TODAY, **kw) -> dict:
    return {rung.tier: rung for rung in rungs(market, today=today, **kw)}


def _matches(actual, expected, tolerance: float) -> bool:
    if expected is None or isinstance(expected, (bool, str)):
        return actual == expected and type(actual) is type(expected)
    return isinstance(actual, (int, float)) and not isinstance(actual, bool) and abs(actual - expected) <= tolerance


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda case: case["name"])
def test_golden_vectors(case):
    row = case["market"]
    market = PassMarket(**{**row, "month_share": tuple(row["month_share"]), "shelf": tuple(map(tuple, row["shelf"]))})
    got = rungs(market, held_rating=case["held_rating"], today=date.fromisoformat(case["today"]))
    expected = case["expect"]
    assert [rung.tier for rung in got] == [rung["tier"] for rung in expected["rungs"]]
    for rung, want in zip(got, expected["rungs"], strict=True):
        wrong = {
            name: (getattr(rung, name), value)
            for name, value in want.items()
            if not _matches(getattr(rung, name), value, VECTORS["tolerance"])
        }
        assert not wrong, (rung.tier, wrong)
    best = best_rung(got)
    assert (None if best is None else best.tier) == expected["best"]
    assert sorted(weak_rungs(got)) == sorted(expected["weak"])
    assert market.month_share_estimated is expected["month_share_estimated"]


def test_the_vectors_hold_hand_checked_cases():
    assert len(VECTORS["cases"]) >= 25
    assert sum(case["hand_checked"] for case in VECTORS["cases"]) >= 8


def test_the_vectors_use_neutral_wording():
    text = (Path(__file__).parent / "fixtures" / "otd_vectors.json").read_text(encoding="utf-8")
    assert "§" not in text and "survey" not in text.lower()


def test_player_limit_is_500_times_mult():
    got = by_tier(make_pass())
    for tier, _, mult in OTD_LADDERS["player"]:
        if tier in ("general", "iconic"):
            continue
        assert (got[tier].limit, got[tier].limit_estimated) == (OTD_PLAYER_LIMIT_PER_MULT * mult, False)
    assert (got["common"].limit, got["legendary"].limit) == (1000, 12500)


def test_general_pays_nothing_on_this_day_so_a_past_season_starts_at_common():
    # Real pays On This Day to Common or better only: every held past-season General reads a limit of 0. A past
    # season pays nothing live either, so its General would pay nothing at all and is no rung.
    for market in (
        make_pass(),
        make_pass(kind="team", rate_traded=None, rate_sales=0, mint_cost=800),
        make_pass(sport="ufc", kind="fighter", mint_cost=800),
    ):
        ladder = rungs(market, today=TODAY)
        assert ladder[0].tier == "common" and "general" not in {rung.tier for rung in ladder}
    # Not held yet, the first rung is the mint and Common's 10 rating together.
    common = rungs(make_pass(), today=TODAY)[0]
    assert (common.rating_to_add, common.cost, common.route) == (10, 300, "mint+cards")
    # Held, or not mintable, it is the cards alone.
    assert rungs(make_pass(), held_rating=5, today=TODAY)[0].tier == "common"
    assert rungs(make_pass(mintable=False), today=TODAY)[0].tier == "common"


def test_a_current_season_general_pays_its_games_left_live_and_nothing_on_this_day():
    # Half played, 150 so far: the season projects to 300 at 1x. A General is the mint alone and pays the 150 of
    # live games left, never the anniversaries of the half already played.
    general = by_tier(make_pass(season_state="current", base_1x=150.0, season_progress=0.5))["general"]
    assert (general.rating_to_add, general.cost, general.route) == (0, 200, "mint")
    assert (general.limit, general.year_rax, general.year_capped) == (0, pytest.approx(150), False)
    assert general.years_to_limit is None  # a limit of 0 is never "reached": it pays nothing On This Day
    assert general.lifetime_per_rax == pytest.approx(150 / 200)
    # 150 back on a 200 mint: it never pays back, so it is never best.
    assert (general.pays_back, general.payback_months) == (False, None)
    # A season played in full has no live games left: no General.
    done = make_pass(season_state="current", base_1x=300.0, season_progress=1.0)
    assert "general" not in by_tier(done)
    # Its live pay alone can pay back a free-ish mint: 150 a season of games left against a 100 mint.
    cheap = by_tier(make_pass(season_state="current", base_1x=150.0, season_progress=0.5, mint_cost=100))["general"]
    assert cheap.pays_back is True


def test_a_pass_already_minted_at_0_rating_climbs_with_cards_only():
    # A General held at 0 rating is minted: its Common is the 10 rating alone, never the mint again.
    common = rungs(make_pass(), today=TODAY, minted=True)[0]
    assert (common.tier, common.rating_to_add, common.cost, common.route) == ("common", 10, 100, "cards")


def test_nothing_pays_back_at_90_a_point_so_nothing_is_picked():
    # At 90 rax a point every card-built rung costs more than its limit, and there is no General to fall back on.
    dear = make_pass(player_id=1, base_1x=600.0, rate_traded=90.0)
    ladder = rungs(dear, today=TODAY)
    assert not any(rung.pays_back for rung in ladder) and best_rung(ladder) is None
    assert pass_picks([dear], today=TODAY) == {}
    assert starters([dear], today=TODAY) == {}
    # At 10 a point Common (3.33) is the first rung, so it has one neighbour and is never weak.
    assert sorted(weak_rungs(rungs(make_pass(), today=TODAY))) == ["rare"]


def test_iconic_has_no_limit_and_uses_horizon():
    iconic = by_tier(make_pass(base_1x=500.0, rate_traded=5.0))["iconic"]
    assert (iconic.limit, iconic.years_to_limit, iconic.year_capped) == (None, None, False)
    assert (iconic.cost, iconic.year_rax) == (200 + 3380 * 5, 500 * 150)
    assert iconic.lifetime_per_rax == pytest.approx(OTD_NO_LIMIT_HORIZON_YEARS * 500 * 150 / 17100)
    # A season too small to earn its cost back within the horizon never pays back.
    small = by_tier(make_pass(base_1x=50.0))["iconic"]
    assert (small.pays_back, small.payback_months, small.payback_month) == (False, None, None)


def test_team_cost_is_none():
    team = make_pass(kind="team", base_1x=1935.0, rate_traded=None, rate_sales=0, mint_cost=800)
    built = rungs(team, today=TODAY)
    assert [rung.tier for rung in built] == [tier for tier, _, _ in OTD_LADDERS["team"] if tier != "general"]
    assert {rung.tier: rung.limit for rung in built} == OTD_TEAM_LIMITS
    # Team cards have no traded rate, so no rung can be priced.
    assert all(r.cost is None and r.year_per_rax is None and r.lifetime_per_rax is None for r in built)
    # Not knowing the cost is not "never pays back": it is unknown.
    assert all(r.pays_back is None and r.payback_months is None and r.payback_month is None for r in built)
    assert best_rung(built) is None and weak_rungs(built) == set()
    assert by_tier(team)["iconic"].years_to_limit == pytest.approx(128000 / (1935 * 6))


def test_pays_back_only_when_the_lifetime_beats_the_cost():
    # A player Common stops at 1,000; 900 to mint plus 100 of cards only breaks even, 899 to mint pays back.
    even = by_tier(make_pass(mint_cost=900))["common"]
    assert (even.lifetime_per_rax, even.pays_back, even.payback_months) == (1.0, False, None)
    beats = by_tier(make_pass(mint_cost=899))["common"]
    assert beats.pays_back is True and beats.payback_months is not None


def test_a_fighter_pass_mints_for_800_when_the_market_does_not_say():
    # Every UFC row of the market states 800 to mint a fighter's pass; the rules' fallback agrees.
    fighter = by_tier(make_pass(sport="ufc", kind="fighter", mint_cost=None))
    assert fighter["common"].cost == 800 + 10 * 10.0


def test_fighter_limits_stated_and_soccer_estimated():
    # Real states a fighter's limits (its own table, not 500 x the multiplier); Iconic has none.
    fighter = by_tier(make_pass(sport="ufc", kind="fighter", base_1x=2800.0, rate_traded=20.0, mint_cost=800))
    assert {tier: rung.limit for tier, rung in fighter.items()} == {**OTD_FIGHTER_LIMITS, "iconic": None}
    assert not any(rung.limit_estimated for rung in fighter.values())
    assert (fighter["common"].limit, fighter["legendary"].limit, fighter["mystic"].limit) == (1500, 24000, 48000)
    soccer = by_tier(make_pass(sport="soccer"))
    assert all(rung.limit_estimated for rung in soccer.values())
    assert (soccer["legendary"].limit, soccer["iconic"].limit) == (12500, None)
    assert not any(rung.limit_estimated for rung in by_tier(make_pass()).values())


def test_year_capped_by_limit():
    got = by_tier(make_pass(base_1x=600.0))
    assert (got["epic"].year_rax, got["epic"].year_capped) == (5000, True)  # would pay 6,000, stops at 5,000
    assert (got["legendary"].year_rax, got["legendary"].year_capped) == (12500, True)
    assert (got["iconic"].year_rax, got["iconic"].year_capped) == (90000, False)
    # Rarity buys more rax a year, not more years: every limited player rung lasts 500 / 600 of a year.
    assert all(rung.years_to_limit == pytest.approx(500 / 600) for tier, rung in got.items() if tier != "iconic")
    assert got["common"].per_game_day == pytest.approx(1200 / 80)


def test_current_season_projection_flag():
    half = by_tier(make_pass(season_state="current", base_1x=150.0, season_progress=0.5))["common"]
    assert half.projected is True
    # The season projects to 300 at 1x: the live half (300) pays now, the played half (300) on its anniversaries.
    assert half.year_rax == pytest.approx(600)
    # Live pay counts toward the limit (audit 4f): the live half (300) leaves 700 of it, so the lifetime is 1,000.
    assert half.lifetime_per_rax == pytest.approx(1000 / 300)
    assert by_tier(make_pass(season_state="current", base_1x=276.0, season_progress=0.92))["common"].projected is False
    assert by_tier(make_pass())["common"].projected is False
    # A past season is final whatever its progress says; a season not started has nothing to project from.
    assert by_tier(make_pass(season_progress=0.5))["common"].year_rax == pytest.approx(600)
    assert rungs(make_pass(season_state="current", base_1x=0.0, season_progress=0.0), today=TODAY) == []
    # A share played over 1 is read as a season played in full, never as negative live pay.
    over = by_tier(make_pass(season_state="current", base_1x=300.0, season_progress=1.2))["common"]
    assert (over.year_rax, over.projected, over.lifetime_per_rax) == (600, False, pytest.approx(1000 / 300))


def test_payback_walk_depends_on_month():
    nba = make_pass(base_1x=360.0, month_share=NBA_MONTHS)  # Common: 300 for 720 a year, 80 a month Oct-Jun
    july = by_tier(nba, today=date(2026, 7, 1))["common"]
    november = by_tier(nba, today=date(2026, 11, 1))["common"]
    assert (july.payback_months, july.payback_month) == (pytest.approx(6.75), "2027-01")
    assert (november.payback_months, november.payback_month) == (pytest.approx(3.75), "2027-02")
    assert july.year_rax == november.year_rax
    # Bought on the 12th, November counts for 19 of its 30 days.
    mid = by_tier(nba, today=date(2026, 11, 12))["common"]
    assert (mid.payback_months, mid.payback_month) == (pytest.approx(3.75), "2027-03")


def test_never_pays_back_dropped_from_picks():
    # Every card-built limit is under its cost at 90 a point.
    dear = make_pass(player_id=1, base_1x=30.0, rate_traded=90.0)
    fine = make_pass(player_id=2)
    assert all(rung.pays_back is False for rung in rungs(dear, today=TODAY))
    assert best_rung(rungs(dear, today=TODAY)) is None
    nothing = make_pass(player_id=3, base_1x=0.0)  # a season with no earnings pays nothing back
    assert all(rung.pays_back is False for rung in rungs(nothing, today=TODAY))
    assert pass_picks([dear, fine, nothing], today=TODAY) == {"nba": [fine.key]}


def test_payback_is_bounded_by_the_horizon():
    assert OTD_PAYBACK_HORIZON_YEARS == 5
    never = (False, None, None)
    # 0.02 a year at Common: every limit is far away, so only the horizon stops the walk.
    tiny = rungs(make_pass(base_1x=0.01), today=TODAY)
    assert [(r.pays_back, r.payback_months, r.payback_month) for r in tiny] == [never] * len(tiny)
    # 3 a year at 1x: General's 200 would take 67 years; no rung is back within 5.
    slow = rungs(make_pass(base_1x=3.0), today=TODAY)
    assert [(r.pays_back, r.payback_months, r.payback_month) for r in slow] == [never] * len(slow)
    assert best_rung(slow) is None
    # Common's 300 at 62 a year is back after 58.1 months, inside the 60; at 58 a year it would take 62.1.
    inside = by_tier(make_pass(base_1x=31.0))["common"]
    assert (inside.pays_back, inside.payback_months, inside.payback_month) == (
        True, pytest.approx(300 / (62 / 12)), "2031-09"
    )
    outside = by_tier(make_pass(base_1x=29.0))["common"]
    assert (outside.pays_back, outside.payback_months, outside.payback_month) == never


def test_weak_rungs_compare_only_rungs_with_a_limit():
    ladder = rungs(make_pass(rate_traded=10.0), today=TODAY)
    tiers = {rung.tier: rung for rung in ladder}
    weak = weak_rungs(ladder)
    assert "rare" in weak
    # Mystic's lifetime per rax is under Legendary's and under Iconic's 3-year count; but Iconic has no limit, so it
    # is never a neighbour, and Mystic, the last rung with a limit, is not weak.
    assert tiers["mystic"].lifetime_per_rax < tiers["legendary"].lifetime_per_rax
    assert tiers["mystic"].lifetime_per_rax < tiers["iconic"].lifetime_per_rax
    assert "mystic" not in weak
    # The first rung, and a rung without a limit, are never weak.
    assert not weak & {"general", "iconic"}
    # Held at Epic: Legendary, Mystic and Iconic are left; with no third rung that has a limit, none is weak.
    assert weak_rungs(rungs(make_pass(), held_rating=212, today=TODAY)) == set()
    # The rule is the limit, not the tier's name: an Iconic with a limit (a fighter's has one) is a neighbour again.
    limited = [replace(rung, limit=75000) if rung.tier == "iconic" else rung for rung in ladder]
    assert "mystic" in weak_rungs(limited)


def test_rare_is_weak_at_10_per_point():
    weak = weak_rungs(rungs(make_pass(rate_traded=10.0), today=TODAY))
    assert "rare" in weak
    # The first and last rungs have one neighbour only, so they are never weak.
    assert not weak & {"general", "iconic"}


SPORT_MONTHS_NBA = (pytest.approx(3.75), "2027-02")  # 80 a month Oct-Jun from 1 November: 300 back in February


@pytest.mark.parametrize(
    "shares",
    [(), (0.0,) * 12, (1 / 11,) * 11, (1 / 13,) * 13, (-0.5,) + (0.0,) * 11],
    ids=["missing", "all_zero", "eleven", "thirteen", "negative_only"],
)
def test_unusable_month_shares_fall_back_to_the_sport_months_flagged(shares):
    market = make_pass(base_1x=360.0, month_share=shares)  # an NBA pass: Common 300 for 720 a year
    assert market.month_share_estimated is True
    common = by_tier(market)["common"]
    assert (common.payback_months, common.payback_month) == SPORT_MONTHS_NBA
    assert common.pays_back is True


def test_usable_month_shares_are_not_flagged():
    market = make_pass(base_1x=360.0, month_share=NBA_MONTHS)
    assert market.month_share_estimated is False
    assert (by_tier(market)["common"].payback_months, by_tier(market)["common"].payback_month) == SPORT_MONTHS_NBA
    # Shares that do not add up to 1 are scaled, not replaced.
    halves = make_pass(month_share=tuple(share / 2 for share in FLAT_MONTHS))
    assert halves.month_share_estimated is False


def test_unknown_sport_without_month_shares_pays_evenly_all_year():
    # No shares and no known season months: every month pays a twelfth, flagged; it still pays back.
    market = make_pass(sport="cricket", month_share=())
    assert market.month_share_estimated is True
    common = by_tier(market)["common"]
    assert (common.pays_back, common.payback_months, common.payback_month) == (True, pytest.approx(6.0), "2027-04")


def test_best_rung_respects_budget():
    got = rungs(make_pass(rate_traded=5.0), today=TODAY)
    assert best_rung(got).tier == "legendary"  # 7,500 a year for 2,100
    assert best_rung(got, budget=2000).tier == "epic"  # 3,000 a year for 1,100
    assert best_rung(got, budget=300).tier == "common"  # 600 a year for 250
    assert best_rung(got, budget=100) is None


def test_held_rating_drops_the_mint_and_the_rungs_below():
    got = rungs(make_pass(base_1x=600.0), held_rating=212, today=TODAY)
    assert [(r.tier, r.rating_to_add, r.cost, r.route) for r in got] == [
        ("legendary", 168, 1680, "cards"), ("mystic", 1168, 11680, "cards"), ("iconic", 3168, 31680, "cards"),
    ]
    common = rungs(make_pass(), today=TODAY)[0]
    assert (common.tier, common.cost, common.route) == ("common", 300, "mint+cards")
    unmintable = rungs(make_pass(mintable=False), today=TODAY)[0]
    assert (unmintable.tier, unmintable.cost, unmintable.route) == ("common", 100, "cards")
    # The rules' 200 for a player pass when the market does not state its mint.
    assert [rung.cost for rung in rungs(make_pass(mint_cost=None), today=TODAY)[:2]] == [300, 500]
    assert rungs(make_pass(), held_rating=3380, today=TODAY) == []


def test_on_sale_cheapest_per_point_and_ignores_parked_asks():
    shelf = ((5.0, 100), (2.0, 30), (4.0, 400), (3.0, 45))  # 20, 15, 100 and 15 rax a point
    market = make_pass(rate_traded=10.0, rate_sales=OTD_IGNORE_ASK_MIN_SALES, shelf=shelf, shelf_count=4)
    # 100 a point is over 5 x the traded 10: a parked ask, not real supply. Cheapest a point first, the cheaper
    # card first on a tie.
    assert on_sale(market, 6) == OnSale(on_sale_rating=10.0, on_sale_cost=175, enough=True)
    assert on_sale(market, 20) == OnSale(on_sale_rating=10.0, on_sale_cost=175, enough=False)
    assert on_sale(market, 0) == OnSale(on_sale_rating=0.0, on_sale_cost=0, enough=True)
    # With too few sales to judge, no ask counts as parked.
    thin = replace(market, rate_sales=OTD_IGNORE_ASK_MIN_SALES - 1)
    assert on_sale(thin, 20) == OnSale(on_sale_rating=14.0, on_sale_cost=575, enough=False)
    # Ratings add up exactly: 4.8 + 3.1 + 2.1 is 10, enough for 10.
    exact = make_pass(shelf=((4.8, 48), (3.1, 31), (2.1, 21)), shelf_count=3)
    assert on_sale(exact, 10) == OnSale(on_sale_rating=10.0, on_sale_cost=100, enough=True)


def test_on_sale_counts_ratings_to_the_hundredth_as_real_shows_them_and_as_the_browser_does():
    # Real's ratings carry two decimals. 7.25 + 2.7 is 9.95: short of 10. Counted in tenths, 7.25 was 7.2 here (Python
    # rounds a half to even) and 7.3 in the browser (Math.round rounds it up), so the two disagreed on what is enough.
    short = make_pass(shelf=((7.25, 40), (2.7, 20)), shelf_count=2)
    assert on_sale(short, 10) == OnSale(on_sale_rating=9.95, on_sale_cost=60, enough=False)
    # 4.72 + 5.27 is 9.99, short of 10 too (in tenths, 4.7 + 5.3 made it 10).
    near = make_pass(shelf=((4.72, 47), (5.27, 53)), shelf_count=2)
    assert on_sale(near, 10) == OnSale(on_sale_rating=9.99, on_sale_cost=100, enough=False)
    # 7.25 + 2.75 is exactly 10.
    whole = make_pass(shelf=((7.25, 72), (2.75, 28)), shelf_count=2)
    assert on_sale(whole, 10) == OnSale(on_sale_rating=10.0, on_sale_cost=100, enough=True)


# --- the feed's build rate and the shelf's auctions (advisor/pass_rates.py) -------------------------------------------

def _measured(name: str, **over) -> PassMarket:
    from advisor.pass_rates import clean_extra
    from tests.pass_scenes import extra

    fields, _ = clean_extra({"rate_traded": over.get("rate_traded", 10.0), **extra(name)})
    return make_pass(**{**fields, **over})


def test_a_rung_is_priced_at_the_build_rate_when_the_feed_found_one():
    wemby = _measured("wemby", rate_traded=38.46, rate_sales=100)
    common = by_tier(wemby)["common"]
    assert common.cost == pytest.approx(200 + 10 * 30.36)  # the mint, then 10 points at the common 5-7 cell
    gibbs = _measured("gibbs", rate_traded=164.38, rate_sales=80, mintable=False)
    assert by_tier(gibbs)["rare"].cost == pytest.approx(80 * 29.17)  # not 80 x 164.38
    # The build rate prices a pass whose traded rate is unknown too.
    assert by_tier(_measured("wemby", rate_traded=None, rate_sales=0, mintable=False))["common"].cost == pytest.approx(303.6)


def test_without_a_build_cell_a_rung_keeps_the_traded_rate():
    thin = _measured("thin", rate_traded=22.0, rate_sales=6, mintable=False)
    assert by_tier(thin)["common"].cost == pytest.approx(220.0)
    assert by_tier(make_pass(mintable=False))["common"].cost == 100.0  # a row without the fields: as before


def test_on_sale_reads_the_auctions_pay_when_given_and_says_whether_every_pay_is_firm():
    market = make_pass(rate_traded=10.0, rate_sales=20, shelf=((5.0, 10),), shelf_count=1)  # the old shelf: 2 a point
    auctions = ((5.0, 60, True), (4.0, 60, False), (3.0, 30, True), (2.0, 400, True))  # 12, 15, 10 and 200 a point
    # The old shelf is not read once the auctions are; 200 a point is over 5 x 10: parked.
    assert on_sale(market, 6, auctions) == OnSale(on_sale_rating=8.0, on_sale_cost=90, enough=True, firm=True)
    assert on_sale(market, 9, auctions) == OnSale(on_sale_rating=12.0, on_sale_cost=150, enough=True, firm=False)
    # Only the firm pays, for a pass deal: the opening is left out.
    assert on_sale(market, 9, auctions, firm_only=True) == OnSale(on_sale_rating=8.0, on_sale_cost=90, enough=False, firm=True)
    assert on_sale(market, 3, ()) == OnSale(on_sale_rating=0.0, on_sale_cost=0, enough=False, firm=True)
    assert on_sale(market, 3) == OnSale(on_sale_rating=5.0, on_sale_cost=10, enough=True)  # without: the old shelf


def test_parked_asks_are_judged_against_the_build_rate():
    wemby = _measured("wemby", rate_traded=38.46, rate_sales=100)
    auctions = ((5.0, 700, True), (5.0, 800, True))  # 140 and 160 a point: under and over 5 x 30.36
    assert on_sale(wemby, 10, auctions).on_sale_cost == 700


def test_starters_common_or_uncommon():
    a = make_pass(player_id=1, rate_traded=5.0)  # best overall: Legendary, back in 3.4 months; best entry: Uncommon, 4.7
    b = make_pass(player_id=2, base_1x=600.0)  # best overall and best entry: Common, back in 3.0 months
    team = make_pass(player_id=4, kind="team", rate_traded=None, rate_sales=0)
    assert pass_picks([a, b, team], today=TODAY)["nba"] == [b.key, a.key]
    assert starters([a, b, team], today=TODAY) == {"nba": b.key}
    # A market nobody trades or sells, or one that never pays back, starts nobody.
    idle = make_pass(sport="nfl", player_id=5, rate_sales=0, shelf_count=0)
    dear = make_pass(sport="nhl", player_id=6, rate_traded=90.0)  # no rung pays back
    assert starters([idle, dear], today=TODAY) == {}


def test_starters_exclude_projected_seasons():
    past = make_pass(player_id=1)  # Common: 600 a year for 300, 2.0 a rax
    # Half played, 300 so far: Common projects to 1,200 a year for 300, 4.0 a rax, but it is a projection.
    projected = make_pass(player_id=2, season=2026, season_state="current", base_1x=300.0, season_progress=0.5)
    assert by_tier(projected)["common"].projected is True
    assert starters([past, projected], today=TODAY) == {"nba": past.key}
    # Picks keep it, first: the page labels it a projection.
    assert pass_picks([past, projected], today=TODAY)["nba"][0] == projected.key
    # 92 % played is no projection: 920 so far, so Common pays 160 live + 1,000 (capped) = 1,160 for 300 and starts.
    done = make_pass(player_id=3, season=2026, season_state="current", base_1x=920.0, season_progress=0.92)
    assert starters([past, projected, done], today=TODAY) == {"nba": done.key}


def test_pass_picks_rank_by_payback_from_today_not_by_a_year_that_starts_later():
    # Two passes of one sport, today 1 November. "Later" pays about 4.0 a rax over the next 12 months (its best rung,
    # Iconic) but every rax of it in May and June; "now" pays 2.0 a rax (Common, 600 a year for 300) spread over the
    # whole year. Ranked by the next 12 months per rax, "later" led although it pays nothing for 6 months; from today,
    # "now" is back first (6.0 months against 6.5): it goes first.
    may_june = tuple(0.5 if month in (5, 6) else 0.0 for month in range(1, 13))
    later = make_pass(player_id=1, base_1x=900.0, month_share=may_june)
    now = make_pass(player_id=2)
    assert best_rung(rungs(later, today=TODAY)).year_per_rax > best_rung(rungs(now, today=TODAY)).year_per_rax
    assert best_rung(rungs(later, today=TODAY)).payback_months > best_rung(rungs(now, today=TODAY)).payback_months
    assert pass_picks([later, now], today=TODAY) == {"nba": [now.key, later.key]}
    # The same two in May: "later" pays now, and leads.
    assert pass_picks([later, now], today=date(2027, 5, 1)) == {"nba": [later.key, now.key]}


def test_pass_picks_rank_by_payback_then_year_per_rax_with_ties_and_liquidity():
    # Flat calendars, from 1 November. A pass that hits its limit early pays at its full rate until then, so it can be
    # back sooner than one paying more a rax over the year.
    bigger = make_pass(player_id=9, base_1x=1200.0, rate_traded=30.0)  # Common 500, paying 200 a month: back in 2.5
    b = make_pass(player_id=2, base_1x=600.0)  # Common 300 at 100 a month: back in 3.0, 3.33 a rax, 1,000 a year
    c = make_pass(player_id=1, base_1x=600.0)  # the same: the lower player id goes first
    b_earlier = make_pass(player_id=2, base_1x=600.0, season=2024)  # the same player: the earlier season first
    a = make_pass(player_id=3, rate_traded=5.0)  # Legendary 2,100 at 625 a month: back in 3.4 (3.57 a rax)
    smaller = make_pass(player_id=8, base_1x=300.0)  # Common 300 at 50 a month: back in 6.0
    idle = make_pass(player_id=7, rate_traded=1.0, rate_sales=0, shelf_count=0)  # nobody trades or sells its cards
    listed = make_pass(player_id=6, rate_sales=0, shelf=((5.0, 50),), shelf_count=1, base_1x=100.0)
    assert not is_liquid(idle) and is_liquid(listed)
    picks = pass_picks([smaller, bigger, idle, listed, b, b_earlier, c, a], today=TODAY)
    assert picks == {"nba": [bigger.key, c.key, b_earlier.key, b.key, a.key, smaller.key, listed.key]}
    many = [make_pass(player_id=100 + i) for i in range(OTD_TOP + 3)]
    assert len(pass_picks(many, today=TODAY)["nba"]) == OTD_TOP
    assert pass_picks([], today=TODAY) == {}


def test_live_pay_fills_the_limit_of_a_season_in_progress():
    # B9 (habits audit 4f): a pass's lifetime limit counts all it earns, live pay included. Live pay itself is never
    # stopped, so a season being played leaves On This Day only the limit minus the live pay still to come.
    half = by_tier(make_pass(season_state="current", base_1x=150.0, season_progress=0.5))
    # Common: whole season 300 at 1x, live half 300, so 700 of the 1,000 is left for the played half (300): not cut.
    assert (half["common"].year_rax, half["common"].year_capped) == (pytest.approx(600), False)
    assert half["common"].lifetime_per_rax * half["common"].cost == pytest.approx(1000)  # the limit, not limit + live
    # Legendary: live half 3,750 of a 12,500 limit; lifetime is the limit, not 16,250.
    assert half["legendary"].lifetime_per_rax * half["legendary"].cost == pytest.approx(12500)
    early = by_tier(make_pass(season_state="current", base_1x=60.0, season_progress=0.1))
    # Epic: season 6,000, live 5,400 is over the 5,000 limit: live pay is still paid whole, On This Day has no room.
    epic = early["epic"]
    assert epic.year_rax == pytest.approx(5400)
    assert epic.year_capped is True
    assert epic.lifetime_per_rax * epic.cost == pytest.approx(5400)
