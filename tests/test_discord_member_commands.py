"""The member's own slash commands (/link, /unlink, /me, /help) and the role picker's buttons: the same link as the site's
POST /api/me/link, answered inside Discord, the slow ones through the interaction's webhook. No network: the importer,
the bot and Discord's webhook are fakes, and the background work runs on the spot."""

import json
import threading

import pytest

from advisor import discord_commands as dc
from advisor.importer import Imported
from advisor.members import MemberLinks
from tests.test_discord_commands import NOW, SITE, USER_ID, call, command, make, snap
from tests.test_discord_gate import GUILD_ID

OTHER = "999988887777666655"
APP = "123456789012345678"
TOKEN = "interaction-token-" + "x" * 30


def passes(n_nba=5, n_nfl=1):
    rows = [{"key": f"nba:2026:player:{i}", "rating": 5.0, "rarity": "common"} for i in range(1, n_nba + 1)]
    rows += [{"key": f"nfl:2026:player:{i}", "rating": 9.0, "rarity": "rare"} for i in range(1, n_nfl + 1)]
    return tuple(rows)


class FakeImporter:
    def __init__(self, found=None, cached=None):
        self.found = found or Imported("ok", "Shaedon", passes())
        self._cached = cached
        self.looked_up = []

    def cached(self, name):
        return self._cached

    def lookup(self, name):
        self.looked_up.append(name)
        return self.found


class Perks:
    def __init__(self, held_result=True):
        self.synced = []
        self.toggled = []
        self.result = held_result
        self.bot = self

    def request_sync(self, uid):
        self.synced.append(uid)

    def toggle_role(self, uid, name, held):
        self.toggled.append((uid, name, list(held)))
        return self.result


class Webhook:
    def __init__(self, status=200, error=None):
        self.calls, self.status, self.error = [], status, error

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, headers, json.loads(body)))
        if self.error:
            raise self.error
        return self.status, b"{}"


def now_sync(work):
    work()
    return True


@pytest.fixture
def world(tmp_path):
    links = MemberLinks(tmp_path / "links.json")
    importer, perks, hook = FakeImporter(), Perks(), Webhook()
    interactions, store, clock = make(snap(), links=links, importer=importer, perks=perks, transport=hook,
                                      spawn=now_sync)
    return type("World", (), {"i": interactions, "links": links, "importer": importer, "perks": perks, "hook": hook,
                              "clock": clock})


def say(world, name, user=USER_ID, **options):
    status, answer = call(world.i, command(name, user=user, **options))
    assert status == 200
    return answer


def text(answer):
    return answer["data"]["content"]


# --- /link -----------------------------------------------------------------------------------------------------------


def test_link_of_a_name_already_read_answers_at_once_links_it_and_asks_for_the_roles(world):
    world.importer._cached = Imported("ok", "Shaedon", passes())
    answer = say(world, "link", username="Shaedon")
    assert answer["type"] == 4 and answer["data"]["flags"] & dc.EPHEMERAL
    words = text(answer)
    assert "Linked **Shaedon**" in words and "6 passes (NBA 5 · NFL 1)" in words
    assert "Roles: Linked, NBA, Starter" in words and SITE in words
    assert world.links.get(USER_ID)["username"] == "Shaedon"
    assert world.perks.synced == [USER_ID]
    assert world.hook.calls == [] and world.importer.looked_up == []  # nothing waited for, nothing to edit


def test_link_of_a_name_to_read_says_thinking_then_edits_the_answer_through_the_webhook(world):
    payload = command("link", username="@Shaedon")
    payload["application_id"], payload["token"] = APP, TOKEN
    status, answer = call(world.i, payload)
    assert status == 200 and answer == {"type": dc.DEFERRED_MESSAGE, "data": {"flags": dc.EPHEMERAL}}
    assert world.importer.looked_up == ["Shaedon"]
    ((method, url, headers, body),) = world.hook.calls
    assert method == "PATCH" and url == f"https://discord.com/api/v10/webhooks/{APP}/{TOKEN}/messages/@original"
    assert "Authorization" not in headers  # the interaction's own webhook needs no bot token
    assert "Linked **Shaedon**" in body["content"] and body["allowed_mentions"] == {"parse": []}
    assert world.links.get(USER_ID) is not None and world.perks.synced == [USER_ID]


@pytest.mark.parametrize("found, words", [
    (Imported("not_found"), "No Real account is called **Ghost**"),
    (Imported("private", "Ghost"), "make it public in Real"),
    (Imported("busy", retry_after=90), "busy right now. Try again in 2 minute"),
])
def test_link_says_plainly_why_it_could_not_read_the_account(world, found, words):
    world.importer.found = found
    payload = command("link", username="Ghost")
    payload["application_id"], payload["token"] = APP, TOKEN
    call(world.i, payload)
    assert words in world.hook.calls[0][3]["content"]
    assert world.links.get(USER_ID) is None and world.perks.synced == []


def test_link_of_a_name_another_member_linked_is_refused_before_any_lookup(world):
    world.links.claim(OTHER, "Shaedon", passes(), now=NOW)
    words = text(say(world, "link", username="shaedon"))
    assert "linked to another Discord member already" in words and "ask the team" in words
    assert world.importer.looked_up == []


def test_a_race_for_a_name_is_caught_when_the_claim_lands(world):
    world.importer._cached = Imported("ok", "Shaedon", passes())
    world.links.claim(OTHER, "Shaedon", passes(), now=NOW)  # linked between the check and the claim: same store
    assert "linked to another Discord member" in text(say(world, "link", username="Shaedon"))


def test_a_name_that_cannot_be_one_is_told_so(world):
    for bad in ("a", "no spaces", "x" * 40, "bad/name"):
        assert "does not look like a Real username" in text(say(world, "link", username=bad))
    assert world.importer.looked_up == []


def test_a_full_store_says_so(world, tmp_path):
    full = MemberLinks(tmp_path / "full.json", max_members=1)
    full.claim(OTHER, "Someone", passes(), now=NOW)
    interactions, _, _ = make(snap(), links=full, importer=FakeImporter(cached=Imported("ok", "Shaedon", passes())),
                              perks=Perks(), transport=Webhook(), spawn=now_sync)
    assert "Linking is full right now" in text(call(interactions, command("link", username="Shaedon"))[1])


def test_seasons_still_being_read_are_said(world):
    world.importer._cached = Imported("ok", "Shaedon", passes(), waiting=4)
    assert "still being read" in text(say(world, "link", username="Shaedon"))


def test_one_member_may_link_three_times_a_minute(world):
    world.importer._cached = Imported("ok", "Shaedon", passes())
    for _ in range(dc.LINK_PER_MIN):
        assert "Linked" in text(say(world, "link", username="Shaedon"))
    assert "One account at a time" in text(say(world, "link", username="Shaedon"))


def test_a_refresh_keeps_the_link_and_asks_for_roles_only_when_they_may_change(world):
    world.importer._cached = Imported("ok", "Shaedon", passes(), waiting=2)
    say(world, "link", username="Shaedon")
    say(world, "link", username="Shaedon")  # the same roles, seasons still waiting: no second sync
    assert world.perks.synced == [USER_ID]
    world.importer._cached = Imported("ok", "Shaedon", passes(), waiting=0)
    say(world, "link", username="Shaedon")
    assert world.perks.synced == [USER_ID, USER_ID]


def test_linking_without_the_member_store_or_the_importer_says_so():
    interactions, _, _ = make(snap())
    assert "not available" in text(call(interactions, command("link", username="Shaedon"))[1])
    for name in ("unlink", "me"):
        assert "not available" in text(call(interactions, command(name))[1])


def test_the_webhook_needs_an_interaction_it_can_trust(world):
    payload = command("link", username="Shaedon")
    payload["application_id"], payload["token"] = APP, "../../evil"
    status, answer = call(world.i, payload)
    assert answer["type"] == 4 and "went wrong" in text(answer)
    assert world.importer.looked_up == [] and world.hook.calls == []


def test_no_room_in_the_background_answers_busy_and_spends_nothing(tmp_path):
    links = MemberLinks(tmp_path / "l.json")
    importer = FakeImporter()
    interactions, _, _ = make(snap(), links=links, importer=importer, perks=Perks(), transport=Webhook(),
                              spawn=lambda work: False)
    payload = command("link", username="Shaedon")
    payload["application_id"], payload["token"] = APP, TOKEN
    answer = call(interactions, payload)[1]
    assert "Busy right now" in text(answer) and importer.looked_up == []


def test_a_follow_up_that_fails_is_logged_and_never_raises(tmp_path, caplog):
    links = MemberLinks(tmp_path / "l.json")
    for hook in (Webhook(error=TimeoutError("secret detail")), Webhook(status=404)):
        interactions, _, _ = make(snap(), links=links, importer=FakeImporter(), perks=Perks(), transport=hook,
                                  spawn=now_sync)
        interactions._sleep = lambda s: None
        payload = command("link", username="Shaedon")
        payload["application_id"], payload["token"] = APP, TOKEN
        assert call(interactions, payload)[1]["type"] == dc.DEFERRED_MESSAGE
    assert "secret detail" not in caplog.text and "TimeoutError" in caplog.text and "HTTP 404" in caplog.text


def test_a_lookup_that_blows_up_still_gives_the_member_an_answer(world):
    def boom(name):
        raise RuntimeError("feed down")

    world.importer.lookup = boom
    payload = command("link", username="Shaedon")
    payload["application_id"], payload["token"] = APP, TOKEN
    call(world.i, payload)
    assert "went wrong on our side" in world.hook.calls[0][3]["content"]


def test_the_default_background_runs_work_in_a_thread_and_holds_a_few_at_a_time(tmp_path, monkeypatch):
    monkeypatch.setattr(dc, "MAX_BACKGROUND", 1)
    interactions, _, _ = make(snap(), links=MemberLinks(tmp_path / "l.json"), importer=FakeImporter(),
                              perks=Perks(), transport=Webhook())
    gate, done = threading.Event(), threading.Event()
    assert interactions._start(lambda: (gate.wait(5), done.set())) is True
    assert interactions._start(lambda: None) is False  # one at a time, as set here
    gate.set()
    assert done.wait(5)
    for _ in range(100):
        if interactions._running == 0:
            break
        threading.Event().wait(0.01)
    assert interactions._start(lambda: None) is True


# --- /unlink, /me, /help ---------------------------------------------------------------------------------------------


def test_unlink_forgets_the_account_and_asks_for_the_roles_to_go(world):
    world.links.claim(USER_ID, "Shaedon", passes(), now=NOW)
    assert "Unlinked" in text(say(world, "unlink"))
    assert world.links.get(USER_ID) is None and world.perks.synced == [USER_ID]
    assert "no linked account" in text(say(world, "unlink"))


def test_me_shows_the_link_the_rarity_mix_and_asks_the_site_for_the_yearly_figure_when_there_is_none(world):
    assert "not linked" in text(say(world, "me")) or "have not linked" in text(say(world, "me"))
    world.links.claim(USER_ID, "Shaedon", passes(), now=NOW - 7200)
    words = text(say(world, "me"))
    assert "**Shaedon** · 6 passes (NBA 5 · NFL 1) · read 2 hours ago" in words
    assert "By rarity: Common 5 · Rare 1" in words
    assert "Roles: Linked, NBA, Starter" in words
    assert f"open the site to see yours: {SITE}" in words
    assert "Deal pings by DM: on" in words


def test_me_gives_the_yearly_figure_once_the_site_has_reported_one(world):
    world.links.claim(USER_ID, "Shaedon", passes(), now=NOW, year=12_345)
    words = text(say(world, "me"))
    assert "up to about 12,345 Rax a year (Steady)" in words and "open the site" not in words
    assert "Roles: Linked, NBA, Steady" in words  # the type follows the figure, not the six passes


def test_me_and_unlink_and_help_are_for_the_member_alone(world):
    for name in ("me", "unlink", "help", "link"):
        assert say(world, name, **({"username": "x1"} if name == "link" else {}))["data"]["flags"] & dc.EPHEMERAL


def test_help_lists_every_command_and_the_buttons(world):
    words = text(say(world, "help"))
    for name in ("/deals", "/price", "/otd", "/fees", "/start", "/link", "/me", "/unlink", "#welcome"):
        assert name in words
    assert "casino" not in words.lower()


# --- the role picker's buttons ---------------------------------------------------------------------------------------


def button(custom_id, roles=(), guild=GUILD_ID, user=USER_ID):
    return {"type": 3, "id": "9", "application_id": APP, "token": TOKEN, "guild_id": guild,
            "data": {"custom_id": custom_id, "component_type": 2},
            "member": {"user": {"id": user}, "roles": list(roles)}}


def test_a_tap_toggles_the_role_for_whoever_tapped_and_tells_them_alone(world):
    status, answer = call(world.i, button("role:alerts", roles=["5", "6"]))
    assert status == 200 and answer == {"type": dc.DEFERRED_MESSAGE, "data": {"flags": dc.EPHEMERAL}}
    assert world.perks.toggled == [(USER_ID, "Deal Alerts", ["5", "6"])]
    assert "Deal Alerts is on" in world.hook.calls[0][3]["content"]
    world.perks.result = False
    call(world.i, button("role:nba"))
    assert world.perks.toggled[-1][1] == "NBA"
    assert "NBA is off" in world.hook.calls[1][3]["content"]


def test_every_sport_has_a_button_and_nothing_else_is_toggled(world):
    from advisor.rules import OTD_SPORT_MONTHS

    assert set(dc.ROLE_BUTTONS) == {"role:alerts"} | {f"role:{s}" for s in OTD_SPORT_MONTHS}
    for bad in ("role:admin", "role:Palace Team", "x", "role:nba;role:admin", None):
        payload = button(bad if bad is not None else "role:alerts")
        payload["data"]["custom_id"] = bad
        answer = call(world.i, payload)[1]
        assert "not in use any more" in text(answer)
    assert world.perks.toggled == []


def test_a_button_in_another_server_or_without_the_bot_does_nothing(world, tmp_path):
    assert "only in the OTD Palace" in text(call(world.i, button("role:alerts", guild="1"))[1])
    interactions, _, _ = make(snap(), links=MemberLinks(tmp_path / "l.json"), importer=FakeImporter(), perks=None)
    assert "not available" in text(call(interactions, button("role:alerts"))[1])


def test_a_role_that_could_not_be_changed_is_said_and_taps_are_limited(world):
    world.perks.result = None
    call(world.i, button("role:alerts"))
    assert "did not work" in world.hook.calls[0][3]["content"]
    for _ in range(dc.TAPS_BURST - 1):  # the first tap above was one
        call(world.i, button("role:alerts"))
    assert "one tap at a time" in text(call(world.i, button("role:alerts"))[1])


def test_picking_several_sports_in_a_row_is_not_throttled_like_linking(world):
    for sport in ("nba", "nfl", "nhl", "mlb"):
        assert call(world.i, button(f"role:{sport}"))[1]["type"] == dc.DEFERRED_MESSAGE


def test_a_follow_up_sent_before_discord_has_the_thinking_answer_is_tried_again(world):
    waits = []
    world.i._sleep = waits.append

    class Late(Webhook):
        def __call__(self, method, url, headers, body):
            status, raw = super().__call__(method, url, headers, body)
            return (404 if len(self.calls) < 3 else 200), raw

    world.i._send = Late()
    call(world.i, button("role:alerts"))
    assert len(world.i._send.calls) == 3 and waits == [0.5, 1.0]


def test_a_follow_up_that_keeps_being_refused_gives_up_after_three_tries(world, caplog):
    world.i._sleep = lambda s: None
    world.i._send = Webhook(status=429)
    call(world.i, button("role:alerts"))
    assert len(world.i._send.calls) == 3 and "refused (HTTP 429)" in caplog.text


def test_a_user_id_that_is_not_a_number_is_no_member():
    assert dc._user({"member": {"user": {"id": "../x"}}}) == ""
