import gzip
import hmac
import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

from advisor import web
from advisor.clicks import ClickLog
from advisor.collector import run_collector
from advisor.store import SnapshotStore
from advisor.web import create_app

SNAPSHOT_TAG = '<script id="snapshot" type="application/json">'
CLICK = {"panel": "deals", "target": "listing", "level": "regular", "sport": "nba", "pos": 3}
TOKEN = "s3cret-token-for-tests"
# A snapshot whose deals cover nba and whose OTD passes also cover nfl.
SNAP = {"version": 1, "sports": ["nba"], "otd": {"picks": {"nba": [], "nfl": []}}}


def app_with(snapshot=None, html="<html><body><div id=root></div><!--SNAPSHOT--></body></html>", tmp_path=None,
             clicks=None, stats_token=None, **kw):
    if html is not None:
        (tmp_path / "index.html").write_text(html)
    store = SnapshotStore()
    if snapshot:
        store.publish(snapshot)
    return create_app(store, tmp_path, clicks=clicks, stats_token=stats_token, **kw).test_client()


def click_log(tmp_path):
    return ClickLog(tmp_path / "clicks.json", lambda: datetime(2026, 11, 12, 18, 0, tzinfo=timezone.utc))


def inlined_json(page: str) -> str:
    return page.split(SNAPSHOT_TAG, 1)[1].split("</script>", 1)[0]


def test_snapshot_warming_up(tmp_path):
    r = app_with(tmp_path=tmp_path).get("/api/snapshot")
    assert (r.status_code, r.get_json()) == (503, {"error": "warming up"})


def test_etag_and_304(tmp_path):
    c = app_with({"version": 1}, tmp_path=tmp_path)
    r = c.get("/api/snapshot")
    assert (r.status_code, r.headers["ETag"]) == (200, '"1"')
    assert r.headers["Cache-Control"] == "no-cache"
    assert r.get_json() == {"version": 1}
    again = c.get("/api/snapshot", headers={"If-None-Match": '"1"'})
    assert (again.status_code, again.get_data()) == (304, b"")
    assert c.get("/api/snapshot", headers={"If-None-Match": '"0"'}).status_code == 200


def test_every_snapshot_answer_names_the_build_so_an_open_page_knows_it_is_old(tmp_path):
    html = '<html><head><script type="module" crossorigin src="/assets/index-Ab12_c-D.js"></script></head>' \
           "<body><!--SNAPSHOT--></body></html>"
    c = app_with({"version": 1}, html=html, tmp_path=tmp_path)
    assert c.get("/api/snapshot").headers["X-Build"] == "index-Ab12_c-D.js"
    assert c.get("/api/snapshot", headers={"If-None-Match": '"1"'}).headers["X-Build"] == "index-Ab12_c-D.js"
    # A rebuilt front end is named at once.
    (tmp_path / "index.html").write_text(html.replace("Ab12_c-D", "Zz99"))
    assert c.get("/api/snapshot").headers["X-Build"] == "index-Zz99.js"


def test_a_page_with_no_built_entry_names_no_build(tmp_path):
    assert "X-Build" not in app_with({"version": 1}, tmp_path=tmp_path).get("/api/snapshot").headers
    assert "X-Build" not in app_with({"version": 1}, html=None, tmp_path=tmp_path).get("/api/snapshot").headers


GZIP = {"Accept-Encoding": "gzip, deflate, br"}
BIG ={"version": 9, "sports": ["nba"], "otd": {"markets": [{"key": f"nba:2025:player:{i}"} for i in range(300)]}}


def test_snapshot_is_gzipped_when_the_client_accepts_it(tmp_path):
    c = app_with(BIG, tmp_path=tmp_path)
    plain = c.get("/api/snapshot")
    packed = c.get("/api/snapshot", headers=GZIP)
    assert "Content-Encoding" not in plain.headers and json.loads(plain.get_data()) == BIG
    assert packed.headers["Content-Encoding"] == "gzip"
    assert json.loads(gzip.decompress(packed.get_data())) == BIG
    assert int(packed.headers["Content-Length"]) == len(packed.get_data()) < len(plain.get_data())
    # The version is the ETag; a strong validator differs by content coding, so the gzipped body has its own.
    assert (plain.headers["ETag"], packed.headers["ETag"]) == ('"9"', '"9-gz"')
    assert plain.headers["Vary"] == packed.headers["Vary"] == "Accept-Encoding"
    assert packed.headers["Cache-Control"] == "no-cache"


def test_snapshot_is_plain_when_gzip_is_refused(tmp_path):
    c = app_with(BIG, tmp_path=tmp_path)
    for header in ("identity", "gzip;q=0", "br"):
        r = c.get("/api/snapshot", headers={"Accept-Encoding": header})
        assert "Content-Encoding" not in r.headers and json.loads(r.get_data()) == BIG, header


def test_any_encoding_gets_gzip_unless_gzip_itself_is_refused(tmp_path):
    c = app_with(BIG, tmp_path=tmp_path)
    for header in ("*", "identity, *;q=0.5", "br, *"):
        r = c.get("/api/snapshot", headers={"Accept-Encoding": header})
        assert r.headers.get("Content-Encoding") == "gzip", header
        assert json.loads(gzip.decompress(r.get_data())) == BIG, header
    for header in ("*;q=0", "gzip;q=0, *", "*, gzip;q=0", "x-gzip;q=0, gzip;q=0, *"):
        r = c.get("/api/snapshot", headers={"Accept-Encoding": header})
        assert "Content-Encoding" not in r.headers and json.loads(r.get_data()) == BIG, header


def test_the_page_is_plain_when_gzip_is_refused(tmp_path):
    c = app_with(BIG, tmp_path=tmp_path)
    for header in ("gzip;q=0", "gzip;q=0, *;q=0", "identity"):
        r = c.get("/", headers={"Accept-Encoding": header})
        assert "Content-Encoding" not in r.headers, header
        assert r.headers["Vary"] == "Accept-Encoding", header
        assert json.loads(inlined_json(r.get_data(as_text=True))) == BIG, header


def test_head_answers_like_get_without_a_body(tmp_path):
    c = app_with(BIG, tmp_path=tmp_path)
    for path in ("/", "/api/snapshot"):
        for headers in ({}, GZIP):
            got, head = c.get(path, headers=headers), c.head(path, headers=headers)
            assert (head.status_code, head.get_data()) == (200, b""), (path, headers)
            for name in ("Content-Type", "Content-Encoding", "Content-Length", "Vary", "Cache-Control", "ETag"):
                assert head.headers.get(name) == got.headers.get(name), (path, headers, name)


def test_304_still_answers_a_gzip_client(tmp_path):
    c = app_with(BIG, tmp_path=tmp_path)
    again = c.get("/api/snapshot", headers={**GZIP, "If-None-Match": '"9"'})
    assert (again.status_code, again.get_data()) == (304, b"")
    assert (again.headers["ETag"], again.headers["Vary"]) == ('"9-gz"', "Accept-Encoding")
    assert again.headers["Cache-Control"] == "no-cache"
    assert c.get("/api/snapshot", headers={**GZIP, "If-None-Match": '"8"'}).status_code == 200


def test_304_matches_either_validator_of_the_current_version(tmp_path):
    c = app_with(BIG, tmp_path=tmp_path)
    for headers in ({}, GZIP):
        for tag in ('"9"', '"9-gz"', 'W/"9"', 'W/"9-gz"', '"3", "9-gz"', "*"):
            r = c.get("/api/snapshot", headers={**headers, "If-None-Match": tag})
            assert (r.status_code, r.get_data()) == (304, b""), (headers, tag)
            assert r.headers["ETag"] == ('"9-gz"' if headers else '"9"'), (headers, tag)
        for tag in ('"8"', '"8-gz"', '"9-br"', '"99"', '"9-gzip"'):
            assert c.get("/api/snapshot", headers={**headers, "If-None-Match": tag}).status_code == 200, tag


OTD_V = "0123456789ab"
PASSES = {**BIG, "otd_version": OTD_V, "deals": [{"listing_id": 1}]}
LEAN = {name: value for name, value in PASSES.items() if name != "otd"}


def test_a_poll_that_already_holds_the_passes_gets_the_snapshot_without_them(tmp_path):
    c = app_with(PASSES, tmp_path=tmp_path)
    full = c.get("/api/snapshot")
    lean = c.get(f"/api/snapshot?otd={OTD_V}")
    assert (full.get_json(), lean.get_json()) == (PASSES, LEAN)
    assert full.headers["ETag"] == lean.headers["ETag"] == '"9"'  # still the whole document's version
    assert len(lean.get_data()) < len(full.get_data()) / 10
    packed = c.get(f"/api/snapshot?otd={OTD_V}", headers=GZIP)
    assert (packed.headers["Content-Encoding"], packed.headers["ETag"]) == ("gzip", '"9-gz"')
    assert json.loads(gzip.decompress(packed.get_data())) == LEAN
    # The 304 logic is unchanged: the version decides, whatever the query.
    again = c.get(f"/api/snapshot?otd={OTD_V}", headers={"If-None-Match": '"9"'})
    assert (again.status_code, again.get_data()) == (304, b"")
    # The page always carries the whole snapshot.
    assert json.loads(inlined_json(c.get("/").get_data(as_text=True))) == PASSES


def test_a_stale_or_junk_pass_version_gets_the_whole_snapshot(tmp_path):
    c = app_with(PASSES, tmp_path=tmp_path)
    for given in ("ffffffffffff", "", OTD_V.upper(), OTD_V + "0", OTD_V[:-1], "%3Cscript%3E", "x" * 3000, "%00"):
        for headers in ({}, GZIP):
            r = c.get(f"/api/snapshot?otd={given}", headers=headers)
            body = gzip.decompress(r.get_data()) if headers else r.get_data()
            assert (r.status_code, json.loads(body)) == (200, PASSES), (given[:20], headers)
    # Asked twice, or with other parameters, the first otd counts.
    assert c.get(f"/api/snapshot?otd={OTD_V}&otd=old").get_json() == LEAN


def test_page_is_gzipped_with_the_snapshot_still_inlined(tmp_path):
    c = app_with(BIG, tmp_path=tmp_path)
    plain = c.get("/")
    packed = c.get("/", headers=GZIP)
    assert "Content-Encoding" not in plain.headers
    assert (packed.headers["Content-Encoding"], packed.headers["Vary"]) == ("gzip", "Accept-Encoding")
    assert plain.headers["Vary"] == "Accept-Encoding"
    page = gzip.decompress(packed.get_data())
    assert page == plain.get_data()
    assert json.loads(inlined_json(page.decode())) == BIG
    assert (packed.headers["Cache-Control"], packed.mimetype) == ("no-cache", "text/html")


def test_page_is_compressed_once_per_version(tmp_path, monkeypatch):
    (tmp_path / "index.html").write_text("<html><body><!--SNAPSHOT--></body></html>")
    store = SnapshotStore()
    store.publish({"version": 1})
    c = create_app(store, tmp_path).test_client()
    calls = []
    real = web.compress
    monkeypatch.setattr(web, "compress", lambda data: calls.append(len(data)) or real(data))
    for _ in range(3):
        c.get("/", headers=GZIP)
    assert len(calls) == 1
    store.publish({"version": 2})
    page = gzip.decompress(c.get("/", headers=GZIP).get_data()).decode()
    assert len(calls) == 2 and json.loads(inlined_json(page)) == {"version": 2}
    # A rebuilt front end is picked up at once, not at the next version.
    (tmp_path / "index.html").write_text("<html><body><main></main><!--SNAPSHOT--></body></html>")
    assert b"<main></main>" in gzip.decompress(c.get("/", headers=GZIP).get_data())


def test_inlined_snapshot_cannot_break_out(tmp_path):
    evil = {"version": 1, "deals": [{"player_name": "</script><b>x</b> &   "}]}
    html = app_with(evil, tmp_path=tmp_path).get("/").get_data(as_text=True)
    assert "</script><b>" not in html
    payload = inlined_json(html)
    assert not any(char in payload for char in "<>&  ")
    assert json.loads(payload) == evil


def test_page_without_snapshot_drops_the_marker(tmp_path):
    r = app_with(tmp_path=tmp_path).get("/")
    page = r.get_data(as_text=True)
    assert (r.status_code, r.headers["Cache-Control"]) == (200, "no-cache")
    assert "<!--SNAPSHOT-->" not in page and SNAPSHOT_TAG not in page
    assert '<div id=root></div></body>' in page


def test_page_inlines_the_latest_snapshot(tmp_path):
    page = app_with({"version": 4}, tmp_path=tmp_path).get("/").get_data(as_text=True)
    assert f'{SNAPSHOT_TAG}{{"version":4}}</script></body>' in page


def test_page_answers_503_when_front_end_not_built(tmp_path):
    r = app_with({"version": 1}, html=None, tmp_path=tmp_path).get("/")
    assert (r.status_code, r.get_data(as_text=True)) == (503, "front end not built")


PERMISSIONS = "camera=(), microphone=(), geolocation=(), payment=(), usb=()"


def every_kind_of_response(c):
    """One response of each kind the app gives: pages, data, errors, an automatic OPTIONS reply."""
    return {
        "page": c.get("/"), "snapshot": c.get("/api/snapshot"), "healthz": c.get("/healthz"),
        "missing asset": c.get("/assets/missing.js"), "unknown path": c.get("/nope"),
        "wrong method": c.get("/api/out"), "options": c.options("/api/snapshot"),
        "click": c.post("/api/out", data=json.dumps(CLICK)), "big click": c.post("/api/out", data="x" * 3000),
    }


def test_security_headers_on_every_response(tmp_path):
    c = app_with({"version": 1}, tmp_path=tmp_path)
    for kind, r in every_kind_of_response(c).items():
        assert r.headers["X-Content-Type-Options"] == "nosniff", kind
        assert r.headers["Referrer-Policy"] == "no-referrer", kind
        assert r.headers["Permissions-Policy"] == PERMISSIONS, kind
        assert r.headers["Cross-Origin-Opener-Policy"] == "same-origin", kind
        assert "Content-Security-Policy" in r.headers, kind
        assert "Server" not in r.headers, kind
    csp = {
        directive.split()[0]: directive.split()[1:]
        for directive in c.get("/").headers["Content-Security-Policy"].split("; ")
    }
    assert csp["script-src"] == ["'self'"]
    # the fonts are served by the site itself: no third party for styles or fonts
    assert csp["style-src"] == ["'self'"]
    assert csp["font-src"] == ["'self'"]
    assert csp["default-src"] == ["'self'"]
    assert (csp["object-src"], csp["form-action"], csp["frame-ancestors"]) == (["'none'"], ["'none'"], ["'none'"])
    assert csp["base-uri"] == ["'none'"]  # stricter than 'self': the page has no <base>


def test_every_response_says_how_to_cache_it(tmp_path):
    c = app_with({"version": 1}, tmp_path=tmp_path)
    responses = every_kind_of_response(c)
    responses["warming up"] = app_with(tmp_path=tmp_path).get("/api/snapshot")
    expected = {"page": "no-cache", "snapshot": "no-cache"}
    for kind, r in responses.items():
        assert r.headers["Cache-Control"] == expected.get(kind, "no-store"), kind
    assert responses["big click"].status_code == 413  # the app's own answer, with every header above


def test_strict_transport_security_only_over_https(tmp_path):
    # The app trusts the request's scheme only: waitress sets it from the platform's X-Forwarded-Proto (see
    # tests/test_server.py), so the raw header alone, as a visitor could send it, never counts here.
    c = app_with({"version": 1}, tmp_path=tmp_path)
    for headers in ({}, {"X-Forwarded-Proto": "http"}, {"X-Forwarded-Proto": "https"}):
        assert "Strict-Transport-Security" not in c.get("/", headers=headers).headers, headers
    for path in ("/", "/healthz", "/nope"):
        r = c.get(path, base_url="https://localhost")
        assert r.headers["Strict-Transport-Security"] == "max-age=31536000", path


def test_healthz_reports_only_freshness_and_version(tmp_path):
    c = app_with(tmp_path=tmp_path)
    r = c.get("/healthz")  # nothing ever published: not ready, so the platform keeps the old deploy serving
    assert (r.status_code, r.get_json()) == (503, {"ok": False, "age_s": None, "version": None})
    assert r.headers["Cache-Control"] == "no-store"
    healthy = app_with({"version": 3}, tmp_path=tmp_path).get("/healthz")
    assert healthy.status_code == 200 and set(healthy.get_json()) == {"ok", "age_s", "version"}
    assert (healthy.get_json()["ok"], healthy.get_json()["version"]) == (True, 3)


def test_healthz_is_200_once_a_first_refresh_failed_so_a_fix_can_ship(tmp_path):
    store = SnapshotStore()
    store.record_error("FeedStale")
    r = create_app(store, tmp_path).test_client().get("/healthz")
    assert r.status_code == 200 and r.get_json() == {"ok": False, "age_s": None, "version": None}


def test_healthz_stays_200_when_the_data_is_only_stale(tmp_path):
    t = [100.0]
    store = SnapshotStore(clock=lambda: t[0])
    store.publish({"version": 5})
    t[0] += 10_000
    r = create_app(store, tmp_path).test_client().get("/healthz")
    assert r.status_code == 200 and r.get_json()["ok"] is False and r.get_json()["version"] == 5


def test_healthz_never_shows_why_the_source_failed(tmp_path):
    class Leaky:  # the shape of a networked source failing: its host, path and token in the message
        def fetch(self, now):
            raise ConnectionError(
                "HTTPSConnectionPool(host='private-export.internal', port=443): Max retries exceeded with url: "
                "/export?token=abc123 (Caused by ProxyError('proxy.example:3128'))"
            )

    store, stop = SnapshotStore(), threading.Event()
    run_collector(Leaky(), store, stop, wait=lambda seconds: stop.set() or True)
    assert store.health()["last_error"] == "ConnectionError"  # kept for the server, never served
    r = create_app(store, tmp_path).test_client().get("/healthz")
    text = r.get_data(as_text=True)
    for secret in ("private-export", "internal", "abc123", "token", "proxy", "3128", "ConnectionError", "error"):
        assert secret not in text, secret


def test_assets_are_served_immutable(tmp_path):
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "app-abc123.js").write_text("console.log(1)")
    r = app_with(tmp_path=tmp_path).get("/assets/app-abc123.js")
    assert (r.status_code, r.get_data(as_text=True)) == (200, "console.log(1)")
    assert r.headers["Cache-Control"] == "public, max-age=31536000, immutable"


SCRIPT = ("export const market = 'palace';\n" * 400).encode()
STYLE = (".row { color: var(--color-text); }\n" * 400).encode()


def built_assets(tmp_path):
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "index-abc123.js").write_bytes(SCRIPT)
    (tmp_path / "assets" / "index-def456.css").write_bytes(STYLE)
    (tmp_path / "assets" / "art-1a2b3c.png").write_bytes(PNG * 40)


def test_assets_are_gzipped_when_the_client_accepts_it(tmp_path):
    built_assets(tmp_path)
    c = app_with(tmp_path=tmp_path)
    for name, body, mimetype in (("index-abc123.js", SCRIPT, "text/javascript"), ("index-def456.css", STYLE, "text/css")):
        packed = c.get(f"/assets/{name}", headers=GZIP)
        plain = c.get(f"/assets/{name}")
        assert (packed.status_code, packed.headers["Content-Encoding"], packed.mimetype) == (200, "gzip", mimetype)
        assert gzip.decompress(packed.get_data()) == body == plain.get_data(), name
        assert int(packed.headers["Content-Length"]) == len(packed.get_data()) < len(body) / 10, name
        assert "Content-Encoding" not in plain.headers and plain.mimetype == mimetype, name
        for r in (packed, plain):
            assert r.headers["Vary"] == "Accept-Encoding", name
            assert r.headers["Cache-Control"] == "public, max-age=31536000, immutable", name
        for refused in ("identity", "gzip;q=0", "br", "*;q=0"):
            r = c.get(f"/assets/{name}", headers={"Accept-Encoding": refused})
            assert "Content-Encoding" not in r.headers and r.get_data() == body, (name, refused)
        head = c.head(f"/assets/{name}", headers=GZIP)
        assert (head.status_code, head.get_data()) == (200, b"")
        for header in ("Content-Encoding", "Content-Length", "Content-Type", "Vary", "Cache-Control", "ETag"):
            assert head.headers.get(header) == packed.headers.get(header), (name, header)


BROTLI_SCRIPT = b"\x1b brotli bytes the build wrote beside the script"  # served as they are: never decoded here
BROTLI = {"Accept-Encoding": "gzip, deflate, br, zstd"}


def test_an_asset_the_build_also_wrote_as_brotli_goes_out_as_brotli_to_a_browser_that_takes_it(tmp_path):
    built_assets(tmp_path)
    (tmp_path / "assets" / "index-abc123.js.br").write_bytes(BROTLI_SCRIPT)
    c = app_with(tmp_path=tmp_path)
    r = c.get("/assets/index-abc123.js", headers=BROTLI)
    assert (r.status_code, r.get_data(), r.headers["Content-Encoding"], r.mimetype) == (
        200, BROTLI_SCRIPT, "br", "text/javascript")
    assert int(r.headers["Content-Length"]) == len(BROTLI_SCRIPT)
    assert r.headers["Vary"] == "Accept-Encoding"
    assert r.headers["Cache-Control"] == "public, max-age=31536000, immutable"
    etag = r.headers["ETag"]
    assert etag not in (c.get("/assets/index-abc123.js", headers={"Accept-Encoding": "gzip"}).headers["ETag"],
                        c.get("/assets/index-abc123.js").headers["ETag"])
    again = c.get("/assets/index-abc123.js", headers={**BROTLI, "If-None-Match": etag})
    assert (again.status_code, again.get_data()) == (304, b"")
    head = c.head("/assets/index-abc123.js", headers=BROTLI)
    assert (head.status_code, head.get_data(), head.headers["Content-Encoding"]) == (200, b"", "br")
    # Refused, or not named (a "*" is answered with gzip, which every client reads), it is gzip or plain as before.
    for accept, coding in (("br;q=0, gzip", "gzip"), ("*", "gzip"), ("gzip", "gzip"), ("identity", None), ("br;q=0", None)):
        r = c.get("/assets/index-abc123.js", headers={"Accept-Encoding": accept})
        assert r.headers.get("Content-Encoding") == coding, accept
        assert (gzip.decompress(r.get_data()) if coding else r.get_data()) == SCRIPT, accept


def test_without_a_brotli_file_a_brotli_browser_gets_gzip_and_the_brotli_file_is_not_a_page(tmp_path):
    built_assets(tmp_path)
    (tmp_path / "assets" / "index-abc123.js.br").write_bytes(BROTLI_SCRIPT)
    c = app_with(tmp_path=tmp_path)
    css = c.get("/assets/index-def456.css", headers=BROTLI)
    assert (css.headers["Content-Encoding"], gzip.decompress(css.get_data())) == ("gzip", STYLE)
    # an image is never sent compressed, even with a .br beside it
    (tmp_path / "assets" / "art-1a2b3c.png.br").write_bytes(b"nope")
    assert c.get("/assets/art-1a2b3c.png", headers=BROTLI).get_data() == PNG * 40
    # the brotli file asked for by its own name is not served as a script
    raw = c.get("/assets/index-abc123.js.br", headers=BROTLI)
    assert raw.status_code == 404


def test_root_files_ignore_brotli_files(tmp_path):
    (tmp_path / "logo.svg").write_text(SVG)
    (tmp_path / "logo.svg.br").write_bytes(b"stale")
    r = app_with(tmp_path=tmp_path).get("/logo.svg", headers=BROTLI)
    assert (r.headers["Content-Encoding"], gzip.decompress(r.get_data()).decode()) == ("gzip", SVG)


def test_an_asset_is_compressed_once(tmp_path, monkeypatch):
    built_assets(tmp_path)
    c = app_with(tmp_path=tmp_path)
    calls = []
    real = web.compress
    monkeypatch.setattr(web, "compress", lambda data, *args: calls.append(len(data)) or real(data, *args))
    for _ in range(3):
        assert gzip.decompress(c.get("/assets/index-abc123.js", headers=GZIP).get_data()) == SCRIPT
    assert calls == [len(SCRIPT)]


def test_images_and_missing_assets_are_never_gzipped(tmp_path):
    built_assets(tmp_path)
    c = app_with(tmp_path=tmp_path)
    r = c.get("/assets/art-1a2b3c.png", headers=GZIP)
    assert (r.status_code, r.get_data(), r.mimetype) == (200, PNG * 40, "image/png")
    assert "Content-Encoding" not in r.headers
    missing = c.get("/assets/index-000000.js", headers=GZIP)
    assert missing.status_code == 404 and "Content-Encoding" not in missing.headers
    assert missing.headers["Cache-Control"] == "no-store"  # never the immutable header
    for path in ("/assets/../index.html", "/assets/..%2Findex.html", "/assets/%2e%2e/index.html"):
        r = c.get(path, headers=GZIP, follow_redirects=True)
        assert r.status_code == 404 and b"SNAPSHOT" not in r.get_data(), path


MANIFEST = json.dumps({"name": "OTD Palace", "icons": [{"src": f"/icon-{n}.png"} for n in range(60)]})
SVG = "<svg xmlns='http://www.w3.org/2000/svg'>" + "<path d='M13 26 32 14l19 12'/>" * 40 + "</svg>"


def test_the_manifest_and_the_svgs_are_gzipped_too(tmp_path, monkeypatch):
    (tmp_path / "manifest.webmanifest").write_text(MANIFEST)
    (tmp_path / "logo.svg").write_text(SVG)
    c = app_with(tmp_path=tmp_path)
    for name, body, mimetype in (("manifest.webmanifest", MANIFEST, "application/manifest+json"),
                                 ("logo.svg", SVG, "image/svg+xml")):
        packed, plain = c.get(f"/{name}", headers=GZIP), c.get(f"/{name}")
        assert (packed.headers["Content-Encoding"], packed.mimetype, plain.mimetype) == ("gzip", mimetype, mimetype)
        assert gzip.decompress(packed.get_data()).decode() == body == plain.get_data(as_text=True), name
        assert packed.headers["Vary"] == plain.headers["Vary"] == "Accept-Encoding", name
        assert packed.headers["Cache-Control"] == "no-cache", name  # not fingerprinted: revalidated
        assert packed.headers["ETag"] != plain.headers["ETag"], name
        again = c.get(f"/{name}", headers={**GZIP, "If-None-Match": packed.headers["ETag"]})
        assert (again.status_code, again.get_data()) == (304, b""), name
    # A root file rebuilt under the same name is compressed again, not served stale.
    calls = []
    real = web.compress
    monkeypatch.setattr(web, "compress", lambda data, *args: calls.append(len(data)) or real(data, *args))
    rebuilt = SVG.replace("M13", "M14") + "<!-- rebuilt -->"
    (tmp_path / "logo.svg").write_text(rebuilt)
    assert gzip.decompress(c.get("/logo.svg", headers=GZIP).get_data()).decode() == rebuilt
    assert gzip.decompress(c.get("/logo.svg", headers=GZIP).get_data()).decode() == rebuilt
    assert len(calls) == 1


def test_a_nul_byte_in_a_file_name_is_the_same_404_gzip_or_not(tmp_path):
    built_assets(tmp_path)
    (tmp_path / "logo.svg").write_text(SVG)
    c = app_with(tmp_path=tmp_path)
    for path in ("/assets/index-abc123.js%00.js", "/assets/index-abc123.js%00", "/assets/%00.css", "/logo.svg%00",
                 "/logo%00.svg"):
        for headers in ({}, GZIP):
            r = c.get(path, headers=headers)
            assert (r.status_code, r.headers["Cache-Control"]) == (404, "no-store"), (path, headers)
            assert "Page not found" in r.get_data(as_text=True), (path, headers)


def test_a_file_too_small_to_shrink_goes_out_plain(tmp_path):
    (tmp_path / "favicon.svg").write_text("<svg/>")
    r = app_with(tmp_path=tmp_path).get("/favicon.svg", headers=GZIP)
    assert (r.get_data(as_text=True), r.headers.get("Content-Encoding")) == ("<svg/>", None)
    assert r.headers["Vary"] == "Accept-Encoding"


def test_assets_refuse_path_traversal(tmp_path):
    (tmp_path / "assets").mkdir()
    (tmp_path / "secret.txt").write_text("secret")
    c = app_with(tmp_path=tmp_path)
    paths = ("/assets/../secret.txt", "/assets/..%2Fsecret.txt", "/assets/%2e%2e/secret.txt", "/assets/%2Fetc/passwd")
    for path in paths:
        r = c.get(path, follow_redirects=True)
        assert r.status_code == 404, path
        assert b"secret" not in r.get_data(), path


def test_favicon_and_logo_are_served_from_the_root(tmp_path):
    (tmp_path / "favicon.svg").write_text("<svg id='favicon'/>")
    (tmp_path / "logo.svg").write_text("<svg id='logo'/>")
    c = app_with(tmp_path=tmp_path)
    for name, body in (("favicon.svg", "<svg id='favicon'/>"), ("logo.svg", "<svg id='logo'/>")):
        r = c.get(f"/{name}")
        assert (r.status_code, r.get_data(as_text=True)) == (200, body), name
        assert r.mimetype == "image/svg+xml", name
        assert r.headers["Cache-Control"] == "no-cache", name  # not fingerprinted, so it must be revalidated
        assert r.headers["X-Content-Type-Options"] == "nosniff", name


PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
ICONS = ("icon-192.png", "icon-512.png", "apple-touch-icon.png")


def test_the_home_screen_manifest_and_icons_are_served_from_the_root(tmp_path):
    manifest = {"name": "OTD Palace", "start_url": "/", "display": "standalone"}
    (tmp_path / "manifest.webmanifest").write_text(json.dumps(manifest))
    for name in ICONS:
        (tmp_path / name).write_bytes(PNG)
    c = app_with(tmp_path=tmp_path)
    r = c.get("/manifest.webmanifest")
    assert (r.status_code, json.loads(r.get_data())) == (200, manifest)
    assert r.mimetype == "application/manifest+json"
    assert (r.headers["Cache-Control"], r.headers["X-Content-Type-Options"]) == ("no-cache", "nosniff")
    for name in ICONS:
        r = c.get(f"/{name}")
        assert (r.status_code, r.get_data(), r.mimetype) == (200, PNG, "image/png"), name
        assert r.headers["Cache-Control"] == "no-cache", name


def png_size(data: bytes) -> tuple[int, int]:
    """A PNG's width and height, from its IHDR chunk."""
    assert data[:8] == PNG[:8] and data[12:16] == b"IHDR"
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def test_the_built_front_end_ships_the_manifest_and_its_icons():
    public = Path(__file__).parent.parent / "frontend" / "public"
    manifest = json.loads((public / "manifest.webmanifest").read_text(encoding="utf-8"))
    assert (manifest["name"], manifest["start_url"], manifest["display"]) == ("OTD Palace", "/", "standalone")
    icons = {(icon["src"], icon["sizes"], icon["purpose"]) for icon in manifest["icons"]}
    # The maskable icon is its own padded drawing: a mask crops the "any" icons' edges.
    assert icons == {
        ("/icon-192.png", "192x192", "any"), ("/icon-512.png", "512x512", "any"),
        ("/icon-maskable-512.png", "512x512", "maskable"),
    }
    for name in (*ICONS, "icon-maskable-512.png"):
        assert (public / name).read_bytes()[:8] == PNG[:8], name
        assert name in web.ROOT_FILES
    assert png_size((public / "icon-maskable-512.png").read_bytes()) == (512, 512)
    assert (public / "icon-maskable-512.png").read_bytes() != (public / "icon-512.png").read_bytes()
    assert "manifest.webmanifest" in web.ROOT_FILES
    page = (public.parent / "index.html").read_text(encoding="utf-8")
    for tag in ('<link rel="manifest" href="/manifest.webmanifest" />',
                '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
                # the name under the icon on an iPhone (else it takes the tab's title, "Today · OTD Palace")
                f'<meta name="apple-mobile-web-app-title" content="{manifest["short_name"]}" />',
                f'<meta name="theme-color" content="{manifest["theme_color"]}" />'):
        assert tag in page, tag


def test_every_launch_screen_the_page_links_is_shipped_at_its_size_and_served():
    public = Path(__file__).parent.parent / "frontend" / "public"
    page = (public.parent / "index.html").read_text(encoding="utf-8")
    linked = re.findall(
        r'<link rel="apple-touch-startup-image" media="\(device-width: (\d+)px\) and \(device-height: (\d+)px\) and '
        r'\(-webkit-device-pixel-ratio: (\d)\) and \(orientation: portrait\)" href="/(splash-(\d+)x(\d+)\.png)" />',
        page,
    )
    assert {name for *_, name, _, _ in linked} == web.SPLASH_FILES  # each served file is linked, each link served
    for w, h, ratio, name, pw, ph in linked:
        assert (int(w) * int(ratio), int(h) * int(ratio)) == (int(pw), int(ph)), name
        assert png_size((public / name).read_bytes()) == (int(pw), int(ph)), name
        assert name in web.ROOT_FILES
    assert '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />' in page
    assert "viewport-fit=cover" in page  # the bar and the tab bar step in by the safe-area insets (phone.css)


def test_only_favicon_and_logo_are_served_from_the_root(tmp_path):
    for name in ("other.svg", "secret.txt", "index.html", "other.webmanifest", "icon-64.png"):
        (tmp_path / name).write_text("data")
    c = app_with(tmp_path=tmp_path)
    paths = ("/other.svg", "/anything-else.svg", "/secret.txt", "/index.html", "/other.webmanifest", "/icon-64.png")
    for path in (*paths, "/favicon.svg", "/logo.svg", "/manifest.webmanifest", *(f"/{name}" for name in ICONS)):
        assert c.get(path).status_code == 404, path  # the allowed files are not in this directory
    assert c.get("/").status_code == 200


def test_root_files_refuse_path_traversal(tmp_path):
    static = tmp_path / "static"
    static.mkdir()
    (tmp_path / "favicon.svg").write_text("outside")
    c = app_with(tmp_path=static)
    for path in ("/../favicon.svg", "/..%2Ffavicon.svg", "/%2e%2e/favicon.svg"):
        r = c.get(path, follow_redirects=True)
        assert r.status_code == 404, path
        assert b"outside" not in r.get_data(), path


def test_out_endpoint_204_and_no_cookie(tmp_path):
    clicks = click_log(tmp_path)
    c = app_with(SNAP, tmp_path=tmp_path, clicks=clicks)
    r = c.post("/api/out", data=json.dumps(CLICK), content_type="application/json")
    assert (r.status_code, r.get_data()) == (204, b"")
    assert "Set-Cookie" not in r.headers
    assert r.headers["Cache-Control"] == "no-store"
    assert clicks.totals()["days"]["2026-11-12"] == [{**CLICK, "count": 1}]
    # A click that does not pass the checks, or JSON that is not a click at all, gets the same answer and counts nothing.
    for body in ({**CLICK, "panel": "sidebar"}, {**CLICK, "pos": 99}, [CLICK], "deals", None, {}):
        r = c.post("/api/out", data=json.dumps(body), content_type="application/json")
        assert (r.status_code, r.get_data()) == (204, b""), body
        assert "Set-Cookie" not in r.headers, body
    # A beacon may come as text/plain or with no type at all: the body is what counts.
    assert c.post("/api/out", data=json.dumps(CLICK), content_type="text/plain").status_code == 204
    assert c.post("/api/out", data=json.dumps(CLICK)).status_code == 204
    assert clicks.totals()["days"]["2026-11-12"] == [{**CLICK, "count": 3}]


def test_out_rejects_big_and_non_json_bodies(tmp_path):
    clicks = click_log(tmp_path)
    c = app_with(SNAP, tmp_path=tmp_path, clicks=clicks)
    padded = json.dumps({**CLICK, "pad": ""})
    at_limit = padded.replace('"pad": ""', '"pad": "' + "x" * (512 - len(padded)) + '"')
    assert len(at_limit.encode()) == 512
    assert c.post("/api/out", data=at_limit, content_type="application/json").status_code == 204
    over = at_limit.replace('"pad": "', '"pad": "x', 1)
    r = c.post("/api/out", data=over, content_type="application/json")
    assert (r.status_code, r.headers["Cache-Control"]) == (413, "no-store")
    assert "Content-Security-Policy" in r.headers
    assert c.post("/api/out", data="x" * 100_000, content_type="application/json").status_code == 413
    for body in (b"not json", b"", b"{", b"\xff\xfe", b"{'panel': 'deals'}"):
        r = c.post("/api/out", data=body, content_type="application/json")
        assert r.status_code == 400, body
        assert "Set-Cookie" not in r.headers, body
    assert clicks.totals()["days"]["2026-11-12"] == [{**CLICK, "count": 1}]  # only the click at the limit
    assert c.get("/api/out").status_code == 405


def test_out_without_a_click_log_still_answers_204(tmp_path):
    r = app_with(tmp_path=tmp_path).post("/api/out", data=json.dumps(CLICK), content_type="application/json")
    assert r.status_code == 204


def post_click(client, **fields):
    return client.post("/api/out", data=json.dumps({**CLICK, **fields}), content_type="application/json")


def test_out_counts_only_the_sports_of_the_current_snapshot(tmp_path):
    (tmp_path / "index.html").write_text("<!--SNAPSHOT-->")
    store, clicks = SnapshotStore(), click_log(tmp_path)
    c = create_app(store, tmp_path, clicks=clicks).test_client()
    # No snapshot yet: only the filters that are not one sport count.
    for sport in ("nba", "all", "mine"):
        assert post_click(c, sport=sport).status_code == 204
    assert [row["sport"] for row in clicks.totals()["days"]["2026-11-12"]] == ["all", "mine"]
    # The snapshot's sports count, and so do the sports its OTD passes are grouped under; nothing else does.
    store.publish(SNAP)
    for sport in ("nba", "nfl", "nhl", "zz"):
        assert post_click(c, sport=sport).status_code == 204
    assert sorted(row["sport"] for row in clicks.totals()["days"]["2026-11-12"]) == ["all", "mine", "nba", "nfl"]
    # A newer snapshot is what counts from then on.
    store.publish({"version": 2, "sports": ["nhl"], "otd": {"picks": {}}})
    for sport in ("nba", "nhl"):
        post_click(c, sport=sport)
    by_sport = {row["sport"]: row["count"] for row in clicks.totals()["days"]["2026-11-12"]}
    assert by_sport == {"all": 1, "mine": 1, "nba": 1, "nfl": 1, "nhl": 1}


def test_stats_404_without_token_env(tmp_path):
    for token in (None, ""):
        c = app_with(tmp_path=tmp_path, clicks=click_log(tmp_path), stats_token=token)
        for headers in ({}, {"Authorization": "Bearer "}, {"Authorization": f"Bearer {TOKEN}"}):
            r = c.get("/api/stats", headers=headers)
            assert r.status_code == 404, (token, headers)
            assert r.headers["Cache-Control"] == "no-store", (token, headers)


def test_stats_bearer_scheme_is_case_insensitive(tmp_path):
    c = app_with(SNAP, tmp_path=tmp_path, clicks=click_log(tmp_path), stats_token=TOKEN)
    for scheme in ("bearer", "BEARER", "BeArEr"):
        r = c.get("/api/stats", headers={"Authorization": f"{scheme} {TOKEN}"})
        assert r.status_code == 200, scheme
    # The token itself is still compared exactly.
    assert c.get("/api/stats", headers={"Authorization": f"bearer {TOKEN.upper()}"}).status_code == 401


def test_stats_401_wrong_token(tmp_path):
    c = app_with(tmp_path=tmp_path, clicks=click_log(tmp_path), stats_token=TOKEN)
    wrong = (
        {}, {"Authorization": ""}, {"Authorization": "Bearer"}, {"Authorization": "Bearer "},
        {"Authorization": "Bearer wrong"}, {"Authorization": f"Bearer {TOKEN}x"}, {"Authorization": f"Bearer {TOKEN[:-1]}"},
        {"Authorization": f"Basic {TOKEN}"}, {"Authorization": TOKEN}, {"Authorization": "Bearer é"},
    )
    for headers in wrong:
        r = c.get("/api/stats", headers=headers)
        assert r.status_code == 401, headers
        assert r.headers["Cache-Control"] == "no-store", headers
        assert TOKEN not in r.get_data(as_text=True), headers


def test_stats_200_right_token_no_store(tmp_path, monkeypatch):
    compared = []
    real_compare = hmac.compare_digest

    def compare_digest(a, b):
        compared.append((type(a), type(b)))
        return real_compare(a, b)

    monkeypatch.setattr("advisor.web.hmac.compare_digest", compare_digest)
    clicks = click_log(tmp_path)
    c = app_with(SNAP, tmp_path=tmp_path, clicks=clicks, stats_token=TOKEN)
    c.post("/api/out", data=json.dumps(CLICK), content_type="application/json")
    r = c.get("/api/stats", headers={"Authorization": f"Bearer {TOKEN}"})
    assert compared == [(bytes, bytes)]  # the token is compared in constant time, as bytes
    assert r.status_code == 200
    assert r.headers["Cache-Control"] == "no-store"
    assert r.get_json() == clicks.totals() == {"days": {"2026-11-12": [{**CLICK, "count": 1}]}}
    assert "Set-Cookie" not in r.headers


def test_csp_allows_same_origin_beacon(tmp_path):
    # No connect-src of its own: default-src 'self' covers the page's beacons to /api/out, and nothing else.
    for path in ("/", "/api/snapshot"):
        csp = {
            directive.split()[0]: directive.split()[1:]
            for directive in app_with({"version": 1}, tmp_path=tmp_path).get(path).headers["Content-Security-Policy"].split("; ")
        }
        assert "connect-src" not in csp, path
        assert csp["default-src"] == ["'self'"], path


def test_unknown_paths_get_a_small_dark_page_with_a_way_home(tmp_path):
    c = app_with({"version": 1}, tmp_path=tmp_path)
    for path in ("/nope", "/assets/missing.js", "/data/clicks.json", "/a/b/c", "/index.html"):
        r = c.get(path)
        page = r.get_data(as_text=True)
        assert (r.status_code, r.mimetype, r.headers["Cache-Control"]) == (404, "text/html", "no-store"), path
        assert '<link rel="stylesheet" href="/error.css">' in page and 'href="/"' in page, path
        assert "OTD Palace" in page and "Not affiliated with Real." in page, path
        assert "style=" not in page and "<style" not in page and "<script" not in page, path  # CSP: no inline style
    sheet = c.get("/error.css")
    assert (sheet.status_code, sheet.mimetype, sheet.headers["Cache-Control"]) == (200, "text/css", "no-cache")
    assert "background" in sheet.get_data(as_text=True)


def test_robots_may_crawl_everything(tmp_path):
    public = Path(__file__).parent.parent / "frontend" / "public"
    robots = (public / "robots.txt").read_text(encoding="utf-8")
    assert robots.splitlines() == ["User-agent: *", "Allow: /", "", "Sitemap: https://otdpalace.com/sitemap.xml"]
    assert "robots.txt" in web.ROOT_FILES
    (tmp_path / "robots.txt").write_text(robots)
    r = app_with(tmp_path=tmp_path).get("/robots.txt")
    assert (r.status_code, r.mimetype, r.get_data(as_text=True)) == (200, "text/plain", robots)


def test_out_refuses_clicks_sent_from_another_site(tmp_path):
    clicks = click_log(tmp_path)
    c = app_with(SNAP, tmp_path=tmp_path, clicks=clicks)
    for site in ("cross-site", "same-site", "none", "bogus", ""):
        r = c.post("/api/out", data=json.dumps(CLICK), headers={"Sec-Fetch-Site": site})
        assert (r.status_code, r.headers["Cache-Control"]) == (403, "no-store"), site
    assert clicks.totals() == {"days": {}}
    # The page's own beacon, and a client that sends no such header at all, still count.
    assert c.post("/api/out", data=json.dumps(CLICK), headers={"Sec-Fetch-Site": "same-origin"}).status_code == 204
    assert c.post("/api/out", data=json.dumps(CLICK)).status_code == 204
    assert clicks.totals()["days"]["2026-11-12"] == [{**CLICK, "count": 2}]


def test_out_takes_thirty_clicks_a_minute_from_one_address(tmp_path):
    t = [1000.0]
    clicks = click_log(tmp_path)
    c = app_with(SNAP, tmp_path=tmp_path, clicks=clicks, clock=lambda: t[0])
    for _ in range(30):
        assert post_click(c).status_code == 204
    over = post_click(c)
    assert (over.status_code, over.headers["Cache-Control"]) == (429, "no-store")
    # Another visitor, as the platform's proxy names it, has a bucket of its own.
    other = c.post("/api/out", data=json.dumps(CLICK), headers={"X-Real-IP": "203.0.113.7"})
    assert other.status_code == 204
    # The bucket refills at thirty a minute: one click every two seconds.
    t[0] += 2
    assert post_click(c).status_code == 204
    assert post_click(c).status_code == 429
    assert clicks.totals()["days"]["2026-11-12"] == [{**CLICK, "count": 32}]


PEER = "198.51.100.1"


def test_the_client_address_is_a_parsed_ip_else_the_peer_and_never_long(tmp_path):
    app = create_app(SnapshotStore(), tmp_path)
    cases = {
        "203.0.113.7": "203.0.113.7",
        " 203.0.113.7 ": "203.0.113.7",
        "2001:DB8:0:0::1": "2001:db8::1",  # one address, one bucket, however it is written
        "fe80::1%eth0": "fe80::1%eth0",
        "": PEER,
        "junk": PEER,
        "203.0.113.7, 10.0.0.1": PEER,
        "999.1.1.1": PEER,
        "x" * 200_000: PEER,
        "fe80::1%" + "e" * 60: PEER,  # parses, but past the 45 characters an address can take
    }
    for header, expected in cases.items():
        with app.test_request_context(headers={"X-Real-IP": header}, environ_base={"REMOTE_ADDR": PEER}):
            assert web._client_address() == expected, header[:40]
    with app.test_request_context(environ_base={"REMOTE_ADDR": "z" * 300}):
        assert web._client_address() == "z" * 64


def test_a_junk_x_real_ip_never_buys_a_fresh_bucket(tmp_path):
    c = app_with(SNAP, tmp_path=tmp_path, clock=lambda: 1000.0)
    for n in range(30):
        r = c.post("/api/out", data=json.dumps(CLICK), headers={"X-Real-IP": f"not-an-address-{n}"})
        assert r.status_code == 204, n
    for header in ("x" * 200_000, "still-not-one", "1.2.3"):
        assert c.post("/api/out", data=json.dumps(CLICK), headers={"X-Real-IP": header}).status_code == 429
    assert c.post("/api/out", data=json.dumps(CLICK), headers={"X-Real-IP": "203.0.113.7"}).status_code == 204
