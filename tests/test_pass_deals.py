"""The locked "Pass deals" teaser (advisor/pass_deals.py): how many passes the cards on sale build for less than usual,
and the best saving, as two numbers per level, never a pass, a name or a price. It follows the browser's own rule
(frontend/src/lib/passDeals.ts) and never says more than the block would show a member of that level."""

from datetime import date

from advisor.pass_deals import best_pct, teaser
from advisor.rules import LEVELS, OTD_IGNORE_ASK_MIN_SALES, PASS_DEALS_PCT_MAX, PASS_DEALS_SHOWN
from advisor.snapshot import _pass_market_json
from tests.factories import make_pass

TODAY = date(2026, 11, 17)
AS_OF = "2026-11-17T12:00:00Z"
NOTHING = {"passes": 0, "best_pct": None}


def served(**kw) -> dict:
    """A pass as the snapshot serves it: 10 a rating point usual, Common = 200 mint + 10 rating = 300."""
    return _pass_market_json(make_pass(**kw), TODAY)


def otd(*markets: dict) -> dict:
    return {"as_of": AS_OF, "markets": list(markets)}


def at(found: dict, level: str = "pro") -> dict:
    return found["levels"][level]


# 11 rating on sale for 93 (8.5 a point, usual 10): Common for 200 + 93 = 293 instead of 300.
CHEAP = {"shelf": ((6, 48), (5, 45)), "shelf_count": 2}


def test_a_pass_whose_cards_on_sale_build_a_rarity_for_less_counts_with_its_saving_rounded_down_to_5():
    assert at(teaser(otd(served(**CHEAP)))) == {"passes": 1, "best_pct": 0}  # 7 / 300 = 2.3%: under 5


def test_the_best_saving_is_the_deepest_one_across_the_passes_shown():
    deep = served(player_id=11, shelf=((10, 50), (1, 5)), shelf_count=2)  # 11 rating for 55: 255 instead of 300
    assert at(teaser(otd(served(**CHEAP), deep))) == {"passes": 2, "best_pct": 15}


def test_cards_at_or_over_the_usual_rate_build_nothing_for_less():
    assert at(teaser(otd(served(shelf=((6, 60), (5, 50)), shelf_count=2)))) == NOTHING
    assert at(teaser(otd(served()))) == NOTHING  # nothing on sale


def test_parked_asks_are_not_supply():
    # 10 rating at 1 a point is real; the second card asks 60 a point (over 5x the usual 10): left out, so the shelf
    # holds 10 of the rating, enough for Common at 210 rather than 300.
    shelf = ((10, 10), (5, 300))
    assert at(teaser(otd(served(shelf=shelf, shelf_count=2)))) == {"passes": 1, "best_pct": 30}


def test_a_usual_rate_from_too_few_trades_calls_nothing_cheaper():
    # The usual rate is a median of trades: from a handful, one dear sale can make every ask look cheap.
    thin = served(rate_sales=OTD_IGNORE_ASK_MIN_SALES - 1, shelf=((10, 10),), shelf_count=1)
    enough = served(player_id=11, rate_sales=OTD_IGNORE_ASK_MIN_SALES, **CHEAP)
    assert at(teaser(otd(thin))) == NOTHING
    assert at(teaser(otd(thin, enough))) == {"passes": 1, "best_pct": 0}


def test_the_saving_said_is_never_above_the_cap():
    # Not mintable: Common is 10 rating at 10 = 100; 10 rating on sale for 26 makes it 74% less.
    steep = served(mint_cost=None, mintable=False, shelf=((10, 26),), shelf_count=1)
    assert at(teaser(otd(steep))) == {"passes": 1, "best_pct": PASS_DEALS_PCT_MAX}
    assert [best_pct(s) for s in (0.049, 0.05, 0.234, 0.499, 0.74, 1.0)] == [0, 5, 20, 45, 50, 50]


def test_only_the_passes_the_block_shows_count_at_most_two_a_sport():
    # Three NBA passes with deals: the block lists the 2 paying the most a year per Rax at the cost on sale (Real pays
    # 2 claims a sport a day). The third saves the most of all, but pays little: no member sees it, so it is not said.
    big = served(player_id=1, base_1x=900.0, **CHEAP)
    big2 = served(player_id=2, base_1x=800.0, **CHEAP)
    small_but_deep = served(player_id=3, base_1x=60.0, shelf=((10, 20),), shelf_count=1)
    nhl = served(sport="nhl", player_id=4, **CHEAP)
    found = at(teaser(otd(big, big2, small_but_deep, nhl)))
    assert found == {"passes": 3, "best_pct": 0}
    assert at(teaser(otd(small_but_deep))) == {"passes": 1, "best_pct": 25}  # alone, the block shows it


def test_the_saving_said_is_the_deepest_of_the_passes_a_member_sees_first():
    # Four passes in four sports: all count (each is on its sport's tab), but the block on every sport ("all", where a
    # member lands) lists the PASS_DEALS_SHOWN paying the most a year per Rax. The fourth saves the most and pays the
    # least: the saving said is the deepest of the first three.
    firsts = [served(sport=sport, player_id=i, base_1x=900.0 - 100 * i, **CHEAP) for i, sport in enumerate(("nba", "nhl", "nfl"))]
    deep_last = served(sport="mlb", player_id=9, base_1x=60.0, shelf=((10, 20),), shelf_count=1)
    assert PASS_DEALS_SHOWN == 3
    assert at(teaser(otd(*firsts, deep_last))) == {"passes": 4, "best_pct": 0}
    assert at(teaser(otd(*firsts[:2], deep_last))) == {"passes": 3, "best_pct": 25}  # third: a member sees it


def test_each_level_gets_what_its_block_shows_and_the_top_pair_is_new():
    # Uncommon at 1,100 usual (200 + 30 at 30); one card of 30 rating on sale for 820 builds it for 1,020 (7% less):
    # over New's default pass budget (1,000), within Regular's and Pro's.
    dear = served(rate_traded=30.0, base_1x=1000.0, shelf=((30, 820),), shelf_count=1)
    found = teaser(otd(dear))
    assert LEVELS["new"]["otd_default_budget"] < 1020 <= LEVELS["regular"]["otd_default_budget"]
    assert set(found["levels"]) == set(LEVELS)
    assert at(found, "new") == NOTHING and at(found, "regular") == at(found, "pro") == {"passes": 1, "best_pct": 5}
    assert {k: found[k] for k in ("passes", "best_pct")} == at(found, "new")


def test_new_leaves_out_a_rarity_paid_back_after_a_year():
    # A season's pay of 30 at 1x: Common pays 60 a year, so 293 is back in about 5 years.
    slow = served(base_1x=30.0, **CHEAP)
    assert at(teaser(otd(slow)), "new") == NOTHING


def test_a_team_pass_an_unknown_rate_and_a_pass_whose_pay_is_months_away_do_not_count():
    team = served(kind="team", player_id=12, **CHEAP)
    unknown = served(player_id=13, rate_traded=None, rate_sales=0, **CHEAP)
    # Pays only in May and June: the next three months hold nothing of its year (lib/passes.ts paysLater).
    later = served(player_id=14, month_share=(0, 0, 0, 0, 0.5, 0.5, 0, 0, 0, 0, 0, 0), **CHEAP)
    assert at(teaser(otd(team, unknown, later))) == NOTHING


def test_a_rarity_that_does_not_pay_back_or_breaks_even_does_not_count():
    market = served(**CHEAP)
    market["rungs"] = [{**rung, "pays_back": False} for rung in market["rungs"]]
    assert at(teaser(otd(market))) == NOTHING
    market["rungs"] = [{**rung, "pays_back": True, "lifetime_per_rax": 1.0} for rung in market["rungs"]]
    assert at(teaser(otd(market))) == NOTHING


def test_it_holds_two_numbers_per_level_and_reads_odd_input_as_nothing():
    found = teaser(otd(served(**CHEAP)))
    assert set(found) == {"passes", "best_pct", "levels"}
    for pair in [found, *found["levels"].values()]:
        assert all(type(pair[k]) is int for k in ("passes", "best_pct"))
    for odd in (None, {}, {"markets": "x"}, {"as_of": AS_OF, "markets": [1, {"key": 2}, {}]}, {"markets": []}):
        got = teaser(odd)
        assert {k: got[k] for k in ("passes", "best_pct")} == NOTHING
        assert all(pair == NOTHING for pair in got["levels"].values())


def test_this_seasons_passes_served_apart_for_deals_count_too():
    # The feed's current-season passes are served in "current_markets": they are Deals' own, so they count here.
    live = served(season=2026, season_label="2025-26", season_state="current", season_progress=0.95, base_1x=285.0,
                  **CHEAP)
    assert at(teaser({"as_of": AS_OF, "markets": [], "current_markets": [live]}))["passes"] == 1
    assert at(teaser({"as_of": AS_OF, "markets": [served(player_id=2, **CHEAP)], "current_markets": "x"}))["passes"] == 1
