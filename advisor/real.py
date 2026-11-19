"""Real's own vocabulary for the server's pages and the Discord copy: the same table as the site's
frontend/src/content/real.ts (tests/test_real.py keeps them equal). Sources and the colour rule are written there."""

RARITY_NAMES = ["General", "Common", "Uncommon", "Rare", "Epic", "Legendary", "Mystic", "Iconic"]
RARITY_EMOJI = ["⚪", "🔵", "🟢", "🟠", "🔴", "🟣", "🟡", "💎"]
RARITY_COLORS = ["#c9cbd1", "#3f8cf0", "#45b35a", "#ee8a2a", "#e5484d", "#a071f0", "#f0c232", "#72d3f2"]

SPORT_NAMES = {
    "nba": "NBA",
    "nfl": "NFL",
    "mlb": "MLB",
    "nhl": "NHL",
    "ufc": "UFC",
    "wnba": "WNBA",
    "soccer": "Soccer",
    "golf": "Golf",
    "cfb": "NCAA Football",
    "cbb": "NCAA Men's Basketball",
}
_SPORT_SHORT = {"soccer": "Soccer", "golf": "Golf", "cricket": "Cricket", "tennis": "Tennis"}

# The leagues whose season straddles New Year: Real writes it as two years ("2025-26"), its data by the year it ends.
CROSS_YEAR_SPORTS = ("nba", "nhl", "cbb")


def rarity_name(rarity: int) -> str:
    return RARITY_NAMES[rarity] if isinstance(rarity, int) and 0 <= rarity < len(RARITY_NAMES) else ""


def rarity_index(tier: str) -> int:
    key = tier.strip().lower() if isinstance(tier, str) else ""
    names = [n.lower() for n in RARITY_NAMES]
    return names.index(key) if key in names else -1


def rarity_label(rarity: int | str, real_label: str | None = None) -> str:
    """"Legendary 3" when Real's own label names that sub-level of this rarity, else the rarity's name."""
    index = rarity if isinstance(rarity, int) else rarity_index(rarity)
    name = rarity_name(index)
    if not name or not isinstance(real_label, str):
        return name
    parts = real_label.strip().split(" ")
    if not parts or parts[0].lower() != name.lower() or len(parts) > 2:
        return name
    if len(parts) == 2 and parts[1].isdigit() and len(parts[1]) <= 2 and parts[1][0] != "0" and parts[1] != "1":
        return f"{name} {parts[1]}"
    return name


def sport_label(sport: str) -> str:
    """"nba" -> "NBA": the short name; a sport that reads as a word gets a capital ("soccer" -> "Soccer")."""
    known = _SPORT_SHORT.get(sport)
    if known:
        return known
    return sport.upper() if len(sport) <= 4 else sport[:1].upper() + sport[1:]


def sport_name(sport: str) -> str:
    return SPORT_NAMES.get(sport) or sport_label(sport)


def season_label(sport: str, season: int) -> str:
    """A season as Real writes it: "2025-26" for NBA 2026, "2026" for NFL or MLB 2026."""
    if not isinstance(season, int) or isinstance(season, bool):
        return ""
    if sport not in CROSS_YEAR_SPORTS:
        return str(season)
    return f"{season - 1}-{season % 100:02d}"
