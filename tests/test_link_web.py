"""A member's linked Real account seen from the web: /api/me/link (read, link or refresh, settings, unlink).

Discord is the scripted fake of test_discord_gate; the importer a fake; the role refreshes are counted, not sent."""

import time

from advisor.importer import Imported
from advisor.members import MemberLinks
from tests.test_gate_web import as_member, log_in, make
from tests.test_discord_gate import USER

PASSES = tuple({"key": f"nba:2026:player:{i}", "rating": 15.0} for i in range(30)) + (
    {"key": "nfl:2025:player:1", "rarity": "rare", "cap": 0.0},)
SAME = {"Sec-Fetch-Site": "same-origin"}


class Importer:
    def __init__(self, answers=None):
        self.asked = []
        self.answers = answers or {}

    def cached(self, username):
        return None

    def follow_up(self, username):
        return False

    def lookup(self, username):
        self.asked.append(username)
        return self.answers.get(username.lower(), Imported("ok", username, PASSES, False))


class Perks:
    def __init__(self):
        self.synced = []

    def request_sync(self, uid):
        self.synced.append(uid)


def setup(tmp_path, importer=None, gate=True):
    links = MemberLinks(tmp_path / "member-links.json")
    perks = Perks()
    c, _, fake = make(tmp_path, gate=gate, importer=importer or Importer(), links=links, perks=perks)
    return c, links, perks


def member(c):
    return {**as_member(log_in(c)), **SAME}


def test_the_routes_are_for_members_only_and_absent_without_the_gate(tmp_path):
    c, _, _ = setup(tmp_path)
    assert c.get("/api/me/link").status_code == 401
    assert c.post("/api/me/link", json={"username": "shaedon"}, headers=SAME).status_code == 401
    assert c.delete("/api/me/link", headers=SAME).status_code == 401
    (tmp_path / "off").mkdir()
    off, _, _ = setup(tmp_path / "off", gate=False)
    assert off.get("/api/me/link").status_code == 404
    assert off.post("/api/me/link", json={"username": "shaedon"}).status_code == 404


def test_linking_reads_the_passes_keeps_the_link_and_refreshes_the_roles(tmp_path):
    c, links, perks = setup(tmp_path)
    h = member(c)
    first = c.get("/api/me/link", headers=h).get_json()
    assert abs(first.pop("now") - time.time()) < 5  # the server's clock, so a device can compare its own against it
    assert first == {"link": None, "unlinked_at": None, "perks": {
        "linked": False, "roles": [], "lounge": False, "big_accounts": False, "pings": False, "dm_closed": False}}
    r = c.post("/api/me/link", json={"username": "@Shaedon", "year": 4321.6}, headers=h)
    assert r.status_code == 200 and r.headers["Cache-Control"] == "no-store"
    body = r.get_json()
    assert body["status"] == "ok" and len(body["passes"]) == 31 and body["passes"][-1]["cap"] == 0.0
    assert body["link"]["username"] == "Shaedon" and body["link"]["passes"] == 31 and body["link"]["year"] == 4322
    assert body["perks"]["roles"] == ["Linked", "NBA", "Starter"] and body["perks"]["pings"] is True
    assert links.get(USER["id"])["username"] == "Shaedon" and perks.synced == [USER["id"]]
    again = c.get("/api/me/link", headers=h).get_json()
    assert again["link"]["username"] == "Shaedon" and again["perks"]["lounge"] is True


def test_a_name_another_member_linked_is_refused_in_plain_words(tmp_path):
    c, links, perks = setup(tmp_path)
    links.claim("999999999999999999", "shaedon", PASSES, now=1.0)
    r = c.post("/api/me/link", json={"username": "Shaedon"}, headers=member(c))
    assert r.status_code == 409 and r.get_json()["error"] == "taken"
    assert "another Discord member" in r.get_json()["message"]
    assert perks.synced == []


def test_an_account_that_cannot_be_read_changes_nothing(tmp_path):
    importer = Importer({"ghost": Imported("not_found"), "busy": Imported("busy", retry_after=9)})
    c, links, perks = setup(tmp_path, importer)
    h = member(c)
    assert c.post("/api/me/link", json={"username": "ghost"}, headers=h).status_code == 404
    busy = c.post("/api/me/link", json={"username": "busy"}, headers=h)
    assert busy.status_code == 503 and busy.headers["Retry-After"] == "9"
    assert links.get(USER["id"]) is None and perks.synced == []


def test_bad_bodies_other_sites_and_too_many_requests_are_refused(tmp_path):
    c, _, _ = setup(tmp_path)
    h = member(c)
    assert c.post("/api/me/link", json={"username": "no spaces"}, headers=h).status_code == 400
    assert c.post("/api/me/link", data="x", headers=h).status_code == 415
    assert c.post("/api/me/link", json={"username": "x" * 9000}, headers=h).status_code == 413
    cross = {**h, "Sec-Fetch-Site": "cross-site"}
    assert c.post("/api/me/link", json={"username": "shaedon"}, headers=cross).status_code == 403
    assert c.delete("/api/me/link", headers=cross).status_code == 403
    codes = [c.patch("/api/me/link", json={"pings": False}, headers=h).status_code for _ in range(25)]
    assert 429 in codes


def test_settings_change_the_pings_and_the_players_followed(tmp_path):
    c, links, _ = setup(tmp_path)
    h = member(c)
    assert c.patch("/api/me/link", json={"pings": False}, headers=h).status_code == 404  # nothing linked yet
    c.post("/api/me/link", json={"username": "shaedon"}, headers=h)
    r = c.patch("/api/me/link", json={"pings": False, "follows": ["nba:7", "<b>"], "year": 10}, headers=h)
    assert r.status_code == 200 and r.get_json()["perks"]["pings"] is False
    row = links.get(USER["id"])
    assert row["pings"] is False and row["follows"] == ["nba:7"] and row["year"] == 10
    assert c.patch("/api/me/link", json={"pings": "yes"}, headers=h).status_code == 400


def test_the_site_reports_the_yearly_figure_and_the_account_type_follows_it_cosmetically(tmp_path):
    c, links, perks = setup(tmp_path)
    h = member(c)
    c.post("/api/me/link", json={"username": "shaedon"}, headers=h)  # 31 passes: a Starter by count
    perks.synced.clear()
    r = c.patch("/api/me/link", json={"year": 750_000}, headers=h)
    body = r.get_json()
    assert r.status_code == 200 and body["link"]["year"] == 750_000
    assert body["perks"]["roles"][-1] == "Big" and body["perks"]["big_accounts"] is True
    assert perks.synced == [USER["id"]]  # the role changed: the bot is asked
    c.patch("/api/me/link", json={"year": 760_000}, headers=h)
    assert perks.synced == [USER["id"]]  # the same type: not asked again
    # garbage is ignored, never stored: a number out of range keeps the last figure, a non-number is a bad request
    for garbage in (-5, 50_000_001, 1e30):
        r = c.patch("/api/me/link", json={"year": garbage}, headers=h)
        assert r.status_code == 200 and r.get_json()["link"]["year"] == 760_000, garbage
    for garbage in ("lots", True, [1], {"a": 1}):
        assert c.patch("/api/me/link", json={"year": garbage}, headers=h).status_code == 400, garbage
    assert links.get(USER["id"])["year"] == 760_000 and perks.synced == [USER["id"]]


def test_unlinking_forgets_the_link_and_takes_the_roles_back(tmp_path):
    c, links, perks = setup(tmp_path)
    h = member(c)
    c.post("/api/me/link", json={"username": "shaedon"}, headers=h)
    r = c.delete("/api/me/link", headers=h)
    assert r.status_code == 204 and links.get(USER["id"]) is None
    assert perks.synced == [USER["id"], USER["id"]]
    after = c.get("/api/me/link", headers=h).get_json()
    assert after["link"] is None and isinstance(after["unlinked_at"], float)


def test_asks_again_while_seasons_are_read_refresh_the_roles_only_when_they_change(tmp_path):
    waiting = Imported("ok", "shaedon", PASSES, False, (), 4, 1)
    importer = Importer({"shaedon": waiting})
    c, links, perks = setup(tmp_path, importer)
    h = member(c)
    for _ in range(3):
        assert c.post("/api/me/link", json={"username": "shaedon"}, headers=h).status_code == 200
    assert perks.synced == [USER["id"]]  # the first link only: the roles did not change


def test_linking_spends_the_lookup_budget_of_the_address(tmp_path):
    importer = Importer()
    c, _, _ = setup(tmp_path, importer)
    h = member(c)
    codes = [c.post("/api/me/link", json={"username": f"name{i}"}, headers=h).status_code for i in range(5)]
    assert codes[:3] == [200, 200, 200] and codes[3] == 429
    assert len(importer.asked) == 3


def test_an_unlink_that_could_not_be_written_is_told_and_a_retry_finishes_it(tmp_path, monkeypatch):
    import os

    c, links, perks = setup(tmp_path)
    h = member(c)
    assert c.post("/api/me/link", json={"username": "shaedon"}, headers=h).status_code == 200
    real = os.replace
    monkeypatch.setattr("os.replace", lambda src, dst: (_ for _ in ()).throw(OSError("disk full")))
    assert c.delete("/api/me/link", headers=h).status_code == 500
    assert links.get(USER["id"]) is not None and links.unlinked_at(USER["id"]) is None  # memory and disk still agree
    monkeypatch.setattr("os.replace", real)
    assert c.delete("/api/me/link", headers=h).status_code == 204
    assert links.get(USER["id"]) is None
