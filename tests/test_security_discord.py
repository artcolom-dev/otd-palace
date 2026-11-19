"""Attacks through the Discord interactions endpoint and the bot's grants (see the internal research notes).
Every test is an attacker's move: it fails when the move works. Discord is a fake; nothing reaches the network."""

import json

import pytest

from advisor import discord_commands as dc
from advisor.discord_perks import PerkBot, PerkConfig
from advisor.members import MemberLinks
from tests.test_discord_commands import GOOD, NOW, USER_ID, call, command, make, sign, snap
from tests.test_discord_gate import BOT_TOKEN, GUILD_ID
from tests.test_discord_member_commands import APP, TOKEN, FakeImporter, OTHER, Perks, Webhook, passes

EVIL = ("@everyone @here <@&123456789012345678> <@222233334444555566> [free rax](https://evil.example) "
        "**bold** `code` ||spoiler|| # heading")


def no_mentions(message: dict) -> bool:
    return message["allowed_mentions"] == {"parse": []}


def test_every_answer_allows_no_mention_at_all_even_when_it_echoes_what_the_member_typed():
    interactions, _, _ = make(snap(GOOD))
    for name, options in (("price", {"player": EVIL, "share": True}), ("deals", {"share": True}), ("start", {"share": True}),
                          ("fees", {"price": 500, "share": True}), ("otd", {"share": True}), ("help", {}), ("me", {})):
        status, answer = call(interactions, command(name, **options))
        assert status == 200 and no_mentions(answer["data"]), name
    text = call(interactions, command("price", player=EVIL, share=True))[1]["data"]["content"]
    assert "[free rax](https" not in text and "<@" not in text.replace("\\<@", "") and "**bold**" not in text


def test_the_follow_up_of_a_slow_answer_allows_no_mention_either(tmp_path):
    hook = Webhook()
    links = MemberLinks(tmp_path / "m.json")
    interactions, _, _ = make(snap(GOOD), links=links, importer=FakeImporter(), transport=hook, spawn=lambda work: work() or True)
    payload = command("link", username="Shaedon")
    payload["application_id"], payload["token"] = APP, TOKEN
    call(interactions, payload)
    assert hook.calls and all(c[3]["allowed_mentions"] == {"parse": []} for c in hook.calls)


@pytest.mark.parametrize("username", ["@everyone", "<@123456789012345678>", "evil\nname", "a" * 31, "x", "../etc", "name;DROP",
                                      "‮evil", "bob\u0000", "ｅｖｉｌ"])
def test_a_link_with_a_name_that_is_not_a_real_username_never_reaches_the_importer_nor_the_store(tmp_path, username):
    importer, links = FakeImporter(), MemberLinks(tmp_path / "m.json")
    interactions, _, _ = make(snap(GOOD), links=links, importer=importer, transport=Webhook(), spawn=lambda w: w() or True)
    answer = call(interactions, command("link", username=username))[1]["data"]
    assert importer.looked_up == [] and links.uids() == []
    assert no_mentions(answer) and "<@" not in answer["content"]


def test_a_button_only_toggles_the_roles_it_was_made_for():
    perks = Perks()
    interactions, _, _ = make(snap(GOOD), perks=perks, spawn=lambda work: work() or True, transport=Webhook())
    for custom_id in ("role:Palace Team", "role:admin", "role:", "role:alerts\n", "ROLE:alerts", "role:Giant", "role:linked",
                      ["role:alerts"], None, 7):
        payload = command("x")
        payload.update({"type": 3, "application_id": APP, "token": TOKEN})
        payload["data"] = {"custom_id": custom_id, "component_type": 2}
        call(interactions, payload)
    assert perks.toggled == []


def test_a_button_toggles_for_the_member_who_tapped_never_for_someone_named_in_the_payload():
    perks = Perks()
    interactions, _, _ = make(snap(GOOD), perks=perks, spawn=lambda work: work() or True, transport=Webhook())
    payload = command("x", user=USER_ID)
    payload.update({"type": 3, "application_id": APP, "token": TOKEN, "user": {"id": OTHER}})
    payload["data"] = {"custom_id": "role:alerts", "component_type": 2, "target_id": OTHER, "values": [OTHER]}
    call(interactions, payload)
    assert [who for who, _, _ in perks.toggled] == [USER_ID]


def test_the_rate_limit_tables_do_not_grow_with_the_number_of_members():
    interactions, _, _ = make(snap(GOOD))
    for n in range(dc.USERS_MAX + 500):
        call(interactions, command("start", user=str(10**16 + n)))
    assert len(interactions._users) <= dc.USERS_MAX and len(interactions._slow) <= dc.USERS_MAX


@pytest.mark.parametrize("value", [None, True, 1.5, [], {}, "x" * 100_000, 10**400, "\u0000", -1])
def test_an_option_of_the_wrong_type_or_size_is_ignored_not_a_failure(value):
    interactions, _, _ = make(snap(GOOD))
    for name, option in (("fees", "price"), ("deals", "max_price"), ("price", "player"), ("deals", "sport"), ("otd", "sport")):
        payload = command(name)
        payload["data"]["options"] = [{"name": option, "value": value}]
        status, answer = call(interactions, payload)
        assert status == 200 and answer["type"] in (4, 5) and no_mentions(answer["data"])


def test_the_signature_covers_the_body_the_timestamp_and_the_key():
    interactions, _, _ = make(snap(GOOD))
    body = json.dumps(command("start")).encode()
    good = sign(body)
    assert interactions.handle(*good, body)[0] == 200
    assert interactions.handle(good[0], good[1], body + b" ")[0] == 401  # one byte more
    assert interactions.handle(good[0], str(int(good[1]) + 1), body)[0] == 401  # another timestamp
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    other = sign(body, key=Ed25519PrivateKey.from_private_bytes(bytes(range(1, 33))))
    assert interactions.handle(*other, body)[0] == 401
    far = str(int(NOW) + 10_000)
    assert interactions.handle(*sign(body, far), body)[0] == 401 and interactions.handle(*sign(body, "0"), body)[0] == 401
    ping = json.dumps({"type": 1}).encode()
    assert interactions.handle("0" * 128, str(int(NOW)), ping)[0] == 401  # a PING is signed like the rest


# --- the bot never gives a role that carries a permission, and DMs only the member it pings for -------------------------


class Discord:
    """Just the routes the bot calls: roles, a member, a role grant, a DM, a message; every write is recorded."""

    def __init__(self, roles):
        self.roles, self.writes, self.dms = roles, [], []

    def __call__(self, method, url, headers, body):
        path = url.split("/api/v10", 1)[1]
        if method == "GET" and path.endswith("/roles"):
            return 200, json.dumps(self.roles).encode()
        if method == "GET" and "/members/" in path:
            return 200, json.dumps({"roles": []}).encode()
        self.writes.append((method, path, body))
        if path.endswith("/users/@me/channels"):
            self.dms.append(json.loads(body)["recipient_id"])
            return 200, json.dumps({"id": "555566667777888899"}).encode()
        if method == "POST" and path.endswith("/roles"):
            return 200, json.dumps({"id": "900000000000000001"}).encode()
        return 204 if method in ("PUT", "DELETE") else 200, b"{}"


def role(name, rid, permissions="0", **over):
    return {"id": rid, "name": name, "permissions": permissions, "managed": False, **over}


def test_a_role_with_permissions_is_never_granted_even_when_it_carries_a_cosmetic_roles_name():
    api = Discord([role("Linked", "111111111111111111", "8"), role("Giant", "111111111111111112", "268435456"),
                   role("NBA", "111111111111111113", "0", managed=True), role("Steady", "111111111111111114", "0")])
    bot = PerkBot(PerkConfig(BOT_TOKEN, GUILD_ID, "https://palace.example.test"), transport=api)
    assert bot.sync_member("222233334444555566", ["Linked", "NBA", "Giant", "Steady"]) in (True, False)
    granted = [p.rsplit("/", 1)[1] for m, p, _ in api.writes if m == "PUT" and "/roles/" in p]
    assert granted == ["111111111111111114"]  # only the plain "Steady" is given: the three others carry power or an integration


def test_the_bot_creates_a_missing_role_with_no_permission_and_never_mentionable():
    api = Discord([])
    bot = PerkBot(PerkConfig(BOT_TOKEN, GUILD_ID, "https://palace.example.test"), transport=api)
    bot.sync_member("222233334444555566", ["Linked"])
    created = [json.loads(b) for m, p, b in api.writes if m == "POST" and p.endswith("/roles")]
    assert created and all(c["permissions"] == "0" and c["mentionable"] is False for c in created)
