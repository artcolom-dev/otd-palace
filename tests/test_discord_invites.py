"""The invite board (/invites): joins through a member's own invite links as Discord counts them, the highest count
seen kept, the staff and the bots left out, two roles for show given once and never taken back by the board. Discord
is a scripted fake guild and the clock a number: no test reaches the network or waits."""

import json

import pytest

from advisor import discord_commands as dc
from advisor import discord_invites as inv
from advisor import discord_perks as perks
from advisor import privacy
from advisor.rules import (
    INVITE_ROLES,
    INVITERS_MAX,
    INVITES_CHECKS_PER_ROUND,
    INVITES_GRANTS_PER_ROUND,
    INVITES_MEMBER_CHECK_S,
    INVITES_REFRESH_S,
    INVITES_TOP,
)
from tests.test_discord_commands import USER_ID, call, command, make, snap
from tests.test_discord_gate import BOT_TOKEN, GUILD_ID
from tests.test_discord_perks import PUBLIC, TEAM_ROLE, Clock, FakeGuild

A = "111111111111111111"
B = "222222222222222222"
C = "333333333333333333"
STAFFER = "444444444444444444"
BOT = "555555555555555555"
HELPER_ROLE = "400000000000000011"
(RECRUITER, RECRUITER_FROM), (AMBASSADOR, AMBASSADOR_FROM) = INVITE_ROLES


def invite(code, uid, uses, bot=False):
    return {"code": code, "uses": uses, "max_age": 0, "inviter": {"id": uid, "username": "x", "bot": bot}}


class Guild(FakeGuild):
    """The perks' fake guild with staff roles that carry rights, and the server's invites."""

    def __init__(self):
        super().__init__()
        self.roles = [{"id": GUILD_ID, "name": "@everyone", "permissions": "104189505"},
                      {"id": TEAM_ROLE, "name": "Palace Team", "permissions": "8"},
                      {"id": HELPER_ROLE, "name": "Helper", "permissions": "0"}]
        self.members = {A: [], B: [], C: [], STAFFER: [HELPER_ROLE]}
        self.invites: list[dict] = []

    def __call__(self, method, url, headers, body):
        path = url.removeprefix(perks.API)
        if path == f"/guilds/{GUILD_ID}/invites" and method == "GET" and (method, path) not in self.fail:
            assert headers["Authorization"] == f"Bot {BOT_TOKEN}"
            self.calls.append((method, path, None))
            return 200, json.dumps(self.invites).encode()
        status, raw = super().__call__(method, url, headers, body)
        if method == "POST" and path == f"/guilds/{GUILD_ID}/roles":
            self.roles[-1]["permissions"] = "0"
        return status, raw


@pytest.fixture
def world(tmp_path):
    guild, clock = Guild(), Clock()
    bot = perks.PerkBot(perks.PerkConfig(BOT_TOKEN, GUILD_ID, PUBLIC), transport=guild, clock=clock)
    board = inv.InviteBoard(tmp_path / "invites.json", clock=clock)
    return type("World", (), {"guild": guild, "clock": clock, "bot": bot, "board": board,
                              "path": tmp_path / "invites.json"})


def read(world, minutes=0):
    """One read of Discord's invites, `minutes` later (a read sooner than the refresh time is not made)."""
    world.clock.t += minutes * 60
    return world.board.refresh(world.bot)


# --- the count -------------------------------------------------------------------------------------------------------


def test_tally_sums_the_uses_of_each_inviters_links_and_leaves_out_bots_and_ownerless_links():
    found = inv.tally([invite("a1", A, 2), invite("a2", A, 3), invite("b1", B, 1), invite("bot", BOT, 40, bot=True),
                       {"code": "vanity", "uses": 9}, {"code": "odd", "uses": "7", "inviter": {"id": C}},
                       {"code": "neg", "uses": -1, "inviter": {"id": C}}, "junk",
                       {"code": "badid", "uses": 3, "inviter": {"id": "not-an-id"}}, invite("zero", C, 0)])
    assert found == {A: 5, B: 1, C: 0}
    assert inv.tally(None) == {} and inv.tally({"message": "Missing Permissions"}) == {}


def test_a_read_counts_the_joins_and_the_board_lists_them_highest_first(world):
    world.guild.invites = [invite("a1", A, 2), invite("a2", A, 3), invite("b1", B, 7), invite("c1", C, 0)]
    assert not world.board.ready()
    assert read(world) is True
    assert world.board.ready()
    assert world.board.top() == [(B, 7), (A, 5)]  # nobody with no join is listed
    assert world.board.count(A) == 5 and world.board.count(C) == 0 and world.board.count("999999999999999999") == 0


def test_invites_are_read_once_per_refresh_time_and_not_while_discord_says_to_wait(world):
    world.guild.invites = [invite("a1", A, 2)]
    read(world)
    reads = lambda: sum(1 for m, p, _ in world.guild.calls if p.endswith("/invites"))  # noqa: E731
    assert reads() == 1
    assert read(world, minutes=INVITES_REFRESH_S / 60 - 1) is False and reads() == 1
    assert read(world, minutes=1) is True and reads() == 2


def test_the_highest_count_seen_is_kept_when_a_link_expires(world):
    world.guild.invites = [invite("a1", A, 6)]
    read(world)
    world.guild.invites = []  # the link expired: Discord forgets its joins
    read(world, minutes=10)
    assert world.board.count(A) == 6 and world.board.top() == [(A, 6)]
    world.guild.invites = [invite("a2", A, 2)]  # a new link counts from zero at Discord: still 6 here, never less
    read(world, minutes=10)
    assert world.board.count(A) == 6


def test_the_counts_survive_a_restart_and_hold_ids_and_numbers_only(world):
    world.guild.invites = [invite("a1", A, 4), invite("b1", B, 1)]
    read(world)
    again = inv.InviteBoard(world.path, clock=world.clock)
    assert again.ready() and again.top() == [(A, 4), (B, 1)]
    kept = world.path.read_text()
    assert "username" not in kept and '"x"' not in kept and "a1" not in kept  # no name, no invite code
    assert set(json.loads(kept)) == {"inviters", "erased", "take_back", "read_at"}


def test_a_file_that_cannot_be_read_starts_empty_and_is_set_aside(world):
    world.path.write_text("{not json")
    board = inv.InviteBoard(world.path, clock=world.clock)
    assert not board.ready() and board.top() == []
    assert world.path.with_name("invites.json.corrupt").exists()


def test_a_failed_read_keeps_the_board_and_says_nothing_of_discords_answer(world, caplog):
    world.guild.invites = [invite("a1", A, 4)]
    read(world)
    world.guild.fail[("GET", f"/guilds/{GUILD_ID}/invites")] = (403, {"message": "Missing Permissions", "code": 50013})
    assert read(world, minutes=10) is False
    assert world.board.top() == [(A, 4)]
    assert "Manage Server" in caplog.text and BOT_TOKEN not in caplog.text and "Missing Permissions" not in caplog.text


def test_before_any_read_the_board_rests(world):
    world.guild.fail[("GET", f"/guilds/{GUILD_ID}/invites")] = (500, {})
    assert read(world) is False
    assert not world.board.ready()
    assert inv.answer(world.board, A, []) == inv.RESTING


def test_the_staff_bots_and_members_who_left_are_left_off_the_board(world):
    world.guild.invites = [invite("s", STAFFER, 50), invite("a", A, 3), invite("bot", BOT, 99, bot=True),
                           invite("left", "666666666666666666", 20)]
    read(world)
    assert world.board.top() == [(A, 3)]
    assert world.board.count(STAFFER) == 50  # their own count is still theirs to see


def test_an_inviter_is_listed_only_once_discord_said_who_they_are(world):
    """Without the staff roles' ids (the roles cannot be read) nobody can be told from the staff: nobody is listed."""
    world.guild.invites = [invite("a", A, 3)]
    world.guild.fail[("GET", f"/guilds/{GUILD_ID}/roles")] = (500, {})
    read(world)
    assert world.board.top() == [] and world.board.count(A) == 3
    del world.guild.fail[("GET", f"/guilds/{GUILD_ID}/roles")]
    world.clock.t += 3600  # the bot's wait after a 5xx is over
    read(world)
    assert world.board.top() == [(A, 3)]


def test_only_so_many_inviters_are_asked_about_in_one_read_the_highest_first(world):
    many = [str(700000000000000000 + i) for i in range(INVITES_CHECKS_PER_ROUND + 5)]
    for i, uid in enumerate(many):
        world.guild.members[uid] = []
    world.guild.invites = [invite(f"c{i}", uid, 100 - i) for i, uid in enumerate(many)]
    read(world)
    asked = [p.rsplit("/", 1)[1] for m, p, _ in world.guild.calls if m == "GET" and "/members/" in p]
    assert asked == many[:INVITES_CHECKS_PER_ROUND]
    assert len(world.board.top(100)) == INVITES_CHECKS_PER_ROUND
    read(world, minutes=10)
    assert len(world.board.top(100)) == len(many)


def test_a_member_who_joins_the_staff_leaves_the_board_at_the_next_check(world):
    world.guild.invites = [invite("a", A, 3)]
    read(world)
    assert world.board.top() == [(A, 3)]
    world.guild.members[A].append(TEAM_ROLE)
    world.clock.t += INVITES_MEMBER_CHECK_S
    read(world)
    assert world.board.top() == []


def test_no_more_inviters_are_kept_than_the_limit(tmp_path):
    board = inv.InviteBoard(tmp_path / "i.json", clock=Clock(), max_inviters=2)
    board.record({A: 1, B: 2, C: 3})
    assert (board.count(A), board.count(B), board.count(C)) == (0, 2, 3)  # the highest counts are the ones kept
    board.record({A: 9})  # full: a newcomer waits, whatever their count (nobody kept is ever dropped)
    assert board.count(A) == 0
    assert INVITERS_MAX >= 1000


# --- the roles -------------------------------------------------------------------------------------------------------


def test_the_roles_are_given_at_their_thresholds_made_with_no_right_and_given_once(world):
    world.guild.invites = [invite("a", A, RECRUITER_FROM), invite("b", B, AMBASSADOR_FROM),
                           invite("c", C, RECRUITER_FROM - 1)]
    read(world)
    assert world.guild.role_names(A) == [RECRUITER]
    assert world.guild.role_names(B) == sorted([RECRUITER, AMBASSADOR])
    assert world.guild.role_names(C) == []
    made = [sent for m, p, sent in world.guild.calls if m == "POST" and p.endswith("/roles")]
    assert {r["name"] for r in made} == {RECRUITER, AMBASSADOR} and all(r["permissions"] == "0" for r in made)
    puts = lambda: sum(1 for m, p, _ in world.guild.calls if m == "PUT" and "/roles/" in p)  # noqa: E731
    before = puts()
    read(world, minutes=10)
    assert puts() == before  # given once: a role the staff took back by hand is not given again


def test_the_board_never_takes_a_role_back(world):
    world.guild.invites = [invite("a", A, RECRUITER_FROM)]
    read(world)
    world.guild.invites = []
    read(world, minutes=10)
    world.clock.t += INVITES_MEMBER_CHECK_S
    read(world, minutes=10)
    assert world.guild.role_names(A) == [RECRUITER]
    assert not [1 for m, p, _ in world.guild.calls if m == "DELETE"]


def test_the_staff_get_no_invite_role_and_a_role_with_rights_is_left_alone(world):
    world.guild.roles.append({"id": "400000000000000020", "name": RECRUITER, "permissions": "8"})  # someone gave it rights
    world.guild.invites = [invite("s", STAFFER, 50), invite("a", A, RECRUITER_FROM)]
    read(world)
    assert world.guild.role_names(STAFFER) == ["Helper"]
    assert world.guild.role_names(A) == []  # never handed out while it carries a right


def test_a_role_that_could_not_be_given_is_tried_again_and_only_so_many_are_given_in_one_read(world):
    many = [str(700000000000000000 + i) for i in range(INVITES_GRANTS_PER_ROUND + 2)]
    for uid in many:
        world.guild.members[uid] = []
    world.guild.invites = [invite(f"c{i}", uid, RECRUITER_FROM) for i, uid in enumerate(many)]
    read(world)
    assert sum(1 for uid in many if world.guild.role_names(uid)) == INVITES_GRANTS_PER_ROUND
    read(world, minutes=10)
    assert all(world.guild.role_names(uid) == [RECRUITER] for uid in many)


def test_the_perks_sync_never_takes_an_invite_role_back(world):
    world.guild.invites = [invite("a", A, RECRUITER_FROM)]
    read(world)
    assert world.bot.sync_member(A, [])  # an unlink: every role the perks manage goes
    assert world.guild.role_names(A) == [RECRUITER]
    assert not {name for name, _ in INVITE_ROLES} & perks.managed_roles()


def test_the_bots_calls_say_gone_wait_and_never_touch_a_role_with_rights(world):
    assert world.bot.member_roles(STAFFER) == ("ok", frozenset({HELPER_ROLE}))
    assert world.bot.member_roles("666666666666666666") == ("gone", frozenset())
    assert world.bot.role_ids(inv.STAFF_ROLES) == {"palace team": TEAM_ROLE, "helper": HELPER_ROLE}
    assert world.bot.give_role("666666666666666666", RECRUITER) is None  # not in the server: nothing given
    assert world.bot.take_role(A, RECRUITER) is True  # held by nobody: nothing to take
    assert world.bot.take_role(A, "Palace Team") is True and world.bot.give_role(A, "Palace Team") is None
    assert not [1 for m, p, _ in world.guild.calls if m in ("PUT", "DELETE") and p.endswith(TEAM_ROLE)]
    world.guild.fail[("GET", f"/guilds/{GUILD_ID}/members/{A}")] = (500, {})
    assert world.bot.member_roles(A) == ("wait", frozenset())
    assert world.bot.invites() is None  # the bot waits after a 5xx: no call, no answer


def test_discord_saying_wait_stops_the_member_checks_until_the_next_read(world):
    world.guild.invites = [invite("b", B, 9), invite("a", A, 3)]
    world.guild.fail[("GET", f"/guilds/{GUILD_ID}/members/{B}")] = (429, {"retry_after": 5})
    read(world)
    assert world.board.top() == []  # B could not be asked about, and A was not asked after Discord said to wait
    del world.guild.fail[("GET", f"/guilds/{GUILD_ID}/members/{B}")]
    read(world, minutes=10)
    assert world.board.top() == [(B, 9), (A, 3)]


# --- delete my data --------------------------------------------------------------------------------------------------


def test_erasing_forgets_the_count_keeps_a_dated_mark_and_takes_the_invite_roles_back(world):
    world.guild.invites = [invite("a", A, RECRUITER_FROM), invite("b", B, 1)]
    read(world)
    assert world.board.erase(A) is True
    assert world.board.count(A) == 0 and world.board.top() == [(B, 1)]
    read(world, minutes=10)  # Discord still counts their links: nothing is kept under them again
    assert world.board.count(A) == 0 and world.board.top() == [(B, 1)]
    assert world.guild.role_names(A) == []  # asked for by the member: the one time a role is taken back
    kept = json.loads(world.path.read_text())
    assert A not in kept["inviters"] and set(kept["erased"]) == {A} and kept["take_back"] == []
    assert world.board.erase("999999999999999999") is False


def test_a_member_who_asks_again_is_counted_again(world):
    world.guild.invites = [invite("a", A, 2)]
    read(world)
    world.board.erase(A)
    words = inv.answer(world.board, A, [])
    assert "counted again" in words
    read(world, minutes=10)
    assert world.board.count(A) == 2


def test_delete_my_data_erases_the_invite_count_too(world):
    world.guild.invites = [invite("a", A, 2)]
    read(world)

    class Worker:
        invites = world.board
        synced = []

        def request_sync(self, uid):
            self.synced.append(uid)

    done = privacy.erase_member(A, None, None, Worker())
    assert done["failed"] is False and world.board.count(A) == 0 and Worker.synced == [A]


def test_the_privacy_notice_says_what_the_board_keeps():
    page = privacy.render_page()
    assert "make an invite link to our server" in page and "highest number of joins" in page
    assert "Invite count:" in page and "your invite count" in page  # how long it is kept, and that Delete removes it


# --- what a member sees ----------------------------------------------------------------------------------------------


def test_the_answer_of_a_member_on_the_board(world):
    world.guild.invites = [invite("a", A, 4), invite("b", B, 12), invite("s", STAFFER, 50)]
    read(world)
    assert inv.answer(world.board, A, []) == "\n".join([
        "**Your invites:** 4 joins through your invite links · #2 on the board",
        f"You have earned **{RECRUITER}**. Next: **{AMBASSADOR}** at {AMBASSADOR_FROM} joins.",
        "**Top inviters**",
        f"1. <@{B}> · 12 joins",
        f"2. <@{A}> · 4 joins",
        inv.HOW_TO,
        inv.FINE_PRINT,
    ])


def test_the_answer_of_a_member_with_no_join_yet(world):
    world.guild.invites = [invite("b", B, 1)]
    read(world)
    words = inv.answer(world.board, A, [])
    assert words.startswith("**Your invites:** no join through your invite links yet.\n"
                            f"**{RECRUITER}** comes at {RECRUITER_FROM} joins, **{AMBASSADOR}** at {AMBASSADOR_FROM}. "
                            "Both are for show: they unlock nothing.")
    assert f"1. <@{B}> · 1 join\n" in words


def test_the_answer_with_nobody_on_the_board_and_at_the_top_role(world):
    read(world)
    assert "Nobody is on the board yet" in inv.answer(world.board, A, [])
    world.guild.invites = [invite("a", A, AMBASSADOR_FROM + 5)]
    read(world, minutes=10)
    assert f"You have earned **{AMBASSADOR}**, the top invite role." in inv.answer(world.board, A, [])


def test_the_staff_see_their_count_and_are_told_they_are_off_the_board(world):
    world.guild.invites = [invite("s", STAFFER, 50), invite("a", A, 4)]
    read(world)
    words = inv.answer(world.board, STAFFER, [HELPER_ROLE])
    assert words.startswith("**Your invites:** 50 joins through your invite links. The team is left off the board.\n"
                            "**Top inviters**")
    assert "earned" not in words and f"<@{STAFFER}>" not in words


def test_the_board_lists_only_so_many(world):
    many = [str(700000000000000000 + i) for i in range(INVITES_TOP + 3)]
    for uid in many:
        world.guild.members[uid] = []
    world.guild.invites = [invite(f"c{i}", uid, 100 - i) for i, uid in enumerate(many)]
    read(world)
    words = inv.answer(world.board, many[-1], [])
    assert f"{INVITES_TOP}. <@{many[INVITES_TOP - 1]}>" in words and f"{INVITES_TOP + 1}. " not in words
    assert f"#{INVITES_TOP + 3} on the board" in words
    assert len(words) < dc.CONTENT_MAX_CHARS - 200


def test_ties_are_listed_in_a_fixed_order(world):
    world.guild.invites = [invite("b", B, 3), invite("a", A, 3)]
    read(world)
    assert world.board.top() == [(A, 3), (B, 3)]


# --- the command -----------------------------------------------------------------------------------------------------


class Perks:
    def __init__(self, board):
        self.invites = board
        self.bot = None


def test_invites_is_a_registered_command_listed_in_help(world):
    names = [c["name"] for c in dc.COMMANDS]
    assert "invites" in names and next(c for c in dc.COMMANDS if c["name"] == "invites")["options"] == []
    interactions, _, _ = make(snap())
    _, answer = call(interactions, command("help"))
    assert "/invites" in answer["data"]["content"]


def test_the_command_answers_the_caller_alone_with_their_count(world):
    world.guild.invites = [invite("me", USER_ID, 4), invite("b", B, 12)]
    world.guild.members[USER_ID] = []
    read(world)
    interactions, _, _ = make(snap(), perks=Perks(world.board))
    status, answer = call(interactions, command("invites"))
    data = answer["data"]
    assert status == 200 and answer["type"] == 4 and data["flags"] & dc.EPHEMERAL
    assert data["allowed_mentions"] == {"parse": []}  # the names are shown, nobody is pinged
    assert "**Your invites:** 4 joins through your invite links · #2 on the board" in data["content"]
    assert data["content"].endswith("-# OTD Palace: https://palace.example.test")


def test_the_command_reads_the_callers_staff_role_from_discords_own_payload(world):
    world.guild.invites = [invite("me", USER_ID, 4)]
    world.guild.members[USER_ID] = []
    read(world)  # checked as a plain member...
    interactions, _, _ = make(snap(), perks=Perks(world.board))
    payload = command("invites")
    payload["member"]["roles"] = [TEAM_ROLE]  # ...and on the staff since
    _, answer = call(interactions, payload)
    assert "The team is left off the board." in answer["data"]["content"]


def test_without_the_bot_or_before_a_read_the_command_says_the_board_rests(world):
    for kw in ({}, {"perks": Perks(world.board)}, {"perks": type("NoBoard", (), {"bot": None})()}):
        interactions, _, _ = make(snap(), **kw)
        _, answer = call(interactions, command("invites"))
        assert inv.RESTING in answer["data"]["content"]


def test_the_command_never_fails_on_a_board_that_raises(world):
    class Broken:
        def __getattr__(self, name):
            raise RuntimeError("boom")

    interactions, _, _ = make(snap(), perks=Perks(Broken()))
    status, answer = call(interactions, command("invites"))
    assert status == 200 and "Something went wrong on our side" in answer["data"]["content"]


# --- the worker ------------------------------------------------------------------------------------------------------


def test_the_perks_worker_reads_the_invites_in_its_own_loop(world, tmp_path):
    from advisor.members import MemberLinks

    worker = perks.PerkWorker(world.bot, MemberLinks(tmp_path / "links.json"), clock=world.clock)
    assert worker.invites is None
    worker.invites_round()  # no board: nothing asked
    assert not [1 for m, p, _ in world.guild.calls if p.endswith("/invites")]
    worker.invites = world.board
    world.guild.invites = [invite("a", A, 2)]
    worker.invites_round()
    assert world.board.top() == [(A, 2)]


def test_a_board_that_raises_never_stops_the_worker(world, tmp_path):
    from advisor.members import MemberLinks

    class Broken:
        def refresh(self, bot):
            raise RuntimeError("boom")

    worker = perks.PerkWorker(world.bot, MemberLinks(tmp_path / "links.json"), clock=world.clock)
    worker.invites = Broken()
    worker.invites_round()
