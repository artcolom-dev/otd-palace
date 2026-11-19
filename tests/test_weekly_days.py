"""NFL and college football passes of one season share their game days (the internal research notes),
golf passes their tournament Sundays (the internal research notes): the shared constants the browser's
planner replays them with are the same on both sides, and the engine says so."""

import re
from pathlib import Path

from advisor import otd
from advisor.rules import OTD_CLAIMS_PER_SPORT_DAY, OTD_SAME_WEEKDAYS, OTD_SPORT_DAYS, OTD_WEEKLY_DAYS

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "frontend" / "src" / "test" / "fixtures.ts"


def test_the_browser_fixture_holds_the_same_weekly_days():
    text = FIXTURES.read_text()
    found = re.search(r"weekly_days: \{ ([^}]*) \}", text)
    assert found, "frontend/src/test/fixtures.ts has no weekly_days"
    ts = {sport: (int(days), float(share)) for sport, days, share in re.findall(r"(\w+): \[(\d+), ([\d.]+)\]", found.group(1))}
    assert ts == OTD_WEEKLY_DAYS


def test_the_browser_fixture_holds_the_same_shared_weekdays():
    found = re.search(r"same_weekdays: \{ ([^}]*) \}", FIXTURES.read_text())
    assert found, "frontend/src/test/fixtures.ts has no same_weekdays"
    ts = {sport: float(share) for sport, share in re.findall(r"(\w+): ([\d.]+)", found.group(1))}
    assert ts == OTD_SAME_WEEKDAYS


def test_weekly_days_are_football_and_golf_and_fit_inside_a_season():
    assert set(OTD_WEEKLY_DAYS) == {"nfl", "cfb", "golf"}
    for sport, (shared, share) in OTD_WEEKLY_DAYS.items():
        claim_days, player_days = OTD_SPORT_DAYS[sport]
        assert 1 <= shared < claim_days
        assert 0 < share <= 1
        assert round(share * player_days) <= shared  # a regular player's shared-day games fit on the shared days
        assert player_days - round(share * player_days) <= claim_days - shared  # and the others on the rest


def test_seasons_that_share_weekdays_are_a_weekly_sport_and_a_share_of_its_days():
    assert set(OTD_SAME_WEEKDAYS) == {"golf"}
    for sport, share in OTD_SAME_WEEKDAYS.items():
        assert sport in OTD_WEEKLY_DAYS
        assert 0 < share <= 1


def test_the_engine_says_whose_claims_it_does_not_count():
    assert OTD_CLAIMS_PER_SPORT_DAY == 2
    assert "OTD_WEEKLY_DAYS" in (otd.__doc__ or "")
    assert "OTD_SAME_WEEKDAYS" in (otd.__doc__ or "")
