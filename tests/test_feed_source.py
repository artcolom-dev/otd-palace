"""The live market feed source: what it asks, what it refuses, how it reads the document, and what never leaks.

The producer is played by a small HTTP server on 127.0.0.1 that serves documents shaped like the contract.
"""

import gzip
import json
import logging
import threading
import time
from dataclasses import replace
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from advisor.collector import run_collector
from advisor.links import REAL_HOME
from advisor.rules import FEED_MAX_BYTES, FEED_TIMEOUT_S, FEED_TOKEN_MIN_CHARS, STALE_AFTER_S
from advisor.sources.feed import FeedError, FeedSource, FeedStale, config_problem
from advisor.sources.fixture import load_fixture
from advisor.sources.memory import FeedMemory
from advisor.store import SnapshotStore
from tests.factories import NOW

DEMO = Path(__file__).resolve().parent.parent / "advisor" / "fixtures" / "demo_raw.json"
TOKEN = "k3y-" + "9f2c61d7a0b84e35" * 3  # 52 characters; nothing may ever print it
COVERAGE = {"sports": ["nba", "nfl", "nhl", "mlb"], "listings_complete": True, "sales_window_h": 168,
            "otd_as_of": "2026-11-12T17:40:00Z"}
_DEMO = json.loads(DEMO.read_text(encoding="utf-8"))


def iso(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def feed_doc(generated_at=NOW, **over) -> dict:
    """The demo market wearing the contract's three extra keys."""
    doc = {**_DEMO, "feed_version": 1, "generated_at": iso(generated_at), "coverage": dict(COVERAGE)}
    return {**doc, **over}


def body_of(doc) -> bytes:
    return json.dumps(doc).encode()


def serving(doc) -> FeedSource:
    """A source whose transport hands back this document (a dict, or the bytes as they are)."""
    body = doc if isinstance(doc, bytes) else body_of(doc)
    return FeedSource("https://feed.test/market", TOKEN, get=lambda url, headers: body)


# --- a local producer -----------------------------------------------------------------------------------------------

def send(handler, status, body=b"", headers=None):
    headers = {"Content-Type": "application/json", **(headers or {})}
    try:
        handler.send_response(status)
        for name, value in headers.items():
            handler.send_header(name, value)
        if "Content-Length" not in headers:
            handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)
    except OSError:  # the consumer gave up on us, which is what some tests are about
        pass


class Producer:
    """Answers `GET /feed` with `document` when the bearer token is right and 404 to everything else, as the contract
    says; a test that wants another behaviour replaces `respond`. Every request is recorded."""

    def __init__(self):
        self.requests = []  # (path, lower-cased headers)
        self.token = TOKEN
        self.document = body_of(feed_doc())
        self.gzipped = False
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                outer.requests.append((self.path, {name.lower(): value for name, value in self.headers.items()}))
                outer.respond(self)

            def log_message(self, *args):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.httpd.server_address[1]}/feed"

    def respond(self, handler):
        if handler.path != "/feed" or handler.headers.get("Authorization") != f"Bearer {self.token}":
            return send(handler, 404, b"not found", {"Content-Type": "text/plain"})
        body, headers = self.document, {"Cache-Control": "no-store"}
        if self.gzipped:
            body, headers["Content-Encoding"] = gzip.compress(body), "gzip"
        send(handler, 200, body, headers)

    def source(self, **kw) -> FeedSource:
        return FeedSource(self.url, TOKEN, **kw)


@pytest.fixture
def producer():
    server = Producer()
    yield server
    server.httpd.shutdown()
    server.httpd.server_close()


def refused(source, now=NOW, expect=FeedError):
    with pytest.raises(expect) as caught:
        source.fetch(now)
    return caught.value


# --- the request ----------------------------------------------------------------------------------------------------

def test_it_reads_the_document_with_the_bearer_token_and_asks_for_gzip(producer):
    raw = producer.source().fetch(NOW)
    [(path, headers)] = producer.requests
    assert path == "/feed"
    assert headers["authorization"] == f"Bearer {TOKEN}"
    assert "gzip" in headers["accept-encoding"] and "json" in headers["accept"]
    assert len(raw.listings) == len(_DEMO["listings"]) and len(raw.sales) == len(_DEMO["sales"])


def test_a_gzipped_answer_reads_the_same(producer):
    plain = producer.source().fetch(NOW)
    producer.gzipped = True
    assert producer.source().fetch(NOW) == plain


def test_rows_parse_exactly_as_the_fixture_loader_parses_them(producer):
    raw = producer.source().fetch(NOW)
    expected = load_fixture(DEMO, NOW)
    assert replace(raw, coverage=None) == expected
    assert raw.fetched_at == NOW and raw.coverage == {**COVERAGE, "bids": {}}


def test_a_wrong_token_is_a_404_and_an_error_that_names_neither_token_nor_address(producer):
    error = refused(FeedSource(producer.url, "w" * 40))
    assert "404" in str(error)
    assert "w" * 40 not in str(error) and producer.url not in str(error)


def test_a_redirect_is_refused_and_never_followed(producer):
    def respond(handler):
        send(handler, 302, b"", {"Location": "/feed"})

    producer.respond = respond
    assert "302" in str(refused(producer.source()))
    assert [path for path, _ in producer.requests] == ["/feed"]  # one request: the Location was not visited


def test_malformed_json_and_other_content_are_refused(producer):
    for body, kind in ((b'{"feed_version": 1, ', "application/json"), (b"NaN", "application/json"),
                       (body_of(feed_doc()), "text/html"), (b"\xff\xfe", "application/json")):
        producer.document = body
        producer.respond = lambda handler, body=body, kind=kind: send(handler, 200, body, {"Content-Type": kind})
        refused(producer.source())


def test_a_body_over_the_limit_is_refused_by_its_declared_length_without_reading_it(producer):
    producer.respond = lambda handler: send(handler, 200, b"{}", {"Content-Length": str(FEED_MAX_BYTES + 1)})
    assert "too big" in str(refused(producer.source()))


def test_a_body_over_the_limit_is_refused_when_it_never_declares_its_length(producer):
    def respond(handler):
        try:
            handler.send_response(200)
            handler.send_header("Content-Type", "application/json")
            handler.end_headers()
            handler.wfile.write(b" " * 5000)
        except OSError:
            pass

    producer.respond = respond
    assert "too big" in str(refused(producer.source(max_bytes=1000)))


def test_a_gzip_bomb_is_refused_by_its_size_once_unpacked(producer):
    bomb = gzip.compress(b" " * 200_000)
    assert len(bomb) < 1000
    producer.respond = lambda handler: send(handler, 200, bomb, {"Content-Encoding": "gzip"})
    assert "too big" in str(refused(producer.source(max_bytes=10_000)))


def test_an_encoding_we_did_not_ask_for_is_refused(producer):
    producer.respond = lambda handler: send(handler, 200, b"{}", {"Content-Encoding": "br"})
    refused(producer.source())


def test_a_slow_producer_is_given_up_on(producer):
    producer.respond = lambda handler: (time.sleep(1.5), send(handler, 200, producer.document))
    started = time.monotonic()
    refused(producer.source(timeout_s=0.3))
    assert time.monotonic() - started < 1.2 and FEED_TIMEOUT_S == 5


def test_an_unreachable_producer_says_only_the_class_of_the_failure(producer):
    producer.httpd.shutdown()
    producer.httpd.server_close()
    error = refused(producer.source())
    assert "reached" in str(error) and producer.url not in str(error)


# --- the document ---------------------------------------------------------------------------------------------------

def test_relative_times_count_from_the_documents_own_time_not_the_fetch():
    made = NOW - timedelta(seconds=12)
    doc = feed_doc(generated_at=made)
    raw = serving(doc).fetch(NOW)
    assert raw.fetched_at == made  # the snapshot will carry this time, not ours
    row, first = doc["listings"][0], raw.listings[0]
    assert first.ends_at == made + timedelta(seconds=row["ends_in_s"])
    assert first.created_at == made - timedelta(seconds=row["created_ago_s"])
    assert raw.sales[0].sold_at == made - timedelta(seconds=doc["sales"][0]["sold_ago_s"])


def test_a_listing_says_when_it_was_last_read():
    """A producer that reads player by player sends listings read minutes before the document: each says how long."""
    made = NOW - timedelta(seconds=12)
    rows = [dict(row) for row in _DEMO["listings"][:2]]
    rows[0]["seen_ago_s"] = 600
    rows[1]["seen_ago_s"] = None
    raw = serving(feed_doc(generated_at=made, listings=rows)).fetch(NOW)
    assert raw.listings[0].seen_at == made - timedelta(seconds=600)
    assert raw.listings[1].seen_at is None


def test_without_seen_ago_a_listing_was_read_when_the_document_was_built():
    assert all(listing.seen_at is None for listing in serving(feed_doc()).fetch(NOW).listings)


@pytest.mark.parametrize("bad", [-1, 1.5, "600", True])
def test_a_listing_age_that_is_not_whole_seconds_is_refused(bad):
    rows = [dict(row) for row in _DEMO["listings"][:1]]
    rows[0]["seen_ago_s"] = bad
    refused(serving(feed_doc(listings=rows)))


def test_live_challenges_ride_along_and_a_row_that_does_not_fit_is_dropped_not_fatal():
    made = NOW - timedelta(seconds=12)
    rows = [
        {"key": "hr", "title": "Watch every home run", "reward": "250 Rax + MLB pack", "ends_in_s": 3600},
        {"key": "open", "title": "Profile badge", "reward": None, "ends_in_s": None},
        {"key": "bad", "title": "", "reward": None, "ends_in_s": 60},
        {"title": "no key"},
        "nonsense",
        {"key": "long", "title": "x" * 200, "reward": None, "ends_in_s": 60},
    ]
    raw = serving(feed_doc(generated_at=made, challenges=rows)).fetch(NOW)
    assert [(c.key, c.title, c.reward, c.ends_at) for c in raw.challenges] == [
        ("hr", "Watch every home run", "250 Rax + MLB pack", made + timedelta(hours=1)),
        ("open", "Profile badge", None, None),
    ]


def test_live_bid_counts_ride_along_in_the_coverage_and_odd_ones_are_dropped():
    watch = {"bids": {
        "nba": {"bids_10m": 131, "bidders_10m": 11, "first_bid_share": 0.96, "matched_10m": 40, "unknown_10m": 91,
                "live": True},
        "nfl": {"bids_10m": "many", "bidders_10m": 2, "live": True},
        "nhl": {"bids_10m": 0, "bidders_10m": 0, "live": False},
    }}
    raw = serving(feed_doc(coverage={**COVERAGE, "watch": watch})).fetch(NOW)
    assert raw.coverage["bids"] == {"nba": {"bids_10m": 131, "bidders_10m": 11, "live": True},
                                    "nhl": {"bids_10m": 0, "bidders_10m": 0, "live": False}}
    assert serving(feed_doc()).fetch(NOW).coverage["bids"] == {}
    assert serving(feed_doc(coverage={**COVERAGE, "watch": "x"})).fetch(NOW).coverage["bids"] == {}


def test_a_document_without_challenges_has_none():
    assert serving(feed_doc()).fetch(NOW).challenges == ()
    refused(serving(feed_doc(challenges="many")))


def test_a_document_older_than_the_stale_limit_is_refused_as_stale():
    assert STALE_AFTER_S == 30
    edge = serving(feed_doc(generated_at=NOW - timedelta(seconds=30))).fetch(NOW)
    assert edge.fetched_at == NOW - timedelta(seconds=30)
    error = refused(serving(feed_doc(generated_at=NOW - timedelta(seconds=31))), expect=FeedStale)
    assert "31" in str(error)
    refused(FeedSource("https://feed.test/m", TOKEN, get=lambda url, headers: body_of(feed_doc()), stale_after_s=5),
            now=NOW + timedelta(seconds=6), expect=FeedStale)


def test_a_document_from_the_future_never_looks_fresher_than_the_fetch():
    ahead = serving(feed_doc(generated_at=NOW + timedelta(seconds=10))).fetch(NOW)
    assert ahead.fetched_at == NOW
    refused(serving(feed_doc(generated_at=NOW + timedelta(minutes=5))))


@pytest.mark.parametrize("stamp", [None, 5, "", "yesterday", "2026-11-12", "2026-11-12T18:00:00", "2026-11-12 18:00"])
def test_a_generated_at_that_is_not_an_aware_time_is_refused(stamp):
    refused(serving({**feed_doc(), "generated_at": stamp}))


def test_a_generated_at_with_an_offset_is_read_as_the_same_moment():
    raw = serving({**feed_doc(), "generated_at": "2026-11-12T19:59:50+02:00"}).fetch(NOW)
    assert raw.fetched_at == NOW - timedelta(seconds=10)


@pytest.mark.parametrize("version", [None, 0, 2, "1", 1.0, True, [1]])
def test_another_feed_version_is_refused(version):
    refused(serving(feed_doc(feed_version=version)))


def test_every_section_and_the_coverage_must_be_there():
    for name in ("listings", "sales", "fmv", "otd", "feed_version", "generated_at", "coverage"):
        refused(serving({key: value for key, value in feed_doc().items() if key != name}))
    for name in ("listings", "sales", "fmv", "otd"):
        refused(serving(feed_doc(**{name: {}})))
        refused(serving(feed_doc(**{name: None})))
    refused(serving(b"[]"))
    refused(serving(b"null"))


def test_an_empty_market_is_a_market():
    raw = serving(feed_doc(listings=[], sales=[], fmv=[], otd=[])).fetch(NOW)
    assert (raw.listings, raw.sales, raw.fmv, raw.otd) == ((), (), {}, ())


def test_no_pass_figures_need_no_measurement_time():
    """The producer has no OTD evidence on hand: it says so with a null `otd_as_of`, and its listings still count."""
    raw = serving(feed_doc(otd=[], coverage={**COVERAGE, "otd_as_of": None})).fetch(NOW)
    assert raw.otd == () and raw.listings and raw.coverage["otd_as_of"] is None


def test_pass_figures_without_a_measurement_time_are_refused():
    refused(serving(feed_doc(coverage={**COVERAGE, "otd_as_of": None})))


def test_with_a_memory_the_sales_outlive_a_producer_restart():
    """The producer restarted and sends no sales yet: the ones it already sent still back the prices."""
    docs = iter([feed_doc(), feed_doc(generated_at=NOW + timedelta(seconds=20), sales=[], fmv=[])])
    source = FeedSource("https://feed.test/market", TOKEN, get=lambda url, headers: body_of(next(docs)),
                        memory=FeedMemory(None))
    first = source.fetch(NOW)
    second = source.fetch(NOW + timedelta(seconds=20))
    assert first.sales and len(second.sales) == len(first.sales) and second.fmv == first.fmv


@pytest.mark.parametrize("coverage", [
    None, [], {}, {**COVERAGE, "sports": "nba"}, {**COVERAGE, "sports": [1]}, {**COVERAGE, "sports": ["N B A"]},
    {**COVERAGE, "listings_complete": "yes"}, {**COVERAGE, "listings_complete": 1},
    {**COVERAGE, "sales_window_h": "168"}, {**COVERAGE, "sales_window_h": True}, {**COVERAGE, "sales_window_h": -1},
    {**COVERAGE, "otd_as_of": 5}, {**COVERAGE, "otd_as_of": "soon"},
    {key: value for key, value in COVERAGE.items() if key != "sports"},
])
def test_a_coverage_that_does_not_say_what_it_covers_is_refused(coverage):
    refused(serving(feed_doc(coverage=coverage)))


def test_the_coverage_keeps_only_its_four_fields():
    raw = serving(feed_doc(coverage={**COVERAGE, "account": "someone"})).fetch(NOW)
    assert raw.coverage == {**COVERAGE, "bids": {}}


def test_a_row_with_a_field_the_model_does_not_know_or_one_missing_is_refused():
    listings = feed_doc()["listings"]
    refused(serving(feed_doc(listings=[{**listings[0], "username": "someone"}])))
    refused(serving(feed_doc(listings=[{key: value for key, value in listings[0].items() if key != "rating"}])))
    refused(serving(feed_doc(listings=[{**listings[0], "ends_in_s": "soon"}])))
    refused(serving(feed_doc(sales=["not a row"])))
    refused(serving(feed_doc(otd=[{**feed_doc()["otd"][0], "month_share": 5}])))


def _with_extra(row, name):
    from tests.pass_scenes import extra
    return {**row, **extra(name)}


def test_pass_rows_may_carry_the_five_new_fields_and_rows_without_them_read_as_before():
    rows = feed_doc()["otd"]
    doc = feed_doc(otd=[_with_extra(rows[0], "wemby"), *rows[1:]])
    raw = serving(doc).fetch(NOW)
    assert raw.otd[0].rate_build == 30.36 and raw.otd[0].rate_build_from == {"bucket": "5-7", "rarity": "common", "sales": 11}
    assert raw.otd[0].rate_bucket == "5-7" and raw.otd[0].measured
    assert len(raw.otd[0].shelf_auctions["listings"]) == 10
    plain = serving(feed_doc()).fetch(NOW)
    assert raw.otd[1:] == plain.otd[1:]
    assert all(m.rate_build is None and m.shelf_auctions is None and not m.measured for m in plain.otd)


def test_a_new_field_that_does_not_fit_is_left_out_logged_and_the_row_stays(caplog):
    rows = feed_doc()["otd"]
    bad = _with_extra(rows[0], "wemby")
    bad["shelf_auctions"]["listings"][0][1] = "110"
    bad["rates_by_bucket"]["3-5"]["sales"] = -1
    with caplog.at_level(logging.WARNING):
        raw = serving(feed_doc(otd=[bad, *rows[1:]])).fetch(NOW)
    assert len(raw.otd) == len(rows)
    first = raw.otd[0]
    assert first.shelf_auctions is None and first.rates_by_bucket is None
    assert first.rate_build == 30.36 and first.rate_bucket == "5-7"
    said = " ".join(record.getMessage() for record in caplog.records)
    assert "shelf_auctions" in said and "rates_by_bucket" in said and TOKEN not in said


def test_a_field_outside_the_contract_still_refuses_the_document():
    rows = feed_doc()["otd"]
    refused(serving(feed_doc(otd=[{**_with_extra(rows[0], "wemby"), "rate_guess": 1.0}, *rows[1:]])))


# --- who may be asked, with what ------------------------------------------------------------------------------------

@pytest.mark.parametrize("url", [
    "https://feed.example.test/market", "https://feed.example.test:8443/market?x=1", "http://127.0.0.1:8080/feed",
    "http://localhost/feed", "http://localhost:9/feed",
])
def test_https_anywhere_and_http_only_to_this_machine(url):
    assert config_problem(url, TOKEN) is None
    FeedSource(url, TOKEN)


@pytest.mark.parametrize("url", [
    None, "", "feed.example.test/market", "http://feed.example.test/market", "http://127.0.0.2/feed",
    "http://localhost.example.test/feed", "ftp://feed.example.test/x", "file:///etc/passwd", "https://",
    "https://user:pw@feed.example.test/x", "https://feed.example.test:notaport/x", "https://feed.example.test/a b",
    "https://feed.example.test/\n", "//feed.example.test/x",
])
def test_any_other_address_is_refused_before_a_request(url):
    assert "ADVISOR_FEED_URL" in config_problem(url, TOKEN)
    with pytest.raises(ValueError) as caught:
        FeedSource(url, TOKEN)
    assert TOKEN not in str(caught.value)


@pytest.mark.parametrize("token", [None, "", "abc123", "q" * (FEED_TOKEN_MIN_CHARS - 1), "q" * 20 + " " + "w" * 20,
                                   "q" * 40 + "\r\nX-Evil: 1", "é" * 40])
def test_a_short_or_unsafe_token_is_refused_without_being_echoed(token):
    problem = config_problem("https://feed.example.test/m", token)
    assert "ADVISOR_FEED_TOKEN" in problem and (len(token or "") < 3 or token not in problem)
    with pytest.raises(ValueError) as caught:
        FeedSource("https://feed.example.test/m", token)
    assert len(token or "") < 3 or token not in str(caught.value)
    assert config_problem("https://feed.example.test/m", "q" * FEED_TOKEN_MIN_CHARS) is None


# --- nothing leaks --------------------------------------------------------------------------------------------------

def test_the_token_and_the_address_never_reach_a_log_an_error_or_the_health_page(producer, caplog):
    producer.token = "another-" + "z" * 40  # so every round is a 404
    source = producer.source()
    assert TOKEN not in repr(source) and TOKEN not in str(vars(source)).replace(f"Bearer {TOKEN}", "")
    store, stop = SnapshotStore(), threading.Event()
    rounds = []

    def wait(seconds):
        rounds.append(seconds)
        stop.set()
        return True

    with caplog.at_level(logging.DEBUG):
        run_collector(source, store, stop, interval_s=10, now=lambda: NOW, wait=wait)
    assert store.health()["last_error"] == "FeedError"
    everything = caplog.text + repr(store.health()) + repr(caplog.records) + "".join(
        str(record.exc_info) for record in caplog.records
    )
    assert TOKEN not in everything and producer.token not in everything
    assert "refresh failed" in caplog.text


def test_no_failure_text_holds_the_token(producer, caplog):
    documents = (b"{", b"[]", body_of(feed_doc(feed_version=9)), body_of(feed_doc(generated_at=NOW - timedelta(hours=1))),
                 body_of(feed_doc(listings=[{"x": 1}])))
    with caplog.at_level(logging.DEBUG):
        for document in documents:
            producer.document = document
            error = refused(producer.source())
            assert TOKEN not in repr(error) + str(error) + repr(error.__cause__) + repr(error.__context__)
        producer.httpd.shutdown()
        producer.httpd.server_close()
        error = refused(producer.source())
        assert TOKEN not in repr(error) + repr(error.__cause__) + repr(error.__context__)
    assert TOKEN not in caplog.text


# --- the collector on a feed ----------------------------------------------------------------------------------------

def round_of(source, now):
    """One collector round: the snapshot it served (a dict), or None, and the health it left."""
    store, stop = SnapshotStore(), threading.Event()

    def wait(seconds):
        stop.set()
        return True

    run_collector(source, store, stop, interval_s=10, now=lambda: now, wait=wait)
    current = store.current()
    return (None if current is None else json.loads(current[0])), store.health()


def test_the_snapshot_carries_the_feeds_time_the_coverage_and_real_deal_links():
    made = NOW - timedelta(seconds=14)
    snap, health = round_of(serving(feed_doc(generated_at=made)), NOW)
    assert snap["generated_at"] == "2026-11-12T17:59:46Z"
    assert snap["rules"]["demo"] is False and snap["rules"]["coverage"] == COVERAGE
    assert snap["deals"] and all(deal["url"].startswith("https://") and deal["url"] != REAL_HOME for deal in snap["deals"])
    assert health["last_error"] is None


def test_a_stale_document_publishes_nothing_new_and_the_last_snapshot_keeps_ageing():
    store, stop = SnapshotStore(), threading.Event()
    stuck = body_of(feed_doc(generated_at=NOW))  # the producer stops refreshing: every fetch gets this one
    clock = iter([NOW, NOW + timedelta(seconds=10), NOW + timedelta(seconds=40)])
    source = FeedSource("https://feed.test/m", TOKEN, get=lambda url, headers: stuck)
    waits = []

    def wait(seconds):
        waits.append(seconds)
        if len(waits) == 3:
            stop.set()
        return stop.is_set()

    run_collector(source, store, stop, interval_s=10, now=lambda: next(clock), wait=wait, first_version=1)
    snap = json.loads(store.current()[0])
    assert snap["generated_at"] == "2026-11-12T18:00:00Z"  # still the one made at 18:00:00 ...
    assert snap["version"] == 2  # ... though a second, equally old round was fine at +10 s
    assert store.health()["last_error"] == "FeedStale"  # and the +40 s round was refused
    assert waits == [10, 10, 20]
