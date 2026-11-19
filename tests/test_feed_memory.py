"""The feed's memory: sales and fair values the feed already sent stay known after the feed forgets them (its
producer restarted), within the sales window for sales and a few hours for fair values, and across a restart of the
site itself."""

import json
from datetime import timedelta

from advisor.sources.memory import FeedMemory
from tests.factories import NOW, make_fmv, make_raw, make_sale

COVER = {"sports": ["nba"], "listings_complete": False, "sales_window_h": 168, "otd_as_of": None}


def doc(at=NOW, sales=(), fmv=None, window_h=168):
    return make_raw(fetched_at=at, sales=sales, fmv=fmv or {}, coverage={**COVER, "sales_window_h": window_h})


def test_sales_survive_a_document_that_no_longer_has_them():
    memory = FeedMemory(None)
    sale = make_sale(price=450, sold_at=NOW - timedelta(hours=3))
    memory.merge(doc(sales=[sale]))
    later = memory.merge(doc(at=NOW + timedelta(minutes=1)))  # the producer restarted: no sales yet
    assert later.sales == (sale,)


def test_the_same_sale_seen_twice_counts_once():
    memory = FeedMemory(None)
    sale = make_sale(price=450, sold_at=NOW - timedelta(hours=3))
    memory.merge(doc(sales=[sale]))
    # the next document counts its age from another second: one second off
    again = memory.merge(doc(at=NOW + timedelta(seconds=20), sales=[make_sale(price=450, sold_at=sale.sold_at
                                                                                + timedelta(seconds=1))]))
    assert len(again.sales) == 1


def test_two_sales_at_the_same_price_minutes_apart_are_two_sales():
    memory = FeedMemory(None)
    first = make_sale(price=450, sold_at=NOW - timedelta(hours=3))
    second = make_sale(price=450, sold_at=NOW - timedelta(hours=2))
    assert len(memory.merge(doc(sales=[first, second])).sales) == 2


def test_sales_older_than_the_window_are_forgotten():
    memory = FeedMemory(None)
    memory.merge(doc(sales=[make_sale(sold_at=NOW - timedelta(hours=167))]))
    assert memory.merge(doc(at=NOW + timedelta(hours=2))).sales == ()


def test_fair_values_are_held_a_few_hours_and_the_newest_wins():
    memory = FeedMemory(None, fmv_hold=timedelta(hours=6))
    memory.merge(doc(fmv={100: make_fmv(median=400, sale_count=9)}))
    held = memory.merge(doc(at=NOW + timedelta(hours=5)))
    assert held.fmv[100].median == 400
    newer = memory.merge(doc(at=NOW + timedelta(hours=5, minutes=1), fmv={100: make_fmv(median=380, sale_count=10)}))
    assert newer.fmv[100].median == 380
    assert 100 in memory.merge(doc(at=NOW + timedelta(hours=11))).fmv  # held from its last sighting
    assert memory.merge(doc(at=NOW + timedelta(hours=11, minutes=2))).fmv == {}


def test_what_the_document_says_stays_as_it_is():
    memory = FeedMemory(None)
    raw = doc(sales=[make_sale()], fmv={100: make_fmv(median=400)})
    merged = memory.merge(raw)
    assert (merged.fetched_at, merged.listings, merged.otd, merged.coverage) == (raw.fetched_at, raw.listings,
                                                                                raw.otd, raw.coverage)


def test_the_memory_outlives_a_restart_of_the_site(tmp_path):
    path = tmp_path / "feed-memory.json"
    sale = make_sale(price=450, sold_at=NOW - timedelta(hours=3))
    FeedMemory(path, save_every=timedelta(0)).merge(doc(sales=[sale], fmv={100: make_fmv(median=400)}))
    restored = FeedMemory(path).merge(doc(at=NOW + timedelta(minutes=2)))
    assert restored.sales == (sale,) and restored.fmv[100].median == 400


def test_it_writes_at_most_every_few_minutes(tmp_path):
    path = tmp_path / "feed-memory.json"
    memory = FeedMemory(path, save_every=timedelta(minutes=5))
    memory.merge(doc(sales=[make_sale(price=1)]))
    memory.merge(doc(at=NOW + timedelta(minutes=1), sales=[make_sale(price=2)]))
    assert len(json.loads(path.read_text())["sales"]) == 1
    memory.merge(doc(at=NOW + timedelta(minutes=6)))
    assert len(json.loads(path.read_text())["sales"]) == 2


def test_an_unreadable_memory_file_is_set_aside_and_the_site_starts_empty(tmp_path):
    path = tmp_path / "feed-memory.json"
    path.write_text("{not json")
    assert FeedMemory(path).merge(doc()).sales == ()
    assert (tmp_path / "feed-memory.json.corrupt").exists()


def test_a_memory_row_that_does_not_fit_is_dropped_not_fatal(tmp_path):
    path = tmp_path / "feed-memory.json"
    good = make_sale(price=450, sold_at=NOW - timedelta(hours=3))
    FeedMemory(path, save_every=timedelta(0)).merge(doc(sales=[good]))
    data = json.loads(path.read_text())
    data["sales"].append({"price": "lots"})
    path.write_text(json.dumps(data))
    assert FeedMemory(path).merge(doc(at=NOW + timedelta(minutes=1))).sales == (good,)


def test_the_memory_is_bounded():
    memory = FeedMemory(None, max_sales=3)
    sales = [make_sale(price=p, sold_at=NOW - timedelta(hours=p)) for p in (1, 2, 3, 4, 5)]
    kept = memory.merge(doc(sales=sales)).sales
    assert sorted(s.price for s in kept) == [1, 2, 3]  # the newest


def test_a_full_memory_thins_the_busiest_markets_and_keeps_last_weeks_sales():
    # Dropping the oldest sales first emptied the week before today, so no price move could be measured any more.
    memory = FeedMemory(None, max_sales=10)
    busy_today = [make_sale(player_id=1, price=100 + i, sold_at=NOW - timedelta(minutes=10 + i)) for i in range(20)]
    busy_last_week = [make_sale(player_id=1, price=200 + i, sold_at=NOW - timedelta(days=2 + i)) for i in range(3)]
    quiet_today = [make_sale(player_id=2, price=300 + i, sold_at=NOW - timedelta(hours=1 + i)) for i in range(2)]
    kept = memory.merge(doc(sales=busy_today + busy_last_week + quiet_today)).sales
    assert len(kept) == 10
    assert {s.price for s in kept if s.player_id == 1 and s.price >= 200} == {200, 201, 202}  # last week, all of it
    assert {s.price for s in kept if s.player_id == 2} == {300, 301}  # the quiet market, untouched
    assert {s.price for s in kept if s.player_id == 1 and s.price < 200} == {100, 101, 102, 103, 104}  # today's newest


def test_a_memory_with_more_markets_than_room_keeps_the_newest_sales():
    memory = FeedMemory(None, max_sales=2)
    sales = [make_sale(player_id=p, price=p, sold_at=NOW - timedelta(hours=p)) for p in (1, 2, 3)]
    assert sorted(s.price for s in memory.merge(doc(sales=sales)).sales) == [1, 2]


def test_flush_writes_what_was_learned_since_the_last_save(tmp_path):
    path = tmp_path / "feed-memory.json"
    memory = FeedMemory(path, save_every=timedelta(minutes=5))
    memory.flush()  # nothing learned yet: nothing written over
    assert not path.exists()
    memory.merge(doc(sales=[make_sale(price=1)]))
    memory.merge(doc(at=NOW + timedelta(minutes=1), sales=[make_sale(price=2)]))
    memory.flush()  # the server stopping: the minute since the last save is not lost
    assert len(json.loads(path.read_text())["sales"]) == 2
    FeedMemory(None).flush()  # no file: nothing to do


def test_the_feed_source_flushes_its_memory(tmp_path):
    from advisor.sources.feed import FeedSource

    path = tmp_path / "feed-memory.json"
    memory = FeedMemory(path, save_every=timedelta(minutes=5))
    memory.merge(doc(sales=[make_sale(price=1)]))
    memory.merge(doc(at=NOW + timedelta(minutes=1), sales=[make_sale(price=2)]))
    FeedSource("https://feed.test/f", "k3y-" + "9f2c61d7a0b84e35" * 3, memory=memory).flush()
    assert len(json.loads(path.read_text())["sales"]) == 2
    FeedSource("https://feed.test/f", "k3y-" + "9f2c61d7a0b84e35" * 3).flush()  # without a memory: nothing to do
