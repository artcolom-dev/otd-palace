"""GET /api/passes/import: a visitor's passes from their Real username."""

import json

from advisor.importer import Imported
from advisor.store import SnapshotStore
from advisor.web import create_app


class FakeImporter:
    def __init__(self, answer):
        self.answer, self.asked = answer, []

    def lookup(self, username):
        self.asked.append(username)
        return self.answer


def client(tmp_path, importer, clock=None):
    kw = {"clock": clock} if clock else {}
    return create_app(SnapshotStore(), tmp_path, importer=importer, **kw).test_client()


def test_without_an_importer_the_route_does_not_exist(tmp_path):
    r = client(tmp_path, None).get("/api/passes/import?u=shaedon")
    assert r.status_code == 404


def test_a_found_roster_comes_back_and_is_never_cached(tmp_path):
    found = Imported("ok", "Shaedon", ({"key": "nba:2026:player:1", "rating": 5.0},), False)
    importer = FakeImporter(found)
    r = client(tmp_path, importer).get("/api/passes/import?u=@shaedon")
    assert r.status_code == 200 and r.headers["Cache-Control"] == "no-store"
    assert r.get_json() == {"status": "ok", "username": "Shaedon", "truncated": False,
                            "passes": [{"key": "nba:2026:player:1", "rating": 5.0}],
                            "markets": [], "waiting": 0, "seasons_waiting": 0}
    assert importer.asked == ["shaedon"]


def test_a_name_that_cannot_be_one_is_refused_without_asking(tmp_path):
    importer = FakeImporter(Imported("ok"))
    for bad in ("", "a", "two words", "x" * 40):
        assert client(tmp_path, importer).get("/api/passes/import", query_string={"u": bad}).status_code == 400
    assert importer.asked == []


def test_each_status_has_its_code(tmp_path):
    for status, code in (("not_found", 404), ("private", 422), ("busy", 503)):
        r = client(tmp_path, FakeImporter(Imported(status))).get("/api/passes/import?u=someone")
        assert (r.status_code, r.get_json()["status"]) == (code, status)


def test_one_address_gets_three_lookups_in_ten_minutes(tmp_path):
    t = [0.0]
    c = client(tmp_path, FakeImporter(Imported("not_found")), clock=lambda: t[0])
    codes = [c.get(f"/api/passes/import?u=name{i}").status_code for i in range(4)]
    assert codes == [404, 404, 404, 429]
    t[0] += 10 * 60
    assert c.get("/api/passes/import?u=name9").status_code == 404


def test_an_answer_already_kept_does_not_use_the_address_allowance(tmp_path):
    """Opening the same analysis again costs the producer nothing: only lookups that leave count against the address."""

    class CachingImporter(FakeImporter):
        def cached(self, username):
            return self.answer if username in self.asked else None

    t = [0.0]
    importer = CachingImporter(Imported("ok", "Someone", ({"key": "nba:2026:player:1", "rating": 5.0},), False))
    c = client(tmp_path, importer, clock=lambda: t[0])
    codes = [c.get("/api/passes/import?u=someone").status_code for _ in range(6)]
    assert codes == [200] * 6
    assert importer.asked == ["someone"]  # one real lookup, five answers from the cache
    others = [c.get(f"/api/passes/import?u=name{i}").status_code for i in range(3)]
    assert others == [200, 200, 429]  # the allowance counted only the first, real lookup


def test_an_analysis_link_has_its_own_preview_page_and_never_starts_a_lookup(tmp_path):
    class CachingImporter(FakeImporter):
        def cached(self, username):
            return self.answer if username == "kept" else None

    importer = CachingImporter(Imported("ok", "Kept", tuple({"key": f"nba:2026:player:{i}", "rating": 1.0} for i in range(42)), False))
    c = client(tmp_path, importer)
    r = c.get("/a/kept")
    page = r.get_data(as_text=True)
    assert r.status_code == 200 and r.mimetype == "text/html"
    assert 'property="og:title" content="Kept&#x27;s Real passes · OTD Palace"' in page
    assert "42 passes" in page
    assert 'http-equiv="refresh" content="0; url=/#account/Kept"' in page
    assert importer.asked == []  # a preview never makes the producer read anything
    other = c.get("/a/someone_else").get_data(as_text=True)
    assert "someone_else" in other and "passes" in other and importer.asked == []
    assert c.get("/a/x").status_code == 404  # not a username
    assert c.get("/a/two%20words").status_code == 404


def test_an_account_with_one_pass_reads_one_pass(tmp_path):
    class CachingImporter(FakeImporter):
        def cached(self, username):
            return self.answer

    one = Imported("ok", "Solo", ({"key": "nba:2026:player:1", "rating": 1.0},), False)
    page = client(tmp_path, CachingImporter(one)).get("/a/solo").get_data(as_text=True)
    assert "Solo holds 1 pass on Real." in page and "1 passes" not in page


def test_without_an_importer_an_analysis_link_goes_home(tmp_path):
    r = client(tmp_path, None).get("/a/kept")
    assert r.status_code == 302 and r.headers["Location"].endswith("/")


def test_the_pages_next_asks_for_an_account_still_waiting_do_not_count_against_the_address(tmp_path):
    class Waiting(FakeImporter):
        def cached(self, username):
            return None

        def follow_up(self, username):
            return username == "big"

    importer = Waiting(Imported("ok", "Big", ({"key": "nba:2026:player:1", "rating": 5.0},), False, waiting=3))
    c = client(tmp_path, importer)
    assert [c.get("/api/passes/import?u=big").status_code for _ in range(8)] == [200] * 8
    assert c.get("/api/passes/import?u=big").get_json()["waiting"] == 3
    statuses = [c.get(f"/api/passes/import?u=other{i}").status_code for i in range(4)]
    assert statuses[-1] == 429                                          # any other name still counts


def test_a_busy_answer_says_when_to_come_back_in_words_and_in_retry_after(tmp_path):
    r = client(tmp_path, FakeImporter(Imported("busy", retry_after=42))).get("/api/passes/import?u=someone")
    assert (r.status_code, r.headers["Retry-After"]) == (503, "42")
    body = r.get_json()
    assert body["status"] == "busy" and "42 s" in body["message"]
    plain = client(tmp_path, FakeImporter(Imported("busy"))).get("/api/passes/import?u=someone")
    assert int(plain.headers["Retry-After"]) > 0 and plain.get_json()["message"]
    assert "Retry-After" not in client(tmp_path, FakeImporter(Imported("not_found"))).get(
        "/api/passes/import?u=someone").headers


def test_the_pages_next_asks_have_a_limit_of_their_own(tmp_path):
    from advisor.rules import IMPORT_FOLLOW_UP_BURST, IMPORT_FOLLOW_UP_PER_MIN

    class Waiting(FakeImporter):
        def cached(self, username):
            return None

        def follow_up(self, username):
            return username == "big"

    t = [0.0]
    importer = Waiting(Imported("ok", "Big", ({"key": "nba:2026:player:1", "rating": 5.0},), False, waiting=3))
    c = client(tmp_path, importer, clock=lambda: t[0])
    codes = [c.get("/api/passes/import?u=big").status_code for _ in range(IMPORT_FOLLOW_UP_BURST + 1)]
    assert codes == [200] * IMPORT_FOLLOW_UP_BURST + [429]
    t[0] += 60 / IMPORT_FOLLOW_UP_PER_MIN
    assert c.get("/api/passes/import?u=big").status_code == 200
    # The page asks every 15 s: well inside the limit, for as long as it asks.
    assert IMPORT_FOLLOW_UP_PER_MIN >= 4
    # And none of it touched the address's own lookups.
    assert [c.get(f"/api/passes/import?u=other{i}").status_code for i in range(4)] == [200, 200, 200, 429]


def test_the_answer_goes_out_gzipped_to_a_client_that_takes_gzip(tmp_path):
    import gzip

    passes = tuple({"key": f"nba:2026:player:{i}", "rating": 5.0} for i in range(2000))
    importer = FakeImporter(Imported("ok", "Big", passes, False))
    c = client(tmp_path, importer)
    packed = c.get("/api/passes/import?u=big", headers={"Accept-Encoding": "gzip, deflate, br"})
    assert packed.status_code == 200 and packed.headers["Content-Encoding"] == "gzip"
    assert packed.headers["Vary"] == "Accept-Encoding" and packed.headers["Cache-Control"] == "no-store"
    assert packed.headers["Content-Type"] == "application/json"
    body = json.loads(gzip.decompress(packed.data))
    assert body == importer.answer.json()
    assert len(packed.data) < len(json.dumps(body)) / 4
    plain = c.get("/api/passes/import?u=big", headers={"Accept-Encoding": "identity"})
    assert "Content-Encoding" not in plain.headers and plain.get_json() == body
    assert plain.headers["Vary"] == "Accept-Encoding"
    refused = c.get("/api/passes/import?u=big", headers={"Accept-Encoding": "gzip;q=0"})
    assert "Content-Encoding" not in refused.headers
