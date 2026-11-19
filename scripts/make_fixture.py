"""Generates the demo dataset: a believable market for the real athletes' cards, with times as offsets.

    uv run python scripts/make_fixture.py --seed 7 --out advisor/fixtures/demo_raw.json

Only the athletes' and teams' names (with each athlete's team and position) are real. Every card, price, sale,
pass and earning is invented, and the same seed always writes the same file. The file format is described in
advisor/sources/fixture.py.
"""

import argparse
import json
import random
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # so the advisor package imports from anywhere

from advisor.model import Fmv, Listing, Sale
from advisor.parsing import bucket_of
from advisor.reference import index_sales, listing_key, reference_for
from advisor.rules import OTD_MINT_COST, OTD_SPORT_DAYS, OTD_SPORT_MONTHS

# The moment the offsets are measured from. Any fixed moment gives the same file.
EPOCH = datetime(2026, 11, 12, 18, 0, tzinfo=timezone.utc)
HOUR, DAY = 3600, 86400

# Athletes with how big a star each is (0 to 1), which lifts the prices of their cards. First id of each sport.
PLAYERS = {
    "nba": (1000, [
        ("Victor Wembanyama", 1.0), ("Cooper Flagg", 0.98), ("Shai Gilgeous-Alexander", 0.97),
        ("Nikola Jokić", 0.95), ("Luka Dončić", 0.95), ("LeBron James", 0.92), ("Anthony Edwards", 0.9),
        ("Giannis Antetokounmpo", 0.9), ("Stephen Curry", 0.9), ("Jayson Tatum", 0.8), ("Kevin Durant", 0.8),
        ("Jalen Brunson", 0.7), ("Devin Booker", 0.7), ("Donovan Mitchell", 0.65), ("Joel Embiid", 0.65),
        ("Tyrese Haliburton", 0.62), ("Jaylen Brown", 0.6), ("Anthony Davis", 0.6), ("Ja Morant", 0.6),
        ("LaMelo Ball", 0.6), ("Paolo Banchero", 0.6), ("Chet Holmgren", 0.6), ("Cade Cunningham", 0.6),
        ("Kawhi Leonard", 0.55), ("Trae Young", 0.55), ("Dylan Harper", 0.55), ("Damian Lillard", 0.5),
        ("Zion Williamson", 0.5), ("Scottie Barnes", 0.5), ("Evan Mobley", 0.45), ("Jalen Williams", 0.45),
        ("Amen Thompson", 0.45), ("Franz Wagner", 0.4), ("Alperen Şengün", 0.4), ("De'Aaron Fox", 0.4),
        ("Karl-Anthony Towns", 0.4), ("Ace Bailey", 0.4), ("Jaren Jackson Jr.", 0.35), ("Bam Adebayo", 0.35),
        ("Domantas Sabonis", 0.3),
    ]),
    "nfl": (2000, [
        ("Patrick Mahomes", 1.0), ("Josh Allen", 0.95), ("Lamar Jackson", 0.93), ("Joe Burrow", 0.9),
        ("Jalen Hurts", 0.85), ("Justin Jefferson", 0.85), ("Ja'Marr Chase", 0.85), ("Saquon Barkley", 0.8),
        ("Jayden Daniels", 0.8), ("CeeDee Lamb", 0.7), ("Caleb Williams", 0.7), ("Puka Nacua", 0.7),
        ("Travis Kelce", 0.65), ("Christian McCaffrey", 0.6), ("Micah Parsons", 0.6), ("Brock Purdy", 0.55),
    ]),
    "nhl": (3000, [
        ("Connor McDavid", 1.0), ("Nathan MacKinnon", 0.85), ("Auston Matthews", 0.8), ("Leon Draisaitl", 0.75),
        ("Connor Bedard", 0.75), ("Cale Makar", 0.7),
    ]),
    "mlb": (4000, [
        ("Shohei Ohtani", 1.0), ("Aaron Judge", 0.9), ("Juan Soto", 0.8), ("Paul Skenes", 0.8),
        ("Bobby Witt Jr.", 0.75), ("Mookie Betts", 0.6), ("Elly De La Cruz", 0.6),
    ]),
}
SEASONS = (2026, 2026, 2026, 2025)  # the current season is the most common

# What a card of each rarity sells for: the cheapest and the dearest, in rax. Most cards trade between 20 and
# 200 rax; only the best rarities of the biggest stars go above 1,000.
PRICE_BANDS = {2: (20, 70), 3: (40, 140), 4: (70, 200), 5: (150, 600), 6: (400, 1600), 7: (1000, 4000)}
# Better rarities have better ratings: which value buckets each rarity can have, lowest first.
RARITY_BUCKETS = {
    2: ("0-1.5", "1.5-3"), 3: ("1.5-3", "3-5"), 4: ("3-5", "5-7"), 5: ("5-7", "7-9"), 6: ("7-9", "9+"), 7: ("9+",),
}
RARITY_WEIGHTS = {2: 30, 3: 32, 4: 24, 5: 10, 6: 2.5, 7: 0.8}
RATING_RANGES = {  # inside each value bucket
    "0-1.5": (0.4, 1.4), "1.5-3": (1.6, 3.0), "3-5": (3.1, 5.0), "5-7": (5.1, 7.0), "7-9": (7.1, 9.0),
    "9+": (9.1, 10.5),
}
MINT_CAPS = {2: 5000, 3: 2000, 4: 500, 5: 150, 6: 50, 7: 10}  # how many of a card exist, roughly

# How the markets (a player's cards of one season and value bucket) trade.
MARKET_KINDS = ("liquid", "mover", "thin")
MARKET_KIND_WEIGHTS = (62, 22, 16)
BASE_SALES = {"liquid": (7, 13), "mover": (6, 11), "thin": (0, 2)}  # sales 1 to 8 days ago, (fewest, most)
RECENT_SALES = {"liquid": (0, 2), "mover": (5, 8), "thin": (0, 1)}  # sales in the last 24 hours
PRICE_NOISE = 0.07  # sale prices spread around the market price by about this share
MOVER_DRIFT = (0.25, 0.45)  # how far the price of a mover has moved today, up or down
CALM_DRIFT = 0.03  # how far the price of any other market has moved

# How the listings are priced, as shares of the reference price.
LISTING_COUNT = 300
SCARCITY = 1.6  # each rarity above 3 is this many times less often listed than the one below
SOON_S = 2 * HOUR  # a listing ending within this is "soon"; bids matter then
SOON_SHARE = 0.28
AUCTION_LENGTHS = (DAY, 2 * DAY, 3 * DAY)
# A roll under a cut gives that listing style; "bid" only for a listing that ends soon.
DEAL_CUT, MILD_CUT, BID_CUT = 0.08, 0.12, 0.26
THIN_DEAL_BOOST = 2  # how many times likelier a listing in a thin market is to be priced as a deal
TARGET_SHARES = {"deal": (0.50, 0.68), "mild": (0.77, 0.79), "fair": (1.0, 1.4)}
TARGET_PRESENT = 0.7  # share of the fair listings that carry a target price
FMV_SHARE = {"thin": 0.85, "liquid": 0.45, "mover": 0.45}  # share of the cards Real has a fair market value for
FMV_TIERS = (("card", 30), ("player", 45), ("similar", 25))
REAL_MINTED_SHARE = 0.2  # share of the listings that are Real's own fresh mints ...
REAL_MINT_PRICE = 10  # ... listed at this target price and opening bid
LISTED_WITHIN_S = 2 * HOUR  # every listing went up within this long before now

# Daily-pay passes: about sixty, drawn on the figures measured for the advisor (rules in advisor/rules.py). A season
# is numbered by the year it ends in; NBA and NHL seasons span two years and show as "2024-25".
SPLIT_SEASONS = {"nba", "nhl"}
PASS_PLAYERS = {"nba": 24, "nfl": 14, "nhl": 9, "mlb": 9}  # player passes per sport, the forced ones below included
PASS_PAST_SEASONS = {"nba": (2025, 2026), "nfl": (2025,), "nhl": (2025, 2026), "mlb": (2025, 2026)}
PASS_CURRENT = {"nba": (2027, 0.12, 3), "nhl": (2027, 0.15, 2), "nfl": (2026, 0.5, 4)}  # (season, share played, passes)
PASS_SEASON_1X = (130, 780)  # a whole season's 1x earnings, from a regular to the top star
PASS_SO_FAR_NOISE = 0.15  # a season in progress has earned its share played, give or take this share
PASS_GAME_DAYS = {"nba": (72, 88), "nhl": (70, 101), "nfl": (14, 20), "mlb": (90, 140)}  # a player's earning days
PITCHER_GAME_DAYS = (26, 34)  # a pitcher earns on far fewer days
PASS_UNMEASURED = 0.15  # share of the past passes whose game days come from the sport's table, not a log
PASS_RATE = {"nba": 11.0, "nfl": 10.0, "nhl": 9.0, "mlb": 12.0}  # median traded rax per rating point
PASS_RATE_SPREAD = 0.3  # log-normal spread around that median ...
PASS_RATE_BAND = (5.0, 20.0)  # ... kept inside this band
PASS_TRADES = (6, 140)  # how many trades a rate comes from
PASS_DEAR = 4  # passes whose few trades went far above the usual rate: no rarity of them pays back ...
PASS_DEAR_RATE = (85.0, 110.0)
PASS_DEAR_TRADES = (1, 4)
PASS_DEAR_SEASON_1X = 450  # ... and whose season is small enough that not even Iconic's horizon covers the cost
PASS_SHELF = (2, 3)  # cards on sale per player pass: listings are added when the demo has fewer
PASS_ASK_OVER_RATE = (2.5, 5.0)  # an added listing asks this many times the traded rate per point
PASS_ASK_OVER_REF = 1.05  # and never under the price its cards sell for, so it is never a deal
PASS_MONTH_NOISE = 0.15  # how much one season's months differ from the sport's usual shape
# Two teammates' passes of one season in each sport: they pay on the same days.
TEAMMATES = (
    ("nba", 2026, ("Shai Gilgeous-Alexander", "Chet Holmgren")),
    ("nfl", 2025, ("Patrick Mahomes", "Travis Kelce")),
    ("nhl", 2026, ("Connor McDavid", "Leon Draisaitl")),
    ("mlb", 2025, ("Shohei Ohtani", "Mookie Betts")),
)
INJURED = (("nba", 2026, "Tyrese Haliburton"),)  # missed that whole season: his pass of it pays nothing
FIRST_SEASON = {"Cooper Flagg": 2026, "Dylan Harper": 2026, "Ace Bailey": 2026}  # rookies have no earlier season
# Team passes: (sport, season, team, name, whole season's 1x earnings, game days).
TEAM_PASSES = (
    ("nba", 2026, "OKC", "Oklahoma City Thunder", (1700, 2200), 88),
    ("nfl", 2025, "KC", "Kansas City Chiefs", (1400, 1900), 20),
)
# One fighter's pass: Real states no limit for these, and it costs 800 to mint.
FIGHTER = ("ufc", 2025, 5001, "Islam Makhachev")
FIGHTER_GAME_DAYS = (29, 39)
FIGHTER_PER_DAY = (80, 95)  # 1x per earning day
FIGHTER_RATE = (18.0, 22.0)
FIGHTER_TRADES = (8, 30)
TEAM_ID_BASE = {"nba": 100, "nfl": 200, "nhl": 300, "mlb": 400}
# Each athlete's team and position, one for every season of the demo.
ROSTER = {
    "Victor Wembanyama": ("SAS", "C"), "Cooper Flagg": ("DAL", "SF"), "Shai Gilgeous-Alexander": ("OKC", "PG"),
    "Nikola Jokić": ("DEN", "C"), "Luka Dončić": ("LAL", "PG"), "LeBron James": ("LAL", "SF"),
    "Anthony Edwards": ("MIN", "SG"), "Giannis Antetokounmpo": ("MIL", "PF"), "Stephen Curry": ("GSW", "PG"),
    "Jayson Tatum": ("BOS", "SF"), "Kevin Durant": ("HOU", "PF"), "Jalen Brunson": ("NYK", "PG"),
    "Devin Booker": ("PHX", "SG"), "Donovan Mitchell": ("CLE", "SG"), "Joel Embiid": ("PHI", "C"),
    "Tyrese Haliburton": ("IND", "PG"), "Jaylen Brown": ("BOS", "SG"), "Anthony Davis": ("DAL", "PF"),
    "Ja Morant": ("MEM", "PG"), "LaMelo Ball": ("CHA", "PG"), "Paolo Banchero": ("ORL", "PF"),
    "Chet Holmgren": ("OKC", "C"), "Cade Cunningham": ("DET", "PG"), "Kawhi Leonard": ("LAC", "SF"),
    "Trae Young": ("ATL", "PG"), "Dylan Harper": ("SAS", "SG"), "Damian Lillard": ("POR", "PG"),
    "Zion Williamson": ("NOP", "PF"), "Scottie Barnes": ("TOR", "SF"), "Evan Mobley": ("CLE", "PF"),
    "Jalen Williams": ("OKC", "SG"), "Amen Thompson": ("HOU", "SF"), "Franz Wagner": ("ORL", "SF"),
    "Alperen Şengün": ("HOU", "C"), "De'Aaron Fox": ("SAS", "PG"), "Karl-Anthony Towns": ("NYK", "C"),
    "Ace Bailey": ("UTA", "SF"), "Jaren Jackson Jr.": ("MEM", "PF"), "Bam Adebayo": ("MIA", "C"),
    "Domantas Sabonis": ("SAC", "C"),
    "Patrick Mahomes": ("KC", "QB"), "Josh Allen": ("BUF", "QB"), "Lamar Jackson": ("BAL", "QB"),
    "Joe Burrow": ("CIN", "QB"), "Jalen Hurts": ("PHI", "QB"), "Justin Jefferson": ("MIN", "WR"),
    "Ja'Marr Chase": ("CIN", "WR"), "Saquon Barkley": ("PHI", "RB"), "Jayden Daniels": ("WAS", "QB"),
    "CeeDee Lamb": ("DAL", "WR"), "Caleb Williams": ("CHI", "QB"), "Puka Nacua": ("LAR", "WR"),
    "Travis Kelce": ("KC", "TE"), "Christian McCaffrey": ("SF", "RB"), "Micah Parsons": ("GB", "LB"),
    "Brock Purdy": ("SF", "QB"),
    "Connor McDavid": ("EDM", "C"), "Nathan MacKinnon": ("COL", "C"), "Auston Matthews": ("TOR", "C"),
    "Leon Draisaitl": ("EDM", "C"), "Connor Bedard": ("CHI", "C"), "Cale Makar": ("COL", "D"),
    "Shohei Ohtani": ("LAD", "DH"), "Aaron Judge": ("NYY", "OF"), "Juan Soto": ("NYM", "OF"),
    "Paul Skenes": ("PIT", "P"), "Bobby Witt Jr.": ("KC", "SS"), "Mookie Betts": ("LAD", "SS"),
    "Elly De La Cruz": ("CIN", "SS"),
}


@dataclass(frozen=True)
class Market:
    """One player's cards of one season and value bucket: what they are worth and how they trade."""

    sport: str
    season: int
    player_id: int
    player_name: str
    star: float
    rarity: int
    bucket: str
    price: int
    kind: str
    drift: float


def _round3(value: float) -> int:
    """Three significant digits, the way prices are quoted."""
    return max(1, int(float(f"{value:.3g}")))


def _markets(rng: random.Random) -> list[Market]:
    markets = []
    for sport, (first_id, players) in PLAYERS.items():
        for index, (name, star) in enumerate(players):
            taken = set()
            while len(taken) < 2 + (star >= 0.75):
                season = rng.choice(SEASONS)
                weights = [w * (0.5 + star) if r >= 5 else w for r, w in RARITY_WEIGHTS.items()]
                rarity = rng.choices(list(RARITY_WEIGHTS), weights)[0]
                buckets = RARITY_BUCKETS[rarity]
                bucket = rng.choice(buckets)
                if (season, bucket) in taken:
                    continue
                taken.add((season, bucket))
                low, high = PRICE_BANDS[rarity]
                position = (buckets.index(bucket) + 0.5) / len(buckets)
                reach = 0.45 * star + 0.4 * position + 0.15 * rng.random()
                kind = rng.choices(MARKET_KINDS, MARKET_KIND_WEIGHTS)[0]
                if kind == "mover":
                    drift = rng.choice((-1, 1)) * rng.uniform(*MOVER_DRIFT)
                else:
                    drift = rng.uniform(-CALM_DRIFT, CALM_DRIFT)
                markets.append(Market(
                    sport, season, first_id + index + 1, name, star, rarity, bucket,
                    _round3(low * (high / low) ** reach), kind, drift,
                ))
    return markets


def _sales(rng: random.Random, markets: list[Market]) -> list[Sale]:
    """Each market's sales: a base window 1 to 8 days back, and the last 24 hours at the drifted price."""
    sales, card_id = [], 100_000
    for market in markets:
        windows = (
            (BASE_SALES[market.kind], (DAY + 60, 8 * DAY), 0.0),
            (RECENT_SALES[market.kind], (60, DAY - 60), market.drift),
        )
        for counts, ages, drift in windows:
            for _ in range(rng.randint(*counts)):
                price = max(1, round(market.price * (1 + drift) * rng.lognormvariate(0, PRICE_NOISE)))
                sales.append(Sale(
                    card_id, market.player_id, market.player_name, market.sport, market.season, market.bucket,
                    price, EPOCH - timedelta(seconds=rng.randint(*ages)),
                ))
                card_id += 1
    return sales


def _fmv(rng: random.Random, market: Market, card_id: int) -> Fmv | None:
    """Real's fair market value for a card, when it has one; a card nobody sells has little to go on."""
    if rng.random() >= FMV_SHARE[market.kind]:
        return None
    tier = rng.choices([t for t, _ in FMV_TIERS], [w for _, w in FMV_TIERS])[0]
    if market.kind == "thin":
        if rng.random() < 0.2:
            return Fmv(card_id, None, None, 0)
        sale_count = rng.randint(3, 12)
    else:
        sale_count = rng.randint(3, 25)
    return Fmv(card_id, _round3(market.price * rng.uniform(0.9, 1.1)), tier, sale_count)


def _style(rng: random.Random, soon: bool, thin: bool) -> str:
    """How a listing is priced. Sellers misprice cards nobody trades, so thin markets have more deals."""
    roll = rng.random() / (THIN_DEAL_BOOST if thin else 1)
    if roll < DEAL_CUT:
        return "deal"
    if roll < MILD_CUT:
        return "mild"
    return "bid" if soon and roll < BID_CUT else "fair"


def _prices(rng: random.Random, anchor: float, style: str, soon: bool) -> tuple[int, int | None, int, int | None]:
    """(min_bid, current_bid, num_bids, target_price) of a listing worth `anchor`, in the given style.

    Styles: "deal" and "mild" put the target price well or a little under the anchor, "bid" is an
    auction about to end with a low bid, "fair" is priced at or above value.
    """
    if style in ("deal", "mild"):
        target = anchor * rng.uniform(*TARGET_SHARES[style])
        current = target * rng.uniform(0.5, 0.9) if rng.random() < 0.3 else None
        start = (current or target) * rng.uniform(0.5, 0.9)
    else:
        target = anchor * rng.uniform(*TARGET_SHARES["fair"]) if rng.random() < TARGET_PRESENT else None
        if style == "bid":
            current = anchor * rng.uniform(0.45, 0.66)
            start = current * rng.uniform(0.7, 0.95)
        elif rng.random() < (0.85 if soon else 0.55):
            current = anchor * (rng.uniform(0.82, 1.04) if soon else rng.uniform(0.5, 0.95))
            start = current * rng.uniform(0.6, 0.95)
        else:
            current = None
            start = anchor * (rng.uniform(0.86, 0.97) if soon else rng.uniform(0.4, 0.9))
    if target is not None and current is not None and current >= 0.95 * target:
        current = 0.9 * target  # a bid never reaches the target price
    target_price = None if target is None else max(1, round(target))
    min_bid = max(1, round(start))
    if current is None:
        return min_bid, None, 0, target_price
    current_bid = max(1, round(current))
    return min(min_bid, current_bid), current_bid, rng.randint(1, 8), target_price


def _listings(rng: random.Random, markets: list[Market], sales: list[Sale]) -> tuple[list[dict], list[Fmv]]:
    """The open listings and the fair market values of their cards, priced against what the engine will think."""
    by_market = index_sales(sales)
    rows, fmv, card_id = [], {}, 400_000
    weights = [(0.3 + m.star) / SCARCITY ** max(0, m.rarity - 3) for m in markets]
    picked = rng.choices(markets, weights, k=LISTING_COUNT)
    for number, market in enumerate(picked):
        card_id += 1
        value = _fmv(rng, market, card_id)
        if value is not None:
            fmv[card_id] = value
        low, high = RATING_RANGES[market.bucket]
        rating = round(rng.uniform(low, high), 1)
        assert bucket_of(rating) == market.bucket
        card = Listing(
            id=810_000 + number, card_id=card_id, sport=market.sport, season=market.season,
            player_id=market.player_id, player_name=market.player_name,
            card_label=f"{market.player_name} {market.season}", rarity=market.rarity, rating=rating,
            mint=None if rng.random() < 0.03 else rng.randint(1, MINT_CAPS[market.rarity]),
            min_bid=0, current_bid=None, num_bids=0, target_price=None, ends_at=EPOCH, created_at=None,
        )
        ref = reference_for(card, by_market.get(listing_key(card), ()), fmv, EPOCH)
        anchor = market.price if ref is None else ref.price

        soon = rng.random() < SOON_SHARE
        length = rng.choice(AUCTION_LENGTHS)
        ends_in = rng.randint(300, SOON_S) if soon else rng.randint(SOON_S + 1, length)
        minted = rng.random() < REAL_MINTED_SHARE
        if minted:  # Real's own mint: a fixed price whatever the card is worth, so never a deal
            min_bid, current_bid, num_bids, target = REAL_MINT_PRICE, None, 0, REAL_MINT_PRICE
        else:
            style = _style(rng, soon, market.kind == "thin")
            min_bid, current_bid, num_bids, target = _prices(rng, anchor, style, soon)
        rows.append({
            "id": card.id, "card_id": card.card_id, "sport": card.sport, "season": card.season,
            "player_id": card.player_id, "player_name": card.player_name, "card_label": card.card_label,
            "rarity": card.rarity, "rating": card.rating, "mint": card.mint, "min_bid": min_bid,
            "current_bid": current_bid, "num_bids": num_bids, "target_price": target,
            "ends_in_s": ends_in, "created_ago_s": rng.randint(0, LISTED_WITHIN_S), "minted_by_real": minted,
        })
    return rows, list(fmv.values())


def _season_label(sport: str, season: int) -> str:
    return f"{season - 1}-{season % 100:02d}" if sport in SPLIT_SEASONS else str(season)


def _team_id(sport: str, team: str) -> int:
    """A team's id: its place among the sport's teams in ROSTER, after the sport's base."""
    teams = sorted({ROSTER[name][0] for name, _ in PLAYERS[sport][1]})
    return TEAM_ID_BASE[sport] + teams.index(team) + 1


def _month_share(rng: random.Random, sport: str) -> list[float]:
    """A season's earnings by calendar month, January first: only the sport's months pay, the first and last of a
    season that is not all year round half as much. Shares to 3 decimals, adding up to 1."""
    months = OTD_SPORT_MONTHS[sport]
    ends = (months[0], months[-1]) if len(months) < 12 else ()
    weights = [0.0] * 12
    for month in months:
        weights[month - 1] = (0.5 if month in ends else 1.0) * rng.uniform(1 - PASS_MONTH_NOISE, 1 + PASS_MONTH_NOISE)
    shares = [round(weight / sum(weights), 3) for weight in weights]
    biggest = shares.index(max(shares))
    shares[biggest] = round(shares[biggest] + 1 - sum(shares), 3)  # the rounding's leftover
    return shares


def _pass_row(**fields) -> dict:
    """A pass market row with its key, its fields in the model's order."""
    row = {"key": f"{fields['sport']}:{fields['season']}:{fields['kind']}:{fields['player_id']}"}
    for name in (
        "sport", "season", "season_label", "season_state", "player_id", "player_name", "team_id", "position", "kind",
        "base_1x", "season_progress", "game_days", "game_days_measured", "month_share", "rate_traded",
        "rate_sales", "shelf", "shelf_count", "mint_cost", "mintable",
    ):
        row[name] = fields[name]
    return row


def _pick_player_passes(rng: random.Random) -> list[tuple[str, int, int]]:
    """(sport, season, player index) of every player pass: the teammates and the injured first, then each sport's
    seasons in progress, then past seasons, stars drawn more often."""
    names = {sport: [name for name, _ in players] for sport, (_, players) in PLAYERS.items()}
    picked = [(sport, season, names[sport].index(name)) for sport, season, group in TEAMMATES for name in group]
    picked += [(sport, season, names[sport].index(name)) for sport, season, name in INJURED]

    for sport, count in PASS_PLAYERS.items():
        if sport in PASS_CURRENT:
            current, _, wanted = PASS_CURRENT[sport]
            _draw_passes(rng, picked, sport, (current,), wanted - sum(p[:2] == (sport, current) for p in picked))
        _draw_passes(rng, picked, sport, PASS_PAST_SEASONS[sport], count - sum(p[0] == sport for p in picked))
    return picked


def _draw_passes(
    rng: random.Random, picked: list[tuple[str, int, int]], sport: str, seasons: tuple[int, ...], how_many: int
) -> None:
    """Add `how_many` new (sport, season, player index) to `picked`, a season of `seasons` each, stars more often,
    never a season before a rookie's first."""
    players = PLAYERS[sport][1]
    weights = [0.5 + star for _, star in players]
    added = 0
    while added < how_many:
        index = rng.choices(range(len(players)), weights)[0]
        season = rng.choice(seasons)
        if (sport, season, index) not in picked and season >= FIRST_SEASON.get(players[index][0], 0):
            picked.append((sport, season, index))
            added += 1


def _player_pass(rng: random.Random, sport: str, season: int, index: int, *, dear: bool, injured: bool) -> dict:
    """One player's pass of one season, its season drawn by how big a star the player is."""
    first_id, players = PLAYERS[sport]
    name, star = players[index]
    team, position = ROSTER[name]
    current, progress, _ = PASS_CURRENT.get(sport, (None, 1.0, 0))
    in_progress = season == current
    progress = progress if in_progress else 1.0
    low, high = PASS_SEASON_1X
    season_1x = low * (high / low) ** (0.75 * star + 0.25 * rng.random())
    if dear:
        season_1x = min(season_1x, PASS_DEAR_SEASON_1X)
    game_days = rng.randint(*(PITCHER_GAME_DAYS if position == "P" else PASS_GAME_DAYS[sport]))
    measured = not in_progress and rng.random() >= PASS_UNMEASURED
    if not in_progress and not measured:
        game_days = OTD_SPORT_DAYS[sport][1]
    base_1x = season_1x * progress
    if in_progress:
        base_1x *= rng.uniform(1 - PASS_SO_FAR_NOISE, 1 + PASS_SO_FAR_NOISE)
    if injured:
        base_1x, game_days, measured = 0.0, 0, True
    if dear:
        rate, trades = round(rng.uniform(*PASS_DEAR_RATE), 1), rng.randint(*PASS_DEAR_TRADES)
    else:
        low_rate, high_rate = PASS_RATE_BAND
        rate = round(min(high_rate, max(low_rate, PASS_RATE[sport] * rng.lognormvariate(0, PASS_RATE_SPREAD))), 1)
        trades = rng.randint(*PASS_TRADES)
    return _pass_row(
        sport=sport, season=season, season_label=_season_label(sport, season),
        season_state="current" if in_progress else "past", player_id=first_id + index + 1, player_name=name,
        team_id=_team_id(sport, team), position=position, kind="player", base_1x=round(base_1x, 1),
        season_progress=progress, game_days=game_days, game_days_measured=measured,
        month_share=_month_share(rng, sport), rate_traded=rate, rate_sales=trades, shelf=[], shelf_count=0,
        mint_cost=OTD_MINT_COST["player"], mintable=True,
    )


def _other_passes(rng: random.Random) -> list[dict]:
    """The team passes and the fighter's: their cards have no rate per point (teams) or no demo listings (UFC)."""
    rows = []
    for sport, season, team, name, season_1x, game_days in TEAM_PASSES:
        team_id = _team_id(sport, team)
        rows.append(_pass_row(
            sport=sport, season=season, season_label=_season_label(sport, season), season_state="past",
            player_id=team_id, player_name=name, team_id=team_id, position=None, kind="team",
            base_1x=round(rng.uniform(*season_1x), 1), season_progress=1.0, game_days=game_days,
            game_days_measured=False, month_share=_month_share(rng, sport), rate_traded=None, rate_sales=0,
            shelf=[], shelf_count=0, mint_cost=OTD_MINT_COST["team"], mintable=True,
        ))
    sport, season, fighter_id, name = FIGHTER
    game_days = rng.randint(*FIGHTER_GAME_DAYS)
    rows.append(_pass_row(
        sport=sport, season=season, season_label=_season_label(sport, season), season_state="past",
        player_id=fighter_id, player_name=name, team_id=None, position=None, kind="fighter",
        base_1x=round(game_days * rng.uniform(*FIGHTER_PER_DAY), 1), season_progress=1.0, game_days=game_days,
        game_days_measured=True, month_share=_month_share(rng, sport),
        rate_traded=round(rng.uniform(*FIGHTER_RATE), 1), rate_sales=rng.randint(*FIGHTER_TRADES), shelf=[],
        shelf_count=0, mint_cost=OTD_MINT_COST["fighter"], mintable=True,
    ))
    return rows


def _asks(listings: list[dict]) -> dict[tuple[str, int, int], list[list]]:
    """The cards on sale now by player-season: [rating, ask] of each listing with a target price, Real's own mints
    left out (the demo gives them any rating at a fixed 10 rax)."""
    asks: dict[tuple[str, int, int], list[list]] = {}
    for row in listings:
        if row["target_price"] is not None and not row["minted_by_real"]:
            asks.setdefault((row["sport"], row["season"], row["player_id"]), []).append(
                [row["rating"], row["target_price"]]
            )
    return asks


def _shelf_listing(rng: random.Random, row: dict, number: int, by_market: dict) -> dict:
    """A card of the pass's player-season listed at a few times the traded rate per point, never under what such
    cards sell for, and ending in more than two hours: never a deal, so the deals stay as they were."""
    rarity = rng.choices(list(RARITY_WEIGHTS), list(RARITY_WEIGHTS.values()))[0]
    bucket = rng.choice(RARITY_BUCKETS[rarity])
    rating = round(rng.uniform(*RATING_RANGES[bucket]), 1)
    card = Listing(
        id=810_000 + number, card_id=400_000 + number + 1, sport=row["sport"], season=row["season"],
        player_id=row["player_id"], player_name=row["player_name"],
        card_label=f"{row['player_name']} {row['season']}", rarity=rarity, rating=rating,
        mint=rng.randint(1, MINT_CAPS[rarity]), min_bid=0, current_bid=None, num_bids=0, target_price=None,
        ends_at=EPOCH, created_at=None,
    )
    ask = _round3(rating * row["rate_traded"] * rng.uniform(*PASS_ASK_OVER_RATE))
    ref = reference_for(card, by_market.get(listing_key(card), ()), {}, EPOCH)
    if ref is not None:
        ask = max(ask, _round3(ref.price * PASS_ASK_OVER_REF))
    return {
        "id": card.id, "card_id": card.card_id, "sport": card.sport, "season": card.season,
        "player_id": card.player_id, "player_name": card.player_name, "card_label": card.card_label,
        "rarity": card.rarity, "rating": card.rating, "mint": card.mint,
        "min_bid": max(1, round(ask * rng.uniform(0.6, 0.9))), "current_bid": None, "num_bids": 0,
        "target_price": ask, "ends_in_s": rng.randint(SOON_S + 1, rng.choice(AUCTION_LENGTHS)),
        "created_ago_s": rng.randint(0, LISTED_WITHIN_S), "minted_by_real": False,
    }


def _passes(rng: random.Random, listings: list[dict], sales: list[Sale]) -> tuple[list[dict], list[dict]]:
    """The daily-pay pass markets, and the listings added so that each player pass has a few cards on sale.

    The shelf of a player pass is its player-season's own listings with a target price. A few thinly traded passes
    trade far above the usual rate per point, so none of their rarities pays back, and one player missed his whole
    season; with the fighter, whose estimated limits are below his costs, about a tenth never pay back.
    """
    picked = _pick_player_passes(rng)
    asks = _asks(listings)
    forced = {(sport, season, name) for sport, season, group in TEAMMATES for name in group}
    injured = {(sport, season, name) for sport, season, name in INJURED}

    def name_of(pick: tuple[str, int, int]) -> str:
        return PLAYERS[pick[0]][1][pick[2]][0]

    def shelf_of(pick: tuple[str, int, int]) -> list:
        sport, season, index = pick
        return asks.get((sport, season, PLAYERS[sport][0] + index + 1), [])

    # The dear passes: past seasons with no listing yet, so that their shelves are priced from their dear trades.
    candidates = [
        pick for pick in picked
        if pick[1] != PASS_CURRENT.get(pick[0], (None,))[0] and (pick[0], pick[1], name_of(pick)) not in forced
        and (pick[0], pick[1], name_of(pick)) not in injured and not shelf_of(pick)
    ]
    dear = set(rng.sample(candidates, PASS_DEAR))
    rows = [
        _player_pass(rng, sport, season, index, dear=(sport, season, index) in dear,
                     injured=(sport, season, PLAYERS[sport][1][index][0]) in injured)
        for sport, season, index in picked
    ] + _other_passes(rng)
    rows.sort(key=lambda row: (row["sport"], row["season"], row["kind"], row["player_id"]))

    by_market = index_sales(sales)
    added: list[dict] = []
    for row in rows:
        if row["kind"] != "player":
            continue
        shelf = list(asks.get((row["sport"], row["season"], row["player_id"]), []))
        for _ in range(rng.randint(*PASS_SHELF) - len(shelf)):
            listing = _shelf_listing(rng, row, LISTING_COUNT + len(added), by_market)
            added.append(listing)
            shelf.append([listing["rating"], listing["target_price"]])
        row["shelf"], row["shelf_count"] = shelf, len(shelf)
    return rows, added


def generate(seed: int) -> dict:
    """The fixture as plain data: the lists `listings`, `sales`, `fmv` and `otd` of row dicts."""
    rng = random.Random(seed)
    markets = _markets(rng)
    sales = _sales(rng, markets)
    listings, fmv = _listings(rng, markets, sales)
    passes, shelf_listings = _passes(rng, listings, sales)
    return {
        "listings": listings + shelf_listings,
        "sales": [
            {
                "card_id": s.card_id, "player_id": s.player_id, "player_name": s.player_name, "sport": s.sport,
                "season": s.season, "bucket": s.bucket, "price": s.price,
                "sold_ago_s": int((EPOCH - s.sold_at).total_seconds()),
            }
            for s in sales
        ],
        "fmv": [{"card_id": v.card_id, "median": v.median, "tier": v.tier, "sale_count": v.sale_count} for v in fmv],
        "otd": passes,
    }


def render(data: dict) -> str:
    """The fixture as JSON text, one row per line so a regenerated file diffs cleanly."""
    sections = []
    for name, rows in data.items():
        lines = ",\n".join("  " + json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in rows)
        sections.append(f'"{name}":[\n{lines}\n]')
    return "{\n" + ",\n".join(sections) + "\n}\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="Write the demo dataset.")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--out", type=Path, default=Path("advisor/fixtures/demo_raw.json"))
    args = parser.parse_args()
    data = generate(args.seed)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(render(data), encoding="utf-8")
    print(f"wrote {args.out}: " + ", ".join(f"{len(rows)} {name}" for name, rows in data.items()))


if __name__ == "__main__":
    main()
