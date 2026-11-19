"""The browser's season events (frontend/src/content/seasonEvents.ts) and the Discord digest's (advisor/season_clock.py)
name the same events on the same dates."""

import re
from pathlib import Path

from advisor.season_clock import EVENTS

TS = Path(__file__).resolve().parent.parent / "frontend" / "src" / "content" / "seasonEvents.ts"


def test_events_match_the_python_table():
    text = TS.read_text()
    found = re.findall(r'id: "([^"]+)", date: "(\d{4}-\d{2}-\d{2})", sport: "([^"]+)"', text)
    assert found == [(e[0], e[1].isoformat(), e[2]) for e in EVENTS]


def test_neither_side_says_a_game_before_a_level_is_lost():
    """A game played before a lift still pays, at the lower rarity (truth audit, finding 15): the digest's lines say
    so, as the site's do."""
    from advisor.season_clock import TIPS

    lines = [event[4] for event in EVENTS] + [tip[2] for tip in TIPS]
    assert not [line for line in lines if "is lost" in line or "lost." in line]
    assert "is lost" not in TS.read_text()
    assert any("lower rarity" in line for line in lines)


def test_college_basketball_march_is_dated_and_worded_the_same_on_both_sides():
    """March holds about 28% of a college basketball season's On This Day pay in the market data (see the
    seasonal clock in advisor/season_clock.py), so the heads-up comes in mid-February, ahead of the late
    February buy window. The title and the line are the same words in the browser and in the digest."""
    event = next(e for e in EVENTS if e[0] == "cbb-march-2027")
    assert event[1].isoformat() == "2027-02-15"
    title, line = event[3], event[4]
    assert title == "March is college basketball's biggest month"
    assert line == ("About 28% of a season's On This Day pay comes in March. Have past-season passes in place by late "
                    "February.")
    assert len(f"{title}. {line}".split()) <= 40
    text = TS.read_text()
    assert f'title: "{title}"' in text
    assert f'line: "{line}"' in text
