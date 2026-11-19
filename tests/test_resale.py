"""Resale: how many recent listings of a player's cards (in the card's rating band) sold, read from the private feed's
`/resale` route through a fake getter (no test touches the network)."""
import json
import threading
from datetime import datetime, timezone

import pytest

from advisor.resale import ResaleBoard, ResaleView, fetch_table, parse, run_resale
from advisor.rules import RESALE_MAX_AGE_S, RESALE_MIN_LISTED, RESALE_RETRY_S, RESALE_TTL_S
from advisor.sources.feed import FeedError

URL = "https://feed.example.internal/internal/market-feed"
TOKEN = "t" * 40
MIN = RESALE_MIN_LISTED


def stamp(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def doc(players=None, at=1_000_000.0, **over):
    base = {"version": 2, "generated_at": stamp(at), "window_days": 30, "min_listed": MIN, "min_sources": 3,
            "bands": [3.0, 6.0, 10.0],
            "players": {"nba": {"22": {"1": [40, 28], "3": [24, 3]}, "23": {"0": [MIN, 1]}}, "nfl": {"7": {"2": [MIN, MIN]}}}
            if players is None else players}
    return {**base, **over}


# ---- parse: what the page may rely on ------------------------------------------------------------------------


def test_parse_keeps_listed_and_sold_by_sport_player_and_the_band_of_the_cards_rating():
    table = parse(doc())
    assert table.bands == (3.0, 6.0, 10.0)
    assert table.get("nba", 22, 4.2) == (40, 28)  # 4.2 is in band 1 (3 up to 6)
    assert table.get("nba", 22, 12.0) == (24, 3)  # band 3 (10 and up)
    assert table.get("nba", 22, 7.5) is None  # band 2: no count there
    assert table.get("nba", 23, 1.0) == (MIN, 1) and table.get("nfl", 7, 6.0) == (MIN, MIN)  # an edge belongs to the band above it


@pytest.mark.parametrize("rating", [None, "4", float("nan"), float("inf"), True, [4]])
def test_a_rating_that_is_not_a_number_has_no_count_rather_than_a_guess(rating):
    assert parse(doc()).get("nba", 22, rating) is None


@pytest.mark.parametrize(
    "bad",
    [
        {"nba": {"x": {"1": [40, 28]}}},  # not an id
        {"nba": {"-5": {"1": [40, 28]}}},
        {"nba": {"007": {"1": [40, 28]}}},  # not the plain digits of an id
        {"nba": {"1" * 13: {"1": [40, 28]}}},  # an id no player has
        {"nba": {"1" * 5000: {"1": [40, 28]}}},  # and one that cannot be turned into a number at all
        {"nba": {"22": {"x": [40, 28]}}},  # not a band
        {"nba": {"22": {"4": [40, 28]}}},  # a band the document does not have (it has 4: 0 to 3)
        {"nba": {"22": {"1": [40]}}},  # not a pair
        {"nba": {"22": {"1": [40, 28, 1]}}},
        {"nba": {"22": {"1": ["40", 28]}}},  # not numbers
        {"nba": {"22": {"1": [40.5, 28]}}},
        {"nba": {"22": {"1": [True, False]}}},
        {"nba": {"22": {"1": [10, 11]}}},  # sold more than listed
        {"nba": {"22": {"1": [10, -1]}}},
        {"nba": {"22": {"1": [MIN - 1, 3]}}},  # too few to be read
        {"": {"22": {"1": [40, 28]}}},
        {"NBA": {"22": {"1": [40, 28]}}},  # the producer lowercases: another spelling is not ours
        {"nba": {"22": [[40, 28]]}},  # a count, not a band mapping
        {"nba": [[22, 40, 28]]},  # not a mapping
        {"nba": None},
    ],
)
def test_parse_drops_what_is_not_a_clean_count_and_keeps_the_rest(bad):
    good = {"nfl": {"7": {"2": [MIN, MIN]}}}
    table = parse(doc(players={**bad, **good}))
    assert table.get("nfl", 7, 7.0) == (MIN, MIN)
    assert table.size() == 1


@pytest.mark.parametrize(
    "junk",
    [None, [], "x", 3, {}, doc(version=1), doc(version=3), doc(version="2"), doc(version=True), doc(version=2.0),
     {"version": 2, "bands": [3.0], "players": None}, doc(players=[]), doc(players="x"),
     doc(bands=None), doc(bands=[]), doc(bands=[6.0, 3.0]), doc(bands=[3.0, 3.0]), doc(bands=["3"]), doc(bands=[True]),
     doc(bands=[float("nan")]), doc(bands=[-1.0]), doc(bands=[1.0] * 9), doc(bands="3")],
)
def test_parse_refuses_a_document_that_is_not_ours_instead_of_guessing(junk):
    with pytest.raises(ValueError):
        parse(junk)


# ---- the board: one read per TTL, the last good table kept, silence when it is too old ---------------------------


class Clock:
    def __init__(self, now=1_000_000.0):
        self.now = now

    def __call__(self):
        return self.now


class Feed:
    def __init__(self, answer=None):
        self.answer, self.calls = doc() if answer is None else answer, 0

    def __call__(self):
        self.calls += 1
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


def board(feed, clock):
    return ResaleBoard(fetch=feed, clock=clock)


def test_the_board_reads_the_table_and_answers_by_sport_player_and_rating():
    feed, clock = Feed(), Clock()
    b = board(feed, clock)
    b.refresh()
    assert b.lookup("nba", 22, 4.2) == (40, 28)
    assert b.lookup("nba", 999, 4.2) is None and b.lookup("mlb", 22, 4.2) is None
    assert b.fresh()


def test_the_board_reads_again_only_after_its_ttl():
    feed, clock = Feed(), Clock()
    b = board(feed, clock)
    b.refresh()
    clock.now += RESALE_TTL_S - 1
    b.refresh()
    assert feed.calls == 1
    clock.now += 2
    b.refresh()
    assert feed.calls == 2


def test_a_failed_read_keeps_the_last_good_table_and_is_retried_after_the_retry_delay_only():
    feed, clock = Feed(), Clock()
    b = board(feed, clock)
    b.refresh()
    feed.answer = FeedError("the feed answered 503")
    clock.now += RESALE_TTL_S + 1
    b.refresh()
    assert b.lookup("nba", 22, 4.2) == (40, 28)
    calls = feed.calls
    clock.now += RESALE_RETRY_S - 1
    b.refresh()
    assert feed.calls == calls
    feed.answer = doc(players={"nba": {"22": {"1": [50, 5]}}}, at=clock.now)
    clock.now += 2
    b.refresh()
    assert b.lookup("nba", 22, 4.2) == (50, 5)


def test_a_table_older_than_the_max_age_stops_speaking():
    feed, clock = Feed(), Clock()
    b = board(feed, clock)
    b.refresh()
    feed.answer = FeedError("down")
    clock.now += RESALE_MAX_AGE_S + 1
    b.refresh()
    assert b.lookup("nba", 22, 4.2) is None and not b.fresh()


def test_age_counts_from_when_the_table_was_built_not_from_when_it_was_fetched():
    clock = Clock()
    almost_too_old = doc(at=clock.now - (RESALE_MAX_AGE_S - 3600))  # built an hour short of the limit
    b = board(Feed(almost_too_old), clock)
    b.refresh()
    assert b.fresh()
    clock.now += 3601  # fetched just now, yet built too long ago
    assert not b.fresh() and b.lookup("nba", 22, 4.2) is None


def test_a_table_built_in_the_future_is_counted_from_now_a_wrong_clock_cannot_make_it_young_for_ever():
    clock = Clock()
    b = board(Feed(doc(at=clock.now + 10 * 86400)), clock)
    b.refresh()
    assert b.fresh()
    clock.now += RESALE_MAX_AGE_S + 1
    assert not b.fresh()


def test_a_document_that_is_not_ours_is_a_failed_read_not_an_empty_verdict():
    feed, clock = Feed(doc(version=9)), Clock()
    b = board(feed, clock)
    b.refresh()
    assert not b.fresh() and b.lookup("nba", 22, 4.2) is None


def test_the_board_never_raises_into_the_refresher_whatever_the_fetch_does():
    feed, clock = Feed(RuntimeError("boom")), Clock()
    b = board(feed, clock)
    b.refresh()
    assert not b.fresh()


# ---- the view a snapshot asks -----------------------------------------------------------------------------------


def test_the_view_gives_the_counts_as_the_json_the_page_reads_and_nothing_for_a_card_without_a_count():
    feed, clock = Feed(), Clock()
    b = board(feed, clock)
    b.refresh()
    view = ResaleView(b)
    assert view.of("nba", 22, "N. Jokić", 4.2) == {"listed": 40, "sold": 28}
    assert view.of("nba", 22, "N. Jokić", 7.5) is None  # a band with no count
    assert view.of("nba", 5, "Nobody", 4.2) is None
    assert view.available() is True


def test_the_view_is_not_available_before_the_first_table_or_when_it_is_too_old():
    clock = Clock()
    b = board(Feed(), clock)
    view = ResaleView(b)
    assert view.available() is False and view.of("nba", 22, "x", 4.2) is None
    b.refresh()
    clock.now += RESALE_MAX_AGE_S + 1
    assert view.available() is False and view.of("nba", 22, "x", 4.2) is None


# ---- the fetch: the feed's own route, with the feed's token -------------------------------------------------------


def test_fetch_asks_the_resale_route_with_the_bearer_token_and_asks_for_gzip():
    seen = {}

    def get(url, headers):
        seen.update(url=url, headers=headers)
        return json.dumps(doc()).encode()  # what `_http_get` hands back: the unzipped body

    out = fetch_table(URL + "/", TOKEN, get=get)
    assert out["players"]["nba"]["22"]["1"] == [40, 28]
    assert seen["url"] == URL + "/resale"
    assert seen["headers"]["Authorization"] == f"Bearer {TOKEN}"
    assert "gzip" in seen["headers"]["Accept-Encoding"]


def test_fetch_raises_on_a_body_that_is_not_json():
    with pytest.raises(FeedError):
        fetch_table(URL, TOKEN, get=lambda url, headers: b"<html>nope</html>")


def test_the_view_and_board_never_show_the_address_or_the_token():
    b = board(Feed(), Clock())
    assert TOKEN not in repr(b) and "example" not in repr(b)
    assert TOKEN not in repr(ResaleView(b))


# ---- the refresher thread ---------------------------------------------------------------------------------------


def test_the_refresher_keeps_reading_until_stopped_and_an_error_does_not_end_it():
    class Flaky:
        calls = 0

        def refresh(self):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("boom")

    waits: list[float] = []

    def wait(seconds):
        waits.append(seconds)
        return len(waits) >= 3

    flaky = Flaky()
    run_resale(flaky, threading.Event(), every_s=60, wait=wait)
    assert (flaky.calls, waits) == (3, [60, 60, 60])
