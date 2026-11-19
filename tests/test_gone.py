import copy
from dataclasses import replace
from datetime import timedelta
from pathlib import Path

from advisor.gone import GoneTracker
from advisor.rules import GONE_KEEP_S, TAKEN_WINDOW_S
from advisor.snapshot import build_snapshot
from advisor.sources.fixture import ReplaySource
from tests.factories import DEAL_KEYS, NOW, five_sales, make_listing, make_raw

# Five sales put the reference at 420, high confidence: a target price of 300 is a deal (28.6 % under).
LATER = NOW + timedelta(hours=5)  # ends past the bid window, so only its target price can make it a deal


def target(listing_id: int, **kw):
    """A target-price deal at 300 with no bid yet, ending in five hours."""
    return make_listing(**{"id": listing_id, "target_price": 300, "ends_at": LATER, **kw})


def bid(listing_id: int, **kw):
    """A bid deal: no target price, an opening bid of 300 and an auction ending within the hour."""
    return make_listing(**{"id": listing_id, "min_bid": 300, **kw})


def run(tracker: GoneTracker, listings, at, sales=None):
    """One collector round: the snapshot of these listings at `at`, through the tracker."""
    raw = make_raw(listings=listings, sales=five_sales() if sales is None else sales)
    return tracker.apply(build_snapshot(raw, at, 1), raw, at)


def ids(rows):
    return [row["listing_id"] for row in rows]


def test_rules_values():
    assert (GONE_KEEP_S, TAKEN_WINDOW_S) == (45, 600)


def test_first_round_has_no_gone():
    raw = make_raw(listings=[target(1)], sales=five_sales())
    snap = build_snapshot(raw, NOW, 1)
    out = GoneTracker().apply(snap, raw, NOW)
    assert out == {**snap, "gone": [], "taken_10m": 0}


def test_missing_listing_is_ended():
    tracker = GoneTracker()
    first = run(tracker, [target(1), target(2)], NOW)
    out = run(tracker, [target(2)], NOW + timedelta(seconds=10))
    [row] = out["gone"]
    # The row is last round's deal exactly as it was served, plus why and when it went.
    assert set(row) == DEAL_KEYS | {"reason", "gone_at"}
    assert {k: v for k, v in row.items() if k not in ("reason", "gone_at")} == first["deals"][0]
    assert (row["listing_id"], row["reason"], row["gone_at"]) == (1, "ended", "2026-11-12T18:00:10Z")
    assert ids(out["deals"]) == [2]


def test_listing_still_listed_past_its_end_is_ended():
    tracker = GoneTracker()
    run(tracker, [target(1, ends_at=NOW + timedelta(seconds=30))], NOW)
    out = run(tracker, [target(1, ends_at=NOW + timedelta(seconds=30))], NOW + timedelta(seconds=30))
    assert [(row["listing_id"], row["reason"]) for row in out["gone"]] == [(1, "ended")]


def test_target_deal_that_got_a_bid_is_countdown_started():
    tracker = GoneTracker()
    run(tracker, [target(1)], NOW)
    # Someone bid the target: the listing has a bid and no target price any more. The bid comes first,
    # so the reason is the countdown, not the price that moved.
    taken = replace(target(1), num_bids=1, current_bid=300, target_price=None)
    out = run(tracker, [taken], NOW + timedelta(seconds=10))
    assert [(row["listing_id"], row["reason"]) for row in out["gone"]] == [(1, "countdown_started")]


def test_a_target_deal_taken_while_the_listing_stays_a_bid_deal_is_taken_but_not_gone():
    tracker = GoneTracker()
    # A target deal that already had a bid under its target.
    run(tracker, [target(1, current_bid=250, num_bids=2)], NOW)
    # Someone bid the target: 10 minutes left, and the bid to beat is still a deal, so the listing stays as a bid
    # deal. The same listing is never both a deal and a gone row: the deal changed kind in place, so the page has one
    # row for it. The someone who took the target still counts as taken.
    taken = target(1, current_bid=300, num_bids=3, ends_at=NOW + timedelta(minutes=10))
    out = run(tracker, [taken], NOW + timedelta(seconds=10))
    assert [(deal["listing_id"], deal["kind"]) for deal in out["deals"]] == [(1, "bid")]
    assert out["gone"] == []
    assert out["taken_10m"] == 1
    later = run(tracker, [taken], NOW + timedelta(seconds=20))
    assert later["gone"] == [] and later["taken_10m"] == 1


def test_a_card_taken_at_its_target_then_won_at_the_end_counts_as_taken_once():
    tracker = GoneTracker()
    run(tracker, [target(1, current_bid=250, num_bids=2)], NOW)
    # Someone bid the target: taken. The listing stays on as a bid deal, its 10-minute countdown running ...
    taken = target(1, current_bid=300, num_bids=3, ends_at=NOW + timedelta(minutes=10))
    assert run(tracker, [taken], NOW + timedelta(seconds=10))["taken_10m"] == 1
    # ... and the auction ends: the same card, taken by the same countdown, is not a second deal taken.
    out = run(tracker, [], NOW + timedelta(minutes=10, seconds=5))
    assert [(row["listing_id"], row["reason"]) for row in out["gone"]] == [(1, "ended")]
    assert out["taken_10m"] == 1


def test_a_gone_row_is_dropped_when_its_listing_becomes_a_deal_again():
    tracker = GoneTracker()
    run(tracker, [target(1)], NOW)
    # The listing stops being a deal (its target price moved up out of reach) ...
    out = run(tracker, [target(1, target_price=400)], NOW + timedelta(seconds=10))
    assert [(row["listing_id"], row["reason"]) for row in out["gone"]] == [(1, "price_moved")]
    # ... and 10 s later it is one again, of the other kind: the page shows the deal, not its old gone row too.
    back = run(tracker, [bid(1, target_price=400)], NOW + timedelta(seconds=20))
    assert ids(back["deals"]) == [1] and back["gone"] == []


def test_the_replay_never_serves_a_listing_as_a_deal_and_as_gone_in_one_snapshot():
    source = ReplaySource(Path(__file__).resolve().parent.parent / "advisor" / "fixtures" / "demo_raw.json")
    tracker = GoneTracker()
    taken = 0
    for step in range(300):  # the seeded demo market, a second at a time: someone takes a target deal now and then
        at = NOW + timedelta(seconds=step)
        raw = source.fetch(at)
        out = tracker.apply(build_snapshot(raw, at, step + 1, demo=True), raw, at)
        live, gone = set(ids(out["deals"])), set(ids(out["gone"]))
        assert not live & gone, f"step {step}: {sorted(live & gone)} is a deal and gone"
        taken = max(taken, out["taken_10m"])
    assert taken >= 1, "the run never saw a target deal taken, so it proved nothing"


def test_a_target_lowered_then_bid_is_countdown_started():
    tracker = GoneTracker()
    run(tracker, [target(1)], NOW)
    # The seller lowered the target to 280 and someone bid it at once: the countdown, not the price, is the news.
    out = run(tracker, [target(1, target_price=280, current_bid=280, num_bids=1)], NOW + timedelta(seconds=10))
    assert [(row["listing_id"], row["reason"]) for row in out["gone"]] == [(1, "countdown_started")]


def test_a_first_bid_under_the_target_is_not_the_countdown():
    tracker = GoneTracker()
    run(tracker, [target(1)], NOW)
    # A bid under the target, and the target price moved up out of reach in the same round.
    out = run(tracker, [target(1, current_bid=200, num_bids=1, target_price=400)], NOW + timedelta(seconds=10))
    assert [(row["listing_id"], row["reason"]) for row in out["gone"]] == [(1, "price_moved")]


def test_bid_deal_outbid():
    tracker = GoneTracker()
    [deal] = run(tracker, [bid(1)], NOW)["deals"]
    assert (deal["kind"], deal["price"]) == ("bid", 300)
    out = run(tracker, [bid(1, current_bid=380, num_bids=1)], NOW + timedelta(seconds=10))
    assert [(row["listing_id"], row["reason"]) for row in out["gone"]] == [(1, "outbid")]


def test_price_moved():
    tracker = GoneTracker()
    run(tracker, [target(1)], NOW)
    out = run(tracker, [target(1, target_price=400)], NOW + timedelta(seconds=10))
    assert [(row["listing_id"], row["reason"]) for row in out["gone"]] == [(1, "price_moved")]


def test_anything_else_is_no_longer_a_deal():
    tracker = GoneTracker()
    run(tracker, [target(1)], NOW)
    # Same listing, but the market it is judged against fell: 300 is no longer far enough under it.
    out = run(tracker, [target(1)], NOW + timedelta(seconds=10), sales=five_sales((330, 340, 350, 360, 370)))
    assert [(row["listing_id"], row["reason"]) for row in out["gone"]] == [(1, "no_longer_a_deal")]
    assert out["taken_10m"] == 0


def test_a_deal_left_out_only_by_the_per_player_cap_is_not_gone():
    tracker = GoneTracker()
    # Three deals of one player fill his MAX_DEALS_PER_PLAYER places ...
    run(tracker, [target(1, target_price=300), target(2, target_price=310), target(3, target_price=320)], NOW)
    # ... then a better fourth one comes: 320 is still on sale, unchanged and still a deal, only left out of the list.
    out = run(
        tracker,
        [target(1, target_price=300), target(2, target_price=310), target(3, target_price=320), target(4, target_price=250)],
        NOW + timedelta(seconds=10),
    )
    assert sorted(ids(out["deals"])) == [1, 2, 4]
    # Nothing about it went: no "No longer a deal" row on the page, no "This deal has gone" on its shared link.
    assert out["gone"] == [] and out["taken_10m"] == 0


def test_a_deal_left_out_by_the_cap_that_also_stopped_being_a_deal_is_gone():
    tracker = GoneTracker()
    run(tracker, [target(1, target_price=300), target(2, target_price=310), target(3, target_price=320)], NOW)
    # The market fell: 320 is no longer far enough under the usual price, whatever the cap.
    out = run(
        tracker,
        [target(1, target_price=300), target(2, target_price=310), target(3, target_price=320), target(4, target_price=250)],
        NOW + timedelta(seconds=10),
        sales=five_sales((370, 380, 390, 400, 410)),
    )
    assert [(row["listing_id"], row["reason"]) for row in out["gone"]] == [(3, "no_longer_a_deal")]


def test_gone_row_expires_after_45s():
    tracker = GoneTracker()
    run(tracker, [target(1)], NOW)
    went = NOW + timedelta(seconds=10)
    assert ids(run(tracker, [], went)["gone"]) == [1]
    assert ids(run(tracker, [], went + timedelta(seconds=GONE_KEEP_S - 1))["gone"]) == [1]
    assert run(tracker, [], went + timedelta(seconds=GONE_KEEP_S))["gone"] == []


def test_gone_is_newest_first():
    tracker = GoneTracker()
    run(tracker, [target(1), target(2), target(3)], NOW)
    run(tracker, [target(2), target(3)], NOW + timedelta(seconds=10))
    out = run(tracker, [target(3)], NOW + timedelta(seconds=20))
    assert ids(out["gone"]) == [2, 1]
    assert [row["gone_at"] for row in out["gone"]] == ["2026-11-12T18:00:20Z", "2026-11-12T18:00:10Z"]


def test_returning_deal_leaves_gone():
    tracker = GoneTracker()
    run(tracker, [target(1), target(2)], NOW)
    out = run(tracker, [target(1, target_price=400), target(2, target_price=400)], NOW + timedelta(seconds=10))
    assert ids(out["gone"]) == [1, 2]
    back = run(tracker, [target(1), target(2, target_price=400)], NOW + timedelta(seconds=20))
    assert (ids(back["deals"]), ids(back["gone"])) == ([1], [2])
    # Once back, it does not reappear in gone while it stays a deal.
    assert ids(run(tracker, [target(1)], NOW + timedelta(seconds=30))["gone"]) == [2]


def test_taken_10m_window():
    tracker = GoneTracker()
    first = run(tracker, [target(1), target(2), target(3), target(4)], NOW)
    assert first["taken_10m"] == 0
    a = NOW + timedelta(seconds=60)
    # 1 ended: taken. 2's price moved: not taken.
    assert run(tracker, [target(2, target_price=400), target(3), target(4)], a)["taken_10m"] == 1
    c = NOW + timedelta(seconds=120)
    # 3 got a bid on its target: taken.
    taken = replace(target(3), num_bids=1, current_bid=300, target_price=None)
    assert run(tracker, [taken, target(4)], c)["taken_10m"] == 2
    # Events outlive their rows: both rows left gone long ago, both events still count ...
    edge = run(tracker, [target(4)], a + timedelta(seconds=TAKEN_WINDOW_S - 1))
    assert (edge["gone"], edge["taken_10m"]) == ([], 2)
    # ... until each is TAKEN_WINDOW_S old.
    assert run(tracker, [target(4)], a + timedelta(seconds=TAKEN_WINDOW_S))["taken_10m"] == 1
    assert run(tracker, [target(4)], c + timedelta(seconds=TAKEN_WINDOW_S))["taken_10m"] == 0


def test_apply_does_not_mutate_input():
    tracker = GoneTracker()
    raw1 = make_raw(listings=[target(1), target(2)], sales=five_sales())
    snap1 = build_snapshot(raw1, NOW, 1)
    before1 = copy.deepcopy(snap1)
    out1 = tracker.apply(snap1, raw1, NOW)
    assert snap1 == before1 and out1 is not snap1 and "gone" not in snap1

    # Changing what the caller got back, or its own snapshot, does not change what the tracker serves next.
    out1["deals"][0]["player_name"] = "changed"
    snap1["deals"][0]["price"] = 1

    later = NOW + timedelta(seconds=10)
    raw2 = make_raw(listings=[target(2)], sales=five_sales())
    snap2 = build_snapshot(raw2, later, 2)
    before2 = copy.deepcopy(snap2)
    out2 = tracker.apply(snap2, raw2, later)
    assert snap2 == before2 and "gone" not in snap2 and "taken_10m" not in snap2
    [row] = out2["gone"]
    assert (row["player_name"], row["price"]) == ("Test Player", 300)

    row["price"] = 2
    out3 = tracker.apply(build_snapshot(raw2, later, 3), raw2, later)
    assert out3["gone"][0]["price"] == 300
