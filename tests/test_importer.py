"""Importing a visitor's passes from their Real username through the private feed."""

import json

from advisor.importer import PassImporter, valid_username
from advisor.sources.feed import FeedError

TOKEN = "k3y-" + "9f2c61d7a0b84e35" * 3


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def producer(answers, seen):
    def get(url, headers):
        seen.append((url, headers))
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return json.dumps(answer).encode()
    return get


def test_a_username_is_checked_before_anything_is_asked():
    assert valid_username(" @shaedon ") == "shaedon"
    assert valid_username("ab") == "ab"
    for bad in ("a", "has space", "x" * 31, "semi;colon", None, 5, "../etc"):
        assert valid_username(bad) is None, bad


def test_it_asks_the_producer_with_the_token_and_keeps_only_what_the_page_needs():
    seen = []
    rows = [
        {"key": "nba:2026:player:1627", "rating": 88.5, "tier": None, "spent": False, "userId": "secret"},
        {"key": "ufc:2023:fighter:42", "rating": None, "tier": "Rare", "spent": True},
        {"key": "nba:2026:player:1627", "rating": 1.0},  # the same pass again
        {"key": "bad key", "rating": 3},
        {"key": "nfl:2025:player:9"},  # neither a rating nor a tier
    ]
    importer = PassImporter("https://feed.test/internal/market-feed/", TOKEN,
                            get=producer([{"username": "Shaedon", "passes": rows, "truncated": False}], seen))
    found = importer.lookup("shaedon")
    assert seen[0][0] == "https://feed.test/internal/market-feed/passes?username=shaedon"
    assert seen[0][1]["Authorization"] == f"Bearer {TOKEN}"
    assert found.json() == {"status": "ok", "username": "Shaedon", "truncated": False, "passes": [
        {"key": "nba:2026:player:1627", "rating": 88.5},
        {"key": "ufc:2023:fighter:42", "tier": "rare", "spent": True},
    ], "markets": [], "waiting": 0, "seasons_waiting": 0}
    assert TOKEN not in repr(importer)


def test_unknown_private_and_busy_answers():
    seen = []
    importer = PassImporter("https://feed.test/f", TOKEN, get=producer([
        FeedError("the feed answered 404"), FeedError("the feed answered 422"), FeedError("the feed answered 429"),
        {"username": "x", "passes": []}, b"not json",
    ], seen))
    assert importer.lookup("nobody").status == "not_found"
    assert importer.lookup("closed").status == "private"
    assert importer.lookup("later").status == "busy"
    assert importer.lookup("empty").status == "private"


def test_answers_are_kept_ten_minutes_and_a_busy_one_is_not_kept():
    seen, clock = [], Clock()
    importer = PassImporter("https://feed.test/f", TOKEN, clock=clock, get=producer([
        {"username": "a1", "passes": [{"key": "nba:2026:player:1", "rating": 5}]},
        FeedError("the feed answered 503"),
        {"username": "b1", "passes": [{"key": "nba:2026:player:2", "rating": 5}]},
        {"username": "a1", "passes": [{"key": "nba:2026:player:1", "rating": 6}]},
    ], seen))
    assert importer.lookup("a1").passes[0]["rating"] == 5
    assert importer.lookup("A1").passes[0]["rating"] == 5  # same name, any case: no new request
    assert len(seen) == 1
    assert importer.lookup("b1").status == "busy"
    assert importer.lookup("b1").status == "ok"  # busy was not kept
    clock.t += 601
    assert importer.lookup("a1").passes[0]["rating"] == 6


def test_the_whole_site_asks_at_most_so_many_an_hour():
    seen, clock = [], Clock()
    answers = [{"username": f"u{i}", "passes": [{"key": "nba:2026:player:1", "rating": 1}]} for i in range(4)]
    importer = PassImporter("https://feed.test/f", TOKEN, clock=clock, per_hour=3, get=producer(answers, seen))
    assert [importer.lookup(f"u{i}").status for i in range(4)] == ["ok", "ok", "ok", "busy"]
    clock.t += 3601
    assert importer.lookup("u3").status == "ok"


def test_a_lookup_the_producer_turned_away_spends_nothing_from_the_hour():
    seen, clock = [], Clock()
    ok = [{"username": f"u{i}", "passes": [{"key": "nba:2026:player:1", "rating": 1}]} for i in range(3)]
    # The producer cannot look for a while (429, 503: nothing read) while visitors keep trying ...
    refused = [FeedError("the feed answered 503"), FeedError("the feed answered 429")] * 2
    importer = PassImporter("https://feed.test/f", TOKEN, clock=clock, per_hour=3, get=producer(refused + ok, seen))
    assert [importer.lookup(f"x{i}").status for i in range(4)] == ["busy"] * 4
    # ... then it is back: the hour's lookups are all still there, not used up by answers that cost it no read.
    clock.t += 60
    assert [importer.lookup(f"u{i}").status for i in range(3)] == ["ok", "ok", "ok"]
    assert len(seen) == 7


def test_every_pass_of_a_big_account_comes_back_up_to_the_producers_bound():
    seen = []
    rows = [{"key": f"nba:2026:player:{i}", "rating": i} for i in range(1576)]
    found = PassImporter("https://feed.test/f", TOKEN, get=producer([{"username": "big", "passes": rows}], seen)).lookup("big")
    assert len(found.passes) == 1576 and not found.truncated
    rows = [{"key": f"nba:2026:player:{i}", "rating": i} for i in range(5100)]
    found = PassImporter("https://feed.test/f", TOKEN, get=producer([{"username": "big", "passes": rows}], seen)).lookup("big")
    assert len(found.passes) == 5000 and found.truncated


def test_the_default_transport_waits_as_long_as_a_lookup_can_take(monkeypatch):
    """A lookup waits up to 25 s for a free account on the producer: the 5 s of the market feed would always give up."""
    from advisor import importer
    from advisor.rules import IMPORT_TIMEOUT_S

    seen = []
    monkeypatch.setattr(importer, "_http_get", lambda url, headers, timeout, max_bytes: seen.append(timeout) or b'{"passes": []}')
    PassImporter("https://feed.test/f", TOKEN).lookup("someone")
    assert seen == [IMPORT_TIMEOUT_S] and IMPORT_TIMEOUT_S >= 30


def test_cached_answers_only_what_is_kept_and_fresh():
    seen, clock = [], Clock()
    importer = PassImporter("https://feed.test/f", TOKEN, clock=clock, get=producer(
        [{"username": "a1", "passes": [{"key": "nba:2026:player:1", "rating": 5}]}], seen))
    assert importer.cached("a1") is None
    importer.lookup("a1")
    assert importer.cached("A1").status == "ok"
    clock.t += 601
    assert importer.cached("a1") is None


# ── every pass valued: the account's own markets ──────────────────────────────

def _row(key="nba:2026:player:7", base=300.0, **over):
    """A pass row as the producer sends it (the feed's otd shape), valued from a ranking only."""
    sport, season, kind, pid = key.split(":")
    row = {"key": key, "sport": sport, "season": int(season), "season_label": season, "season_state": "past",
           "player_id": int(pid), "player_name": "Seven", "team_id": None, "position": None, "kind": kind,
           "base_1x": base, "season_progress": 1.0, "game_days": 70, "game_days_measured": False,
           "month_share": [0.0] * 12, "rate_traded": None, "rate_sales": 0, "shelf": [], "shelf_count": 0,
           "mint_cost": 200, "mintable": True}
    row.update(over)
    return row


def test_the_accounts_valued_passes_come_back_as_the_snapshot_sends_markets():
    seen = []
    passes = [{"key": "nba:2026:player:7", "rating": 12}, {"key": "nba:2024:team:3", "tier": "rare"}]
    markets = [_row(), _row("nba:2024:team:3", base=0.0, player_name=""),
               _row("nba:2026:player:999"),                          # not one of the account's passes
               _row("nba:2026:player:7", base=1.0),                  # the same pass again: the first stays
               {**_row("nba:2026:player:8"), "secret": 1},           # a field the model does not have
               _row("nba:2026:player:9", game_days="many")]          # a row that does not fit
    passes += [{"key": "nba:2026:player:8", "rating": 3}, {"key": "nba:2026:player:9", "rating": 3}]
    found = PassImporter("https://feed.test/f", TOKEN, get=producer(
        [{"username": "Big", "passes": passes, "markets": markets, "waiting": 4, "seasons_waiting": 2}], seen)).lookup("big")
    by_key = {m["key"]: m for m in found.markets}
    assert set(by_key) == {"nba:2026:player:7", "nba:2024:team:3"}
    assert by_key["nba:2026:player:7"]["base_1x"] == 300.0 and by_key["nba:2026:player:7"]["rungs"]
    assert by_key["nba:2024:team:3"]["base_1x"] == 0.0                # earns nothing: still valued
    assert found.waiting == 4 and found.seasons_waiting == 2
    for bad in (-1, "3", True, 10**9):
        got = PassImporter("https://feed.test/f", TOKEN, get=producer(
            [{"username": "Big", "passes": passes, "waiting": bad}], [])).lookup("big")
        assert got.waiting == 0


def test_an_accounts_pass_row_with_the_feeds_new_fields_is_valued_not_dropped():
    from tests.pass_scenes import extra

    passes = [{"key": "nba:2026:player:7", "rating": 12}]
    row = {**_row(rate_traded=38.46, rate_sales=100), **extra("wemby")}
    found = PassImporter("https://feed.test/f", TOKEN, get=producer(
        [{"username": "Big", "passes": passes, "markets": [row]}], [])).lookup("big")
    assert [m["key"] for m in found.markets] == ["nba:2026:player:7"]
    assert found.markets[0]["rate_build"] == 30.36


def test_an_answer_still_waiting_is_kept_briefly_and_the_pages_next_asks_are_free():
    clock, seen = Clock(), []
    waiting = {"username": "Big", "passes": [{"key": "nba:2026:player:7", "rating": 12}], "waiting": 1}
    done = {**waiting, "waiting": 0, "markets": [_row()]}
    importer = PassImporter("https://feed.test/f", TOKEN, get=producer([waiting, waiting, done], seen),
                            clock=clock, per_hour=1)
    assert importer.lookup("big").waiting == 1 and not importer.follow_up("other")
    assert importer.follow_up("BIG") and importer.cached("big") is not None
    clock.t += 16                                                       # past IMPORT_PENDING_CACHE_S
    assert importer.cached("big") is None
    assert importer.lookup("big").waiting == 1                         # asked again, though the hour's 1 is spent
    clock.t += 16
    found = importer.lookup("big")
    assert found.waiting == 0 and len(found.markets) == 1 and len(seen) == 3
    assert not importer.follow_up("big")                               # valued: back to the normal rules
    clock.t += 16
    assert importer.cached("big") is found                             # and kept the usual 10 minutes


# --- many visitors at once --------------------------------------------------------------------------------------

import threading  # noqa: E402

from advisor.importer import Imported  # noqa: E402


class Held:
    """A producer that keeps every ask waiting until `release` is set, counting the asks."""

    def __init__(self, answer):
        self.answer, self.release, self.asked = answer, threading.Event(), []
        self.arrived = threading.Semaphore(0)

    def __call__(self, url, headers):
        self.asked.append(url)
        self.arrived.release()
        assert self.release.wait(5)
        return json.dumps(self.answer).encode()


def _in_thread(fn, *args):
    out = {}
    thread = threading.Thread(target=lambda: out.setdefault("value", fn(*args)), daemon=True)
    thread.start()
    return thread, out


def test_asks_for_one_name_at_once_share_a_single_lookup():
    held = Held({"username": "Big", "passes": [{"key": "nba:2026:player:1", "rating": 5.0}]})
    importer = PassImporter("https://feed.test/f", TOKEN, get=held, per_hour=5)
    first, got_first = _in_thread(importer.lookup, "Big")
    assert held.arrived.acquire(timeout=5)
    others = [_in_thread(importer.lookup, name) for name in ("big", "BIG", "big")]
    held.release.set()
    for thread, _ in [(first, got_first), *others]:
        thread.join(5)
    answers = [got_first["value"], *(out["value"] for _, out in others)]
    assert all(answer.status == "ok" and answer.username == "Big" for answer in answers)
    assert len(held.asked) == 1  # one call to the producer, the others waited for its answer


def test_only_a_few_asks_wait_on_lookups_already_out_so_threads_stay_free():
    import time

    from advisor.rules import IMPORT_MAX_WAITERS

    held = Held({"username": "Big", "passes": [{"key": "nba:2026:player:1", "rating": 5.0}]})
    importer = PassImporter("https://feed.test/f", TOKEN, get=held, per_hour=5)
    first = _in_thread(importer.lookup, "Big")
    assert held.arrived.acquire(timeout=5)
    waiting = [_in_thread(importer.lookup, "big") for _ in range(IMPORT_MAX_WAITERS)]
    deadline = time.monotonic() + 5
    while sum(f.waiters for f in importer._in_flight.values()) < IMPORT_MAX_WAITERS and time.monotonic() < deadline:
        time.sleep(0.01)
    refused = importer.lookup("BIG")
    assert refused.status == "busy" and refused.retry_after > 0
    held.release.set()
    for thread, out in [first, *waiting]:
        thread.join(5)
        assert out["value"].status == "ok"
    assert len(held.asked) == 1


def test_at_most_two_lookups_leave_at_once_and_the_third_is_told_when_to_come_back():
    held = Held({"username": "x", "passes": [{"key": "nba:2026:player:1", "rating": 5.0}]})
    importer = PassImporter("https://feed.test/f", TOKEN, get=held, per_hour=3)
    running = [_in_thread(importer.lookup, name) for name in ("aa", "bb")]
    assert held.arrived.acquire(timeout=5) and held.arrived.acquire(timeout=5)
    refused = importer.lookup("cc")
    assert refused.status == "busy" and refused.retry_after > 0
    assert len(held.asked) == 2
    held.release.set()
    for thread, _ in running:
        thread.join(5)
    # The refusal spent nothing from the hour: the third lookup of the hour still goes out, the fourth does not.
    assert importer.lookup("cc").status == "ok"
    assert importer.lookup("dd").status == "busy"


def test_a_lookup_that_fails_frees_its_place():
    importer = PassImporter("https://feed.test/f", TOKEN, get=producer([FeedError("x")] * 3 + [
        {"username": "x", "passes": [{"key": "nba:2026:player:1", "rating": 5.0}]}], []))
    assert [importer.lookup(f"n{i}").status for i in range(3)] == ["busy"] * 3
    assert importer.lookup("n9").status == "ok"


def test_the_hours_budget_says_when_a_lookup_frees_up():
    clock = Clock()
    importer = PassImporter("https://feed.test/f", TOKEN, clock=clock, per_hour=1, get=producer(
        [{"username": "x", "passes": [{"key": "nba:2026:player:1", "rating": 5.0}]}], []))
    importer.lookup("aa")
    clock.t += 600
    refused = importer.lookup("bb")
    assert refused.status == "busy" and refused.retry_after == 3000
    assert Imported("busy") == Imported("busy", retry_after=9)  # the hint is no part of the answer itself


def _one(row):
    importer = PassImporter("https://feed.test/f", TOKEN, get=producer([{"username": "x1", "passes": [row]}], []))
    return importer.lookup("x1").passes


def test_reals_own_rung_cap_and_earnings_come_through_checked():
    row = {"key": "nba:2026:player:7", "rating": 61.0, "level": 3, "rarity": "Rare", "label": "Rare 1\x07",
           "mult": 4, "cap": 1250.5, "earned": 749.5, "spent": False}
    assert _one(row) == ({"key": "nba:2026:player:7", "rating": 61.0, "level": 3, "rarity": "rare",
                          "label": "Rare 1", "mult": 4.0, "cap": 1250.5, "earned": 749.5},)


def test_a_pass_that_can_earn_nothing_more_keeps_its_cap_of_zero():
    assert _one({"key": "nfl:2024:player:9", "rating": 12, "rarity": "common", "cap": 0, "earned": 1000}) == (
        {"key": "nfl:2024:player:9", "rating": 12.0, "rarity": "common", "cap": 0.0, "earned": 1000.0},)


def test_the_older_shape_still_reads_as_before():
    assert _one({"key": "nhl:2025:player:3", "rating": 33.3}) == ({"key": "nhl:2025:player:3", "rating": 33.3},)


def test_reals_rung_alone_is_enough_and_bad_values_are_left_out_one_by_one():
    assert _one({"key": "mlb:2025:player:4", "rarity": "epic", "label": None, "mult": None, "cap": None}) == (
        {"key": "mlb:2025:player:4", "rarity": "epic"},)
    bad = {"key": "mlb:2025:player:5", "rating": 5, "level": True, "rarity": "shiny", "label": "x" * 200,
           "mult": float("inf"), "cap": -1, "earned": "lots"}
    out = _one(bad)[0]
    assert out["key"] == "mlb:2025:player:5" and out["rating"] == 5.0
    assert set(out) <= {"key", "rating", "label"} and len(out.get("label", "")) <= 24
    assert _one({"key": "mlb:2025:player:6", "level": 10**9, "mult": 0, "cap": 1e12})[0:1] == ()


def test_the_sample_data_links_a_sample_account_built_from_its_own_passes():
    from advisor.importer import DemoImporter
    from advisor.store import SnapshotStore

    store = SnapshotStore()
    demo = DemoImporter(store)
    assert demo.lookup("anyone").status == "busy"  # no snapshot yet
    markets = [{"key": f"nba:2025:player:{i}", "kind": "player"} for i in range(40)]
    markets += [{"key": "nba:2025:team:1", "kind": "team"}]
    store.publish({"version": 1, "otd": {"markets": markets}})
    found = demo.lookup("Shaedon")
    assert found.status == "ok" and found.username == "Shaedon" and found.markets == ()
    assert 8 <= len(found.passes) <= 24 and all(":player:" in p["key"] for p in found.passes)
    assert all({"key", "rating", "rarity", "mult", "cap", "earned", "label"} <= set(p) for p in found.passes)
    assert any(p["cap"] == 0 for p in found.passes)  # one maxed pass at least, as real accounts have
    assert demo.lookup("shaedon").passes == found.passes  # the same name, the same account
    assert demo.lookup("other_one").passes != found.passes
    assert demo.cached("x") is None and demo.follow_up("x") is False
