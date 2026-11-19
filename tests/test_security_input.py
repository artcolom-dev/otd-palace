"""Attacks through what a member or a visitor sends (a yearly figure, a body), one test each (see
the internal research notes). Every test is an attacker's move: it fails when the move works."""

import pytest

from advisor.members import MemberLinks, _year
from advisor.push import Dispatcher, PushStore
from tests.test_discord_gate import USER
from tests.test_gate_web import as_member, log_in, make
from tests.test_link_web import SAME, setup
from tests.test_push import FakeSender


# --- the yearly figure and every JSON body: nothing a member sends may crash a request ---------------------------


@pytest.mark.parametrize("given", [10**400, -10**400, float("inf"), float("-inf"), float("nan"), True, "9", None,
                                   -1, 50_000_001, [1], {"a": 1}])
def test_a_year_that_is_not_a_sane_number_is_ignored_and_never_crashes(given):
    assert _year(given) is None


def raw(c, path, method, body, headers):
    return c.open(path, method=method, data=body, headers={"Content-Type": "application/json", **SAME, **headers})


def test_a_year_of_a_thousand_digits_is_a_400_or_ignored_never_a_500(tmp_path):
    c, links, _ = setup(tmp_path)
    h = {**as_member(log_in(c)), **SAME}
    assert c.post("/api/me/link", json={"username": "shaedon"}, headers=h).status_code == 200
    huge = '{"year": ' + "9" * 400 + "}"
    assert raw(c, "/api/me/link", "PATCH", huge, h).status_code in (200, 400)
    assert raw(c, "/api/me/link", "POST", '{"username": "shaedon", "year": ' + "9" * 400 + "}", h).status_code in (200, 400)
    assert links.get(USER["id"])["year"] is None


@pytest.mark.parametrize("path,method,needs_member,depth", [
    ("/api/out", "POST", False, 250), ("/api/me/link", "POST", True, 4000), ("/api/me/link", "PATCH", True, 4000),
])
def test_the_deepest_body_that_fits_never_makes_a_500(tmp_path, path, method, needs_member, depth):
    """Python 3.13 reads 4000 levels without trouble, and every body is capped before it is parsed: guard it."""
    c, _, _ = setup(tmp_path)
    h = {**as_member(log_in(c)), **SAME} if needs_member else dict(SAME)
    assert raw(c, path, method, "[" * depth + "]" * depth, h).status_code in (204, 400)  # /api/out says 204 to all


def test_the_deepest_push_body_that_fits_is_a_400_never_a_500(tmp_path):
    dispatcher = Dispatcher(PushStore(tmp_path / "push.json"), FakeSender(201), public_key="BKey", check_s=10)
    c, _, _ = make(tmp_path, push=dispatcher)
    bomb = "[" * 2000 + "]" * 2000
    h = {**as_member(log_in(c)), **SAME}
    for method in ("PUT", "DELETE"):
        assert raw(c, "/api/push/subscription", method, bomb, h).status_code == 400
    assert raw(c, "/api/push/test", "POST", bomb, h).status_code == 400


# --- who may touch whose link ---------------------------------------------------------------------------------------

OTHER = "999988887777666655"


def test_no_parameter_makes_a_member_read_change_or_delete_another_members_link(tmp_path):
    c, links, _ = setup(tmp_path)
    links.claim(OTHER, "victim", ({"key": "nba:2026:player:1", "rating": 9.0},), now=1.0, year=777)
    before = links.get(OTHER)
    h = {**as_member(log_in(c)), **SAME}
    for extra in ({"uid": OTHER}, {"user_id": OTHER}, {"discord_id": OTHER}, {"id": OTHER}, {"member": {"id": OTHER}}):
        assert c.patch("/api/me/link", json={"pings": False, "follows": ["nba:1"], "year": 5, **extra}, headers=h).status_code in (200, 404, 429)
        assert c.post("/api/me/link", json={"username": "shaedon", **extra}, headers=h).status_code in (200, 429)
    for query in (f"?uid={OTHER}", f"?user_id={OTHER}", f"?discord_id={OTHER}"):
        assert c.get("/api/me/link" + query, headers=h).status_code == 200
        assert c.delete("/api/me/link" + query, headers=h).status_code in (204, 429)
    assert links.get(OTHER) == before  # not one byte of it changed
    assert c.delete("/api/me", headers=h).status_code in (204, 429)
    assert links.get(OTHER) == before


@pytest.mark.parametrize("name", ["ſhaedon", "shaedon​", "ｓhaedon", "shaedoń", "İstanbul", "sha edon", "sha\nedon",
                                  "shaedon‮", "‮shaedon", "sha/edon", "sha?x=1", "a" * 31, "é"])
def test_a_username_that_is_not_plain_ascii_cannot_collide_with_or_impersonate_another(name):
    from advisor.importer import valid_username
    assert valid_username(name) is None


def test_the_member_file_is_written_for_its_owner_alone_and_leaves_no_temporary_file(tmp_path):
    import os
    links = MemberLinks(tmp_path / "member-links.json")
    links.claim(USER["id"], "shaedon", ({"key": "nba:2026:player:1", "rating": 9.0},), now=1.0)
    assert (os.stat(tmp_path / "member-links.json").st_mode & 0o077) == 0
    assert [p.name for p in tmp_path.iterdir()] == ["member-links.json"]


def test_the_store_takes_no_member_past_its_cap_but_still_refreshes_those_it_has(tmp_path):
    links = MemberLinks(tmp_path / "m.json", max_members=2)
    rows = ({"key": "nba:2026:player:1", "rating": 9.0},)
    assert [links.claim(str(10**16 + n), f"name{n}", rows, now=1.0) for n in range(3)] == ["ok", "ok", "full"]
    assert links.claim(str(10**16), "name0", rows, now=2.0) == "ok"
