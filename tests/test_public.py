"""The free site's snapshot (advisor/public.py): what anyone who is not a member of our Discord server gets.

Built here from the demo market, the same way the collector builds the live one. Every test is a leak it must stop:
nothing a member alone may see reaches the free site's payload, through the page or /api/snapshot."""

import gzip
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

from advisor import public
from advisor.pass_deals import said, teaser
from advisor.rules import PASS_DEALS_SAY_PCT, PUBLIC_DEALS, PUBLIC_MOVES, PUBLIC_PASSES_PER_SPORT
from advisor.share import safe_deals
from advisor.snapshot import build_snapshot, otd_version
from advisor.sources.fixture import FixtureSource
from advisor.store import SnapshotStore
from tests.test_gate_web import as_member, log_in, make
from tests.test_share import gone

DEMO = Path(__file__).resolve().parents[1] / "advisor" / "fixtures" / "demo_raw.json"
NOW = datetime(2026, 11, 17, 12, 0, tzinfo=timezone.utc)
TOP_KEYS = {"version", "generated_at", "sports", "levels", "rules", "pulse", "taken_10m", "challenges", "bidding",
            "deals", "gone", "moves", "otd", "otd_version", "links", "locked"}


@pytest.fixture(scope="module")
def whole() -> dict:
    raw = FixtureSource(DEMO).fetch(NOW)
    snap = build_snapshot(raw, raw.fetched_at, 7, demo=True, accounts=True, push={"public_key": "BKey", "check_s": 10})
    # A few deals that just went away, as the collector adds them: a member's only.
    snap["gone"] = [gone(990_001, player_name="Gone Player"), gone(990_002)]
    snap["taken_10m"] = 2
    return snap


def ids_in(text: str) -> set[int]:
    return {int(found) for found in re.findall(r'"listing_id":\s*(\d+)', text)}


def test_the_free_snapshot_has_the_whole_ones_shape_and_nothing_else(whole):
    free = public.public_snapshot(whole)
    assert set(free) <= TOP_KEYS
    assert {key: free[key] for key in ("version", "generated_at", "levels", "rules")} == {
        key: whole[key] for key in ("version", "generated_at", "levels", "rules")}


def test_it_holds_the_best_few_deals_of_the_new_level_one_per_player_and_nothing_else(whole):
    free = public.public_snapshot(whole)
    safe = {row["listing_id"] for row in safe_deals(whole)}
    shown = [row["listing_id"] for row in free["deals"]]
    assert 0 < len(shown) <= PUBLIC_DEALS and set(shown) <= safe
    groups = [(row["sport"], row["season"], row["player_id"]) for row in free["deals"]]
    assert len(set(groups)) == len(groups)
    margins = [row["flip_margin"] for row in free["deals"]]
    assert margins == sorted(margins, reverse=True)
    assert all("recent_sales" not in row and set(row) <= set(public.DEAL_KEYS) for row in free["deals"])
    # No other listing, live or gone, anywhere in the payload: not a deal, not a gone row, not a twin.
    text = json.dumps(free)
    assert ids_in(text) == set(shown) and free["gone"] == []
    assert len(whole["deals"]) > PUBLIC_DEALS  # the demo market has more: the test would prove nothing otherwise
    assert "Gone Player" not in text


def test_it_holds_a_summary_of_the_moves(whole):
    free = public.public_snapshot(whole)
    for side in ("risers", "fallers"):
        assert len(free["moves"][side]) <= PUBLIC_MOVES
        assert [(m["sport"], m["player_id"]) for m in free["moves"][side]] == [
            (m["sport"], m["player_id"]) for m in whole["moves"][side][:PUBLIC_MOVES]]
        assert all(set(m) <= set(public.MOVE_KEYS) for m in free["moves"][side])
    hidden = whole["moves"]["risers"][PUBLIC_MOVES:] + whole["moves"]["fallers"][PUBLIC_MOVES:]
    shown = {(m["sport"], m["player_id"]) for side in ("risers", "fallers") for m in free["moves"][side]}
    assert hidden and all((m["sport"], m["player_id"]) not in shown for m in hidden)


def test_it_holds_each_sports_best_passes_and_starter_and_only_those_markets(whole):
    free = public.public_snapshot(whole)["otd"]
    named = {key for keys in free["picks"].values() for key in keys} | set(free["starters"].values())
    assert {market["key"] for market in free["markets"]} == named
    assert all(len(keys) <= PUBLIC_PASSES_PER_SPORT for keys in free["picks"].values())
    for sport, keys in free["picks"].items():
        assert keys == whole["otd"]["picks"][sport][:PUBLIC_PASSES_PER_SPORT]
    assert len(free["markets"]) < len(whole["otd"]["markets"])
    assert public.public_snapshot(whole)["otd_version"] == otd_version(free) != whole["otd_version"]


def test_the_alerts_key_and_the_account_link_are_left_out_and_locked_counts_what_members_get(whole):
    free = public.public_snapshot(whole)
    # The invite and where a gift of Rax goes are said to everyone; the alerts and the account link are a member's.
    assert free["links"] == {"community": whole["links"]["community"], "push": None, "accounts": False,
                             "support": {"account": "otdpalace", "url": None}}
    assert "BKey" not in json.dumps(free)
    assert free["locked"] == {
        "deals": len(whole["deals"]), "risers": len(whole["moves"]["risers"]),
        "fallers": len(whole["moves"]["fallers"]), "passes": len(whole["otd"]["markets"]), "alerts": True,
        "accounts": True, "pass_deals": said(teaser(whole["otd"])),
        "by_rarity": {str(r): sum(1 for row in whole["deals"] if row["rarity"] == r) for r in range(8)},
    }


def test_locked_counts_every_members_deal_by_rarity_as_counts_only(whole):
    """The locked rarity strip: how many deals a member sees at each of Real's eight rarities, from the whole list.
    Eight whole numbers keyed "0".."7" and nothing else: no name, price or id of a member's deal."""
    by_rarity = public.public_snapshot(whole)["locked"]["by_rarity"]
    assert set(by_rarity) == {str(r) for r in range(8)}
    assert all(type(n) is int and n >= 0 for n in by_rarity.values())
    assert sum(by_rarity.values()) == len(whole["deals"])
    assert len({row["rarity"] for row in whole["deals"]}) > 1  # the demo market spans rarities: the test proves something
    for r in range(8):
        assert by_rarity[str(r)] == sum(1 for row in whole["deals"] if row["rarity"] == r)


def test_a_deal_of_unknown_rarity_is_counted_under_no_rarity(whole):
    """A rarity that is not one of Real's eight (missing, out of range, not a whole number) counts nowhere: the strip's
    chips only ever count cards of that rarity. The free snapshot still says how many deals there are in all."""
    first = whole["deals"][0]
    odd = [{**first, "listing_id": 1}, {**first, "listing_id": 2, "rarity": 8}, {**first, "listing_id": 3, "rarity": -1},
           {**first, "listing_id": 4, "rarity": None}, {**first, "listing_id": 5, "rarity": True},
           {**first, "listing_id": 6, "rarity": "5"}, {**first, "listing_id": 7, "rarity": 5.0}]
    del odd[0]["rarity"]
    free = public.public_snapshot({**whole, "deals": odd})["locked"]
    assert free["by_rarity"] == {str(r): 0 for r in range(8)} and free["deals"] == len(odd)


def test_the_teaser_says_no_percent_while_the_usual_rate_is_not_trusted(whole, monkeypatch):
    """PASS_DEALS_SAY_PCT off (the block itself on): the free site gets how many passes, per level, and no percent
    at all; the page then leads with the count. The counts are the teaser's own."""
    import advisor.pass_deals as pd
    monkeypatch.setattr(pd, "PASS_DEALS_ON", True)
    counted = teaser(whole["otd"])
    sent = pd.said(counted)
    assert PASS_DEALS_SAY_PCT is False
    assert sent["passes"] == counted["passes"] and sent["best_pct"] is None
    assert {level: pair["passes"] for level, pair in sent["levels"].items()} == \
        {level: pair["passes"] for level, pair in counted["levels"].items()}
    assert all(pair["best_pct"] is None for pair in sent["levels"].values())


def test_said_keeps_the_percent_when_it_is_trusted(monkeypatch):
    import advisor.pass_deals as pd
    monkeypatch.setattr(pd, "PASS_DEALS_ON", True)
    monkeypatch.setattr(pd, "PASS_DEALS_SAY_PCT", True)
    pair = {"passes": 3, "best_pct": 15, "levels": {"new": {"passes": 3, "best_pct": 15}}}
    assert pd.said(pair) == pair


def test_pass_deals_are_a_members_block_the_free_site_gets_two_numbers_of_it_and_no_other_pass(whole):
    """The visitor's place for "Pass deals" says how many and the best saving, from the whole snapshot's passes; no
    member-only pass (nor its shelf) is in the free snapshot."""
    free = public.public_snapshot(whole)
    assert free["locked"]["pass_deals"] == said(teaser(whole["otd"]))
    assert set(free["locked"]["pass_deals"]) == {"passes", "best_pct", "levels"}
    assert all(set(pair) == {"passes", "best_pct"} for pair in free["locked"]["pass_deals"]["levels"].values())
    shown = {market["key"] for market in free["otd"]["markets"]}
    hidden = [market for market in whole["otd"]["markets"] if market["key"] not in shown]
    text = json.dumps(free)
    assert hidden and all(market["key"] not in text for market in hidden)


def test_this_seasons_passes_never_reach_a_visitor_and_are_not_counted_as_passes(whole):
    """The current-season passes (served apart, for Deals) are a member's: none is in the free snapshot, so a free
    deal can show a pass line only for a pass the free snapshot already holds. "See all N passes" counts what the
    Passes tab lists, the past seasons."""
    current = whole["otd"]["current_markets"]
    free = public.public_snapshot(whole)
    text = json.dumps(free)
    assert current and all(market["key"] not in text for market in current)
    assert "current_markets" not in free["otd"]
    assert all(market["season_state"] == "past" for market in free["otd"]["markets"])
    assert free["locked"]["passes"] == len(whole["otd"]["markets"])


def test_a_field_added_later_never_reaches_the_free_site_by_accident(whole):
    later = {**whole, "members_secret": "x" * 8, "deals": [{**row, "seller": "someone"} for row in whole["deals"]],
             "moves": {side: [{**m, "history": [1, 2]} for m in whole["moves"][side]] for side in ("risers", "fallers")},
             "links": {**whole["links"], "admin": "/secret"}}
    text = json.dumps(public.public_snapshot(later))
    assert "members_secret" not in text and "seller" not in text and "history" not in text and "/secret" not in text


def test_a_snapshot_it_cannot_read_gives_visitors_no_market_never_the_whole_one(monkeypatch, whole):
    def broken(snapshot):
        raise ValueError("odd")
    monkeypatch.setattr("advisor.store.public_snapshot", broken)
    store = SnapshotStore()
    store.publish(whole)
    free = json.loads(store.current(public=True)[0])
    assert free["deals"] == [] and free["locked"]["deals"] == 0 and "otd" not in free
    assert free["locked"]["pass_deals"] == {"passes": 0, "best_pct": None}
    assert free["locked"]["by_rarity"] == {str(r): 0 for r in range(8)}
    assert json.loads(store.current()[0])["deals"] == whole["deals"]  # members are served as ever


# --- the web: the page and /api/snapshot -----------------------------------------------------------------------------


def test_a_visitor_gets_only_the_free_snapshot_by_every_way_the_page_asks(tmp_path, whole):
    c, _, _ = make(tmp_path, snap=whole)
    c = c.application.test_client(use_cookies=False)
    member_only = {row["listing_id"] for row in whole["deals"]} - {row["listing_id"] for row in public.public_deals(whole)}
    page = c.get("/").get_data(as_text=True)
    plain = c.get("/api/snapshot")
    packed = c.get("/api/snapshot", headers={"Accept-Encoding": "gzip"})
    lean = c.get(f"/api/snapshot?otd={public.public_snapshot(whole)['otd_version']}")
    asked_whole = c.get(f"/api/snapshot?otd={whole['otd_version']}")  # the member's passes' version: no shortcut
    assert plain.headers["ETag"] == '"7p"' and packed.headers["ETag"] == '"7p-gz"'
    assert json.loads(gzip.decompress(packed.get_data())) == plain.get_json()
    assert "otd" not in lean.get_json() and asked_whole.get_json() == plain.get_json()
    for text in (page, plain.get_data(as_text=True), lean.get_data(as_text=True), asked_whole.get_data(as_text=True)):
        assert not ids_in(text) & member_only and "Gone Player" not in text and "BKey" not in text


def test_a_member_gets_everything_and_a_visitors_tag_never_answers_for_it(tmp_path, whole):
    c, _, _ = make(tmp_path, snap=whole)
    session = as_member(log_in(c))
    r = c.get("/api/snapshot", headers=session)
    assert r.headers["ETag"] == '"7"' and len(r.get_json()["deals"]) == len(whole["deals"])
    assert "locked" not in r.get_json() and r.get_json()["links"]["push"] == {"public_key": "BKey", "check_s": 10}
    assert c.get("/api/snapshot", headers={**session, "If-None-Match": '"7p", "7p-gz"'}).status_code == 200
    assert "Gone Player" in c.get("/", headers=session).get_data(as_text=True)


def test_pass_deals_switched_off_sends_nothing_to_tease(whole):
    """PASS_DEALS_ON off: the block is hidden for everyone, so the free site gets zero passes at every level and the
    page shows no locked place either."""
    from advisor.rules import PASS_DEALS_ON
    assert PASS_DEALS_ON is False
    free = public.public_snapshot(whole)["locked"]["pass_deals"]
    assert free["passes"] == 0 and free["best_pct"] is None
    assert all(pair == {"passes": 0, "best_pct": None} for pair in free["levels"].values())


def test_anon_and_out_visitors_get_the_rarity_counts_and_no_member_deal(tmp_path, whole):
    """The locked rarity strip, as a visitor's browser receives it: not signed in (anon), or signed in but not in the
    server (out). The same eight counts for both, and still no member's listing anywhere in the answer."""
    from urllib.parse import parse_qs, urlsplit

    from advisor import discord_gate as dg
    from tests.test_discord_gate import FakeDiscord
    from tests.test_gate_web import cookies_of

    c, _, _ = make(tmp_path, snap=whole, fake=FakeDiscord(join=(400, {"code": 30001})))  # the join fails: out
    start = c.get("/auth/discord?next=%2F")
    state = parse_qs(urlsplit(start.headers["Location"]).query)["state"][0]
    back = c.get(f"/auth/discord/callback?code=abc&state={state}",
                 headers={"Cookie": f"{dg.STATE_COOKIE}={cookies_of(start)[dg.STATE_COOKIE].value}"})
    out = as_member(cookies_of(back)[dg.SESSION_COOKIE].value)
    anon = c.application.test_client(use_cookies=False).get("/api/snapshot")
    signed_out = c.application.test_client(use_cookies=False).get("/api/snapshot", headers=out)
    member_only = {row["listing_id"] for row in whole["deals"]} - {row["listing_id"] for row in public.public_deals(whole)}
    want = public.rarity_counts(whole["deals"])
    for r in (anon, signed_out):
        free = r.get_json()
        assert free["locked"]["by_rarity"] == want
        assert not ids_in(r.get_data(as_text=True)) & member_only


def test_the_gift_link_is_repeated_as_a_name_and_a_link_only():
    from advisor.public import _support

    assert _support({"account": "otdpalace", "url": "https://www.realapp.com/Abc123", "extra": 1}) == {
        "account": "otdpalace", "url": "https://www.realapp.com/Abc123"}
    assert _support({"account": "otdpalace", "url": 7}) == {"account": "otdpalace", "url": None}
    for odd in (None, [], "otdpalace", {}, {"account": ""}, {"account": 3, "url": None}):
        assert _support(odd) is None
