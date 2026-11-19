"""Real's vocabulary on the server (advisor/real.py) is the site's (frontend/src/content/real.ts): same rarities,
colours, emoji, sports and season rule, so a Discord embed reads like the page it links to."""

import re
from pathlib import Path

from advisor import real

ROOT = Path(__file__).resolve().parents[1]
TS = (ROOT / "frontend/src/content/real.ts").read_text(encoding="utf-8")


def _ts_rarities() -> list[tuple[str, str, str, str]]:
    return re.findall(r'\{ key: "(\w+)", name: "(\w+)", emoji: "([^"]+)", color: "(#[0-9a-f]{6})" \}', TS)


def test_the_rarities_are_reals_eight_in_reals_order():
    assert real.RARITY_NAMES == ["General", "Common", "Uncommon", "Rare", "Epic", "Legendary", "Mystic", "Iconic"]


def test_the_rarity_table_is_the_sites():
    ts = _ts_rarities()
    assert len(ts) == 8
    assert [name for _, name, _, _ in ts] == real.RARITY_NAMES
    assert [emoji for _, _, emoji, _ in ts] == real.RARITY_EMOJI
    assert [color for _, _, _, color in ts] == real.RARITY_COLORS


def test_the_stylesheet_draws_the_same_colours():
    tokens = (ROOT / "frontend/src/styles/tokens.css").read_text(encoding="utf-8")
    dark = tokens[tokens.index(":root {"):tokens.index(":root[data-theme")]
    assert [c for _, c in sorted(re.findall(r"--rarity-(\d): (#[0-9a-f]{6});", dark))] == real.RARITY_COLORS


def test_a_sub_level_is_written_as_reals_label_says():
    assert real.rarity_label("legendary", "Legendary 3") == "Legendary 3"
    assert real.rarity_label(6, "Mystic 10") == "Mystic 10"
    assert real.rarity_label(5, "Legendary 1") == "Legendary"
    assert real.rarity_label(5, "Mystic 2") == "Legendary"
    assert real.rarity_label(5, None) == "Legendary"
    assert real.rarity_label(9, None) == ""


def test_seasons_are_written_as_real_writes_them_and_as_the_site_does():
    assert real.season_label("nba", 2026) == "2025-26"
    assert real.season_label("cbb", 2000) == "1999-00"
    assert real.season_label("nfl", 2026) == "2026"
    cross = re.search(r"CROSS_YEAR_SPORTS: readonly string\[\] = \[([^\]]*)\]", TS)
    assert cross is not None
    assert re.findall(r'"(\w+)"', cross.group(1)) == list(real.CROSS_YEAR_SPORTS)


def test_sports_are_named_as_on_the_site():
    block = TS[TS.index("SPORT_NAMES"):TS.index("};", TS.index("SPORT_NAMES"))]
    assert dict(re.findall(r'(\w+): "([^"]+)"', block)) == real.SPORT_NAMES
    assert real.sport_label("nba") == "NBA"
    assert real.sport_label("soccer") == "Soccer"
    assert real.sport_name("cfb") == "NCAA Football"
