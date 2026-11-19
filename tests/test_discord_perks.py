"""What linking a Real account unlocks in our Discord: roles, two members-only channels and personal deal pings.
Discord is a scripted fake guild here and the clock a number: no test reaches the network or waits."""

import json

import pytest

from advisor import discord_perks as perks
from advisor.members import MemberLinks
from advisor.rules import LINK_PINGS_PER_DAY
from tests.test_discord_gate import BOT_TOKEN, GUILD_ID
from tests.test_discord_gate import ENV as GATE_ENV
from tests.test_discord_post import NOON, snapshot
from tests.test_discord_post import deal as _deal


def deal(listing_id=101, **over):
    """The poster tests' deal, on player 22 (the one these members hold) unless said otherwise."""
    return _deal(listing_id, **{"player_id": 22, **over})

PUBLIC = "https://palace.example.test"
UID = "111111111111111111"
OTHER = "222222222222222222"
MARKET = "300000000000000001"
TEAM_ROLE = "400000000000000009"
CLOSED = 50007  # Discord: "Cannot send messages to this user"


class FakeGuild:
    """A guild as Discord keeps it: roles, channels, members' roles and DM channels; `fail` answers a path."""

    def __init__(self):
        self.calls: list[tuple[str, str, dict | None]] = []
        self.roles = [{"id": GUILD_ID, "name": "@everyone"}, {"id": TEAM_ROLE, "name": "Palace Team"},
                      {"id": "400000000000000010", "name": "Deal Alerts"}]
        self.channels = [{"id": MARKET, "name": "MARKET", "type": 4}, {"id": "300000000000000002",
                                                                       "name": "live-deals", "type": 0}]
        self.members = {UID: [], OTHER: []}
        self.fail: dict[tuple[str, str], tuple[int, dict]] = {}
        self.dms: list[tuple[str, dict]] = []
        self.next_id = 500000000000000000

    def _id(self) -> str:
        self.next_id += 1
        return str(self.next_id)

    def __call__(self, method, url, headers, body):
        assert headers["Authorization"] == f"Bot {BOT_TOKEN}"
        path = url.removeprefix(perks.API)
        sent = json.loads(body) if body else None
        self.calls.append((method, path, sent))
        if (method, path) in self.fail:
            status, data = self.fail[(method, path)]
            return status, json.dumps(data).encode()
        g = f"/guilds/{GUILD_ID}"
        if path == f"{g}/roles" and method == "GET":
            return 200, json.dumps(self.roles).encode()
        if path == f"{g}/roles" and method == "POST":
            role = {"id": self._id(), "name": sent["name"]}
            self.roles.append(role)
            return 200, json.dumps(role).encode()
        if path == f"{g}/channels" and method == "GET":
            return 200, json.dumps(self.channels).encode()
        if path == f"{g}/channels" and method == "POST":
            channel = {"id": self._id(), **sent}
            self.channels.append(channel)
            return 201, json.dumps(channel).encode()
        if method == "PUT" and path.startswith("/channels/") and "/permissions/" in path:
            _, _, cid, _, rid = path.split("/")
            channel = next(c for c in self.channels if c["id"] == cid)
            over = channel.setdefault("permission_overwrites", [])
            over[:] = [o for o in over if o["id"] != rid] + [{"id": rid, **sent}]
            return 204, b""
        if path.startswith(f"{g}/members/"):
            parts = path.split("/")
            uid = parts[4]
            if uid not in self.members:
                return 404, b'{"code": 10007}'
            if len(parts) == 5:
                return 200, json.dumps({"roles": self.members[uid]}).encode()
            role = parts[6]
            if method == "PUT" and role not in self.members[uid]:
                self.members[uid].append(role)
            if method == "DELETE" and role in self.members[uid]:
                self.members[uid].remove(role)
            return 204, b""
        if path == "/users/" + "@me/channels":
            return 200, json.dumps({"id": "6" + sent["recipient_id"][1:]}).encode()
        if path.startswith("/channels/") and path.endswith("/messages"):
            self.dms.append((path.split("/")[2], sent))
            return 200, json.dumps({"id": self._id()}).encode()
        return 404, b"{}"

    def role_names(self, uid):
        names = {r["id"]: r["name"] for r in self.roles}
        return sorted(names[r] for r in self.members[uid])


class Clock:
    def __init__(self, t=NOON):
        self.t = t

    def __call__(self):
        return self.t


@pytest.fixture
def guild():
    return FakeGuild()


def bot_for(guild, clock=None):
    config = perks.PerkConfig(bot_token=BOT_TOKEN, guild_id=GUILD_ID, public_url=PUBLIC)
    return perks.PerkBot(config, transport=guild, clock=clock or Clock())


def nba(n, start=0):
    return [{"key": f"nba:2026:player:{i}", "rating": 15.0} for i in range(start, start + n)]


def test_settings_follow_the_gate_and_can_be_turned_off():
    assert perks.config_from_env({}) is None
    config = perks.config_from_env(GATE_ENV)
    assert config.guild_id == GUILD_ID and BOT_TOKEN not in repr(config)
    assert perks.config_from_env({**GATE_ENV, "ADVISOR_DISCORD_PERKS": "0"}) is None


def test_linking_gives_the_roles_creating_the_missing_ones_once_without_any_permission(guild):
    bot = bot_for(guild)
    assert bot.sync_member(UID, ["Linked", "NBA", "Starter"]) is True
    assert guild.role_names(UID) == ["Linked", "NBA", "Starter"]
    created = [sent for method, path, sent in guild.calls if method == "POST" and path.endswith("/roles")]
    assert [c["name"] for c in created] == ["Linked", "NBA", "Starter"]
    assert all(c["permissions"] == "0" and c["mentionable"] is False for c in created)
    guild.calls.clear()
    assert bot.sync_member(OTHER, ["Linked", "NBA", "Starter"]) is True
    assert not [c for c in guild.calls if c[0] == "POST"]  # the roles exist now: none created again


def test_a_role_made_by_hand_after_the_bot_read_the_roles_is_never_made_twice(guild):
    bot = bot_for(guild)
    assert bot.sync_member(UID, ["Linked"]) is True  # the roles are read once and kept
    guild.roles.append({"id": "400000000000000030", "name": "Steady", "permissions": "0"})  # the setup script made it since
    guild.calls.clear()
    assert bot.sync_member(OTHER, ["Linked", "Steady"]) is True
    assert [r["name"] for r in guild.roles].count("Steady") == 1  # one Steady, not two
    assert not [c for c in guild.calls if c[0] == "POST" and c[1].endswith("/roles")]
    assert "400000000000000030" in guild.members[OTHER]


def test_a_refresh_moves_the_roles_and_an_unlink_takes_them_all_back(guild):
    bot = bot_for(guild)
    bot.sync_member(UID, ["Linked", "NBA", "Starter"])
    guild.members[UID].append(TEAM_ROLE)  # a role the bot does not manage stays whatever happens
    bot.sync_member(UID, ["Linked", "NFL", "Steady"])
    # a sport's role is also the member's own pick: a refresh adds sport roles and never takes one back
    assert guild.role_names(UID) == ["Linked", "NBA", "NFL", "Palace Team", "Steady"]
    bot.sync_member(UID, [])
    assert guild.role_names(UID) == ["Palace Team"]


def test_discord_errors_never_raise_and_a_member_who_left_is_skipped(guild):
    bot = bot_for(guild)
    del guild.members[UID]
    assert bot.sync_member(UID, ["Linked"]) is False
    guild.fail[("GET", f"/guilds/{GUILD_ID}/roles")] = (500, {})
    assert bot_for(guild).sync_member(OTHER, ["Linked"]) is False

    def broken(*_):
        raise TimeoutError

    config = perks.PerkConfig(bot_token=BOT_TOKEN, guild_id=GUILD_ID, public_url=PUBLIC)
    assert perks.PerkBot(config, transport=broken, clock=Clock()).sync_member(OTHER, ["Linked"]) is False


def test_the_two_lounges_are_made_once_under_market_for_their_role_alone(guild):
    bot = bot_for(guild)
    assert bot.ensure_channels() is True
    made = {c["name"]: c for c in guild.channels if c.get("type") == 0 and c["name"] != "live-deals"}
    assert set(made) == {"linked-lounge", "big-accounts"}
    roles = {r["name"]: r["id"] for r in guild.roles}
    for name, seen_by in (("linked-lounge", ["Linked"]), ("big-accounts", ["Big", "Giant"])):  # the two top account types
        channel = made[name]
        assert channel["parent_id"] == MARKET
        rules = {o["id"]: o for o in channel["permission_overwrites"]}
        assert rules[GUILD_ID]["deny"] == "1024"  # @everyone cannot see it
        assert all(rules[roles[role]]["allow"] == "1024" for role in seen_by) and rules[TEAM_ROLE]["allow"] == "1024"
        assert len(rules) == 2 + len(seen_by)  # @everyone, the team, and those roles alone
    calls = len(guild.calls)
    assert bot_for(guild).ensure_channels() is True
    assert not [c for c in guild.calls[calls:] if c[0] == "POST"]  # found by name: nothing made twice


def test_no_market_category_makes_no_channel(guild):
    guild.channels = [c for c in guild.channels if c["type"] != 4]
    assert bot_for(guild).ensure_channels() is False
    assert not [c for c in guild.calls if c[0] == "POST" and c[1].endswith("/channels")]


def links_with(tmp_path, players=("nba:22",), pings=True):
    links = MemberLinks(tmp_path / "member-links.json")
    passes = [{"key": f"{p.split(':')[0]}:2026:player:{p.split(':')[1]}", "rating": 15.0} for p in players]
    links.claim(UID, "shaedon", passes, now=NOON - 100)
    if not pings:
        links.update(UID, pings=False)
    return links


def test_a_deal_on_a_player_held_is_sent_by_dm_once(guild, tmp_path):
    links = links_with(tmp_path)
    worker = perks.PerkWorker(bot_for(guild), links, clock=Clock())
    snap = snapshot([deal(101), deal(102, player_id=99)])
    worker.ping_round(snap, fresh=True)
    assert [(ch, m["embeds"][0]["url"]) for ch, m in guild.dms] == [("6" + UID[1:], f"{PUBLIC}/d/101")]
    assert guild.dms[0][1]["allowed_mentions"] == {"parse": []}
    worker.ping_round(snap, fresh=True)
    assert len(guild.dms) == 1  # never the same listing twice
    assert links.get(UID)["dm_channel"] == "6" + UID[1:]


def test_followed_players_count_too_and_three_a_day_at_most(guild, tmp_path):
    links = links_with(tmp_path, players=())
    links.update(UID, follows=["nba:22"])
    clock = Clock()
    worker = perks.PerkWorker(bot_for(guild, clock), links, clock=clock)
    worker.ping_round(snapshot([deal(100 + i) for i in range(6)]), fresh=True)
    assert len(guild.dms) == LINK_PINGS_PER_DAY
    clock.t += 86400 + 1
    worker.ping_round(snapshot([deal(100 + i) for i in range(6)]), fresh=True)
    assert len(guild.dms) == 2 * LINK_PINGS_PER_DAY


def test_no_pings_when_off_on_stale_or_sample_data(guild, tmp_path):
    links = links_with(tmp_path, pings=False)
    worker = perks.PerkWorker(bot_for(guild), links, clock=Clock())
    worker.ping_round(snapshot([deal(101)]), fresh=True)
    links.update(UID, pings=True)
    worker.ping_round(snapshot([deal(101)]), fresh=False)
    worker.ping_round(snapshot([deal(101)], demo=True), fresh=True)
    worker.ping_round(snapshot([deal(101, confidence="low")]), fresh=True)  # under the posts' quality bar
    assert guild.dms == []


def test_closed_dms_are_remembered_and_stop_the_pings(guild, tmp_path):
    links = links_with(tmp_path)
    guild.fail[("POST", f"/channels/6{UID[1:]}/messages")] = (403, {"code": CLOSED})
    worker = perks.PerkWorker(bot_for(guild), links, clock=Clock())
    worker.ping_round(snapshot([deal(101), deal(102)]), fresh=True)
    assert links.get(UID)["dm_closed"] is True
    sends = [c for c in guild.calls if c[1].endswith("/messages")]
    assert len(sends) == 1  # stopped at the first refusal
    del guild.fail[("POST", f"/channels/6{UID[1:]}/messages")]
    worker.ping_round(snapshot([deal(103)]), fresh=True)
    assert guild.dms == []


def test_a_rate_limit_stops_the_round_and_the_next_one_waits(guild, tmp_path):
    links = links_with(tmp_path)
    clock = Clock()
    bot = bot_for(guild, clock)
    guild.fail[("POST", "/users/" + "@me/channels")] = (429, {"retry_after": 30})
    worker = perks.PerkWorker(bot, links, clock=clock)
    worker.ping_round(snapshot([deal(101)]), fresh=True)
    del guild.fail[("POST", "/users/" + "@me/channels")]
    calls = len(guild.calls)
    worker.ping_round(snapshot([deal(101)]), fresh=True)
    assert len(guild.calls) == calls  # still waiting
    clock.t += 31
    worker.ping_round(snapshot([deal(101)]), fresh=True)
    assert len(guild.dms) == 1 and links.get(UID)["dm_closed"] is False


def test_the_worker_refreshes_roles_from_the_link_kept(guild, tmp_path):
    links = MemberLinks(tmp_path / "member-links.json")
    links.claim(UID, "shaedon", nba(30), now=NOON)
    worker = perks.PerkWorker(bot_for(guild), links, clock=Clock())
    worker.request_sync(UID)
    worker.request_sync(UID)  # asked twice before it ran: one refresh
    assert worker.drain() == 1
    assert guild.role_names(UID) == ["Linked", "NBA", "Starter"]
    links.unlink(UID)
    worker.request_sync(UID)
    worker.drain()
    assert guild.role_names(UID) == []


def test_the_state_a_member_sees(guild, tmp_path):
    links = MemberLinks(tmp_path / "member-links.json")
    assert perks.perks_state(None) == {"linked": False, "roles": [], "lounge": False, "big_accounts": False,
                                       "pings": False, "dm_closed": False}
    links.claim(UID, "shaedon", nba(600), now=NOON)  # no yearly figure yet: 600 passes read as a Big account
    state = perks.perks_state(links.get(UID))
    assert state == {"linked": True, "roles": ["Linked", "NBA", "Big"], "lounge": True, "big_accounts": True,
                     "pings": True, "dm_closed": False}
    # the site's figure wins over the number of passes, and #big-accounts opens to Big and Giant alone
    for year, role, opens in ((900, "Starter", False), (70_000, "Steady", False), (400_000, "Strong", False),
                              (500_000, "Big", True), (3_000_000, "Giant", True)):
        links.update(UID, year=year)
        state = perks.perks_state(links.get(UID))
        assert state["roles"] == ["Linked", "NBA", role] and state["big_accounts"] is opens, year


def test_a_role_of_that_name_with_permissions_is_never_given_nor_made_again(guild):
    guild.roles.append({"id": "400000000000000020", "name": "NBA", "permissions": "8"})  # an admin's role
    guild.members[UID].append("400000000000000020")
    bot = bot_for(guild)
    bot.sync_member(UID, ["Linked", "NBA", "Starter"])
    assert guild.role_names(UID) == ["Linked", "NBA", "Starter"]  # theirs, kept; no second NBA made
    assert [r["name"] for r in guild.roles].count("NBA") == 1
    bot.sync_member(UID, [])
    assert guild.role_names(UID) == ["NBA"]  # and never taken back by the bot


def test_a_failed_refresh_is_tried_again_later_with_a_growing_delay_and_never_given_up(guild, tmp_path):
    clock = Clock()
    links = MemberLinks(tmp_path / "member-links.json")
    links.claim(UID, "shaedon", nba(30), now=NOON)
    worker = perks.PerkWorker(bot_for(guild, clock), links, clock=clock)
    fail = ("GET", f"/guilds/{GUILD_ID}/members/{UID}")
    guild.fail[fail] = (403, {})
    worker.request_sync(UID)
    assert worker.drain() == 1 and worker.drain() == 0  # it waits for its delay, Discord is not hammered
    waits = []
    for _ in range(8):
        before = len(guild.calls)
        for step in range(1, 1000):
            clock.t += 5
            if worker.drain():
                waits.append(step * 5)
                break
        assert len(guild.calls) > before
    assert waits[0] < waits[2] < waits[4] and max(waits) <= 300 + 5 and waits[-1] >= 295  # grows, capped
    del guild.fail[fail]  # a year later it still comes back: no give-up
    clock.t += 300
    assert worker.drain() == 1
    assert guild.role_names(UID) == ["Linked", "NBA", "Starter"]
    clock.t += 3000
    assert worker.drain() == 0  # done: nothing left waiting


def test_a_member_who_left_is_marked_gone_not_retried_not_pinged_and_comes_back_on_the_next_sweep(guild, tmp_path):
    clock = Clock()
    links = links_with(tmp_path)
    worker = perks.PerkWorker(bot_for(guild, clock), links, clock=clock)
    guild.members.pop(UID)  # banned or removed: Discord answers 404
    guild.fail[("GET", f"/guilds/{GUILD_ID}/members/{UID}")] = (404, {"code": 10007})
    worker.request_sync(UID)
    assert worker.drain() == 1
    assert links.get(UID)["gone"] is True and links.pingable() == []
    calls = len(guild.calls)
    clock.t += 10_000
    assert worker.drain() == 0 and len(guild.calls) == calls  # not retried for ever
    del guild.fail[("GET", f"/guilds/{GUILD_ID}/members/{UID}")]
    guild.members[UID] = []  # they rejoin
    worker2 = perks.PerkWorker(bot_for(guild, clock), links, clock=clock)  # a restart's sweep asks for everyone
    assert worker2.sweep() == 1
    worker2.drain()
    assert guild.role_names(UID) == ["Linked", "Starter"] and links.get(UID)["gone"] is False
    assert [uid for uid, _ in links.pingable()] == [UID]


def test_a_429_pauses_the_refreshes_for_what_discord_said(guild, tmp_path):
    clock = Clock()
    links = MemberLinks(tmp_path / "member-links.json")
    links.claim(UID, "shaedon", nba(30), now=NOON)
    worker = perks.PerkWorker(bot_for(guild, clock), links, clock=clock)
    guild.fail[("GET", f"/guilds/{GUILD_ID}/members/{UID}")] = (429, {"retry_after": 120})
    worker.request_sync(UID)
    assert worker.drain() == 1
    calls = len(guild.calls)
    clock.t += 100
    assert worker.drain() == 0 and len(guild.calls) == calls  # still inside Retry-After


def test_a_dm_channel_discord_forgot_is_opened_again(guild, tmp_path):
    links = links_with(tmp_path)
    links.note_dm(UID, channel="700000000000000001")
    guild.fail[("POST", "/channels/700000000000000001/messages")] = (404, {"code": 10003})
    perks.PerkWorker(bot_for(guild), links, clock=Clock()).ping_round(snapshot([deal(101)]), fresh=True)
    assert len(guild.dms) == 1 and links.get(UID)["dm_channel"] == "6" + UID[1:]


def test_no_ping_for_a_card_of_a_pass_held_at_its_rarity_or_higher(guild, tmp_path):
    links = MemberLinks(tmp_path / "member-links.json")
    links.claim(UID, "shaedon", [{"key": "nba:2026:player:22", "rarity": "epic"}], now=NOON)
    worker = perks.PerkWorker(bot_for(guild), links, clock=Clock())
    worker.ping_round(snapshot([deal(101, rarity=3), deal(102, rarity=5), deal(103, season=2025, rarity=1)]), fresh=True)
    assert sorted(m["embeds"][0]["url"].rsplit("/", 1)[1] for _, m in guild.dms) == ["102", "103"]


def test_a_button_toggles_the_role_and_reads_the_roles_fresh_each_time(guild):
    bot = bot_for(guild)
    assert bot.toggle_role(UID, "NBA", []) is True  # made with no permission, then given
    rid = next(r["id"] for r in guild.roles if r["name"] == "NBA")
    assert guild.members[UID] == [rid]
    assert bot.toggle_role(UID, "NBA", [rid]) is False and guild.members[UID] == []
    reads = [c for c in guild.calls if c[:2] == ("GET", f"/guilds/{GUILD_ID}/roles")]
    assert len(reads) == 2  # not a table kept from the first tap


def test_a_role_that_gained_a_permission_since_is_never_handed_out_by_a_button(guild):
    bot = bot_for(guild)
    assert bot.toggle_role(UID, "NBA", []) is True
    next(r for r in guild.roles if r["name"] == "NBA")["permissions"] = "8"  # someone made it an admin role
    assert bot.toggle_role(OTHER, "NBA", []) is None and guild.members[OTHER] == []


def test_a_role_given_permissions_later_is_noticed_once_the_cached_roles_are_old(guild):
    clock = Clock()
    bot = bot_for(guild, clock)
    assert bot.sync_member(UID, ["Linked", "NBA"]) is True
    next(r for r in guild.roles if r["name"] == "NBA")["permissions"] = "8"  # staff gave it a permission since
    clock.t += 60
    bot.sync_member(OTHER, ["Linked", "NBA"])  # still within the cache: not read again
    assert "NBA" in guild.role_names(OTHER)
    clock.t += perks.ROLES_CACHE_S
    bot.sync_member(UID, ["Linked", "NBA"])
    guild.members[OTHER] = []
    bot.sync_member(OTHER, ["Linked", "NBA"])
    assert guild.role_names(OTHER) == ["Linked"]  # never handed out again


def test_a_toggle_that_discord_refuses_says_so(guild):
    bot = bot_for(guild)
    assert bot.toggle_role(UID, "NBA", []) is True
    rid = next(r["id"] for r in guild.roles if r["name"] == "NBA")
    guild.fail[("PUT", f"/guilds/{GUILD_ID}/members/{OTHER}/roles/{rid}")] = (403, {})
    assert bot.toggle_role(OTHER, "NBA", []) is None


def test_the_lounge_of_the_big_accounts_is_not_the_old_role_s_any_more(guild):
    assert perks.BIG_ACCOUNT_ROLES == ("Big", "Giant")
    assert {"Not earning yet", "Starter", "Steady", "Strong", "Big", "Giant"} <= perks.managed_roles()
    assert {"Rookie", "Collector", "Big Account"} <= perks.managed_roles()  # still the bot's to take back


def test_a_refresh_moves_a_holder_of_an_old_size_role_to_the_type_and_takes_the_old_one_back(guild):
    old = {"id": "400000000000000031", "name": "Collector", "permissions": "0"}
    guild.roles.append(old)
    guild.members[UID].append(old["id"])
    bot = bot_for(guild)
    assert bot.sync_member(UID, ["Linked", "NBA", "Strong"]) is True
    assert guild.role_names(UID) == ["Linked", "NBA", "Strong"]
    assert [r["name"] for r in guild.roles].count("Collector") == 1  # the old role is left on the server for the setup script


def test_the_worker_sweeps_every_linked_member_once_at_start_so_old_roles_empty_out(guild, tmp_path):
    links = MemberLinks(tmp_path / "member-links.json")
    links.claim(UID, "shaedon", nba(30), now=NOON)
    links.claim(OTHER, "someone", nba(5), now=NOON)
    worker = perks.PerkWorker(bot_for(guild), links, clock=Clock())
    assert worker.sweep() == 2
    assert worker.drain() == 2
    assert guild.role_names(UID) == ["Linked", "NBA", "Starter"]
    assert worker.sweep() == 0  # once


def test_an_existing_big_accounts_is_opened_to_big_and_giant_without_taking_anything_away(guild):
    old = {"id": "400000000000000031", "name": "Big Account", "permissions": "0"}
    guild.roles.append(old)
    guild.channels.append({"id": "300000000000000077", "name": "big-accounts", "type": 0, "parent_id": MARKET,
                           "permission_overwrites": [{"id": GUILD_ID, "type": 0, "allow": "0", "deny": "1024"},
                                                     {"id": old["id"], "type": 0, "allow": "1024", "deny": "0"}]})
    guild.channels.append({"id": "300000000000000078", "name": "linked-lounge", "type": 0, "parent_id": MARKET,
                           "permission_overwrites": []})
    bot = bot_for(guild)
    assert bot.ensure_channels() is True
    ids = {r["name"]: r["id"] for r in guild.roles}
    lounge = next(c for c in guild.channels if c["name"] == "big-accounts")
    seen = {o["id"] for o in lounge["permission_overwrites"] if int(o["allow"]) & 1024}
    assert seen == {old["id"], ids["Big"], ids["Giant"]}  # the old role keeps its right while it exists
    puts = [c for c in guild.calls if c[0] == "PUT" and "/permissions/" in c[1]]
    assert len(puts) == 3  # Big, Giant and Linked (the lounge that had none)
    calls = len(guild.calls)
    assert bot_for(guild).ensure_channels() is True
    assert not [c for c in guild.calls[calls:] if c[0] in ("PUT", "POST")]  # a second time changes nothing


def test_the_start_up_sweep_asks_for_everyone_even_past_the_queue_s_room(guild, tmp_path):
    links = MemberLinks(tmp_path / "member-links.json")
    uids = [str(111111111111111111 + i) for i in range(5)]
    for i, uid in enumerate(uids):
        guild.members[uid] = []
        links.claim(uid, f"name_{i}", nba(3), now=NOON)
    worker = perks.PerkWorker(bot_for(guild), links, clock=Clock(), queue_max=2)
    asked, synced = 0, 0
    for _ in range(10):
        asked += worker.sweep()
        synced += worker.drain()
    assert asked == 5 and synced == 5 and worker.sweep() == 0
    assert all("Linked" in guild.role_names(uid) for uid in uids)
