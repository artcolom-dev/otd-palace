"""The locked "Pass deals" teaser (advisor/pass_deals.py) and the members' block (frontend/src/lib/passDeals.ts) find
the same passes on the same snapshot: tests/fixtures/pass_deals_parity.json holds it and what each level must find, and
frontend/src/lib/passDealsParity.test.ts holds the browser to the same `expect`.

The fixture's snapshot is the server's own output for its passes, so the browser is tested on what it would be served.
After a change to the pass engine, `uv run python -m tests.test_pass_deals_parity` serves it again (the expectations
stay as written: a change they no longer meet must be looked at, not rewritten)."""

import dataclasses
import json
from datetime import date, datetime
from pathlib import Path

import pytest

from advisor.model import PassMarket
from advisor.pass_deals import _shown, teaser
from advisor.rules import LEVELS, PASS_DEALS_PCT_MIN
from advisor.snapshot import _otd_json, _otd_rules
from advisor.sources.fixture import parse_pass_market

FIXTURE = Path(__file__).parent / "fixtures" / "pass_deals_parity.json"
PARITY = json.loads(FIXTURE.read_text(encoding="utf-8"))
OTD = PARITY["otd"]
TODAY = date.fromisoformat(OTD["as_of"][:10])
BASIS = [field.name for field in dataclasses.fields(PassMarket)]


def _markets(otd: dict) -> list[dict]:
    return [*otd["markets"], *otd["current_markets"]]


def _served_again(otd: dict) -> dict:
    """`otd` served again by the server from its own passes' basis (what the feed sends), without picks and starters."""
    markets = tuple(parse_pass_market({name: m[name] for name in BASIS if name in m}) for m in _markets(otd))
    now = datetime.fromisoformat(otd["as_of"].replace("Z", "+00:00"))
    again = json.loads(json.dumps(_otd_json(markets, now)))
    del again["picks"], again["starters"]
    return again


def test_the_fixture_is_served_with_the_rules_and_budgets_the_server_serves():
    assert PARITY["rules"] == json.loads(json.dumps(_otd_rules()))
    assert PARITY["budgets"] == {level: LEVELS[level]["otd_default_budget"] for level in LEVELS}
    assert set(PARITY["expect"]) == set(LEVELS)


def test_the_fixture_snapshot_is_what_the_server_serves_for_its_passes():
    assert _served_again(OTD) == OTD, "the pass engine changed: run `uv run python -m tests.test_pass_deals_parity`"


def test_every_pass_says_what_it_is_there_for():
    assert sorted(PARITY["why"]) == sorted(m["key"] for m in _markets(OTD))


@pytest.mark.parametrize("level", list(LEVELS))
def test_the_teaser_counts_what_the_block_shows_a_member_of_each_level(level):
    want = PARITY["expect"][level]
    assert teaser(OTD)["levels"][level] == {"passes": want["passes"], "best_pct": want["best_pct"]}
    assert [deal[2] for deal in _shown(_markets(OTD), TODAY, level)] == want["keys"]


@pytest.mark.parametrize("level", list(LEVELS))
def test_the_teaser_says_the_percent_only_from_the_threshold_up(level):
    want = PARITY["expect"][level]
    says_pct = want["best_pct"] is not None and want["best_pct"] >= PASS_DEALS_PCT_MIN
    assert ("%" in want["title"]) is says_pct
    assert (f"{want['best_pct']}%" in want["title"]) is says_pct
    assert (f"{want['passes']} pass" in want["title"]) is not says_pct  # under it, the count is the hook


def test_the_fixture_reads_on_both_sides_of_the_threshold():
    said = [PARITY["expect"][level]["best_pct"] >= PASS_DEALS_PCT_MIN for level in LEVELS]
    assert True in said and False in said
    assert PASS_DEALS_PCT_MIN in [PARITY["expect"][level]["best_pct"] for level in LEVELS]  # exactly at it, said


def test_the_top_level_pair_is_new_s():
    found = teaser(OTD)
    assert {"passes": found["passes"], "best_pct": found["best_pct"]} == found["levels"]["new"]


if __name__ == "__main__":
    PARITY["otd"] = _served_again(OTD)
    FIXTURE.write_text(json.dumps(PARITY, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"served {FIXTURE.name} again")
