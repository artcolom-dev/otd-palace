"""`season_clock.pays_from`: the Discord posts say when an idle sport's passes start to pay, from the site's own months."""

from datetime import date, datetime, timezone

import pytest

from advisor import season_clock
from advisor.discord_post import otd_message


@pytest.mark.parametrize("sport, day, expected", [
    ("mlb", date(2026, 11, 16), "pays from March"),          # a past MLB season in November: idle until spring
    ("MLB", date(2026, 11, 16), "pays from March"),          # case does not matter
    ("wnba", date(2026, 11, 16), "pays from May"),
    ("nba", date(2026, 7, 10), "pays from October"),          # a range that wraps the year
    ("nba", date(2026, 11, 16), None),                        # paying now
    ("mlb", date(2027, 4, 10), None),
    ("golf", date(2026, 11, 16), None),                       # pays all year
    ("curling", date(2026, 11, 16), None),                    # a sport the site does not know
    (None, date(2026, 11, 16), None),
])
def test_pays_from(sport, day, expected):
    assert season_clock.pays_from(sport, day) == expected


def pick(sport):
    return {"player_name": "A. Player", "sport": sport, "season": 2023, "tier": "legendary", "cost": 1663,
            "year_rax": 11950, "payback_months": 5.2}


def test_the_daily_post_says_an_idle_pass_pays_from_spring_and_a_paying_one_does_not():
    day = datetime(2026, 11, 16, 15, tzinfo=timezone.utc)
    lines = otd_message([pick("mlb"), pick("nba")], "https://palace.example.test", day)["embeds"][0]["description"]
    first, second = lines.split("\n")[:2]
    assert "pays from March" in first and "pays back in 5 months" in first
    assert "pays from" not in second and "pays back in 5 months" in second
