"""Web push alerts: the endpoint allowlist, the subscription store, the dispatcher's rules and limits, the VAPID
configuration and the real sender, all without a network (a fake sender, or a fake HTTP adapter under pywebpush)."""

import base64
import json
import logging
import os
import shutil
import subprocess
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

import http_ece
import pytest
import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from advisor import push
from advisor.push import (
    Dispatcher,
    PushStore,
    WebPushSender,
    config_from_env,
    endpoint_allowed,
    parse_endpoint,
    parse_subscription,
)
from advisor.rules import (
    PUSH_ALLOWED_HOSTS,
    PUSH_DEFAULT_DIGEST_HOUR,
    PUSH_DEFAULT_QUIET,
    PUSH_LAST_CALL_S,
    PUSH_MAX_BYTES,
    PUSH_MAX_FOLLOWS,
    PUSH_MAX_SUBS,
    PUSH_MOVE_MIN,
    PUSH_PER_HOUR,
    PUSH_ROW_TTL_DAYS,
    PUSH_TAG_COOLDOWN_S,
    PUSH_TEST_GLOBAL_PER_HOUR,
)
from scripts import gen_vapid
from tests.factories import NOW


def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# A browser's subscription key: a real P-256 point (a made-up one is refused).
P256DH = b64(ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(
    serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))
AUTH = b64(bytes(range(16)))
FCM = "https://fcm.googleapis.com/fcm/send/device-token-1"
ALL_ON = {"deals": True, "last_call": True, "moves": True, "digest": True}


def subscription(endpoint=FCM):
    return {"endpoint": endpoint, "keys": {"p256dh": P256DH, "auth": AUTH}}


def rules(**overrides):
    base = {
        "level": "pro", "budget": None, "follows": ["nba:10"], "opened": [], "categories": dict(ALL_ON),
        "digest_hour": 3, "quiet": None, "utc_offset_min": 0,
    }
    return {**base, **overrides}


def body(sub=None, rule=None, **extra) -> bytes:
    return json.dumps({"subscription": sub or subscription(), "rules": rule or rules(), **extra}).encode()


def deal(listing_id, player_id=10, sport="nba", price=100, reference=170, discount=0.41, kind="target",
         confidence="high", ends_in_s=1800, falling=False, name="Test Player", at=NOW, injury=None):
    row = {
        "listing_id": listing_id, "sport": sport, "player_id": player_id, "player_name": name, "kind": kind,
        "price": price, "reference": reference, "discount": discount, "confidence": confidence,
        "ends_at": iso(at + timedelta(seconds=ends_in_s)), "falling": falling,
    }
    if injury is not None:
        row["injury"] = {"status": injury, "part": None, "back": None}
    return row


def move(player_id=10, change=0.25, sport="nba", name="Test Player"):
    return {"sport": sport, "season": 2026, "player_id": player_id, "player_name": name, "bucket": "r3",
            "median_recent": 500, "median_base": 400, "change": change, "sales_recent": 8}


def snap(deals=(), risers=(), fallers=(), at=NOW):
    return {"version": 1, "generated_at": iso(at), "deals": list(deals),
            "moves": {"risers": list(risers), "fallers": list(fallers)}, "gone": []}


class FakeSender:
    """Records what it is asked to send and answers with `status` (or raises it)."""

    def __init__(self, status=201):
        self.status = status
        self.sent: list[tuple[str, dict, int, str]] = []

    def __call__(self, endpoint, keys, payload, ttl, urgency):
        self.sent.append((endpoint, json.loads(payload), ttl, urgency))
        if isinstance(self.status, Exception):
            raise self.status
        return self.status

    @property
    def payloads(self):
        return [payload for _, payload, _, _ in self.sent]


def setup(tmp_path, rule=None, status=201, endpoint=FCM, clock=NOW.timestamp()):
    """A store with one subscription, a fake sender, and a dispatcher whose clock stands at `clock` (by default the
    snapshot time NOW, so the last-call check against the clock never gets in the way)."""
    store = PushStore(tmp_path / "push.json")
    assert store.upsert(subscription(endpoint), rule or rules()) == "ok"
    sender = FakeSender(status)
    return store, sender, Dispatcher(store, sender, public_key="PUBLIC", check_s=10, clock=lambda: clock)


# --- the allowlist ------------------------------------------------------------------------------------------------

def test_the_allowlist_names_the_five_push_services():
    assert PUSH_ALLOWED_HOSTS == (
        "fcm.googleapis.com", "updates.push.services.mozilla.com", "*.notify.windows.com", "web.push.apple.com",
        "*.push.apple.com",
    )


@pytest.mark.parametrize("endpoint", [
    "https://fcm.googleapis.com/fcm/send/abc:APA91b",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAAA",
    "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB",
    "https://web.push.apple.com/QGuQyavXutnMH",
    "https://api.push.apple.com/3/device/abc",
])
def test_the_allowlist_takes_the_push_services(endpoint):
    assert endpoint_allowed(endpoint)


@pytest.mark.parametrize("endpoint", [
    "https://evil.example/push",
    "http://fcm.googleapis.com/fcm/send/abc",  # https only
    "https://user:pw@fcm.googleapis.com/fcm/send/abc",  # userinfo
    "https://user@fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com.evil.example/x",
    "https://evilfcm.googleapis.com/x",
    "https://notify.windows.com/x",  # a wildcard needs a name before it
    "https://evil.example/.notify.windows.com/x",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "https://fcm.googleapis.com./fcm/send/abc",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://fcm.googleapis.com",
    "https://fcm.googleapis.com/x#fragment",
    "https://fcm.googleapis.com/x y",
    "https://fcm.googleapis.com/" + "a" * 1100,
    "",
    None,
    42,
])
def test_the_allowlist_refuses_anything_else(endpoint):
    assert not endpoint_allowed(endpoint)


# --- what a subscription may hold ---------------------------------------------------------------------------------

def test_a_good_subscription_is_kept_without_anything_personal():
    parsed = parse_subscription(body(name="Ann", email="ann@example.com", ua="Mozilla/5.0"))
    assert parsed is not None
    sub, rule = parsed
    assert sub == subscription()
    assert set(rule) == {"level", "budget", "follows", "opened", "categories", "digest_hour", "quiet", "utc_offset_min"}
    assert "Ann" not in json.dumps(parsed) and "example.com" not in json.dumps(parsed)


def test_missing_settings_take_their_defaults_and_categories_start_off():
    minimal = {"level": "new", "budget": 200, "follows": []}
    _, rule = parse_subscription(body(rule=minimal))
    assert rule == {
        "level": "new", "budget": 200, "follows": [], "opened": [],
        "categories": {"deals": False, "last_call": False, "moves": False, "digest": False, "routine": False},
        "digest_hour": PUSH_DEFAULT_DIGEST_HOUR, "quiet": list(PUSH_DEFAULT_QUIET), "utc_offset_min": 0,
    }


@pytest.mark.parametrize("bad", [
    b"not json",
    b"[]",
    json.dumps({"rules": rules()}).encode(),
    body(sub={"endpoint": "https://evil.example/x", "keys": {"p256dh": P256DH, "auth": AUTH}}),
    body(sub={"endpoint": FCM, "keys": {"p256dh": b64(b"\x04" + bytes(10)), "auth": AUTH}}),
    body(sub={"endpoint": FCM, "keys": {"p256dh": b64(b"\x04" + bytes(64)), "auth": AUTH}}),  # not on the curve
    body(sub={"endpoint": FCM, "keys": {"p256dh": P256DH, "auth": b64(bytes(8))}}),
    body(sub={"endpoint": FCM, "keys": {"p256dh": P256DH}}),
    body(rule=rules(level="expert")),
    body(rule=rules(budget=-5)),
    body(rule=rules(budget="any")),
    body(rule=rules(follows=["Test Player"])),
    body(rule=rules(follows=[f"nba:{i}" for i in range(PUSH_MAX_FOLLOWS + 1)])),
    body(rule=rules(opened=["12"])),
    body(rule=rules(categories={"deals": "yes"})),
    body(rule=rules(digest_hour=24)),
    body(rule=rules(quiet=[23, 25])),
    body(rule=rules(quiet=[23])),
    body(rule=rules(utc_offset_min=900)),
    body(rule=rules(utc_offset_min=True)),
])
def test_a_bad_subscription_is_refused(bad):
    assert parse_subscription(bad) is None


def test_a_subscription_fits_in_the_body_cap():
    # The biggest rules a device sends still fit, with a long endpoint.
    rule = rules(follows=[f"soccer:{10**9 + i}" for i in range(PUSH_MAX_FOLLOWS)], opened=list(range(10**8, 10**8 + 30)))
    big = body(sub=subscription("https://updates.push.services.mozilla.com/wpush/v2/" + "g" * 300), rule=rule)
    assert len(big) <= PUSH_MAX_BYTES
    assert parse_subscription(big) is not None


def test_an_endpoint_is_written_one_way():
    for written in ("https://FCM.GoogleAPIs.com/fcm/send/Device-1", "https://fcm.googleapis.com:443/fcm/send/Device-1"):
        sub, _ = parse_subscription(body(sub=subscription(written)))
        assert sub["endpoint"] == "https://fcm.googleapis.com/fcm/send/Device-1"  # the path keeps its case
        assert parse_endpoint(json.dumps({"endpoint": written}).encode()) == sub["endpoint"]
    assert parse_subscription(body(sub=subscription("https://fcm.googleapis.com:8443/fcm/send/x"))) is None


def test_one_device_is_one_row(tmp_path):
    store = PushStore(tmp_path / "push.json")
    for written in (FCM, FCM.replace("fcm.googleapis.com", "FCM.googleapis.com"), FCM.replace(".com/", ".com:443/")):
        sub, rule = parse_subscription(body(sub=subscription(written)))
        store.upsert(sub, rule)
    assert len(store) == 1


# --- the store ----------------------------------------------------------------------------------------------------

def test_upsert_then_delete(tmp_path):
    store = PushStore(tmp_path / "push.json")
    assert store.upsert(subscription(), rules()) == "ok"
    assert store.get(FCM)["rules"]["follows"] == ["nba:10"]
    assert store.upsert(subscription(), rules(follows=["mlb:7"])) == "ok"
    assert store.get(FCM)["rules"]["follows"] == ["mlb:7"]
    assert len(store) == 1
    assert store.delete(FCM) is True
    assert store.get(FCM) is None
    assert store.delete(FCM) is False


def test_the_store_survives_a_restart_and_holds_only_what_it_needs(tmp_path):
    path = tmp_path / "push.json"
    PushStore(path).upsert(subscription(), rules())
    again = PushStore(path)
    assert again.get(FCM)["keys"] == {"p256dh": P256DH, "auth": AUTH}
    saved = json.loads(path.read_text())
    (row,) = saved["subs"]
    assert set(row) == {"endpoint", "keys", "rules", "state", "last_seen"}
    assert [p.name for p in tmp_path.iterdir()] == ["push.json"]  # the temporary file was renamed over it


def test_an_upsert_keeps_the_counters(tmp_path):
    store, sender, dispatcher = setup(tmp_path)
    assert dispatcher.send_test(FCM, NOW) == "sent"
    store.upsert(subscription(), rules(level="new"))
    assert dispatcher.send_test(FCM, NOW) == "sent"
    assert dispatcher.send_test(FCM, NOW) == "sent"
    assert dispatcher.send_test(FCM, NOW) == "limited"  # the tests sent before the upsert still count


def test_the_store_is_bounded(tmp_path):
    store = PushStore(tmp_path / "push.json", max_subs=2)
    assert PUSH_MAX_SUBS == 5000
    assert store.upsert(subscription(FCM + "a"), rules()) == "ok"
    assert store.upsert(subscription(FCM + "b"), rules()) == "ok"
    assert store.upsert(subscription(FCM + "c"), rules()) == "full"
    assert store.upsert(subscription(FCM + "a"), rules(level="new")) == "ok"  # an update still goes through


def test_every_category_off_stores_nothing(tmp_path):
    store = PushStore(tmp_path / "push.json")
    off = rules(categories={c: False for c in ALL_ON})
    assert store.upsert(subscription(), off) == "ok"
    assert len(store) == 0
    store.upsert(subscription(), rules())
    assert store.upsert(subscription(), off) == "ok"  # turning the last one off removes the row
    assert store.get(FCM) is None
    assert json.loads((tmp_path / "push.json").read_text())["subs"] == []


def test_an_unchanged_put_writes_nothing_until_the_next_day(tmp_path, monkeypatch):
    clock = [NOW.timestamp()]
    store = PushStore(tmp_path / "push.json", clock=lambda: clock[0])
    writes = []
    real_write = store._write
    monkeypatch.setattr(store, "_write", lambda: writes.append(1) or real_write())
    store.upsert(subscription(), rules())
    assert len(writes) == 1 and store.get(FCM)["last_seen"] == NOW.timestamp()
    clock[0] += 3600
    store.upsert(subscription(), rules())
    assert len(writes) == 1  # same rules, same day: the file is left alone
    store.upsert(subscription(), rules(level="new"))
    assert len(writes) == 2
    clock[0] += 86400
    store.upsert(subscription(), rules(level="new"))
    assert len(writes) == 3 and store.get(FCM)["last_seen"] == clock[0]


def test_a_write_that_fails_is_tried_again_by_the_next_put_and_the_next_flush(tmp_path, monkeypatch):
    path = tmp_path / "push.json"
    store = PushStore(path)
    real_replace = os.replace

    def broken(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", broken)
    assert store.upsert(subscription(), rules()) == "ok"  # kept in memory, not on disk
    assert not path.exists()
    monkeypatch.setattr(os, "replace", real_replace)
    assert store.upsert(subscription(), rules()) == "ok"  # nothing changed, but the file is behind: written now
    assert json.loads(path.read_text())["subs"][0]["endpoint"] == FCM
    writes = []
    real_write = store._write
    monkeypatch.setattr(store, "_write", lambda: writes.append(1) or real_write())
    store.upsert(subscription(), rules())
    assert writes == []  # saved: an unchanged PUT leaves the file alone again


def test_a_write_that_fails_is_tried_again_by_the_next_flush(tmp_path, monkeypatch):
    path = tmp_path / "push.json"
    store = PushStore(path)
    real_replace = os.replace
    monkeypatch.setattr(os, "replace", lambda *a, **k: (_ for _ in ()).throw(OSError("read-only")))
    store.upsert(subscription(), rules())
    store.flush()  # still failing: stays dirty
    monkeypatch.setattr(os, "replace", real_replace)
    store.flush()
    assert json.loads(path.read_text())["subs"][0]["endpoint"] == FCM


def test_a_row_not_seen_for_a_month_is_dropped_by_the_round(tmp_path):
    store = PushStore(tmp_path / "push.json", clock=lambda: NOW.timestamp())
    store.upsert(subscription(), rules())
    sender = FakeSender()
    dispatcher = Dispatcher(store, sender, public_key="PUBLIC", check_s=10, clock=lambda: NOW.timestamp())
    assert PUSH_ROW_TTL_DAYS == 30
    dispatcher.process(snap(), NOW + timedelta(days=29))
    assert store.get(FCM) is not None
    later = NOW + timedelta(days=31)
    dispatcher.process(snap([deal(1, at=later)]), later)
    assert store.get(FCM) is None and sender.sent == []
    assert json.loads((tmp_path / "push.json").read_text())["subs"] == []


def test_a_row_not_seen_for_a_month_is_dropped_on_load(tmp_path):
    path = tmp_path / "push.json"
    now = NOW.timestamp()
    row = {"endpoint": FCM, "keys": {"p256dh": P256DH, "auth": AUTH}, "rules": rules(), "state": {}}
    stale = {**row, "endpoint": FCM + "-stale", "last_seen": now - 31 * 86400}
    fresh = {**row, "last_seen": now - 29 * 86400}
    path.write_text(json.dumps({"subs": [stale, fresh], "dead": []}))
    store = PushStore(path, clock=lambda: now)
    assert len(store) == 1 and store.get(FCM) is not None


def test_an_unreadable_store_is_set_aside(tmp_path, caplog):
    path = tmp_path / "push.json"
    path.write_text("{not json")
    with caplog.at_level(logging.WARNING):
        store = PushStore(path)
    assert len(store) == 0
    assert (tmp_path / "push.json.corrupt").exists()


def test_rows_that_do_not_check_out_are_dropped_on_load(tmp_path):
    path = tmp_path / "push.json"
    good = {"endpoint": FCM, "keys": {"p256dh": P256DH, "auth": AUTH}, "rules": rules(), "state": {}}
    evil = {**good, "endpoint": "https://evil.example/x"}
    path.write_text(json.dumps({"subs": [good, evil, "junk"], "dead": []}))
    store = PushStore(path)
    assert len(store) == 1 and store.get(FCM) is not None


def test_concurrent_upserts_are_all_kept(tmp_path):
    store = PushStore(tmp_path / "push.json")
    threads = [threading.Thread(target=store.upsert, args=(subscription(f"{FCM}-{i}"), rules())) for i in range(20)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(store) == 20
    assert len(json.loads((tmp_path / "push.json").read_text())["subs"]) == 20


# --- the push service's answers -----------------------------------------------------------------------------------

@pytest.mark.parametrize("status", [404, 410])
def test_a_gone_subscription_is_deleted_and_stays_gone(tmp_path, status):
    store, sender, dispatcher = setup(tmp_path, status=status)
    assert dispatcher.send_test(FCM, NOW) == "gone"
    assert store.get(FCM) is None
    assert store.upsert(subscription(), rules()) == "dead"  # the device learns it was unsubscribed


def test_other_failures_back_off_and_never_raise(tmp_path):
    store, sender, dispatcher = setup(tmp_path, rule=rules(follows=["nba:10", "nba:11", "nba:12"]), status=500)
    dispatcher.process(snap(), NOW)
    dispatcher.process(snap([deal(1)]), NOW + timedelta(seconds=10))
    assert len(sender.sent) == 1
    sender.status = 201
    dispatcher.process(snap([deal(1), deal(2, player_id=11)]), NOW + timedelta(seconds=20))
    assert len(sender.sent) == 1  # still backing off
    dispatcher.process(snap([deal(3, player_id=12)]), NOW + timedelta(minutes=3))
    assert len(sender.sent) == 2  # tried again once the wait is over
    assert store.get(FCM) is not None


def test_a_sender_that_raises_never_reaches_the_caller(tmp_path):
    store, sender, dispatcher = setup(tmp_path, status=RuntimeError("network down"))
    dispatcher.process(snap(), NOW)
    dispatcher.process(snap([deal(1)]), NOW + timedelta(seconds=10))
    assert len(sender.sent) == 1
    assert store.get(FCM) is not None


def test_garbage_never_reaches_the_caller(tmp_path):
    store, sender, dispatcher = setup(tmp_path)
    dispatcher.process({"deals": "nope"}, NOW)
    dispatcher.process(snap([{"listing_id": "x"}]), NOW)
    dispatcher.notify(None, None)
    assert sender.sent == []


def test_notify_only_queues_and_the_queue_is_bounded(tmp_path):
    store, sender, dispatcher = setup(tmp_path)
    for i in range(50):
        dispatcher.notify(snap([deal(i)]), NOW)
    assert sender.sent == []
    assert dispatcher.queued() <= push.PUSH_QUEUE


def test_the_thread_sends_what_was_queued(tmp_path):
    store, sender, dispatcher = setup(tmp_path)
    dispatcher.start()
    try:
        dispatcher.notify(snap(), NOW)
        dispatcher.notify(snap([deal(1)]), NOW + timedelta(seconds=10))
        dispatcher.wait_idle(timeout=5)
    finally:
        dispatcher.stop()
    assert [p["tag"] for p in sender.payloads] == ["deal:nba:10"]


def test_an_endpoint_off_the_allowlist_is_never_sent_to(tmp_path, monkeypatch):
    store, sender, dispatcher = setup(tmp_path)
    monkeypatch.setattr(push, "endpoint_allowed", lambda endpoint: False)  # say the allowlist shrank since
    assert dispatcher.send_test(FCM, NOW) == "gone"
    assert sender.sent == []
    assert store.get(FCM) is None


# --- limits ----------------------------------------------------------------------------------------------------------

def test_the_thirteenth_in_an_hour_is_refused(tmp_path):
    follows = [f"nba:{i}" for i in range(1, 14)]
    store, sender, dispatcher = setup(tmp_path, rule=rules(follows=follows))
    dispatcher.process(snap(), NOW)
    dispatcher.process(snap([deal(100 + i, player_id=i) for i in range(1, 14)]), NOW + timedelta(seconds=10))
    assert PUSH_PER_HOUR == 12
    assert len(sender.sent) == 12
    later = NOW + timedelta(minutes=61)
    dispatcher.process(snap([deal(200, player_id=13, at=later)]), later)
    assert len(sender.sent) == 13  # an hour later there is room again


def test_one_tag_waits_out_its_cooldown(tmp_path):
    store, sender, dispatcher = setup(tmp_path)
    dispatcher.process(snap(), NOW)
    dispatcher.process(snap([deal(1)]), NOW + timedelta(minutes=1))
    dispatcher.process(snap([deal(1), deal(2)]), NOW + timedelta(minutes=6))
    assert len(sender.sent) == 1
    assert PUSH_TAG_COOLDOWN_S == 900
    dispatcher.process(snap([deal(3)]), NOW + timedelta(minutes=17))
    assert len(sender.sent) == 2


@pytest.mark.parametrize(("quiet", "offset_min", "sent"), [
    ([17, 19], 0, 0),  # 18:00 is inside 17:00-19:00
    ([17, 19], -600, 1),  # 08:00 there
    ([23, 7], 480, 0),  # 02:00 there: the default night wraps over midnight
    ([23, 7], 0, 1),
    (None, 480, 1),  # no quiet hours at all
    ([18, 20], 0, 0),  # the quiet hours start on their first hour ...
    ([16, 18], 0, 1),  # ... and are over at their last one: 16:00 to 18:00 lets an alert at 18:00 go
    ([22, 18], 0, 1),  # the same when they wrap over midnight
    ([18, 7], 0, 0),
])
def test_quiet_hours(tmp_path, quiet, offset_min, sent):
    store, sender, dispatcher = setup(tmp_path, rule=rules(quiet=quiet, utc_offset_min=offset_min))
    dispatcher.process(snap(), NOW)
    dispatcher.process(snap([deal(1)]), NOW + timedelta(seconds=10))
    assert len(sender.sent) == sent


def test_deleting_and_subscribing_again_does_not_reset_the_test_limit(tmp_path):
    store, sender, dispatcher = setup(tmp_path)
    for _ in range(4):
        assert store.upsert(subscription(), rules()) == "ok"
        for _ in range(3):
            dispatcher.send_test(FCM, NOW)
        store.delete(FCM)
    assert len(sender.sent) == 3


def test_tests_have_a_budget_for_the_whole_server(tmp_path):
    store, sender, dispatcher = setup(tmp_path)
    endpoints = [f"{FCM}-{i}" for i in range(PUSH_TEST_GLOBAL_PER_HOUR + 1)]
    for endpoint in endpoints:
        store.upsert(subscription(endpoint), rules())
    results = [dispatcher.send_test(endpoint, NOW) for endpoint in endpoints]
    assert PUSH_TEST_GLOBAL_PER_HOUR == 60
    assert results.count("sent") == 60 and results[-1] == "limited"
    assert dispatcher.send_test(endpoints[-1], NOW + timedelta(minutes=61)) == "sent"


def test_a_test_ignores_quiet_hours_and_is_limited_to_three_an_hour(tmp_path):
    store, sender, dispatcher = setup(tmp_path, rule=rules(quiet=[0, 23]))
    assert [dispatcher.send_test(FCM, NOW) for _ in range(4)] == ["sent", "sent", "sent", "limited"]
    assert dispatcher.send_test(FCM, NOW + timedelta(minutes=61)) == "sent"
    assert dispatcher.send_test(FCM + "-other", NOW) == "unknown"
    assert sender.payloads[0]["tag"] == "test"


# --- what each alert matches ----------------------------------------------------------------------------------------

def test_a_new_deal_on_a_followed_player_says_what_it_is(tmp_path):
    store, sender, dispatcher = setup(tmp_path)
    dispatcher.process(snap([deal(1, player_id=99)]), NOW)  # deals there from the start are not new
    dispatcher.process(snap([deal(1, player_id=99), deal(7, price=1250, reference=2100, discount=0.404)]),
                       NOW + timedelta(seconds=10))
    (payload,) = sender.payloads
    assert payload == {
        "title": "New deal on a player you follow",
        "body": "Test Player · 1,250 Rax to start, 40% under usual",
        "tag": "deal:nba:10",
        "url": "/?open=7#deals",
        "icon": "/icon-192.png",
    }


def test_a_deal_that_leaves_and_comes_back_is_not_announced_twice(tmp_path):
    store, sender, dispatcher = setup(tmp_path)
    dispatcher.process(snap(), NOW)
    dispatcher.process(snap([deal(1)]), NOW + timedelta(seconds=10))
    dispatcher.process(snap(), NOW + timedelta(minutes=1))
    later = NOW + timedelta(minutes=20)  # past the cooldown
    dispatcher.process(snap([deal(1, at=later)]), later)
    assert len(sender.sent) == 1


def test_one_row_that_breaks_never_stops_the_others(tmp_path, monkeypatch):
    store, sender, dispatcher = setup(tmp_path)
    store.upsert(subscription(FCM + "-second"), rules())
    real_claim = store.claim

    def claim(endpoint, *args, **kwargs):
        if endpoint == FCM:
            raise RuntimeError("a broken row")
        return real_claim(endpoint, *args, **kwargs)

    monkeypatch.setattr(store, "claim", claim)
    dispatcher.process(snap(), NOW)
    dispatcher.process(snap([deal(1)]), NOW + timedelta(seconds=10))
    assert [endpoint for endpoint, *_ in sender.sent] == [FCM + "-second"]


def test_rows_that_break_make_one_log_line_with_counts_and_one_traceback(tmp_path, monkeypatch, caplog):
    store, sender, dispatcher = setup(tmp_path)
    for n in range(4):
        store.upsert(subscription(FCM + f"-{n}"), rules())

    def claim(endpoint, *args, **kwargs):
        # the setup's own row (...token-1) and -0, -1, -2 raise one class; -3 another
        raise RuntimeError("a broken row") if not endpoint.endswith("-3") else KeyError("odd")

    monkeypatch.setattr(store, "claim", claim)
    dispatcher.process(snap(), NOW)
    caplog.clear()
    with caplog.at_level(logging.ERROR, logger="advisor.push"):
        dispatcher.process(snap([deal(1)]), NOW + timedelta(seconds=10))
    errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert len(errors) == 1  # five rows, one line
    message = errors[0].getMessage()
    assert "5 of 5" in message and "KeyError x1" in message and "RuntimeError x4" in message
    assert errors[0].exc_info is not None  # and one traceback


def test_a_round_where_every_row_serves_logs_no_error(tmp_path, caplog):
    store, sender, dispatcher = setup(tmp_path)
    with caplog.at_level(logging.ERROR, logger="advisor.push"):
        dispatcher.process(snap(), NOW)
    assert [r for r in caplog.records if r.levelno >= logging.ERROR] == []


def test_a_new_deal_matches_by_follow_key(tmp_path):
    store, sender, dispatcher = setup(tmp_path, rule=rules(follows=["nba:10"]))
    dispatcher.process(snap(), NOW)
    dispatcher.process(snap([deal(1, player_id=11), deal(2, sport="mlb", player_id=10)]), NOW + timedelta(seconds=10))
    assert sender.sent == []


def test_a_new_deal_matches_by_level_and_budget(tmp_path):
    store, sender, dispatcher = setup(tmp_path, rule=rules(level="new", budget=200))
    dispatcher.process(snap(), NOW)
    dispatcher.process(snap([
        deal(1, kind="bid", ends_in_s=600),  # New sees no bids
        deal(2, price=300),  # over budget
        deal(3, falling=True),  # New hides falling markets
        deal(4, confidence="medium"),  # New wants a sure usual price
        deal(5, discount=0.21),  # under New's 25 %
    ]), NOW + timedelta(seconds=10))
    assert sender.sent == []
    dispatcher.process(snap([deal(6, price=150, discount=0.3)]), NOW + timedelta(seconds=20))
    assert [p["url"] for p in sender.payloads] == ["/?open=6#deals"]


def test_a_deal_of_a_player_who_most_likely_misses_the_game_is_not_sent_to_new_but_is_to_the_others(tmp_path):
    for status in ("out", "suspended", "doubtful"):
        store, sender, dispatcher = setup(tmp_path / status, rule=rules(level="new", budget=200))
        dispatcher.process(snap(), NOW)
        dispatcher.process(snap([deal(1, price=150, discount=0.3, injury=status)]), NOW + timedelta(seconds=10))
        assert sender.sent == [], status
    store, sender, dispatcher = setup(tmp_path / "regular", rule=rules(level="regular", budget=200))
    dispatcher.process(snap(), NOW)
    dispatcher.process(snap([deal(1, price=150, discount=0.3, injury="out")]), NOW + timedelta(seconds=10))
    assert len(sender.payloads) == 1


def test_a_deal_of_a_player_who_may_well_play_is_still_sent_to_new(tmp_path):
    for status in ("questionable", "day"):
        store, sender, dispatcher = setup(tmp_path / status, rule=rules(level="new", budget=200))
        dispatcher.process(snap(), NOW)
        dispatcher.process(snap([deal(1, price=150, discount=0.3, injury=status)]), NOW + timedelta(seconds=10))
        assert len(sender.payloads) == 1, status


def test_a_bid_deal_matches_only_inside_the_levels_bid_window(tmp_path):
    store, sender, dispatcher = setup(tmp_path, rule=rules(level="regular", follows=["nba:10", "nba:11"]))
    dispatcher.process(snap(), NOW)
    dispatcher.process(snap([deal(1, kind="bid", ends_in_s=45 * 60), deal(2, player_id=11, kind="bid", ends_in_s=600,
                                                                             price=90)]), NOW + timedelta(seconds=10))
    assert [p["body"] for p in sender.payloads] == ["Test Player · 90 Rax top bid, 41% under usual"]


def test_a_category_that_is_off_sends_nothing(tmp_path):
    store, sender, dispatcher = setup(tmp_path, rule=rules(categories={**ALL_ON, "deals": False}))
    dispatcher.process(snap(), NOW)
    dispatcher.process(snap([deal(1)]), NOW + timedelta(seconds=10))
    assert sender.sent == []


def test_last_call_only_for_an_opened_deal_still_listed_and_only_once(tmp_path):
    store, sender, dispatcher = setup(tmp_path, rule=rules(opened=[5, 6], categories={**ALL_ON, "deals": False}))
    soon = PUSH_LAST_CALL_S - 60
    deals = [
        deal(5, kind="bid", price=480, ends_in_s=soon, name="Ann Bee"),
        deal(7, ends_in_s=soon),  # never opened here
    ]  # 6 was opened but is no longer a deal
    dispatcher.process(snap(deals), NOW)
    dispatcher.process(snap(deals), NOW + timedelta(seconds=10))
    assert sender.payloads == [{
        "title": "Last call", "body": "Ann Bee · ends in under 3 min, top bid 480 Rax", "tag": "last:5",
        "url": "/?open=5#deals", "icon": "/icon-192.png",
    }]
    assert sender.sent[0][3] == "high"


def test_last_call_names_the_price_to_start_a_target_deal(tmp_path):
    store, sender, dispatcher = setup(tmp_path, rule=rules(opened=[5], categories={**ALL_ON, "deals": False}))
    dispatcher.process(snap([deal(5, price=150, ends_in_s=100)]), NOW)
    assert [p["body"] for p in sender.payloads] == ["Test Player · ends in under 3 min, 150 Rax to start"]


def test_last_call_is_never_sent_for_a_deal_that_left_the_list(tmp_path):
    # The listing may still be open in Real (someone started its countdown), but it is no longer a deal here: an
    # alert would call open what the page then shows as gone.
    store, sender, dispatcher = setup(tmp_path, rule=rules(opened=[5], categories={**ALL_ON, "deals": False}))
    left = {**deal(5, ends_in_s=100), "reason": "countdown_started", "gone_at": iso(NOW)}
    dispatcher.process({**snap(), "gone": [left]}, NOW)
    assert sender.sent == []


def test_last_call_waits_until_the_end_is_near(tmp_path):
    store, sender, dispatcher = setup(tmp_path, rule=rules(opened=[5]))
    dispatcher.process(snap([deal(5, ends_in_s=600)]), NOW)
    assert sender.sent == []
    dispatcher.process(snap([deal(5, ends_in_s=-1)]), NOW)  # already over
    assert sender.sent == []


def test_last_call_checks_the_clock_again_right_before_sending(tmp_path):
    # The round runs late (a slow push service before it): the auction ended in the meantime.
    later = (NOW + timedelta(seconds=150)).timestamp()
    store, sender, dispatcher = setup(tmp_path, rule=rules(opened=[5], categories={**ALL_ON, "deals": False}),
                                      clock=later)
    dispatcher.process(snap([deal(5, ends_in_s=120)]), NOW)
    assert sender.sent == []


def test_a_price_move_once_a_day_per_player(tmp_path):
    store, sender, dispatcher = setup(tmp_path, rule=rules(follows=["nba:10", "nba:11"]))
    moves = snap(risers=[move(10, 0.25), move(10, 0.31)], fallers=[move(11, -0.22, name="Cy Dee"), move(12, -0.5)])
    dispatcher.process(moves, NOW)
    assert PUSH_MOVE_MIN == 0.20
    assert sorted(p["body"] for p in sender.payloads) == [
        "Cy Dee prices are down 22% today", "Test Player prices are up 31% today",  # its biggest move
    ]
    assert {p["url"] for p in sender.payloads} == {"/#prices"}
    dispatcher.process(moves, NOW + timedelta(hours=1))
    assert len(sender.sent) == 2
    dispatcher.process(moves, NOW + timedelta(days=1))
    assert len(sender.sent) == 4


def test_a_small_move_is_not_news(tmp_path):
    store, sender, dispatcher = setup(tmp_path)
    dispatcher.process(snap(risers=[move(10, 0.19)]), NOW)
    assert sender.sent == []


def test_the_digest_once_a_day_at_its_hour_with_the_best_three(tmp_path):
    rule = rules(follows=[], digest_hour=9, utc_offset_min=-540)  # 18:00 UTC is 09:00 there
    store, sender, dispatcher = setup(tmp_path, rule=rule)
    deals = [deal(i, player_id=i, discount=0.2 + i / 100, name=f"P{i}") for i in range(1, 6)]
    dispatcher.process(snap(deals), NOW)
    (payload,) = sender.payloads
    assert payload["title"] == "Today's 3 best deals for you"
    assert payload["body"] == "P5 25% under · P4 24% under · P3 23% under"
    assert (payload["tag"], payload["url"]) == ("digest", "/#today")
    dispatcher.process(snap(deals), NOW + timedelta(minutes=30))
    assert len(sender.sent) == 1
    dispatcher.process(snap(deals), NOW + timedelta(hours=2))  # past its hour
    assert len(sender.sent) == 1
    tomorrow = NOW + timedelta(days=1)
    dispatcher.process(snap([deal(i, player_id=i, discount=0.3, name=f"P{i}", at=tomorrow) for i in range(1, 3)]),
                       tomorrow)
    assert len(sender.sent) == 2


def test_no_digest_when_nothing_fits(tmp_path):
    store, sender, dispatcher = setup(tmp_path, rule=rules(follows=[], digest_hour=18, budget=50))
    dispatcher.process(snap([deal(1, price=100)]), NOW)
    assert sender.sent == []


def test_the_digest_respects_quiet_hours(tmp_path):
    store, sender, dispatcher = setup(tmp_path, rule=rules(follows=[], digest_hour=18, quiet=[17, 20]))
    dispatcher.process(snap([deal(1)]), NOW)
    assert sender.sent == []


NONE_ON = {"deals": False, "last_call": False, "moves": False, "digest": False, "routine": False}


def routine_only(**overrides):
    return rules(follows=[], categories={**NONE_ON, "routine": True}, **overrides)


def test_the_routine_reminder_comes_once_a_day_at_the_digest_hour(tmp_path):
    store, sender, dispatcher = setup(tmp_path, rule=routine_only(digest_hour=9, utc_offset_min=-540))
    dispatcher.process(snap([]), NOW)  # 18:00 UTC is 09:00 there; no deal is needed for it
    (payload,) = sender.payloads
    assert payload["title"] == "Your daily checklist"
    assert payload["body"] == "A few small things to do today, about five minutes."
    assert (payload["tag"], payload["url"]) == ("routine", "/#today")
    dispatcher.process(snap([]), NOW + timedelta(minutes=30))
    assert len(sender.sent) == 1  # once a day
    dispatcher.process(snap([]), NOW + timedelta(hours=2))  # past its hour
    assert len(sender.sent) == 1
    dispatcher.process(snap([], at=NOW + timedelta(days=1)), NOW + timedelta(days=1))
    assert len(sender.sent) == 2


def test_the_routine_reminder_is_off_until_chosen_and_stays_off_with_the_other_four_on(tmp_path):
    store, sender, dispatcher = setup(tmp_path, rule=rules(follows=[], digest_hour=18))  # ALL_ON has no routine
    dispatcher.process(snap([]), NOW)
    assert sender.sent == []


def test_the_routine_reminder_respects_quiet_hours(tmp_path):
    store, sender, dispatcher = setup(tmp_path, rule=routine_only(digest_hour=18, quiet=[17, 20]))
    dispatcher.process(snap([]), NOW)
    assert sender.sent == []


def test_the_routine_reminder_and_the_digest_are_two_notices(tmp_path):
    store, sender, dispatcher = setup(
        tmp_path, rule=rules(follows=[], digest_hour=18, categories={**NONE_ON, "digest": True, "routine": True}))
    dispatcher.process(snap([deal(1)]), NOW)
    assert sorted(p["tag"] for p in sender.payloads) == ["digest", "routine"]


def test_a_routine_flag_that_is_not_a_boolean_is_refused():
    for bad in ("yes", 1, None, [], {}):
        assert parse_subscription(body(rule=rules(categories={"routine": bad}))) is None


def test_an_old_page_that_does_not_know_the_routine_category_still_subscribes():
    _, rule = parse_subscription(body(rule=rules(categories=dict(ALL_ON))))
    assert rule["categories"] == {**ALL_ON, "routine": False}


def test_one_best_deal_is_named_as_one(tmp_path):
    store, sender, dispatcher = setup(tmp_path, rule=rules(follows=[], digest_hour=18))
    dispatcher.process(snap([deal(1)]), NOW)
    assert sender.payloads[0]["title"] == "Today's best deal for you"


# --- VAPID ------------------------------------------------------------------------------------------------------------

def mint() -> tuple[str, str]:
    """A fresh VAPID keypair as the environment holds it: the raw private scalar and the public point, base64url."""
    key = ec.generate_private_key(ec.SECP256R1())
    public = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return b64(key.private_numbers().private_value.to_bytes(32, "big")), b64(public)


def vapid_env(**overrides):
    private, public = mint()
    env = {"ADVISOR_VAPID_PRIVATE": private, "ADVISOR_VAPID_PUBLIC": public,
           "ADVISOR_VAPID_SUBJECT": "https://marketpalace.example/contact"}
    return {**env, **overrides}


def test_no_vapid_means_no_push_and_no_noise(caplog):
    with caplog.at_level(logging.WARNING):
        assert config_from_env({}) is None
    assert caplog.records == []


def test_a_minted_keypair_configures_push():
    env = vapid_env()
    config = config_from_env(env)
    assert config is not None
    assert config.public_key == env["ADVISOR_VAPID_PUBLIC"]
    assert config.subject == "https://marketpalace.example"  # push services are shown the site's origin only
    assert config.vapid.sign({"sub": config.subject, "aud": "https://fcm.googleapis.com"})["Authorization"].startswith(
        "vapid t="
    )


@pytest.mark.parametrize("overrides", [
    {"ADVISOR_VAPID_PUBLIC": ""},  # half set
    {"ADVISOR_VAPID_SUBJECT": ""},
    {"ADVISOR_VAPID_SUBJECT": "mailto:nobody"},
    {"ADVISOR_VAPID_SUBJECT": "mailto:alerts@marketpalace.example?subject=hi"},
    {"ADVISOR_VAPID_SUBJECT": "http://marketpalace.example/"},
    {"ADVISOR_VAPID_SUBJECT": "https://marketpalace.example:8443/"},
    {"ADVISOR_VAPID_SUBJECT": "https://[::1/"},
    {"ADVISOR_VAPID_PRIVATE": "-----BEGIN PRIVATE KEY-----\nMIGH\n-----END PRIVATE KEY-----"},  # PEM is refused
    {"ADVISOR_VAPID_PRIVATE": b64(bytes(31))},
    {"ADVISOR_VAPID_PUBLIC": mint()[1]},  # not the private key's half
])
def test_a_bad_vapid_setting_turns_push_off_with_a_warning(overrides, caplog):
    with caplog.at_level(logging.WARNING):
        assert config_from_env(vapid_env(**overrides)) is None
    assert caplog.records


def test_the_keypair_script_refuses_a_directory_inside_the_repository(capsys):
    inside = Path(__file__).resolve().parent.parent / "scripts"
    before = sorted(p.name for p in inside.iterdir())
    assert gen_vapid.main([str(inside)]) != 0
    assert sorted(p.name for p in inside.iterdir()) == before
    assert "repository" in capsys.readouterr().err


_ROOT = Path(__file__).resolve().parent.parent


def _in_a_checkout() -> bool:
    """Whether git is there and the repository is a checkout (a source archive or an image has no .git)."""
    if shutil.which("git") is None:
        return False
    return subprocess.run(["git", "rev-parse", "--is-inside-work-tree"], cwd=_ROOT, capture_output=True).returncode == 0


def _git_ignores(path: str) -> bool:
    return subprocess.run(["git", "check-ignore", "-q", path], cwd=_ROOT, capture_output=True).returncode == 0


@pytest.mark.skipif(not _in_a_checkout(), reason="needs git and a checkout")
def test_key_files_are_ignored_by_git():
    assert _git_ignores("vapid_private.txt") and _git_ignores("deploy/vapid_public.txt")


@pytest.mark.skipif(not _in_a_checkout(), reason="needs git and a checkout")
def test_git_ignores_the_servers_data_directory_but_not_the_front_ends_data_code():
    assert _git_ignores("data/clicks.json") and _git_ignores("data/push.json")
    assert not _git_ignores("frontend/src/data/zzz.ts")


def test_a_mailto_of_the_site_is_a_subject_too():
    assert config_from_env(vapid_env(ADVISOR_VAPID_SUBJECT="mailto:alerts@marketpalace.example")).subject == (
        "mailto:alerts@marketpalace.example"
    )


@pytest.mark.skipif(shutil.which("openssl") is None, reason="scripts/gen_vapid.py needs the openssl command")
def test_the_keypair_script_makes_keys_the_server_takes(tmp_path, capsys):
    assert gen_vapid.main([str(tmp_path)]) == 0
    private = (tmp_path / "vapid_private.txt").read_text()
    public = (tmp_path / "vapid_public.txt").read_text()
    assert private not in capsys.readouterr().out  # the private key is never printed
    config = config_from_env({"ADVISOR_VAPID_PRIVATE": private, "ADVISOR_VAPID_PUBLIC": public,
                              "ADVISOR_VAPID_SUBJECT": "https://marketpalace.example"})
    assert config is not None and config.public_key == public


# --- the real sender, under a fake HTTP adapter --------------------------------------------------------------------

def browser():
    key = ec.generate_private_key(ec.SECP256R1())
    public = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    auth = os.urandom(16)
    return key, {"p256dh": b64(public), "auth": b64(auth)}, auth


class FakeAdapter:
    def __init__(self, status=201, location=None):
        self.status, self.location, self.requests = status, location, []

    def __call__(self, request, **kwargs):  # set on the class, it is called without the adapter itself
        self.requests.append(request)
        response = requests.Response()
        response.status_code = self.status
        response.reason = "Fake"
        response.url = request.url
        response.request = request
        response._content = b""
        if self.location:
            response.headers["Location"] = self.location
        return response


def test_the_sender_encrypts_signs_and_posts_once(monkeypatch):
    fake = FakeAdapter(201)
    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", fake)
    config = config_from_env(vapid_env())
    key, keys, auth = browser()
    status = WebPushSender(config)(FCM, keys, b'{"title":"Hi"}', 60, "normal")
    assert status == 201
    (request,) = fake.requests
    assert request.url == FCM
    assert request.headers["Authorization"].startswith("vapid t=")
    assert f"k={config.public_key}" in request.headers["Authorization"]
    assert (request.headers["Content-Encoding"], request.headers["TTL"]) == ("aes128gcm", "60")
    assert http_ece.decrypt(request.body, private_key=key, auth_secret=auth, version="aes128gcm") == b'{"title":"Hi"}'


@pytest.mark.parametrize("status", [301, 302, 307, 308])
def test_the_sender_never_follows_a_redirect(monkeypatch, status):
    fake = FakeAdapter(status, location="https://evil.example/collect")
    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", fake)
    _, keys, _ = browser()
    assert WebPushSender(config_from_env(vapid_env()))(FCM, keys, b"{}", 60, "normal") == status
    assert len(fake.requests) == 1


def test_the_sender_refuses_an_endpoint_off_the_allowlist(monkeypatch):
    fake = FakeAdapter(201)
    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", fake)
    _, keys, _ = browser()
    assert WebPushSender(config_from_env(vapid_env()))("https://evil.example/x", keys, b"{}", 60, "normal") == 0
    assert fake.requests == []


def test_a_network_failure_is_a_failed_send(monkeypatch):
    def boom(*args, **kwargs):
        raise requests.ConnectionError("down")

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", boom)
    _, keys, _ = browser()
    assert WebPushSender(config_from_env(vapid_env()))(FCM, keys, b"{}", 60, "normal") == 0


# --- the Discord gate's say over who gets alerts ----------------------------------------------------------------------

MEMBER = {"uid": "111122223333444455", "iat": 1_800_000_000}


def test_a_subscription_made_by_a_member_keeps_who_made_it_across_a_restart(tmp_path):
    path = tmp_path / "push.json"
    PushStore(path).upsert(subscription(), rules(), member=MEMBER)
    assert PushStore(path).get(FCM)["member"] == MEMBER
    PushStore(path).upsert(subscription(), rules(), member=MEMBER | {"iat": 1_800_000_500})  # a new login is kept
    assert PushStore(path).get(FCM)["member"]["iat"] == 1_800_000_500


def test_a_stored_member_that_is_not_one_is_dropped_on_load(tmp_path):
    path = tmp_path / "push.json"
    PushStore(path).upsert(subscription(), rules(), member=MEMBER)
    saved = json.loads(path.read_text())
    saved["subs"][0]["member"] = {"uid": "../etc", "iat": "soon"}
    path.write_text(json.dumps(saved))
    assert "member" not in PushStore(path).get(FCM)


def test_the_dispatcher_drops_and_never_alerts_a_subscription_the_gate_no_longer_allows(tmp_path):
    store, sender, dispatcher = setup(tmp_path)
    asked = []
    dispatcher.allowed = lambda row: asked.append(row.get("member")) or False
    dispatcher.process(snap([deal(1, player_id=99)]), NOW)
    dispatcher.process(snap([deal(1, player_id=99), deal(7)]), NOW + timedelta(seconds=10))
    assert sender.sent == [] and store.get(FCM) is None and asked == [None]


def test_without_a_gate_every_subscription_is_served_as_before(tmp_path):
    store, sender, dispatcher = setup(tmp_path)
    assert dispatcher.allowed is None
    dispatcher.process(snap([deal(1, player_id=99)]), NOW)
    dispatcher.process(snap([deal(1, player_id=99), deal(7)]), NOW + timedelta(seconds=10))
    assert len(sender.sent) == 1


def test_a_digest_that_failed_to_send_is_tried_again_within_its_hour(tmp_path):
    rule = rules(follows=[], digest_hour=9, utc_offset_min=-540)
    store, sender, dispatcher = setup(tmp_path, rule=rule, status=503)
    deals = [deal(i, player_id=i, discount=0.2 + i / 100, name=f"P{i}") for i in range(1, 4)]
    dispatcher.process(snap(deals), NOW)
    assert len(sender.sent) == 1  # the push service was down
    sender.status = 201
    dispatcher.process(snap(deals), NOW + timedelta(minutes=5))  # the wait (60 s) is over, still 09:00 there
    assert len(sender.sent) == 2
    assert sender.payloads[1]["tag"] == "digest"
