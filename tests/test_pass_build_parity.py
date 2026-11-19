"""Rung pricing on the feed's build rate, the shelf's live auctions and the pass deals they allow: the server
(advisor/otd.py, advisor/pass_rates.py, advisor/pass_deals.py) and the browser (frontend/src/lib/passes.ts,
passRates.ts, passDeals.ts) agree on the same passes. tests/fixtures/pass_build_parity.json holds the feed's rows
(shaped on the live probe of three passes, plus a thin pass, a pass as the feed serves it today and a plain one), the
snapshot the server serves for them and what both sides must find; frontend/src/lib/passBuildParity.test.ts holds
the browser to the same `expect`.

After a change to the pass engine, `uv run python -m tests.test_pass_build_parity` serves the snapshot again; the
expectations stay as written (a change they no longer meet must be looked at, not rewritten). `--expect` writes them
afresh, for a new scene only."""

import json
import sys
from datetime import date, datetime
from pathlib import Path

import pytest

from advisor.otd import on_sale, rungs
from advisor.pass_deals import _shown
from advisor.pass_rates import live_auctions, market_build_rate
from advisor.rules import LEVELS
from advisor.snapshot import _otd_json, _otd_rules
from advisor.sources.fixture import parse_pass_market

FIXTURE = Path(__file__).parent / "fixtures" / "pass_build_parity.json"
PARITY = json.loads(FIXTURE.read_text(encoding="utf-8"))
AS_OF = PARITY["as_of"]
NOW = datetime.fromisoformat(AS_OF.replace("Z", "+00:00"))
TODAY = date.fromisoformat(AS_OF[:10])
WEMBY, CONTROL, FIRM = "nba:2027:player:9001", "nba:2027:player:9002", "nhl:2025:player:9007"


def _markets():
    return {m.key: m for m in (parse_pass_market(row) for row in PARITY["rows"])}


def _served() -> dict:
    otd = json.loads(json.dumps(_otd_json(tuple(_markets().values()), NOW)))
    del otd["picks"], otd["starters"]
    return otd


def _all(otd: dict) -> list[dict]:
    return [*otd["markets"], *otd["current_markets"]]


def _found(market) -> dict:
    """What the server makes of one pass: its build rate, its rungs' costs, and the cards on sale toward Common and
    Rare (from the live auctions when served)."""
    build = market_build_rate(market)
    ladder = {rung.tier: rung for rung in rungs(market, today=TODAY)}
    auctions = live_auctions(market, NOW)
    sales = {}
    for tier in ("common", "rare"):
        sale = on_sale(market, ladder[tier].rating_to_add, auctions)
        sales[tier] = {"rating": sale.on_sale_rating, "cost": sale.on_sale_cost, "enough": sale.enough, "firm": sale.firm}
    return {
        "build": {"rate": build.rate, "thin": build.thin, "bucket": build.bucket, "rarity": build.rarity, "sales": build.sales},
        "costs": {tier: rung.cost for tier, rung in ladder.items()},
        "on_sale": sales,
    }


def _expect() -> dict:
    markets = _markets()
    served = _served()
    return {
        "passes": {key: _found(market) for key, market in markets.items()},
        "pass_deals": {level: [[d[2], d[1]] for d in _shown(_all(served), TODAY, level)] for level in LEVELS},
    }


def test_the_fixture_is_served_with_the_rules_and_budgets_the_server_serves():
    assert PARITY["rules"] == json.loads(json.dumps(_otd_rules()))
    assert PARITY["budgets"] == {level: LEVELS[level]["otd_default_budget"] for level in LEVELS}


def test_the_fixture_snapshot_is_what_the_server_serves_for_its_rows():
    assert _served() == PARITY["otd"], "the pass engine changed: run `uv run python -m tests.test_pass_build_parity`"


def test_every_pass_says_what_it_is_there_for():
    assert sorted(PARITY["why"]) == sorted(row["key"] for row in PARITY["rows"])


@pytest.mark.parametrize("key", [row["key"] for row in PARITY["rows"]])
def test_the_server_prices_each_pass_as_expected(key):
    want = PARITY["expect"]["passes"][key]
    got = _found(_markets()[key])
    assert got["build"] == want["build"]
    assert got["on_sale"] == want["on_sale"]
    assert got["costs"].keys() == want["costs"].keys()
    for tier, cost in want["costs"].items():
        assert got["costs"][tier] == pytest.approx(cost, abs=1e-9), tier


@pytest.mark.parametrize("level", list(LEVELS))
def test_the_server_finds_the_expected_pass_deals(level):
    got = [[d[2], d[1]] for d in _shown(_all(PARITY["otd"]), TODAY, level)]
    want = PARITY["expect"]["pass_deals"][level]
    assert [key for key, _ in got] == [key for key, _ in want]
    assert [cost for _, cost in got] == pytest.approx([cost for _, cost in want], abs=1e-9)


def test_a_wembanyama_shaped_scene_yields_no_pass_deal():
    """Shelf pays of 38 to 60 a point, firm (ending within 2 hours, read 10 minutes ago), against a build rate of
    30.36: no rarity is cheaper on the shelf than built at the usual rate, so no pass deal at any level. The same pass
    as served today (no new fields, a shelf of 40 and 50 floor openings against a traded rate of 38.46) was one."""
    wemby = next(m for m in _all(PARITY["otd"]) if m["key"] == WEMBY)
    assert wemby["rate_build"] == 30.36
    firm = [(rating, pay) for rating, pay, f in wemby["auctions"] if f == 1]
    assert len(firm) == len(wemby["auctions"]) == 9
    assert min(pay / rating for rating, pay in firm) > 37.9 and max(pay / rating for rating, pay in firm) < 60.3
    for level in LEVELS:
        keys = [d[2] for d in _shown(_all(PARITY["otd"]), TODAY, level)]
        assert WEMBY not in keys, level
    assert any(CONTROL in [d[2] for d in _shown(_all(PARITY["otd"]), TODAY, level)] for level in LEVELS)


def test_a_firm_cheap_shelf_is_a_pass_deal_and_an_opening_is_left_out():
    deals = {key: cost for key, cost in PARITY["expect"]["pass_deals"]["regular"]}
    assert deals[FIRM] == pytest.approx(200 + 60 + 48 + 48)  # the mint and the three firm auctions, not the opening


def test_the_probed_passes_cost_what_the_build_rate_says():
    passes = PARITY["expect"]["passes"]
    assert passes[WEMBY]["costs"]["common"] == pytest.approx(200 + 10 * 30.36)
    assert passes[CONTROL]["costs"]["common"] == pytest.approx(200 + 10 * 38.46)
    assert passes["nfl:2024:player:9003"]["costs"]["rare"] == pytest.approx(200 + 80 * 29.17)  # not 164.38 a point
    assert passes["nhl:2023:player:9004"]["costs"]["common"] == pytest.approx(200 + 10 * 20.34)
    thin = passes["mlb:2025:player:9005"]
    assert thin["build"]["thin"] is True and thin["costs"]["common"] == pytest.approx(200 + 10 * 22.0)


if __name__ == "__main__":
    PARITY["otd"] = _served()
    PARITY["rules"] = json.loads(json.dumps(_otd_rules()))
    if "--expect" in sys.argv:
        PARITY["expect"] = _expect()
    FIXTURE.write_text(json.dumps(PARITY, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"served {FIXTURE.name} again")
