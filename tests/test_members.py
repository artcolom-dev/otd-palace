"""The Real account each Discord member linked, kept on the server so it follows them to any device."""

import json
import threading

from advisor.members import MemberLinks, roles_for, summarize

A, B = "111111111111111111", "222222222222222222"
PASSES = [
    {"key": "nba:2026:player:1", "rating": 12.0},  # rating 12: Common
    {"key": "nba:2026:player:2", "rarity": "rare", "rating": 40.0},  # Real's own rung wins over the rating
    {"key": "nba:2025:player:2", "tier": "epic"},
    {"key": "nfl:2025:player:9", "rating": 0.0},
    {"key": "ufc:2024:fighter:5", "rarity": "common"},
    {"key": "nba:2024:team:3", "rating": 31.0},
]


def test_a_summary_counts_passes_per_sport_and_rung_and_lists_the_players_held():
    s = summarize(PASSES)
    assert s["passes"] == 6
    assert s["sports"]["nba"] == {"n": 4, "rungs": {"common": 2, "rare": 1, "epic": 1}}
    assert s["sports"]["nfl"] == {"n": 1, "rungs": {"general": 1}}
    assert s["sports"]["ufc"] == {"n": 1, "rungs": {"common": 1}}


def test_roles_follow_the_account_linked_and_say_nothing_more():
    assert roles_for(None) == []
    # No yearly figure reported yet: the number of passes stands in for the account's type.
    assert roles_for(summarize(PASSES)) == ["Linked", "NBA", "Starter"]  # NBA has 4 passes, NFL and UFC under 3
    many = summarize([{"key": f"nfl:2025:player:{i}", "rating": 5.0} for i in range(130)])
    assert roles_for(many) == ["Linked", "NFL", "Steady"]
    big = summarize([{"key": f"mlb:2025:player:{i}", "rating": 5.0} for i in range(500)])
    assert roles_for(big)[-1] == "Big"
    assert roles_for(summarize([]))[-1] == "Not earning yet"


def test_the_size_role_is_the_account_type_of_the_yearly_figure_once_the_site_reported_one():
    summary = summarize(PASSES)  # 6 passes: Starter by count
    names = {0: "Not earning yet", 1: "Starter", 9_999: "Starter", 10_000: "Steady", 120_000: "Strong", 700_000: "Big",
             2_000_000: "Giant", 6_200_000: "Giant"}
    for year, name in names.items():
        assert roles_for(summary, year)[-1] == name
    assert roles_for(summary, None)[-1] == "Starter"
    assert roles_for(summarize([{"key": f"mlb:2025:player:{i}", "rating": 5.0} for i in range(500)]), 50_000)[-1] == "Steady"


def test_one_username_per_member_and_one_member_per_username(tmp_path):
    links = MemberLinks(tmp_path / "member-links.json")
    assert links.claim(A, "Shaedon", PASSES, now=100.0, year=1234) == "ok"
    assert links.claim(B, "shaedon", PASSES, now=101.0) == "taken"  # names are compared without case
    assert links.owner_of("SHAEDON") == A
    assert links.claim(A, "other_name", PASSES[:1], now=102.0) == "ok"  # re-linking replaces the name
    assert links.owner_of("shaedon") is None
    assert links.claim(B, "Shaedon", PASSES, now=103.0) == "ok"  # free again
    row = links.get(A)
    assert row["username"] == "other_name" and row["linked_at"] == 102.0 and row["summary"]["passes"] == 1


def test_refreshing_the_same_name_keeps_when_it_was_linked_and_the_settings(tmp_path):
    links = MemberLinks(tmp_path / "member-links.json")
    links.claim(A, "Shaedon", PASSES, now=100.0)
    links.update(A, pings=False, follows=["nba:7", "bad", "nfl:8"])
    links.claim(A, "shaedon", PASSES[:2], now=500.0, year=99)
    row = links.get(A)
    assert row["linked_at"] == 100.0 and row["refreshed_at"] == 500.0 and row["year"] == 99
    assert row["pings"] is False and row["follows"] == ["nba:7", "nfl:8"]
    assert row["players"] == ["nba:1", "nba:2"]


def test_pings_are_on_by_default_and_the_link_survives_a_restart(tmp_path):
    path = tmp_path / "member-links.json"
    links = MemberLinks(path)
    links.claim(A, "Shaedon", PASSES, now=100.0)
    links.note_ping(A, 42, 150.0)
    links.note_dm(A, channel="333333333333333333")
    again = MemberLinks(path)
    row = again.get(A)
    assert row["pings"] is True and row["pinged"] == [[42, 150.0]] and row["dm_channel"] == "333333333333333333"
    assert row["players"] == ["nba:1", "nba:2", "nfl:9", "ufc:5"]  # teams are not players
    assert again.unlink(A) is True and again.get(A) is None and MemberLinks(path).get(A) is None
    assert again.unlink(A) is False


def test_closed_dms_are_remembered_and_stop_the_pings(tmp_path):
    links = MemberLinks(tmp_path / "member-links.json")
    links.claim(A, "Shaedon", PASSES, now=100.0)
    links.note_dm(A, closed=True)
    assert links.get(A)["dm_closed"] is True
    assert [uid for uid, _ in links.pingable()] == []
    links.update(A, pings=True)  # turning pings on again tries DMs again
    assert links.get(A)["dm_closed"] is False and [uid for uid, _ in links.pingable()] == [A]


def test_everything_kept_is_bounded(tmp_path):
    links = MemberLinks(tmp_path / "member-links.json", max_members=2)
    many = [{"key": f"nba:2025:player:{i}", "rating": 1.0} for i in range(5000)]
    assert links.claim(A, "a_name", many, now=1.0) == "ok"
    assert len(links.get(A)["players"]) == 250
    links.update(A, follows=[f"nba:{i}" for i in range(1000)], year=1e15)
    assert len(links.get(A)["follows"]) == 200 and links.get(A)["year"] is None
    for i in range(80):
        links.note_ping(A, i, float(i))
    assert len(links.get(A)["pinged"]) == 50 and links.get(A)["pinged"][-1] == [79, 79.0]
    assert links.claim(B, "b_name", many, now=2.0) == "ok"
    assert links.claim("333333333333333333", "c_name", many, now=3.0) == "full"


def test_a_file_that_cannot_be_read_is_set_aside_and_bad_rows_are_dropped(tmp_path):
    path = tmp_path / "member-links.json"
    path.write_text("{not json")
    assert MemberLinks(path).get(A) is None
    assert (tmp_path / "member-links.json.corrupt").exists()
    path.write_text(json.dumps({"links": {A: {"username": "ok_name", "linked_at": 1.0}, "nope": {"username": "x"},
                                          B: {"username": "bad name!", "linked_at": 1.0}}}))
    links = MemberLinks(path)
    assert links.get(A)["username"] == "ok_name" and links.get(A)["pings"] is True
    assert links.get(B) is None and links.get("nope") is None


def test_claims_from_many_threads_at_once_give_the_name_to_one_member(tmp_path):
    links = MemberLinks(tmp_path / "member-links.json")
    results = []
    uids = [str(10**17 + i) for i in range(20)]
    threads = [threading.Thread(target=lambda u=u: results.append(links.claim(u, "contested", PASSES, now=1.0)))
               for u in uids]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results.count("ok") == 1 and results.count("taken") == 19
    saved = json.loads((tmp_path / "member-links.json").read_text())
    assert [row["username"] for row in saved["links"].values()] == ["contested"]


def test_the_rung_held_per_player_season_is_kept_for_the_pings(tmp_path):
    links = MemberLinks(tmp_path / "member-links.json")
    links.claim(A, "Shaedon", PASSES, now=1.0)
    assert links.get(A)["owned"] == {"nba:2026:1": 1, "nba:2026:2": 3, "nba:2025:2": 4, "nfl:2025:9": 0,
                                     "ufc:2024:5": 1}  # teams are no player's pass


def test_an_unlink_is_remembered_until_the_member_links_again(tmp_path):
    path = tmp_path / "member-links.json"
    links = MemberLinks(path)
    links.claim(A, "Shaedon", PASSES, now=1.0)
    assert links.unlinked_at(A) is None
    links.unlink(A)
    at = links.unlinked_at(A)
    assert at is not None and MemberLinks(path).unlinked_at(A) == at
    links.claim(A, "Shaedon", PASSES, now=2.0)
    assert links.unlinked_at(A) is None and MemberLinks(path).unlinked_at(A) is None


def test_an_unlink_is_remembered_even_when_the_server_held_no_link(tmp_path):
    # A device linked on its own while the server kept nothing (a restart, an erase, a failed write): its member presses
    # Unlink, the server says 204: another device still holding the old link must not link them back.
    path = tmp_path / "member-links.json"
    links = MemberLinks(path)
    assert links.unlink(A) is False  # there was no link to forget ...
    at = links.unlinked_at(A)
    assert at is not None and MemberLinks(path).unlinked_at(A) == at  # ... and the unlink is remembered all the same
    links.claim(A, "Shaedon", PASSES, now=2.0)
    assert links.unlinked_at(A) is None


def test_the_yearly_figure_is_a_whole_number_from_0_to_50_million_and_garbage_is_ignored(tmp_path):
    links = MemberLinks(tmp_path / "member-links.json")
    links.claim(A, "a_name", PASSES, now=1.0)
    for sent, kept in ((4321.6, 4322), (0, 0), (50_000_000, 50_000_000), (50_000_001, 50_000_000), (-1, 50_000_000),
                       (float("nan"), 50_000_000), (float("inf"), 50_000_000), (True, 50_000_000), ("9", 50_000_000),
                       (None, 50_000_000), (12.4, 12)):
        links.update(A, year=sent)
        assert links.get(A)["year"] == kept, sent
    assert links.uids() == [A]


def test_a_year_of_half_a_rax_is_rounded_half_up_like_the_site():
    summary = summarize([{"key": "nba:2025:player:1", "tier": "common"}])
    assert "Starter" in roles_for(summary, 0.5)


def test_a_pass_listed_twice_is_counted_once():
    one = {"key": "nba:2025:player:1", "tier": "common"}
    assert summarize([one, dict(one), dict(one)]) == summarize([one])


def test_a_rung_is_read_as_the_site_reads_it():
    # An exact rating beats a rarity given by hand; a rating below 0 reads as 0 (lib/passes.ts heldRung).
    rated = summarize([{"key": "nba:2025:player:1", "tier": "rare", "rating": 400}])
    assert rated["sports"]["nba"]["rungs"] == {"legendary": 1}
    negative = summarize([{"key": "nba:2025:player:2", "rating": -500}])
    assert negative["sports"]["nba"]["rungs"] == {"general": 1}
