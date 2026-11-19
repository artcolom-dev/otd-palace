"""Reading our Discord for the admin panel (advisor/discord_activity.py): GET only, counts of messages (never their
text), joins, leaves, roles and the reactions on the bot's posts, with Discord's limits respected."""

import json
from urllib.parse import parse_qs, urlsplit

from advisor.activity import ActivityLog
from advisor.discord_activity import (
    DiscordReader,
    ReaderConfig,
    config_from_env,
    snowflake_at,
    time_of,
)
from advisor.rules import DISCORD_ACTIVITY_PAGES

T0 = 1_795_000_000
GUILD = "876543210987654321"
UID = "111122223333444455"
UID2 = "999988887777666655"
AVATAR = "a" * 32
CONFIG = ReaderConfig(bot_token="bot-token-never-shown", guild_id=GUILD, public_url="https://example.test")


def sf(ts, n=0):
    return str(snowflake_at(ts) + n)


def message(ts, uid, n=0, bot=False, kind=0, reactions=(), content="", embeds=()):
    return {"id": sf(ts, n), "type": kind, "content": content, "embeds": list(embeds),
            "author": {"id": uid, "username": f"user{uid[-3:]}", "global_name": None, "avatar": AVATAR, "bot": bot},
            "reactions": [{"emoji": {"name": e, "id": None}, "count": c} for e, c in reactions]}


class FakeDiscord:
    """Our server as Discord's API shows it, read with GET only."""

    def __init__(self, members_list=403):
        self.calls = []
        self.members_list = members_list
        self.roles = [{"id": GUILD, "name": "@everyone"}, {"id": "500000000000000001", "name": "Linked"},
                      {"id": "500000000000000002", "name": "NBA"}]
        self.channels = [{"id": "600000000000000001", "type": 0, "name": "market-talk"},
                         {"id": "600000000000000002", "type": 0, "name": "live-deals"},
                         {"id": "600000000000000003", "type": 2, "name": "voice"},
                         {"id": "600000000000000004", "type": 15, "name": "questions"}]
        self.threads = [{"id": "700000000000000001", "type": 11, "parent_id": "600000000000000004",
                         "last_message_id": sf(T0 - 100)}]
        self.messages = {"600000000000000001": [message(T0 - 3600, UID, 1, content="secret words"),
                                                message(T0 - 3500, UID, 2), message(T0 - 3400, UID2, 3),
                                                message(T0 - 3300, UID2, 4, kind=7)],
                         "600000000000000002": [message(T0 - 7200, "800000000000000001", 5, bot=True,
                                                        reactions=[("🔥", 4), ("👍", 2)],
                                                        embeds=[{"title": "LeBron James 2025 · 40% under"}])],
                         "700000000000000001": [message(T0 - 100, UID2, 6)]}
        self.members = {UID: {"user": {"id": UID, "username": "dealhunter", "global_name": "Deal Hunter",
                                       "avatar": AVATAR},
                              "nick": None, "roles": ["500000000000000001"], "joined_at": "2026-11-01T10:00:00+00:00"}}
        self.status_for = {}

    def __call__(self, method, url, headers, body):
        assert method == "GET" and body is None
        assert headers["Authorization"] == "Bot bot-token-never-shown"
        parts = urlsplit(url)
        path, query = parts.path.removeprefix("/api/v10"), parse_qs(parts.query)
        self.calls.append(path + ("?" + parts.query if parts.query else ""))
        if path in self.status_for:
            status, data = self.status_for[path]
            return status, json.dumps(data).encode()
        if path == f"/guilds/{GUILD}/roles":
            return 200, json.dumps(self.roles).encode()
        if path == f"/guilds/{GUILD}/members":
            if self.members_list == 403:
                return 403, b'{"message": "Missing Access", "code": 50001}'
            return 200, json.dumps(list(self.members.values())).encode()
        if path.startswith(f"/guilds/{GUILD}/members/"):
            uid = path.rsplit("/", 1)[1]
            return (200, json.dumps(self.members[uid]).encode()) if uid in self.members else (404, b"{}")
        if path == f"/guilds/{GUILD}/channels":
            return 200, json.dumps(self.channels).encode()
        if path == f"/guilds/{GUILD}/threads/active":
            return 200, json.dumps({"threads": self.threads}).encode()
        if path.startswith("/channels/") and path.endswith("/messages"):
            cid = path.split("/")[2]
            found = sorted(self.messages.get(cid, []), key=lambda m: int(m["id"]), reverse=True)
            if "after" in query:
                after = int(query["after"][0])
                found = [m for m in found if int(m["id"]) > after]
                found = sorted(found, key=lambda m: int(m["id"]))[:int(query["limit"][0])]
                found.reverse()
            else:
                found = found[:int(query["limit"][0])]
            return 200, json.dumps(found).encode()
        return 404, b"{}"


class Clock:
    def __init__(self, at=T0):
        self.at = at

    def __call__(self):
        return self.at


def reader(fake=None, log=None, clock=None):
    clock = clock or Clock()
    log = log or ActivityLog(None, clock=clock)
    fake = fake or FakeDiscord()
    return DiscordReader(CONFIG, log, transport=fake, clock=clock, pause=lambda s: False), log, fake


def test_snowflakes_and_times_go_both_ways():
    assert abs(time_of(sf(T0)) - T0) < 1


def test_a_round_counts_messages_per_channel_day_and_author_never_their_text():
    r, log, fake = reader()
    status = r.run_once()
    day = T0 // 86400
    assert sorted(log.read("SELECT channel, uid, n FROM d_msgs")) == [
        ("market-talk", UID, 2), ("market-talk", UID2, 1), ("questions", UID2, 1)]
    assert sorted(log.read("SELECT day, channel, n FROM d_chan")) == [
        (day, "live-deals", 1), (day, "market-talk", 3), (day, "questions", 1)]
    assert "secret words" not in json.dumps(log.read("SELECT * FROM d_people"))
    assert status["messages"] == 5 and status["members_list"] == "refused"


def test_a_welcome_message_is_a_join():
    r, log, _ = reader()
    r.run_once()
    assert log.read("SELECT uid, kind FROM d_events WHERE kind = 'join'") == [(UID2, "join")]


def test_the_next_round_reads_only_what_is_new():
    r, log, fake = reader()
    r.run_once()
    fake.messages["600000000000000001"].append(message(T0 + 10, UID, 9))
    fake.calls.clear()
    r.run_once()
    assert ("market-talk", UID, 3) in log.read("SELECT channel, uid, n FROM d_msgs")
    after = [c for c in fake.calls if c.startswith("/channels/600000000000000001/messages?after=")]
    assert after == [f"/channels/600000000000000001/messages?after={sf(T0 - 3300, 4)}&limit=100"]


def test_a_first_read_goes_back_a_week_and_no_further():
    r, log, fake = reader()
    fake.messages["600000000000000001"].append(message(T0 - 8 * 86400, UID, 0))
    r.run_once()
    assert ("market-talk", UID, 2) in log.read("SELECT channel, uid, n FROM d_msgs")


def test_a_busy_channel_is_read_a_few_pages_a_round():
    r, log, fake = reader()
    fake.messages["600000000000000001"] = [message(T0 - 5000 + i, UID, i) for i in range(DISCORD_ACTIVITY_PAGES * 100 + 50)]
    r.run_once()
    assert log.read("SELECT n FROM d_msgs WHERE channel = 'market-talk'") == [(DISCORD_ACTIVITY_PAGES * 100,)]
    r.run_once()
    assert log.read("SELECT n FROM d_msgs WHERE channel = 'market-talk'") == [(DISCORD_ACTIVITY_PAGES * 100 + 50,)]


def test_the_bots_posts_are_kept_with_their_reactions():
    r, log, fake = reader()
    r.run_once()
    assert log.read("SELECT channel, title, reactions, top FROM d_posts") == [
        ("live-deals", "LeBron James 2025 · 40% under", 6, "🔥 4 · 👍 2")]
    fake.messages["600000000000000002"][0]["reactions"][0]["count"] = 9
    r.run_once()
    assert log.read("SELECT reactions FROM d_posts") == [(11,)]


def test_site_members_are_checked_one_by_one_without_the_members_intent():
    clock = Clock()
    r, log, fake = reader(clock=clock)
    log.note_auth(UID, "Deal Hunter")
    log.note_auth(UID2, "Gone Person")
    log.flush()
    r.run_once()
    people = dict((uid, (name, roles, present)) for uid, name, roles, present in
                  log.read("SELECT uid, name, roles, present FROM d_people WHERE checked IS NOT NULL"))
    assert people[UID] == ("Deal Hunter", json.dumps(["Linked"]), 1)
    assert people[UID2][2] == 0
    fake.members[UID]["roles"] = ["500000000000000001", "500000000000000002"]
    del fake.members[UID]
    clock.at += 1800
    r.run_once()
    assert log.read("SELECT uid, kind FROM d_events WHERE kind = 'leave'") == [(UID, "leave")]


def test_with_the_members_intent_the_whole_list_is_read():
    fake = FakeDiscord(members_list=200)
    r, log, _ = reader(fake=fake)
    status = r.run_once()
    assert status["members_list"] == "ok"
    assert log.read("SELECT uid, present FROM d_people WHERE uid = ?", (UID,)) == [(UID, 1)]


def test_discord_saying_wait_ends_the_round_and_nothing_is_written_wrong():
    fake = FakeDiscord()
    fake.status_for[f"/guilds/{GUILD}/channels"] = (429, {"retry_after": 5})
    r, log, _ = reader(fake=fake)
    status = r.run_once()
    assert status["error"] == "limited"
    assert log.read("SELECT COUNT(*) FROM d_chan") == [(0,)]


def test_only_get_is_ever_sent():
    r, _, fake = reader()
    r.run_once()  # FakeDiscord asserts every call is a GET without a body
    assert fake.calls


def test_someone_who_erased_their_data_is_counted_in_the_channel_only():
    r, log, fake = reader()
    log.erase_member(UID)
    r.run_once()
    assert log.read("SELECT COUNT(*) FROM d_msgs WHERE uid = ?", (UID,)) == [(0,)]
    assert log.read("SELECT COUNT(*) FROM d_people WHERE uid = ?", (UID,)) == [(0,)]
    assert ("market-talk", 3) in [(c, n) for _, c, n in log.read("SELECT day, channel, n FROM d_chan")]


def test_it_is_on_with_the_gate_and_off_with_the_switch():
    from tests.test_discord_gate import BOT_TOKEN, ENV as env

    assert config_from_env(env).guild_id == env["ADVISOR_DISCORD_GUILD_ID"]
    assert config_from_env({**env, "ADVISOR_DISCORD_ACTIVITY": "0"}) is None
    assert config_from_env({}) is None
    assert BOT_TOKEN not in repr(config_from_env(env))


def test_a_page_that_cannot_be_read_leaves_the_channel_where_it_was():
    fake = FakeDiscord()
    r, log, _ = reader(fake=fake)
    fake.status_for["/channels/600000000000000001/messages"] = (200, None)
    r.run_once()
    assert log.cursor("600000000000000001") == sf(T0 - 7 * 86400)  # read again from there next round
    assert log.read("SELECT COUNT(*) FROM d_chan WHERE channel = 'market-talk'") == [(0,)]
