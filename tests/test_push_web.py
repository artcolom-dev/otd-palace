"""The push routes, the service worker served from the root, and the snapshot's push link."""

import json
from pathlib import Path

from advisor import web
from advisor.push import Dispatcher, PushStore
from advisor.rules import PUSH_CLIENT_PER_MIN, PUSH_MAX_BYTES
from advisor.store import SnapshotStore
from advisor.web import create_app
from tests.test_push import ALL_ON, FCM, FakeSender, body, rules, subscription

PUBLIC = "BPublicKeyForTests"
HTML = "<html><body><div id=root></div><!--SNAPSHOT--></body></html>"


def client_with(tmp_path, push=True, status=201):
    (tmp_path / "index.html").write_text(HTML)
    store = PushStore(tmp_path / "push.json")
    sender = FakeSender(status)
    dispatcher = Dispatcher(store, sender, public_key=PUBLIC, check_s=10) if push else None
    return create_app(SnapshotStore(), tmp_path, push=dispatcher).test_client(), store, sender


def put(client, data: bytes, content_type="application/json", headers=None):
    return client.put("/api/push/subscription", data=data, content_type=content_type, headers=headers or {})


def no_cookie_no_store(response):
    assert "Set-Cookie" not in response.headers
    assert response.headers["Cache-Control"] == "no-store"


def test_every_push_route_is_404_while_push_is_off(tmp_path):
    client, _, _ = client_with(tmp_path, push=False)
    assert client.get("/api/push/key").status_code == 404
    assert put(client, body()).status_code == 404
    assert client.delete("/api/push/subscription", json={"endpoint": FCM}).status_code == 404
    assert client.post("/api/push/test", json={"endpoint": FCM}).status_code == 404


def test_the_public_key(tmp_path):
    client, _, _ = client_with(tmp_path)
    r = client.get("/api/push/key")
    assert (r.status_code, r.get_json()) == (200, {"public_key": PUBLIC})
    no_cookie_no_store(r)


def test_subscribe_update_and_delete(tmp_path):
    client, store, _ = client_with(tmp_path)
    r = put(client, body())
    assert r.status_code == 204
    no_cookie_no_store(r)
    assert store.get(FCM)["rules"] == {**rules(), "categories": {**rules()["categories"], "routine": False}, "quiet": None}
    assert put(client, body(rule=rules(level="new"))).status_code == 204
    assert store.get(FCM)["rules"]["level"] == "new"
    r = client.delete("/api/push/subscription", json={"endpoint": FCM})
    assert r.status_code == 204
    no_cookie_no_store(r)
    assert store.get(FCM) is None
    assert client.delete("/api/push/subscription", json={"endpoint": FCM}).status_code == 204


def test_a_subscription_is_json_only_and_capped(tmp_path):
    client, store, _ = client_with(tmp_path)
    assert put(client, body(), content_type="text/plain").status_code == 415
    assert put(client, b"{nope").status_code == 400
    assert put(client, body(sub=subscription("https://evil.example/x"))).status_code == 400
    big = body(padding="x" * PUSH_MAX_BYTES)
    r = put(client, big)
    assert r.status_code == 413
    no_cookie_no_store(r)
    assert len(store) == 0


def test_a_dead_subscription_is_told_so(tmp_path):
    client, store, _ = client_with(tmp_path, status=410)
    put(client, body())
    assert client.post("/api/push/test", json={"endpoint": FCM}).status_code == 410
    assert put(client, body()).status_code == 410  # the page turns its switch off


def test_a_full_store_refuses_newcomers(tmp_path):
    client, store, _ = client_with(tmp_path)
    store._max_subs = 0
    assert put(client, body()).status_code == 503


def test_send_a_test_three_times_an_hour(tmp_path):
    client, _, sender = client_with(tmp_path)
    put(client, body())
    codes = [client.post("/api/push/test", json={"endpoint": FCM}).status_code for _ in range(4)]
    assert codes == [204, 204, 204, 429]
    assert [p["title"] for p in sender.payloads] == ["Alerts are on"] * 3
    r = client.post("/api/push/test", json={"endpoint": FCM + "-unknown"})
    assert r.status_code == 404
    no_cookie_no_store(r)


def test_four_rounds_of_subscribe_three_tests_and_delete_send_three_tests(tmp_path):
    client, _, sender = client_with(tmp_path)
    for round_ in range(4):
        who = {"X-Real-IP": f"203.0.113.{round_}"}  # a fresh address each round: the per-address limit is not the guard
        assert client.put("/api/push/subscription", data=body(), content_type="application/json", headers=who).status_code == 204
        for _ in range(3):
            client.post("/api/push/test", json={"endpoint": FCM}, headers=who)
        assert client.delete("/api/push/subscription", json={"endpoint": FCM}, headers=who).status_code == 204
    assert len(sender.sent) == 3


def test_push_routes_are_rate_limited_per_address(tmp_path):
    client, _, _ = client_with(tmp_path)
    one, other = {"X-Real-IP": "198.51.100.7"}, {"X-Real-IP": "198.51.100.8"}
    codes = [put(client, body(), headers=one).status_code for _ in range(PUSH_CLIENT_PER_MIN)]
    assert codes == [204] * PUSH_CLIENT_PER_MIN
    r = put(client, body(), headers=one)
    assert r.status_code == 429
    no_cookie_no_store(r)
    assert client.delete("/api/push/subscription", json={"endpoint": FCM}, headers=one).status_code == 429
    assert client.post("/api/push/test", json={"endpoint": FCM}, headers=one).status_code == 429
    assert put(client, body(), headers=other).status_code == 204
    assert client.get("/api/push/key", headers=one).status_code == 200  # the key costs nothing


def test_every_category_off_answers_204_and_stores_nothing(tmp_path):
    client, store, _ = client_with(tmp_path)
    put(client, body())
    assert put(client, body(rule=rules(categories={c: False for c in ALL_ON}))).status_code == 204
    assert len(store) == 0


def test_a_test_that_fails_says_so(tmp_path):
    client, _, _ = client_with(tmp_path, status=500)
    put(client, body())
    assert client.post("/api/push/test", json={"endpoint": FCM}).status_code == 502


def test_the_service_worker_is_served_from_the_root(tmp_path):
    client, _, _ = client_with(tmp_path)
    (tmp_path / "sw.js").write_text("self.addEventListener('push', () => {});")
    r = client.get("/sw.js")
    assert r.status_code == 200
    assert r.mimetype == "text/javascript"
    assert r.headers["Cache-Control"] == "no-cache"
    assert r.headers["Service-Worker-Allowed"] == "/"
    assert "sw.js" in web.ROOT_FILES


def test_only_the_service_worker_gets_the_scope_header(tmp_path):
    client, _, _ = client_with(tmp_path)
    (tmp_path / "favicon.svg").write_text("<svg/>")
    assert "Service-Worker-Allowed" not in client.get("/favicon.svg").headers
    assert client.get("/other.js").status_code == 404


def test_the_front_end_ships_the_service_worker():
    public = Path(__file__).parent.parent / "frontend" / "public"
    assert (public / "sw.js").is_file()

