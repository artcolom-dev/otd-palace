import importlib.util
import json
import math
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

from advisor.deals import find_deals
from advisor.gone import GoneTracker
from advisor.model import Listing
from advisor.otd import best_rung, rungs
from advisor.rules import OTD_SPORT_MONTHS, REPLAY_TAKE_CHANCE, REPLAY_TARGET_CEILING
from advisor.snapshot import build_snapshot
from advisor.sources.fixture import FixtureSource, ReplaySource, load_fixture
from tests.factories import NOW, make_fmv, make_listing, make_pass, make_raw, make_sale

ROOT = Path(__file__).resolve().parent.parent
DEMO = ROOT / "advisor" / "fixtures" / "demo_raw.json"
MIN_DEALS_PER_LEVEL = 5  # "several": enough that no level of the demo looks empty
SPORTS_BY_SALES_TODAY = ["nba", "nfl", "mlb", "nhl"]  # 160, 85, 38 and 32 sales in the demo's last 24 hours

MINI_FIXTURE = {
    "listings": [
        dict(
            id=1, card_id=100, sport="nba", season=2026, player_id=10, player_name="Test Player",
            card_label="Test Player 2026", rarity=3, rating=4.2, mint=12, min_bid=100, current_bid=150,
            num_bids=2, target_price=300, ends_in_s=3600, created_ago_s=7200,
        ),
        dict(
            id=2, card_id=101, sport="nba", season=2026, player_id=10, player_name="Test Player",
            card_label="Test Player 2026", rarity=3, rating=4.2, mint=None, min_bid=100, current_bid=None,
            num_bids=0, target_price=None, ends_in_s=60, created_ago_s=None, minted_by_real=True,
        ),
    ],
    "sales": [
        dict(
            card_id=100, player_id=10, player_name="Test Player", sport="nba", season=2026, bucket="3-5",
            price=400, sold_ago_s=86400,
        ),
    ],
    "fmv": [dict(card_id=100, median=600, tier="player", sale_count=3)],
    "otd": [
        dict(
            key="nba:2025:player:10", sport="nba", season=2025, season_label="2024-25", season_state="past",
            player_id=10, player_name="Test Player", team_id=1, position="PG", kind="player", base_1x=300.0,
            season_progress=1.0, game_days=80, game_days_measured=True, month_share=[1 / 12] * 12,
            rate_traded=10.0, rate_sales=20, shelf=[[5.0, 100]], shelf_count=1, mint_cost=200, mintable=True,
        ),
    ],
}


def test_fixture_times_are_relative_to_now():
    raw = load_fixture(DEMO, NOW)
    assert all(l.ends_at > NOW for l in raw.listings) and raw.fetched_at == NOW


def test_load_fixture_builds_the_model_from_offsets(tmp_path):
    path = tmp_path / "mini.json"
    path.write_text(json.dumps(MINI_FIXTURE), encoding="utf-8")
    assert load_fixture(path, NOW) == make_raw(
        listings=[
            make_listing(
                id=1, current_bid=150, num_bids=2, target_price=300,
                ends_at=NOW + timedelta(hours=1), created_at=NOW - timedelta(hours=2),
            ),
            make_listing(
                id=2, card_id=101, mint=None, ends_at=NOW + timedelta(minutes=1), created_at=None,
                minted_by_real=True,
            ),
        ],
        sales=[make_sale(sold_at=NOW - timedelta(days=1))],
        fmv={100: make_fmv(card_id=100, median=600, tier="player", sale_count=3)},
        otd=[make_pass(shelf=((5.0, 100),), shelf_count=1)],
    )


def test_a_fixture_source_serves_the_same_world_whenever_it_is_asked():
    source = FixtureSource(DEMO)
    later = NOW + timedelta(days=3)
    first, second = source.fetch(NOW), source.fetch(later)
    assert second.fetched_at == later
    assert [l.ends_at - later for l in second.listings] == [l.ends_at - NOW for l in first.listings]
    assert [l.id for l in second.listings] == [l.id for l in first.listings]


def run_replay(fetches, step=timedelta(seconds=10), seed=7):
    source = ReplaySource(DEMO, seed=seed)
    return [source.fetch(NOW + i * step) for i in range(fetches)]


def test_replay_is_deterministic_and_moves():
    a, b = ReplaySource(DEMO, seed=7), ReplaySource(DEMO, seed=7)
    first = a.fetch(NOW)
    assert first == b.fetch(NOW)
    later = a.fetch(NOW + timedelta(seconds=10))
    assert later != first and all(l.ends_at > NOW + timedelta(seconds=10) for l in later.listings)


def test_replay_repeats_itself_for_a_seed_and_differs_between_seeds():
    assert run_replay(20) == run_replay(20)
    assert run_replay(20)[-1] != run_replay(20, seed=8)[-1]


def test_a_replay_listing_copied_from_a_real_mint_is_listed_by_a_player(tmp_path):
    # The only card the replay can copy is one of Real's own mints; the listings it adds are still a player's.
    mint = {
        **MINI_FIXTURE["listings"][0], "min_bid": 10, "current_bid": None, "num_bids": 0, "target_price": 10,
        "ends_in_s": 86400, "minted_by_real": True,
    }
    path = tmp_path / "mint.json"
    path.write_text(json.dumps({**MINI_FIXTURE, "listings": [mint]}), encoding="utf-8")
    source = ReplaySource(path)
    last = [source.fetch(NOW + i * timedelta(seconds=10)) for i in range(30)][-1]
    added = [l for l in last.listings if l.id != mint["id"]]
    assert added and not any(l.minted_by_real for l in added)
    assert [l.minted_by_real for l in last.listings if l.id == mint["id"]] == [True]


def test_replay_never_serves_an_ended_listing_nor_repeats_an_id():
    step = timedelta(minutes=5)  # long enough steps that most of the first listings end along the way
    for i, raw in enumerate(run_replay(120, step=step)):
        now = NOW + i * step
        assert all(l.ends_at > now for l in raw.listings)
        assert len({l.id for l in raw.listings}) == len(raw.listings)


def test_replay_raises_bids_and_adds_new_listings_some_of_them_deals():
    first, *_, last = run_replay(30)
    before = {l.id: l for l in first.listings}
    after = {l.id: l for l in last.listings}
    raised = [i for i in before.keys() & after.keys() if (after[i].current_bid or 0) > (before[i].current_bid or 0)]
    new = after.keys() - before.keys()
    assert raised and new
    assert {d.listing_id for d in find_deals(last, NOW + timedelta(seconds=290))} & new


def test_only_the_taker_ever_bids_a_target_price_however_long_the_replay_runs():
    # Bidding the target price starts a countdown, so a listing's opening bid and its ordinary bids stay under
    # 0.95 x the target; only the taker bids the target itself, and then the auction ends within 10 minutes.
    # Real lists its own mints with an opening bid equal to their target price; nobody bids on those here.
    taken_at: dict[int, datetime] = {}
    step = timedelta(seconds=10)
    for i, raw in enumerate(run_replay(600, step=step)):  # a hundred minutes of fetches, long enough for bids to climb
        now = NOW + i * step
        for listing in raw.listings:
            if listing.minted_by_real:
                assert (listing.min_bid, listing.target_price, listing.current_bid) == (10, 10, None)
            elif listing.target_price is not None:
                assert listing.min_bid < listing.target_price
                if listing.current_bid == listing.target_price:
                    taken_at.setdefault(listing.id, now)
                    assert listing.ends_at <= taken_at[listing.id] + timedelta(minutes=10)
                else:
                    assert (listing.current_bid or 0) <= math.floor(listing.target_price * REPLAY_TARGET_CEILING)
    assert taken_at


def test_the_taker_bids_the_target_of_a_target_deal_within_200_fetches():
    assert REPLAY_TAKE_CHANCE == 0.15  # the chance, on each fetch, that one target deal is taken
    source = ReplaySource(DEMO)
    step = timedelta(seconds=10)
    before: dict[int, Listing] = {}
    prev_kinds: dict[int, str] = {}
    taken = []
    for i in range(200):
        now = NOW + i * step
        raw = source.fetch(now)
        deal_kinds = {deal.listing_id: deal.kind for deal in find_deals(raw, now)}
        for listing in raw.listings:
            earlier = before.get(listing.id)
            if listing.target_price is not None and listing.current_bid == listing.target_price and (
                earlier is not None and earlier.current_bid != earlier.target_price
            ):
                taken.append(listing.id)
                # It was a target deal the fetch before; it took one more bid, and its auction ends within 10 min.
                assert prev_kinds[listing.id] == "target"
                assert listing.num_bids == earlier.num_bids + 1
                assert listing.ends_at == min(earlier.ends_at, now + timedelta(minutes=10))
                assert deal_kinds.get(listing.id) != "target"
        before = {listing.id: listing for listing in raw.listings}
        prev_kinds = deal_kinds
    assert taken


def test_with_the_tracker_a_taken_target_deal_changes_kind_in_place_and_counts_as_taken():
    source, tracker = ReplaySource(DEMO), GoneTracker()
    kinds, flips, taken, reasons = {}, 0, 0, set()
    for i in range(200):
        now = NOW + i * timedelta(seconds=10)
        raw = source.fetch(now)
        out = tracker.apply(build_snapshot(raw, now, i), raw, now)
        reasons |= {row["reason"] for row in out["gone"]}
        taken = max(taken, out["taken_10m"])
        served = {deal["listing_id"]: deal["kind"] for deal in out["deals"]}
        # The taker bids the target: the listing stays on as a bid deal, the same row of the page changing kind.
        flips += sum(1 for listing, kind in served.items() if kinds.get(listing) == "target" and kind == "bid")
        kinds = served
        assert not set(served) & {row["listing_id"] for row in out["gone"]}
    assert flips >= 1 and taken >= 1
    assert "countdown_started" not in reasons  # it only shows when the listing is no deal at all any more
    assert {"ended", "outbid"} <= reasons


def demo_snapshot():
    return build_snapshot(load_fixture(DEMO, NOW), NOW, 1)


def shown_by_level(snapshot) -> dict[str, list[dict]]:
    """The deals each level shows a new visitor, as filterDeals does: its default budget, every sport."""
    return {
        name: [
            d for d in snapshot["deals"]
            if d["kind"] in level["kinds"] and d["confidence"] in level["confidence"]
            and d["discount"] >= level["min_discount"]
            and (level["default_budget"] is None or d["price"] <= level["default_budget"])
            and (d["kind"] != "bid" or ends_in_s(d) <= level["bid_max_left_min"] * 60)
            and not (level["hide_falling"] and d["falling"])
        ]
        for name, level in snapshot["levels"].items()
    }


def ends_in_s(deal: dict) -> float:
    return (datetime.strptime(deal["ends_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) - NOW).total_seconds()


def test_every_level_of_the_demo_shows_several_deals():
    shown = shown_by_level(demo_snapshot())
    assert {name: len(deals) >= MIN_DEALS_PER_LEVEL for name, deals in shown.items()} == dict.fromkeys(shown, True), {
        name: len(deals) for name, deals in shown.items()
    }


def test_the_demo_has_risers_fallers_and_passes_for_every_sport():
    raw = load_fixture(DEMO, NOW)
    snapshot = build_snapshot(raw, NOW, 1)
    assert snapshot["sports"] == SPORTS_BY_SALES_TODAY
    assert len(snapshot["moves"]["risers"]) >= 3 and len(snapshot["moves"]["fallers"]) >= 3
    assert all(abs(m["change"]) >= 0.20 for m in snapshot["moves"]["risers"] + snapshot["moves"]["fallers"])
    assert all(len(snapshot["otd"]["picks"][sport]) >= 3 for sport in snapshot["sports"])


def test_demo_fixture_properties():
    raw = load_fixture(DEMO, NOW)
    snapshot = build_snapshot(raw, NOW, 1)
    otd, markets = snapshot["otd"], raw.otd

    # About sixty passes: the four sports with listings and one fighter, every ladder present, keys unique.
    assert 55 <= len(markets) <= 65 and len({m.key for m in markets}) == len(markets)
    assert {m.sport for m in markets} == set(snapshot["sports"]) | {"ufc"}
    kinds = Counter(m.kind for m in markets)
    assert (kinds["team"], kinds["fighter"], kinds["player"]) == (2, 1, len(markets) - 3)

    # Some seasons are still being played and say how far along they are; the others are final.
    current = [m for m in markets if m.season_state == "current"]
    assert len(current) >= 5 and all(0 < m.season_progress < 1 and not m.game_days_measured for m in current)
    assert all(m.season_progress == 1.0 for m in markets if m.season_state == "past")

    # Each season pays only in its sport's months, and its shares add up to one.
    for m in markets:
        months = set(OTD_SPORT_MONTHS[m.sport])
        assert len(m.month_share) == 12 and abs(sum(m.month_share) - 1) < 1e-9
        assert all(share == 0 for month, share in enumerate(m.month_share, 1) if month not in months)
        assert all(share > 0 for month, share in enumerate(m.month_share, 1) if month in months)

    # Cards trade at 5 to 20 rax a rating point, except a few dear, thin tapes; team cards have no rate.
    rates = [m.rate_traded for m in markets if m.kind == "player"]
    assert sum(5 <= rate <= 20 for rate in rates) / len(rates) >= 0.85
    assert all(m.rate_traded is None and m.shelf_count == 0 for m in markets if m.kind == "team")

    # Two teammates' passes of one season in every sport with listings: they pay on the same days.
    for sport in snapshot["sports"]:
        teams = Counter((m.season, m.team_id) for m in markets if m.sport == sport and m.kind == "player")
        assert max(teams.values()) >= 2, sport

    # Every player pass has a few cards on sale, and they are the demo's own listings of that player-season.
    asks: dict[tuple, list] = {}
    for listing in raw.listings:
        if listing.target_price is not None and not listing.minted_by_real:
            asks.setdefault((listing.sport, listing.season, listing.player_id), []).append(
                (listing.rating, listing.target_price)
            )
    for m in markets:
        if m.kind == "player":
            assert 2 <= m.shelf_count == len(m.shelf), m.key
            assert sorted(m.shelf) == sorted(asks[(m.sport, m.season, m.player_id)]), m.key

    # A few never pay back at any rarity: a season that earned nothing, and the dear, thin tapes, now that a past
    # season's General (the mint alone) pays nothing. None of those that never pay back is picked or a starter.
    today = NOW.date()
    never = {m.key for m in markets if m.kind != "team" and best_rung(rungs(m, today=today)) is None}
    dear = [m for m in markets if m.kind == "player" and m.rate_traded > 20]
    assert dear and {m.key for m in dear} <= never
    assert all(m.base_1x == 0 or m.key in {d.key for d in dear} for m in markets if m.key in never)
    assert not never & {key for keys in otd["picks"].values() for key in keys}
    assert not never & set(otd["starters"].values())
    assert set(otd["starters"]) == set(snapshot["sports"]) | {"ufc"}  # the fighter pays back under Real's limits
    # The demo's seasons being played (projections) are served apart, for Deals only: no pick and no starter is one.
    served = {market["key"]: market for market in otd["markets"]}
    current = {market["key"] for market in otd["current_markets"]}
    assert current and all(otd_m["season_state"] == "current" for otd_m in otd["current_markets"])
    assert any(market["rungs"] and market["rungs"][0]["projected"] for market in otd["current_markets"])
    suggested = {key for keys in otd["picks"].values() for key in keys} | set(otd["starters"].values())
    assert suggested <= set(served) and not suggested & current
    assert not any(served[key]["rungs"][0]["projected"] for key in suggested)


def test_the_committed_demo_is_what_the_generator_makes():
    spec = importlib.util.spec_from_file_location("make_fixture", ROOT / "scripts" / "make_fixture.py")
    generator = importlib.util.module_from_spec(spec)
    sys.modules["make_fixture"] = generator
    try:
        spec.loader.exec_module(generator)
    finally:
        del sys.modules["make_fixture"]
    assert generator.render(generator.generate(seed=7)) == DEMO.read_text(encoding="utf-8")


def test_the_demo_follows_the_market_evidence():
    data = json.loads(DEMO.read_text(encoding="utf-8"))
    raw = load_fixture(DEMO, NOW)
    snapshot = build_snapshot(raw, NOW, 1)

    # About a fifth of the listings are Real's own mints at 10 rax, and none of them is a deal.
    minted = [l for l in raw.listings if l.minted_by_real]
    assert 0.15 <= len(minted) / len(raw.listings) <= 0.25
    assert all((l.target_price, l.min_bid, l.current_bid) == (10, 10, None) for l in minted)
    assert not {l.id for l in minted} & {d["listing_id"] for d in snapshot["deals"]}

    # Listings were put up over the last two hours.
    ages = [row["created_ago_s"] for row in data["listings"]]
    assert min(ages) >= 0 and max(ages) <= 7200 and max(ages) - min(ages) >= 6000

    # Some markets fell hard today, and some deals sit in them.
    assert sum(d["falling"] for d in snapshot["deals"]) >= 2
    assert len(snapshot["moves"]["fallers"]) >= 3 and len(snapshot["moves"]["risers"]) >= 3

    # Ordinary cards sell for 20 to 200 rax; a few star cards go above 1,000.
    prices = [sale.price for sale in raw.sales]
    assert sum(20 <= p <= 200 for p in prices) / len(prices) >= 0.6
    assert 1 <= sum(p > 1000 for p in prices) <= 0.1 * len(prices)
