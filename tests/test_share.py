"""A deal's public page (/d/<listing id>), its drawn card and the similar deals they offer."""

import gzip
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from advisor.links import REAL_HOME
from advisor.rules import SHARE_PER_MIN
from advisor.share import RARITY_COLORS, safe_deals, twins
from advisor.store import SnapshotStore
from advisor.web import CONTENT_SECURITY_POLICY, create_app

NEW = {"label": "New", "min_discount": 0.25, "confidence": ["high"], "kinds": ["target"], "bid_max_left_min": 0,
       "hide_falling": True, "hide_hurt": True}
GZIP = {"Accept-Encoding": "gzip"}
URL = "https://www.realapp.com/D5h7FRFWPOKGR"


def deal(listing_id=101, **over):
    row = {
        "listing_id": listing_id, "card_id": listing_id, "sport": "nba", "season": 2026, "player_id": 22,
        "player_name": "Nikola Jokić", "card_label": "x", "rarity": 3, "rating": 7.4, "bucket": "7-9", "mint": 12,
        "kind": "target", "price": 150, "reference": 228, "ref_source": "sales", "ref_tier": None, "ref_sample": 12,
        "confidence": "high", "discount": 0.342, "gap": 78, "flip_margin": 45, "num_bids": 0,
        "ends_at": "2026-11-12T19:00:00Z", "url": URL, "per_point": 20.3, "ref_per_point": 30.8,
        "listed_at": "2026-11-12T17:55:00Z", "falling": False,
    }
    return {**row, **over}


def gone(listing_id=90, reason="ended", **over):
    return {**deal(listing_id, **over), "reason": reason, "gone_at": "2026-11-12T18:00:00Z"}


def snapshot(deals=(), gone_rows=(), demo=False, version=5):
    return {"version": version, "deals": list(deals), "gone": list(gone_rows), "levels": {"new": NEW},
            "rules": {"demo": demo, "twins": {"price_band": 0.25, "max": 3}}}


def make(snap=None, tmp_path=None, clock=None, **kw):
    store = SnapshotStore()
    if snap is not None:
        store.publish(snap)
    (tmp_path / "index.html").write_text("<html><!--SNAPSHOT--></html>")
    extra = {"clock": clock} if clock else {}
    app = create_app(store, tmp_path, **kw, **extra)
    return app.test_client(), store


def text(r):
    return r.get_data(as_text=True)


# --- the similar deals -------------------------------------------------------------------------------------------


def ids(rows):
    return [row["listing_id"] for row in rows]


def test_the_same_player_season_comes_first_then_the_same_sport_at_a_close_price_and_rating():
    subject = deal(1, price=100, rating=5.0)
    pool = [
        deal(2, player_id=9, price=110, rating=5.0, discount=0.40),
        deal(3, price=300, rating=4.0, discount=0.26),  # the same player-season, whatever price and rating
        deal(4, player_id=8, price=120, rating=6.0, discount=0.30),
        deal(5, player_id=7, sport="nfl", price=100, rating=5.0),  # another sport
        deal(6, player_id=6, price=126, rating=5.0),  # past the band (25 % of 100 is 25)
        deal(7, player_id=5, price=100, rating=4.9),  # under the rating
        deal(8, season=2025, price=100, rating=5.0, discount=0.28),  # another season of the player: a similar deal
    ]
    assert ids(twins(subject, pool)) == [3, 2, 4]  # the player-season, then the best discounts; 8 (.28) is cut by the cap


def test_the_band_is_inclusive_and_better_discounts_come_first_within_a_group():
    subject = deal(1, price=100, rating=5.0)
    pool = [
        deal(2, player_id=2, price=125, rating=5.0, discount=0.26),
        deal(3, player_id=3, price=75, rating=5.0, discount=0.31),
        deal(4, player_id=4, price=100, rating=5.0, discount=0.31),
    ]
    assert ids(twins(subject, pool)) == [4, 3, 2]  # 0.31 ties: the nearer price first; then 0.26


def test_a_listing_is_never_its_own_twin_whatever_its_kind_and_shows_once():
    subject = deal(1, price=100)
    pool = [deal(1, kind="bid", price=90), deal(2, kind="target", price=95, discount=0.3),
            deal(2, kind="bid", price=90, discount=0.4)]
    assert ids(twins(subject, pool)) == [2]
    assert twins(subject, pool)[0]["kind"] == "bid"  # the better of the two


def test_a_subject_without_a_pool_has_no_twins_and_the_result_is_capped():
    assert twins(deal(1), []) == []
    pool = [deal(i, price=100, rating=9.0) for i in range(2, 12)]
    assert len(twins(deal(1), pool)) == 3
    assert len(twins(deal(1), pool, limit=2)) == 2


# --- the page ----------------------------------------------------------------------------------------------------


def test_the_page_shows_the_deal_with_its_facts_and_the_ways_on(tmp_path):
    c, _ = make(snapshot([deal()]), tmp_path)
    r = c.get("/d/101")
    html = text(r)
    assert (r.status_code, r.mimetype) == (200, "text/html")
    assert "<title>Nikola Jokić" in html and "150 Rax" in html
    assert "to start" in html and "228" in html and "12 sales" in html and "34% under" in html
    assert f'href="{URL}"' in html and "Open in Real" in html
    assert 'href="/"' in html and "See more deals" in html
    assert 'src="/d/101/card.svg"' in html
    assert "Not affiliated with Real" in html
    assert "Sample data" not in html


def test_a_bid_deal_says_top_bid(tmp_path):
    c, _ = make(snapshot([deal(kind="bid", price=64)]), tmp_path)
    assert "top bid" in text(c.get("/d/101"))


def test_a_deal_of_a_hurt_player_says_so_with_what_hurts_and_when_he_may_be_back(tmp_path):
    hurt = {"status": "out", "part": "Knee", "back": "2026-11-18"}
    c, _ = make(snapshot([deal(injury=hurt)]), tmp_path)
    page = text(c.get("/d/101"))
    assert "ESPN lists this player as hurt: Out · knee · back about Nov 18." in page
    assert "check the news before you bid" in page
    assert "ESPN lists the player as out" in page  # the link preview says it too, not only the page


def test_a_hurt_note_is_never_invented_from_something_that_is_not_one(tmp_path):
    for odd in ({"status": "probable"}, {"status": ["out"]}, "out", 5, {}, {"status": "day", "part": "<b>x</b>", "back": "soon"}):
        c, _ = make(snapshot([deal(injury=odd)]), tmp_path)
        page = text(c.get("/d/101"))
        assert "<b>x</b>" not in page
        assert ("ESPN lists this player as hurt: Day-to-day." in page) == (isinstance(odd, dict) and odd.get("status") == "day")
        assert "ESPN lists this player" not in page or isinstance(odd, dict) and odd.get("status") == "day"


def test_a_falling_deal_says_so(tmp_path):
    c, _ = make(snapshot([deal(falling=True)]), tmp_path)
    assert "falling" in text(c.get("/d/101")).lower()


def test_the_face_comes_through_our_own_photo_proxy_never_a_third_party(tmp_path):
    c, _ = make(snapshot([deal()]), tmp_path)
    html = text(c.get("/d/101"))
    assert 'src="/img/players/nba/22"' in html
    sources = re.findall(r'\b(?:src|srcset)="([^"]*)"', html)
    assert sources and all(src.startswith("/") and not src.startswith("//") for src in sources)
    odd = text(make(snapshot([deal(sport="a/b")]), tmp_path)[0].get("/d/101"))
    assert "/img/players/" not in odd  # a sport that is no plain name gets no photo, only initials


def test_names_are_escaped_everywhere(tmp_path):
    name = '<script>alert(1)</script> & "x" <img src=x onerror=y>'
    c, _ = make(snapshot([deal(player_name=name)]), tmp_path)
    html = text(c.get("/d/101"))
    assert "<script>alert" not in html and "<img src=x" not in html
    assert "&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;" in html or "&lt;script&gt;alert(1)" in html
    assert 'content="<' not in html


def test_the_meta_tags_are_there_and_the_image_offered_to_scrapers_is_our_own_generic_one(tmp_path):
    c, _ = make(snapshot([deal()]), tmp_path)
    html = text(c.get("/d/101", base_url="https://palace.example"))
    assert 'property="og:title" content="Nikola Jokić' in html
    assert 'property="og:description" content="' in html
    assert 'property="og:url" content="https://palace.example/d/101"' in html
    assert 'name="twitter:card" content="summary_large_image"' in html
    assert 'name="robots" content="noindex"' in html
    # The same preview picture under every link (logo, name, drawn cards): no player, no photo, no price in it.
    assert 'property="og:image" content="https://palace.example/og.png"' in html
    assert 'property="og:image:width" content="1200"' in html and 'property="og:image:height" content="630"' in html
    assert 'name="twitter:image" content="https://palace.example/og.png"' in html
    assert 'property="og:image:alt" content="' in html


def test_the_og_image_is_served_and_the_share_style_uses_the_sites_rarity_colours(tmp_path):
    from advisor.real import RARITY_COLORS

    c, _ = make(snapshot([deal()]), tmp_path)
    css = text(c.get("/share.css"))
    for n, color in enumerate(RARITY_COLORS):
        assert f".r{n} {{ --c: {color}; }}" in css
    assert "#6f717a" not in css  # the old grey: there is one rarity scale


def test_the_address_of_the_page_cannot_break_out_of_its_tag(tmp_path):
    c, _ = make(snapshot([deal()]), tmp_path)
    html = text(c.get("/d/101", headers={"Host": 'a"><script>x</script>.example'}))
    assert "<script>x" not in html and '"><script' not in html


def test_the_page_carries_no_inline_style_or_script_and_the_site_headers(tmp_path):
    c, _ = make(snapshot([deal(), gone(90)]), tmp_path)
    for path in ("/d/101", "/d/90"):
        r = c.get(path)
        html = text(r)
        assert " style=" not in html and "<style" not in html and "data:" not in html
        assert not re.search(r"\son\w+=", html)
        assert re.findall(r"<script[^>]*>", html) == ['<script src="/share.js" defer>']
        assert '<link rel="stylesheet" href="/share.css">' in html
        assert r.headers["Content-Security-Policy"] == CONTENT_SECURITY_POLICY
        assert r.headers["X-Content-Type-Options"] == "nosniff" and r.headers["Referrer-Policy"] == "no-referrer"
        assert r.headers["Cache-Control"] == "no-cache"


def test_the_page_is_gzipped_when_the_client_takes_gzip(tmp_path):
    c, _ = make(snapshot([deal()]), tmp_path)
    plain, packed = c.get("/d/101"), c.get("/d/101", headers=GZIP)
    assert "Content-Encoding" not in plain.headers and packed.headers["Content-Encoding"] == "gzip"
    assert gzip.decompress(packed.get_data()) == plain.get_data()
    assert packed.headers["Vary"] == plain.headers["Vary"] == "Accept-Encoding"


def test_sample_data_is_said_on_the_page_and_every_link_to_real_goes_to_its_home_page(tmp_path):
    c, _ = make(snapshot([deal(url="https://www.realapp.com/invented")], demo=True), tmp_path)
    html = text(c.get("/d/101"))
    assert "Sample data" in html and f'href="{REAL_HOME}"' in html and "invented" not in html


@pytest.mark.parametrize("url", ["javascript:alert(1)", "http://evil.example/", "//evil.example/", "", None, 5])
def test_a_link_that_is_not_https_never_reaches_the_page(tmp_path, url):
    c, _ = make(snapshot([deal(url=url)]), tmp_path)
    html = text(c.get("/d/101"))
    assert "evil" not in html and "javascript" not in html and f'href="{REAL_HOME}"' in html


def test_open_in_real_is_counted_from_the_share_panel(tmp_path):
    c, _ = make(snapshot([deal()]), tmp_path)
    html = text(c.get("/d/101"))
    assert 'data-out="" data-sport="nba"' in html
    js = c.get("/share.js")
    assert js.mimetype == "text/javascript" and '"share"' in text(js) and "/api/out" in text(js)
    assert '".face img"' in text(js) and '"error"' in text(js)  # a face with no photo keeps its initials, not a broken image
    css = c.get("/share.css")
    assert css.mimetype == "text/css" and css.headers["Cache-Control"] == "no-cache"
    assert css.headers["Content-Security-Policy"] == CONTENT_SECURITY_POLICY


def test_a_deal_that_went_away_says_so_and_offers_similar_ones(tmp_path):
    rows = [deal(201, player_id=5, price=140, discount=0.30), deal(202, price=160, discount=0.35),
            deal(203, price=100, discount=0.50, falling=True), deal(204, kind="bid", price=150, discount=0.4),
            deal(205, price=150, discount=0.2, confidence="medium"), deal(206, sport="nfl", price=150)]
    c, _ = make(snapshot(rows, [gone(90, price=150, player_id=22, season=2026)]), tmp_path)
    r = c.get("/d/90")
    html = text(r)
    assert r.status_code == 200 and "This deal has gone" in html and "Its auction ended" in html
    assert "Open in Real" not in html and "Similar deals" in html
    found = re.findall(r'href="/d/(\d+)"', html)
    assert found == ["202", "201"]  # the same player-season first; no falling, bid, medium or other-sport deal
    assert 'src="/img/players/nba/22"' in html


def test_a_deal_whose_countdown_started_may_still_be_open_in_real(tmp_path):
    c, _ = make(snapshot([], [gone(90, reason="countdown_started")]), tmp_path)
    html = text(c.get("/d/90"))
    assert "Someone started the countdown" in html and f'href="{URL}"' in html


def test_a_deal_stays_gone_after_the_snapshot_forgets_its_row(tmp_path):
    c, store = make(snapshot([], [gone(90)]), tmp_path)
    store.publish(snapshot([deal(5)], [], version=6))
    assert "This deal has gone" in text(c.get("/d/90"))


def test_a_deal_nobody_knows_gets_a_plain_404_page_with_the_way_home(tmp_path):
    c, _ = make(snapshot([deal()]), tmp_path)
    for path in ("/d/999", "/d/0", "/d/abc", "/d/-1", "/d/1.5", "/d/" + "9" * 5000, "/d/999/card.svg"):
        r = c.get(path)
        assert r.status_code == 404, path
        assert r.headers["Cache-Control"] == "no-store"
    html = text(c.get("/d/999"))
    assert "no longer" in html.lower() and 'href="/"' in html


def test_before_the_first_snapshot_the_page_is_a_404_not_a_crash(tmp_path):
    c, _ = make(None, tmp_path)
    assert c.get("/d/1").status_code == 404 and c.get("/d/1/card.svg").status_code == 404


def test_an_unreadable_snapshot_is_a_404_too(tmp_path):
    c, store = make(None, tmp_path)
    store.publish({"version": 1, "deals": "no", "gone": 7})
    assert c.get("/d/1").status_code == 404


def test_the_page_is_rate_limited_per_address_like_the_other_public_routes(tmp_path):
    now = [0.0]
    c, _ = make(snapshot([deal()]), tmp_path, clock=lambda: now[0])
    statuses = [c.get("/d/101", headers={"X-Real-IP": "203.0.113.9"}).status_code for _ in range(SHARE_PER_MIN + 1)]
    assert statuses == [200] * SHARE_PER_MIN + [429]
    assert c.get("/d/101", headers={"X-Real-IP": "203.0.113.10"}).status_code == 200
    now[0] += 5
    assert c.get("/d/101", headers={"X-Real-IP": "203.0.113.9"}).status_code == 200


# --- the card ----------------------------------------------------------------------------------------------------


SVG = "{http://www.w3.org/2000/svg}"


def test_the_card_is_a_valid_svg_with_the_deals_figures(tmp_path):
    c, _ = make(snapshot([deal()]), tmp_path)
    r = c.get("/d/101/card.svg")
    assert (r.status_code, r.mimetype) == (200, "image/svg+xml")
    root = ET.fromstring(r.get_data())
    assert root.tag == f"{SVG}svg" and root.get("role") == "img"
    words = " ".join(el.text or "" for el in root.iter() if el.tag == f"{SVG}text")
    assert "Nikola Jokić" in words and "150" in words and "34% under" in words and "7.4" in words
    assert "Rare" in words and "to start" in words
    assert RARITY_COLORS[3] in text(r)


def test_the_card_holds_nothing_but_drawn_shapes_and_escaped_text(tmp_path):
    name = '<script>x</script> & "q" \x00\x08 end'
    c, _ = make(snapshot([deal(player_name=name)]), tmp_path)
    body = text(c.get("/d/101/card.svg"))
    root = ET.fromstring(body.encode())  # still well-formed with control characters in the name
    tags = {el.tag.removeprefix(SVG) for el in root.iter()}
    assert tags <= {"svg", "title", "desc", "rect", "text", "path", "circle", "g"}
    assert "<script" not in body and "style=" not in body and "href" not in body and "http" not in body.replace(
        "http://www.w3.org/2000/svg", ""
    )
    assert "&lt;script&gt;" in body


def test_a_long_name_is_cut_so_it_stays_on_the_card(tmp_path):
    c, _ = make(snapshot([deal(player_name="Wolfeschlegelsteinhausenbergerdorff Junior the Third of Many")]), tmp_path)
    words = [el.text for el in ET.fromstring(c.get("/d/101/card.svg").get_data()).iter(f"{SVG}text")]
    assert any(w and w.endswith("…") and len(w) <= 26 for w in words)


def test_the_card_is_cached_by_version_gzipped_and_revalidated(tmp_path):
    c, store = make(snapshot([deal()], version=5), tmp_path)
    first = c.get("/d/101/card.svg")
    assert first.headers["Cache-Control"] == "no-cache" and first.headers["Content-Security-Policy"]
    tag = first.headers["ETag"]
    assert c.get("/d/101/card.svg", headers={"If-None-Match": tag}).status_code == 304
    packed = c.get("/d/101/card.svg", headers=GZIP)
    assert packed.headers["Content-Encoding"] == "gzip" and packed.headers["ETag"] != tag
    assert gzip.decompress(packed.get_data()) == first.get_data()
    store.publish(snapshot([deal(price=140)], version=6))
    assert c.get("/d/101/card.svg", headers={"If-None-Match": tag}).status_code == 200


def test_a_card_for_a_deal_that_went_away_is_drawn_dimmed_and_says_gone(tmp_path):
    c, _ = make(snapshot([], [gone(90)]), tmp_path)
    r = c.get("/d/90/card.svg")
    words = " ".join(el.text or "" for el in ET.fromstring(r.get_data()).iter(f"{SVG}text"))
    assert r.status_code == 200 and "Gone" in words


def test_the_rarity_colours_are_the_sites_own():
    tokens = (Path(__file__).parent.parent / "frontend/src/styles/tokens.css").read_text()
    dark = tokens[tokens.index(":root {"):tokens.index(":root[data-theme")]
    site = re.findall(r"--rarity-(\d): (#[0-9a-f]{6});", dark)
    assert [color for _, color in sorted(site)] == RARITY_COLORS


def test_a_share_never_points_at_a_deal_whose_player_most_likely_misses_the_game():
    out = deal(1, injury={"status": "out", "part": "Knee", "back": None})
    doubtful = deal(2, injury={"status": "doubtful", "part": None, "back": None})
    suspended = deal(3, injury={"status": "suspended", "part": None, "back": None})
    day = deal(4, injury={"status": "day", "part": "Foot", "back": None})
    healthy = deal(5)
    shown = [row["listing_id"] for row in safe_deals(snapshot([out, doubtful, suspended, day, healthy]))]
    assert shown == [4, 5]  # a player who may well play, and one with no note, stay
