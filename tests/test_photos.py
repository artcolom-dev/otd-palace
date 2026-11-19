"""Player photos: the store with a fake fetcher (no test touches the network), and the route serving them."""

import io
import json
from urllib.parse import quote
import threading
import zlib

import pytest
from PIL import Image

from advisor import photos as photos_module
from advisor.photos import PhotoStore, allowed, normalise
from advisor.rules import (
    PHOTO_HOSTS,
    PHOTO_MAX_BYTES,
    PHOTO_MISS_TTL_S,
    PHOTO_RETRY_S,
    PHOTO_ROSTER_MAX_BYTES,
    PHOTO_SIDE_MAX,
    PHOTO_TTL_S,
)
from advisor.store import SnapshotStore
from advisor.web import create_app

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 40
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 40
MLB = "https://img.mlbstatic.com/mlb-photos/image/upload/w_180,q_auto:best/v1/people/660271/headshot/silo/current.png"
NHL = "https://assets.nhle.com/mugs/nhl/latest/8478402.png"
ESPN = "https://site.web.api.espn.com/apis/site/v2/sports/"


def espn_photo(path: str) -> str:
    return f"https://a.espncdn.com/combiner/i?img=/i/headshots/{path}&w=180&h=130"


NBA_TEAMS = {"sports": [{"leagues": [{"teams": [{"team": {"id": "1"}}, {"team": {"id": "2"}}]}]}]}
NBA_ROSTERS = {
    "1": {"athletes": [
        {"fullName": "Nikola Jokić", "headshot": {"href": "https://a.espncdn.com/i/headshots/nba/players/full/3112335.png"}},
        {"fullName": "P.J. Washington Jr.", "headshot": {"href": "https://a.espncdn.com/i/headshots/nba/players/full/4278078.png"}},
    ]},
    "2": {"athletes": [
        {"fullName": "Shai Gilgeous-Alexander", "headshot": {"href": "https://a.espncdn.com/i/headshots/nba/players/full/4278073.png"}},
        {"fullName": "No Photo Guy"},
    ]},
}
NFL_TEAMS = {"sports": [{"leagues": [{"teams": [{"team": {"id": "1"}}, {"team": {"id": "2"}}]}]}]}
NFL_ROSTERS = {  # grouped by position, and two Josh Allens on two teams
    "1": {"athletes": [{"position": "offense", "items": [
        {"fullName": "Josh Allen", "position": {"abbreviation": "QB"},
         "headshot": "https://a.espncdn.com/i/headshots/nfl/players/full/3918298.png"},
        {"fullName": "Puka Nacua", "headshot": "https://a.espncdn.com/i/headshots/nfl/players/full/4426515.png"},
    ]}]},
    "2": {"athletes": [{"position": "defense", "items": [
        {"fullName": "Josh Allen", "position": {"abbreviation": "LB"},
         "headshot": "https://a.espncdn.com/i/headshots/nfl/players/full/3915189.png"},
    ]}]},
}
MLB_TEAMS = {"sports": [{"leagues": [{"teams": [{"team": {"id": "1"}}, {"team": {"id": "2"}}]}]}]}
MLB_ROSTERS = {  # grouped by position, two Will Smiths, and a name with an accent and a suffix
    "1": {"athletes": [{"position": "Pitchers", "items": [
        {"fullName": "Shohei Ohtani", "headshot": {"href": "https://a.espncdn.com/i/headshots/mlb/players/full/39832.png"}},
        {"fullName": "Will Smith", "headshot": {"href": "https://a.espncdn.com/i/headshots/mlb/players/full/1111.png"}},
    ]}]},
    "2": {"athletes": [{"position": "Catchers", "items": [
        {"fullName": "Will Smith", "headshot": {"href": "https://a.espncdn.com/i/headshots/mlb/players/full/2222.png"}},
        {"fullName": "Ronald Acuña Jr.", "headshot": {"href": "https://a.espncdn.com/i/headshots/mlb/players/full/36185.png"}},
    ]}]},
}
NHL_TEAMS = {"sports": [{"leagues": [{"teams": [{"team": {"id": "7"}}]}]}]}
NHL_ROSTERS = {"7": {"athletes": [{"position": "Centers", "items": [
    {"fullName": "Connor McDavid", "headshot": {"href": "https://a.espncdn.com/i/headshots/nhl/players/full/3895074.png"}},
    {"fullName": "Tim Stützle", "headshot": {"href": "https://a.espncdn.com/i/headshots/nhl/players/full/4565222.png"}},
]}]}}
UFC_RANKINGS = {"rankings": [
    {"name": "Pound for pound", "ranks": [{"athlete": {"displayName": "Islam Makhachev",
                                                       "headshot": "https://a.espncdn.com/i/headshots/mma/players/full/3332412.png"}}]},
    {"name": "Lightweight", "ranks": [{"athlete": {"displayName": "Islam Makhachev",
                                                   "headshot": "https://a.espncdn.com/i/headshots/mma/players/full/3332412.png"}}]},
]}


SEARCH = "https://site.web.api.espn.com/apis/common/v3/search"


def search(query: str, league: str) -> str:
    return f"{SEARCH}?query={quote(query)}&limit=25&type=player&league={league}"


def hit(name: str, league: str, path: str | None) -> dict:
    return {"displayName": name, "league": league,
            "headshot": {"href": f"https://a.espncdn.com/i/headshots/{path}"} if path else None}


SEARCH_PHOTOS = ["college-football/players/full/4911971.png", "college-football/players/full/1.png",
                 "mens-college-basketball/players/full/5105.png", "golf/players/full/7081.png"]
SEARCHES = {
    ("jahiem white", "college-football"): {"pageCount": 1, "items": [
        hit("Jahiem White", "college-football", SEARCH_PHOTOS[0]), hit("Tyler White", "college-football", None)]},
    ("white", "college-football"): {"pageCount": 1, "items": [
        hit("Jahiem White", "college-football", SEARCH_PHOTOS[0]), hit("John White", "college-football", SEARCH_PHOTOS[1]),
        hit("Tyler White", "college-football", None)]},
    ("brown", "college-football"): {"pageCount": 1, "items": [
        hit("Kai Brown", "college-football", SEARCH_PHOTOS[1]), hit("Kyle Brown", "college-football", None)]},
    ("acuff", "mens-college-basketball"): {"pageCount": 1, "items": [
        hit("Cooper Acuff", "mens-college-basketball", None),
        hit("Tyre Acuff", "mens-college-basketball", SEARCH_PHOTOS[2]),
        hit("Darius Acuff Jr.", "nba", "nba/players/full/9.png")]},  # another league, never taken
    ("smith", "mens-college-basketball"): {"pageCount": 3, "items": [
        hit("Zane Smith", "mens-college-basketball", "mens-college-basketball/players/full/77.png")]},
    ("si woo kim", "pga"): {"pageCount": 1, "items": [hit("Si Woo Kim", "pga", SEARCH_PHOTOS[3])]},
    ("si woo kim", "lpga"): {"pageCount": 0, "items": []},
    ("trayce jackson davis", "mens-college-basketball"): {"pageCount": 0, "items": []},
    ("trayce jackson davis", "nba"): {"pageCount": 1, "items": [hit("Trayce Jackson-Davis", "nba", SEARCH_PHOTOS[2])]},
    ("jayden daniels", "college-football"): {"pageCount": 1, "items": [
        hit("Jayden Daniels", "college-football", SEARCH_PHOTOS[0])]},
    ("jeremiah smith", "college-football"): {"pageCount": 1, "items": [
        hit("Jeremiah Smith", "college-football", SEARCH_PHOTOS[0]), hit("Jeremiah Smith", "college-football", SEARCH_PHOTOS[1])]},
    ("jahiem white", "nfl"): {"pageCount": 0, "items": []},
}


class FakeNet:
    """Answers like the public sources would, records every url asked, and can be told to fail."""

    def __init__(self):
        self.asked: list[tuple[str, int]] = []
        self.down = False
        self.images: dict[str, tuple[bytes, str]] = {
            MLB: (PNG, "image/png"),
            NHL: (PNG, "image/png"),
            espn_photo("nba/players/full/3112335.png"): (PNG, "image/png"),
            espn_photo("nba/players/full/4278078.png"): (JPEG, "image/jpeg"),
            espn_photo("nfl/players/full/4426515.png"): (PNG, "image/png"),
            espn_photo("nfl/players/full/3918298.png"): (PNG, "image/png"),
            espn_photo("nfl/players/full/3915189.png"): (JPEG, "image/jpeg"),
            espn_photo("mma/players/full/3332412.png"): (PNG, "image/png"),
            espn_photo("mlb/players/full/39832.png"): (PNG, "image/png"),
            espn_photo("mlb/players/full/36185.png"): (JPEG, "image/jpeg"),
            espn_photo("nhl/players/full/3895074.png"): (PNG, "image/png"),
            espn_photo("nhl/players/full/4565222.png"): (PNG, "image/png"),
        }
        self.json = {f"{ESPN}basketball/nba/teams": NBA_TEAMS, f"{ESPN}football/nfl/teams": NFL_TEAMS,
                     f"{ESPN}mma/ufc/rankings": UFC_RANKINGS}
        self.json |= {f"{ESPN}basketball/nba/teams/{t}/roster": r for t, r in NBA_ROSTERS.items()}
        self.json |= {f"{ESPN}football/nfl/teams/{t}/roster": r for t, r in NFL_ROSTERS.items()}
        self.json |= {f"{ESPN}baseball/mlb/teams": MLB_TEAMS, f"{ESPN}hockey/nhl/teams": NHL_TEAMS}
        self.json |= {f"{ESPN}baseball/mlb/teams/{t}/roster": r for t, r in MLB_ROSTERS.items()}
        self.json |= {f"{ESPN}hockey/nhl/teams/{t}/roster": r for t, r in NHL_ROSTERS.items()}
        self.json |= {search(q, league): answer for (q, league), answer in SEARCHES.items()}
        self.images |= {espn_photo(path): (PNG, "image/png") for path in SEARCH_PHOTOS}

    def __call__(self, url: str, max_bytes: int):
        self.asked.append((url, max_bytes))
        assert allowed(url), url
        if self.down:
            return None
        if url in self.json:
            return json.dumps(self.json[url]).encode(), "application/json"
        return self.images.get(url)

    def urls(self) -> list[str]:
        return [url for url, _ in self.asked]


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def net():
    return FakeNet()


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def store(tmp_path, net, clock):
    return PhotoStore(tmp_path / "photos", get=net, clock=clock)


def test_names_match_without_accents_case_punctuation_or_suffix():
    assert normalise("Nikola Jokić") == "nikola jokic"
    assert normalise("Shai Gilgeous-Alexander") == "shai gilgeous alexander"
    assert normalise("P.J. Washington Jr.") == normalise("PJ Washington") == "pj washington"
    assert normalise("De'Aaron Fox") == "deaaron fox"
    assert normalise("Marvin Harrison Jr") == "marvin harrison"
    assert normalise("Kenneth Walker III") == "kenneth walker"
    assert normalise("Rasmus Højlund") == "rasmus hojlund"
    assert normalise("  Luka   DONČIĆ ") == "luka doncic"


def test_resolve_mlb_and_nhl_by_id_without_asking_anything(store, net):
    assert store.resolve("mlb", 660271, "Shohei Ohtani") == MLB
    assert store.resolve("nhl", 8478402, "Connor McDavid") == NHL
    assert net.asked == []


@pytest.mark.parametrize("sport", ["soccer", "wcbb", "../etc", ""])
def test_sports_without_a_public_source_have_no_photo(store, net, sport):
    assert store.resolve(sport, 7, "Anyone") is None
    assert store.fetch(sport, 7, "Anyone") is None
    assert net.asked == []


def test_resolve_espn_by_name_from_the_rosters(store, net):
    assert store.resolve("nba", 99, "Nikola Jokic") == espn_photo("nba/players/full/3112335.png")
    assert store.resolve("nba", 98, "PJ Washington") == espn_photo("nba/players/full/4278078.png")
    assert store.resolve("nba", 97, "Shai Gilgeous Alexander") == espn_photo("nba/players/full/4278073.png")
    assert store.resolve("nba", 96, "No Photo Guy") is None
    assert store.resolve("nba", 95, "Not On A Roster") is None
    # The teams list and each roster once, with the roster's own size cap.
    assert sorted(net.urls()) == sorted([f"{ESPN}basketball/nba/teams", f"{ESPN}basketball/nba/teams/1/roster",
                                         f"{ESPN}basketball/nba/teams/2/roster"])
    assert {cap for _, cap in net.asked} == {PHOTO_ROSTER_MAX_BYTES}


def test_a_name_two_athletes_share_has_no_photo(store):
    assert store.resolve("nfl", 1, "Josh Allen") is None
    assert store.resolve("nfl", 2, "Puka Nacua") == espn_photo("nfl/players/full/4426515.png")


def test_espn_id_names_the_athlete_of_a_map_already_built_and_never_asks_the_network(store, net):
    assert store.espn_id("nba", "N. Jokić") is None  # no map yet: nothing, and nothing asked
    assert net.asked == []
    store.resolve("nba", 1, "Nikola Jokić")  # builds the sport's map, as a visitor's first photo does
    asked = len(net.asked)
    assert store.espn_id("nba", "Nikola Jokić") == "3112335"
    assert store.espn_id("nba", "N. Jokić") == "3112335"  # as the live feed abbreviates it
    assert store.espn_id("nba", "P.J. Washington Jr.") == "4278078"
    assert store.espn_id("nba", "Nobody Known") is None
    assert store.espn_id("nba", "No Photo Guy") is None  # an athlete without a headshot has no id to join on
    assert len(net.asked) == asked


def test_has_map_says_whether_a_sports_roster_map_is_there_to_join_on_without_asking_the_network(tmp_path, store, net, clock):
    assert store.has_map("nba") is False and net.asked == []
    store.resolve("nba", 1, "Nikola Jokić")
    asked = len(net.asked)
    assert store.has_map("nba") is True
    assert store.has_map("soccer") is False  # no ESPN roster for it
    clock.t += 30 * 24 * 3600  # an old map still joins
    assert store.has_map("nba") is True
    assert PhotoStore(tmp_path / "photos", get=net, clock=clock).has_map("nba") is True  # kept on disk
    assert len(net.asked) == asked


def test_espn_id_tells_two_of_one_name_apart_only_by_position_and_else_says_nothing(store):
    store.resolve("nfl", 1, "Puka Nacua")
    assert store.espn_id("nfl", "Josh Allen") is None
    assert store.espn_id("nfl", "Josh Allen", "QB") == "3918298"
    assert store.espn_id("nfl", "Josh Allen", "LB") == "3915189"
    assert store.espn_id("nfl", "Josh Allen", "K") is None


def test_espn_id_also_covers_nhl_and_mlb_whose_photos_still_come_straight_from_the_leagues_id(store, net):
    store.warm()
    assert store.espn_id("nhl", "Connor McDavid") == "3895074"
    assert store.espn_id("nhl", "C. McDavid") == "3895074"
    assert store.espn_id("mlb", "S. Ohtani") == "39832"
    assert store.espn_id("mlb", "Will Smith") is None  # two of the name, no position: never a guess
    assert store.has_map("nhl") and store.has_map("mlb")
    assert store.resolve("nhl", 8478402, "Connor McDavid") == NHL  # the face is still by id, never by name
    assert store.resolve("mlb", 660271, "Shohei Ohtani") == MLB


def test_espn_id_has_nothing_for_a_sport_with_no_espn_roster(store):
    store.resolve("nba", 1, "Nikola Jokić")
    assert store.espn_id("soccer", "Anyone") is None
    assert store.espn_id("ufc", "Anyone") is None  # its map is of fighters, not a roster with an injury list


def test_espn_id_still_answers_from_an_old_map_without_building_a_new_one(store, net, clock):
    store.resolve("nba", 1, "Nikola Jokić")
    asked = len(net.asked)
    clock.t += 30 * 24 * 3600  # long past PHOTO_TTL_S
    assert store.espn_id("nba", "Nikola Jokić") == "3112335"
    assert len(net.asked) == asked


def test_espn_id_reads_a_map_kept_on_disk_by_an_earlier_run(tmp_path, net, clock):
    PhotoStore(tmp_path / "photos", get=net, clock=clock).resolve("nba", 1, "Nikola Jokić")
    fresh = PhotoStore(tmp_path / "photos", get=net, clock=clock)  # a restart: nothing in memory
    asked = len(net.asked)
    assert fresh.espn_id("nba", "Nikola Jokić") == "3112335"
    assert len(net.asked) == asked


def test_a_namesake_without_a_headshot_still_makes_the_name_ambiguous(store, net):
    """A roster athlete with no headshot is no photo, but he is still a person: without him the name looks unique and
    the other one's id (and injury) would land on his card."""
    net.json[f"{ESPN}football/nfl/teams/1/roster"] = {"athletes": [{"position": "offense", "items": [
        {"fullName": "Puka Nacua", "position": {"abbreviation": "WR"},
         "headshot": "https://a.espncdn.com/i/headshots/nfl/players/full/4426515.png"}]}]}
    net.json[f"{ESPN}football/nfl/teams/2/roster"] = {"athletes": [{"position": "offense", "items": [
        {"fullName": "Puka Nacua", "position": {"abbreviation": "TE"}}]}]}  # no headshot
    store.resolve("nfl", 1, "Puka Nacua")
    assert store.espn_id("nfl", "Puka Nacua") is None
    assert store.espn_id("nfl", "P. Nacua") is None
    assert store.espn_id("nfl", "Puka Nacua", "WR") == "4426515"  # the page knows his position: no doubt
    assert store.espn_id("nfl", "Puka Nacua", "TE") is None  # the one with no photo has no id to give
    assert store.resolve("nfl", 1, "Puka Nacua") is None  # and no face is shown for either without a position
    assert store.resolve("nfl", 1, "Puka Nacua", "WR") == espn_photo("nfl/players/full/4426515.png")


def test_a_roster_athlete_alone_of_his_name_without_a_headshot_has_no_id_and_hides_no_other(store, net):
    net.json[f"{ESPN}football/nfl/teams/1/roster"] = {"athletes": [{"position": "offense", "items": [
        {"fullName": "Josh Smith", "position": {"abbreviation": "WR"}},
        {"fullName": "Josh Smythe", "position": {"abbreviation": "WR"},
         "headshot": "https://a.espncdn.com/i/headshots/nfl/players/full/111.png"}]}]}
    store.resolve("nfl", 1, "Josh Smythe")
    assert store.espn_id("nfl", "Josh Smith") is None
    assert store.espn_id("nfl", "J. Smith") is None  # his own name is taken, by a man with no photo
    assert store.espn_id("nfl", "J. Smythe") == "111"


def test_ufc_fighters_come_from_the_rankings(store, net):
    assert store.resolve("ufc", 5, "Islam Makhachev") == espn_photo("mma/players/full/3332412.png")
    assert store.resolve("ufc", 6, "A Champion Missing From Them") is None
    assert net.urls() == [f"{ESPN}mma/ufc/rankings"]


def test_the_map_is_kept_on_disk_for_seven_days(tmp_path, net, clock, store):
    store.resolve("nba", 1, "Nikola Jokic")
    asked = len(net.asked)
    again = PhotoStore(tmp_path / "photos", get=net, clock=clock)  # a restart reads it from disk
    assert again.resolve("nba", 1, "Nikola Jokic") == espn_photo("nba/players/full/3112335.png")
    assert len(net.asked) == asked
    clock.t += PHOTO_TTL_S + 1
    again.resolve("nba", 1, "Nikola Jokic")
    assert len(net.asked) == 2 * asked  # rebuilt once it is a week old


def test_a_map_that_cannot_be_read_is_not_a_miss_and_is_retried_later(store, net, clock):
    net.down = True
    assert store.fetch("nba", 1, "Nikola Jokic") is None
    assert store.fetch("nba", 1, "Nikola Jokic") is None
    assert net.urls() == [f"{ESPN}basketball/nba/teams"]  # asked once, not on every view
    net.down = False
    clock.t += PHOTO_RETRY_S + 1
    assert store.fetch("nba", 1, "Nikola Jokic") == (PNG, "image/png")  # the player was not remembered as a miss


def test_fetch_keeps_the_photo_on_disk(tmp_path, store, net, clock):
    assert store.fetch("mlb", 660271, "Shohei Ohtani") == (PNG, "image/png")
    assert net.asked == [(MLB, PHOTO_MAX_BYTES)]
    assert store.fetch("mlb", 660271, "Shohei Ohtani") == (PNG, "image/png")
    restarted = PhotoStore(tmp_path / "photos", get=net, clock=clock)
    assert restarted.fetch("mlb", 660271, "Shohei Ohtani") == (PNG, "image/png")
    assert len(net.asked) == 1
    assert (tmp_path / "photos" / "mlb" / "660271.img").read_bytes() == PNG


def test_a_photo_is_fetched_again_after_seven_days_and_kept_when_that_fails(store, net, clock):
    store.fetch("nhl", 8478402, "Connor McDavid")
    clock.t += PHOTO_TTL_S + 1
    net.down = True
    assert store.fetch("nhl", 8478402, "Connor McDavid") == (PNG, "image/png")  # the old one, still
    assert len(net.asked) == 2
    store.fetch("nhl", 8478402, "Connor McDavid")
    assert len(net.asked) == 2  # and not asked again before a day


def test_a_miss_is_remembered_for_a_day(store, net, clock):
    assert store.fetch("mlb", 1, "Nobody") is None
    assert store.fetch("mlb", 1, "Nobody") is None
    assert len(net.asked) == 1
    clock.t += PHOTO_MISS_TTL_S + 1
    store.fetch("mlb", 1, "Nobody")
    assert len(net.asked) == 2


def test_espn_players_are_fetched_by_name(store, net):
    assert store.fetch("nba", 12, "P.J. Washington") == (JPEG, "image/jpeg")
    assert store.fetch("nba", 13, "No Photo Guy") is None
    assert store.fetch("ufc", 5, "Islam Makhachev") == (PNG, "image/png")


def test_without_a_name_only_the_disk_answers(store, net):
    assert store.fetch("mlb", 660271) is None
    assert net.asked == []
    store.fetch("mlb", 660271, "Shohei Ohtani")
    assert store.fetch("mlb", 660271) == (PNG, "image/png")
    assert len(net.asked) == 1


@pytest.mark.parametrize("answer", [(b"<html>nope</html>", "image/png"), (PNG, "text/html"), (PNG, "image/svg+xml"),
                                    (b"GIF89a....", "image/gif"), (JPEG, "image/png")])
def test_only_real_images_of_allowed_types_are_kept(store, net, answer):
    net.images[MLB] = answer
    assert store.fetch("mlb", 660271, "Shohei Ohtani") is None


def test_failures_never_raise(tmp_path, clock):
    def broken(url, max_bytes):
        raise RuntimeError("boom")

    store = PhotoStore(tmp_path / "photos", get=broken, clock=clock)
    assert store.fetch("mlb", 660271, "Shohei Ohtani") is None
    assert store.resolve("nba", 1, "Nikola Jokic") is None
    assert store.fetch(" mlb", 1, "x") is None
    assert store.fetch("mlb", -1, "x") is None


def test_a_broken_cache_file_is_refetched(tmp_path, store, net):
    store.fetch("mlb", 660271, "Shohei Ohtani")
    (tmp_path / "photos" / "mlb" / "660271.json").write_text("{not json")
    assert store.fetch("mlb", 660271, "Shohei Ohtani") == (PNG, "image/png")
    assert len(net.asked) == 2


def big_png(width: int = 336, height: int = 336) -> bytes:
    """A headshot the way NHL serves one: a large RGBA PNG, its corners see-through, its middle busy."""
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    pixels = image.load()
    for x in range(width // 6, width - width // 6):
        for y in range(height // 8, height):
            pixels[x, y] = ((x * 7 + y * 3) % 256, (x * y) % 256, (x ^ y) % 256, 255)
    out = io.BytesIO()
    image.save(out, "PNG")
    return out.getvalue()


def webp_size(body: bytes) -> tuple[tuple[int, int], str]:
    with Image.open(io.BytesIO(body)) as image:
        assert image.format == "WEBP"
        return image.size, image.mode


def test_a_big_photo_is_kept_and_served_as_a_small_webp_with_its_see_through_corners(tmp_path, store, net):
    # A phone shows a face at 76 px at most, 228 device pixels on a 3x screen: a 336 px PNG of 100 KB is mostly waste.
    png = big_png()
    net.images[NHL] = (png, "image/png")
    body, content_type = store.fetch("nhl", 8478402, "Connor McDavid")
    assert content_type == "image/webp"
    assert len(body) < len(png) / 2  # a real NHL photo: 100 KB to 5 KB
    assert webp_size(body) == ((PHOTO_SIDE_MAX, PHOTO_SIDE_MAX), "RGBA")
    assert (tmp_path / "photos" / "nhl" / "8478402.img").read_bytes() == body
    assert json.loads((tmp_path / "photos" / "nhl" / "8478402.json").read_text())["type"] == "image/webp"


def test_a_wide_photo_keeps_its_shape_and_a_small_one_its_size(store, net):
    net.images[NHL] = (big_png(500, 300), "image/png")
    assert webp_size(store.fetch("nhl", 8478402, "Connor McDavid")[0])[0] == (380, PHOTO_SIDE_MAX)
    net.images[MLB] = (big_png(180, 130), "image/png")  # ESPN's size: under the limit, only re-encoded
    assert webp_size(store.fetch("mlb", 660271, "Shohei Ohtani")[0])[0] == (180, 130)


def test_what_cannot_be_made_smaller_is_served_as_it_came(store, net):
    tiny = io.BytesIO()
    Image.new("1", (200, 200), 1).save(tiny, "PNG", optimize=True)
    net.images[MLB] = (tiny.getvalue(), "image/png")  # one flat colour in 97 bytes: a webp of it is no smaller
    assert store.fetch("mlb", 660271, "Shohei Ohtani") == (tiny.getvalue(), "image/png")
    # bytes with the right signature that no decoder reads (the fixtures above) are kept as they are
    assert store.fetch("ufc", 5, "Islam Makhachev") == (PNG, "image/png")


def test_an_image_claiming_too_many_pixels_is_never_decoded(store, net, monkeypatch):
    header = io.BytesIO()
    Image.new("L", (1, 1)).save(header, "PNG")
    data = bytearray(header.getvalue())
    data[16:24] = (5000).to_bytes(4, "big") + (5000).to_bytes(4, "big")  # IHDR width and height
    data[29:33] = zlib.crc32(bytes(data[12:29])).to_bytes(4, "big")  # and its checksum, so it opens
    with Image.open(io.BytesIO(bytes(data))) as claimed:
        assert claimed.size == (5000, 5000)
    net.images[MLB] = (bytes(data), "image/png")
    monkeypatch.setattr(Image.Image, "load", lambda self: pytest.fail("decoded"))
    assert store.fetch("mlb", 660271, "Shohei Ohtani") == (bytes(data), "image/png")


def test_a_photo_an_older_server_kept_is_made_small_once(tmp_path, net, clock, monkeypatch):
    png = big_png()
    folder = tmp_path / "photos" / "nhl"
    folder.mkdir(parents=True)
    (folder / "8478402.img").write_bytes(png)
    (folder / "8478402.json").write_text(json.dumps({"type": "image/png", "expires": clock.t + 3600}))
    store = PhotoStore(tmp_path / "photos", get=net, clock=clock)
    body, content_type = store.fetch("nhl", 8478402, "Connor McDavid")
    assert content_type == "image/webp" and len(body) < len(png)
    assert net.asked == []  # still fresh: nothing asked, only re-encoded
    assert (folder / "8478402.img").read_bytes() == body
    assert json.loads((folder / "8478402.json").read_text())["expires"] == clock.t + 3600
    # one that cannot be made smaller is tried once, not on every request
    (folder / "1.img").write_bytes(PNG)
    (folder / "1.json").write_text(json.dumps({"type": "image/png", "expires": clock.t + 3600}))
    calls = []
    real = photos_module.shrink
    monkeypatch.setattr(photos_module, "shrink", lambda photo: calls.append(1) or real(photo))
    assert store.fetch("nhl", 1, "Somebody") == (PNG, "image/png")
    assert store.fetch("nhl", 1, "Somebody") == (PNG, "image/png")
    assert len(calls) == 1


def test_one_fetch_per_player_and_one_map_build_at_a_time(tmp_path, clock):
    net = FakeNet()
    gate = threading.Event()
    calls = []

    def slow(url, max_bytes):
        calls.append(url)
        gate.wait(2)
        return net(url, max_bytes)

    store = PhotoStore(tmp_path / "photos", get=slow, clock=clock)
    results = []
    threads = [threading.Thread(target=lambda: results.append(store.fetch("mlb", 660271, "Shohei Ohtani")))
               for _ in range(6)]
    for thread in threads:
        thread.start()
    gate.set()
    for thread in threads:
        thread.join(5)
    assert results == [(PNG, "image/png")] * 6
    assert calls == [MLB]


def test_get_refuses_any_other_host_without_asking(monkeypatch):
    opened = []
    monkeypatch.setattr(photos_module._OPENER, "open", lambda *a, **k: opened.append(a))
    for url in ["https://media.realapp.com/x.png", "https://mediaservice.real.vg/x.png", "http://img.mlbstatic.com/x.png",
                "https://site.api.espn.com/x", "https://img.mlbstatic.com.evil.test/x.png",
                "https://user@img.mlbstatic.com/x.png", "https://img.mlbstatic.com:8443/x.png", "ftp://assets.nhle.com/x"]:
        assert photos_module._get(url) is None, url
    assert opened == []
    assert PHOTO_HOSTS == {"img.mlbstatic.com", "assets.nhle.com", "site.web.api.espn.com", "a.espncdn.com"}


class FakeResponse:
    def __init__(self, body: bytes, length: str | None = None, status: int = 200):
        self.status, self._body = status, body
        from email.message import Message

        self.headers = Message()
        self.headers["Content-Type"] = "image/png"
        if length is not None:
            self.headers["Content-Length"] = length

    def read(self, n):
        chunk, self._body = self._body[:n], self._body[n:]
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_get_caps_the_size_and_sends_a_browser_user_agent(monkeypatch):
    seen = []

    def opener(response):
        def open_(request, timeout):
            seen.append((request.get_header("User-agent"), timeout))
            return response

        return open_

    monkeypatch.setattr(photos_module._OPENER, "open", opener(FakeResponse(PNG)))
    assert photos_module._get(MLB) == (PNG, "image/png")
    assert seen[0][0].startswith("Mozilla/5.0") and seen[0][1] == photos_module.PHOTO_TIMEOUT_S == 3
    monkeypatch.setattr(photos_module._OPENER, "open", opener(FakeResponse(b"x" * (PHOTO_MAX_BYTES + 1))))
    assert photos_module._get(MLB) is None
    monkeypatch.setattr(photos_module._OPENER, "open", opener(FakeResponse(PNG, length=str(PHOTO_MAX_BYTES + 1))))
    assert photos_module._get(MLB) is None
    monkeypatch.setattr(photos_module._OPENER, "open", opener(FakeResponse(b"x" * PHOTO_MAX_BYTES)))
    assert photos_module._get(MLB) is not None  # exactly the cap is fine

    def fails(request, timeout):
        raise TimeoutError

    monkeypatch.setattr(photos_module._OPENER, "open", fails)
    assert photos_module._get(MLB) is None


def test_redirects_are_not_followed():
    handler = photos_module._NoRedirect()
    assert handler.redirect_request(None, None, 302, "Found", {}, "https://assets.nhle.com/mugs/nhl/default-skater.png") is None


# --- the route -------------------------------------------------------------------------------------------------

SNAP = {
    "version": 1,
    "deals": [{"sport": "mlb", "player_id": 660271, "player_name": "Shohei Ohtani"}],
    "gone": [{"sport": "nfl", "player_id": 77, "player_name": "Josh Allen"},  # no position: which one is unknown
             {"sport": "nba", "player_id": 12, "player_name": "Nikola Jokić"}],
    "moves": {"risers": [{"sport": "nhl", "player_id": 8478402, "player_name": "Connor McDavid"}], "fallers": []},
    "otd": {"markets": [{"sport": "nfl", "player_id": 78, "player_name": "Josh Allen", "kind": "player", "position": "LB"},
                        {"sport": "nba", "player_id": 3, "player_name": "Denver Nuggets", "kind": "team"},
                        {"sport": "ufc", "player_id": 5, "player_name": "Islam Makhachev", "kind": "fighter"}]},
}


def client(tmp_path, photos, snapshot=SNAP):
    store = SnapshotStore()
    if snapshot:
        store.publish(snapshot)
    return create_app(store, tmp_path, photos=photos).test_client()


def test_route_serves_the_photo_with_cache_headers_and_etag(tmp_path, store):
    c = client(tmp_path, store)
    r = c.get("/img/players/mlb/660271")
    assert (r.status_code, r.data, r.headers["Content-Type"]) == (200, PNG, "image/png")
    assert r.headers["Cache-Control"] == "public, max-age=86400"
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    etag = r.headers["ETag"]
    again = c.get("/img/players/mlb/660271", headers={"If-None-Match": etag})
    assert (again.status_code, again.data) == (304, b"")


def test_route_finds_the_name_in_the_snapshot(tmp_path, store, net):
    c = client(tmp_path, store)
    assert c.get("/img/players/nba/12").status_code == 200  # a deal that just went away
    assert c.get("/img/players/nhl/8478402").status_code == 200  # a price move
    assert c.get("/img/players/ufc/5").status_code == 200  # a fighter pass


def test_route_looks_a_player_up_by_the_whole_name_the_snapshot_has(tmp_path, store, net):
    # The live deals write "J. White" (ambiguous among the league's Whites); his price move has the whole name.
    snap = {"version": 1, "deals": [{"sport": "cfb", "player_id": 5, "player_name": "J. White"}],
            "moves": {"risers": [{"sport": "cfb", "player_id": 5, "player_name": "Jahiem White"}], "fallers": []}}
    assert client(tmp_path, store, snapshot=snap).get("/img/players/cfb/5").status_code == 200
    assert search("jahiem white", "college-football") in net.urls()


def test_route_answers_204_without_a_photo(tmp_path, store, net):
    # No photo is no error: a 204 (an empty answer the img still fails on, so the page shows initials) keeps the
    # browser's console quiet, where a 404 would log one line per face.
    c = client(tmp_path, store)
    for path in ["/img/players/golf/1", "/img/players/nba/3", "/img/players/mlb/42"]:
        r = c.get(path)
        assert (r.status_code, r.data) == (204, b""), path
        assert "Content-Type" not in r.headers or not r.headers["Content-Type"].startswith("image/"), path
    for path in ["/img/players/mlb/-1", "/img/players/mlb/abc", "/img/players/..%2Fetc/1"]:  # no such route
        assert c.get(path).status_code == 404, path
    r = c.get("/img/players/golf/1")
    assert r.headers["Cache-Control"] == "public, max-age=600"
    assert r.headers["X-Content-Type-Options"] == "nosniff" and "Content-Security-Policy" in r.headers
    # A team pass (its id is a team's) and a player the snapshot does not show are never looked up.
    assert all("/people/42/" not in url for url in net.urls())
    assert net.asked == []


def test_route_without_a_photo_store_answers_quietly(tmp_path):
    r = client(tmp_path, None).get("/img/players/mlb/660271")
    assert r.status_code == 204


def test_route_before_the_first_snapshot(tmp_path, store, net):
    assert client(tmp_path, store, snapshot=None).get("/img/players/mlb/660271").status_code == 204
    assert net.asked == []


def test_route_does_not_keep_a_404_while_the_sports_map_is_not_built(tmp_path, store, net, clock):
    # A fresh server: ESPN's roster cannot be read yet, so "no photo" is not an answer. Never cached by the browser.
    snap = {"version": 1, "deals": [{"sport": "nba", "player_id": 12, "player_name": "Nikola Jokić"}]}
    c = client(tmp_path, store, snapshot=snap)
    net.down = True
    r = c.get("/img/players/nba/12")
    assert (r.status_code, r.headers["Cache-Control"]) == (204, "no-store")
    assert store.lookup("nba", 12, "Nikola Jokić") == (None, False)
    # Nothing was written as a miss, so once the map is there the face comes with no wait.
    net.down = False
    clock.t += PHOTO_RETRY_S + 1  # the failed build is tried again after an hour
    r = c.get("/img/players/nba/12")
    assert (r.status_code, r.data) == (200, PNG)
    assert r.headers["Cache-Control"] == "public, max-age=86400"


def test_route_keeps_a_settled_no_match_for_ten_minutes(tmp_path, store, net):
    snap = {"version": 1, "deals": [{"sport": "nba", "player_id": 12, "player_name": "Nobody On A Roster"}]}
    r = client(tmp_path, store, snapshot=snap).get("/img/players/nba/12")
    assert (r.status_code, r.headers["Cache-Control"]) == (204, "public, max-age=600")
    assert store.lookup("nba", 12, "Nobody On A Roster") == (None, True)
    assert store.lookup("golf", 1, "Anyone") == (None, True)
    assert store.lookup("nba", 12) == (None, True)  # not shown: only the disk answers, and that is an answer


def test_csp_keeps_images_on_our_own_origin(tmp_path):
    r = client(tmp_path, None).get("/img/players/mlb/1")
    csp = {d.split()[0]: d.split()[1:] for d in r.headers["Content-Security-Policy"].split("; ")}
    assert csp["img-src"] == ["'self'"]


def test_warm_builds_every_name_matched_map_once(store, net):
    store.warm()
    asked = set(net.urls())
    assert {f"{ESPN}basketball/nba/teams", f"{ESPN}football/nfl/teams", f"{ESPN}mma/ufc/rankings",
            f"{ESPN}basketball/wnba/teams"} <= asked
    count = len(net.asked)
    store.warm()
    store.resolve("nba", 1, "Nikola Jokic")
    assert len(net.asked) == count  # nothing asked again: the maps are fresh, and WNBA's failure waits an hour


def test_a_map_cut_short_by_the_deadline_is_kept_and_rebuilt_after_a_day(tmp_path, clock, monkeypatch):
    net = FakeNet()
    slow_roster = f"{ESPN}basketball/nba/teams/2/roster"

    def get(url, max_bytes):
        if url == slow_roster:
            threading.Event().wait(0.5)
        return net(url, max_bytes)

    monkeypatch.setattr(photos_module, "PHOTO_MAP_DEADLINE_S", 0.1)
    store = PhotoStore(tmp_path / "photos", get=get, clock=clock)
    assert store.resolve("nba", 1, "Nikola Jokic") == espn_photo("nba/players/full/3112335.png")  # team 1 was read
    assert store.resolve("nba", 2, "Shai Gilgeous-Alexander") is None  # team 2 was not, in time
    saved = json.loads((tmp_path / "photos" / "maps" / "nba.json").read_text())
    assert saved["expires"] == clock.t + PHOTO_MISS_TTL_S


# --- the demo: real names, invented ids -------------------------------------------------------------------------

@pytest.fixture
def demo(tmp_path, net, clock):
    return PhotoStore(tmp_path / "photos-demo", get=net, clock=clock, ids_are_real=False)


def test_demo_mlb_and_nhl_are_matched_by_name_and_never_by_id(demo, net):
    assert demo.resolve("mlb", 5001, "Shohei Ohtani") == espn_photo("mlb/players/full/39832.png")
    assert demo.resolve("nhl", 5002, "Connor McDavid") == espn_photo("nhl/players/full/3895074.png")
    assert demo.resolve("mlb", 660271, "A Name Not On A Roster") is None  # a real MLB id, but the wrong man
    assert demo.fetch("nhl", 8478402, "Nobody On A Roster") is None
    assert not any("mlbstatic" in url or "nhle.com" in url for url in net.urls())
    assert f"{ESPN}baseball/mlb/teams" in net.urls() and f"{ESPN}hockey/nhl/teams" in net.urls()


def test_demo_names_match_through_accents_and_suffixes(demo):
    assert demo.resolve("mlb", 1, "Ronald Acuna Jr") == espn_photo("mlb/players/full/36185.png")
    assert demo.resolve("mlb", 2, "RONALD ACUÑA") == espn_photo("mlb/players/full/36185.png")
    assert demo.resolve("nhl", 3, "Tim Stutzle") == espn_photo("nhl/players/full/4565222.png")


def test_demo_a_shared_name_has_no_photo(demo):
    assert demo.resolve("mlb", 1, "Will Smith") is None


def test_demo_fetch_serves_the_matched_photo_and_keeps_it_apart(tmp_path, demo, net):
    assert demo.fetch("mlb", 5001, "Shohei Ohtani") == (PNG, "image/png")
    assert (tmp_path / "photos-demo" / "mlb" / "5001.img").exists()
    assert not (tmp_path / "photos").exists()


def test_demo_keeps_the_other_sources_and_the_sports_without_one(demo, net):
    assert demo.resolve("nba", 9, "Nikola Jokic") == espn_photo("nba/players/full/3112335.png")
    assert demo.resolve("nfl", 9, "Puka Nacua") == espn_photo("nfl/players/full/4426515.png")
    assert demo.resolve("ufc", 9, "Islam Makhachev") == espn_photo("mma/players/full/3332412.png")
    for sport in ("golf", "soccer", "cfb", "cbb"):
        assert demo.resolve(sport, 9, "Anyone") is None and demo.fetch(sport, 9, "Anyone") is None


def test_real_ids_still_come_from_the_id_and_a_photo_never_asks_the_rosters(store, net):
    assert store.resolve("mlb", 660271, "Shohei Ohtani") == MLB
    assert store.resolve("nhl", 8478402, "Connor McDavid") == NHL
    assert not any("baseball/mlb" in url or "hockey/nhl" in url for url in net.urls())  # the face needs no roster
    store.warm()  # the rosters are read too, but only for the injury join (`espn_id`)
    assert {f"{ESPN}baseball/mlb/teams", f"{ESPN}hockey/nhl/teams"} <= set(net.urls())
    assert store.resolve("mlb", 660271, "Shohei Ohtani") == MLB  # and the face is still the id's


def test_demo_warm_builds_the_mlb_and_nhl_maps_too(demo, net):
    demo.warm()
    assert {f"{ESPN}baseball/mlb/teams", f"{ESPN}hockey/nhl/teams", f"{ESPN}basketball/nba/teams"} <= set(net.urls())


def test_a_kept_photo_is_not_served_to_another_name_under_the_same_id(demo, net, clock):
    # The demo's fixture is regenerated and id 5001 is now another player: the old face must not follow the id.
    assert demo.fetch("mlb", 5001, "Shohei Ohtani") == (PNG, "image/png")
    assert demo.fetch("mlb", 5001, "Ronald Acuna") == (JPEG, "image/jpeg")
    assert demo.fetch("mlb", 5001, "Nobody On A Roster") is None  # and the old face is no fallback for a stranger


def test_route_in_demo_mode_looks_the_name_up_and_never_the_id(tmp_path, demo, net):
    c = client(tmp_path, demo)
    r = c.get("/img/players/mlb/660271")  # the snapshot's Shohei Ohtani, whatever the id says
    assert (r.status_code, r.data) == (200, PNG)
    assert c.get("/img/players/nhl/8478402").status_code == 200
    assert c.get("/img/players/nba/12").status_code == 200
    assert c.get("/img/players/mlb/42").status_code == 204  # not shown by the snapshot: no photo
    assert not any("mlbstatic" in url or "nhle.com" in url for url in net.urls())


# --- a name two athletes share: the position says which one --------------------------------------------------------

def test_a_shared_name_is_told_apart_by_position(store):
    qb, lb = espn_photo("nfl/players/full/3918298.png"), espn_photo("nfl/players/full/3915189.png")
    assert store.resolve("nfl", 1, "Josh Allen", "QB") == qb
    assert store.resolve("nfl", 2, "Josh Allen", "LB") == lb
    assert store.resolve("nfl", 3, "Josh Allen", "WR") is None  # neither of them
    assert store.resolve("nfl", 4, "Josh Allen") is None  # no position: still a guess, so no face
    assert store.resolve("nfl", 5, "Puka Nacua", "WR") == espn_photo("nfl/players/full/4426515.png")  # unshared: as ever


def test_two_athletes_sharing_name_and_position_have_no_photo(tmp_path, net, clock):
    net.json[f"{ESPN}baseball/mlb/teams/2/roster"] = {"athletes": [{"items": [
        {"fullName": "Will Smith", "position": {"abbreviation": "C"},
         "headshot": "https://a.espncdn.com/i/headshots/mlb/players/full/1.png"},
        {"fullName": "Will Smith", "position": {"abbreviation": "C"},
         "headshot": "https://a.espncdn.com/i/headshots/mlb/players/full/2.png"},
        {"fullName": "Will Smith", "position": {"abbreviation": "P"},
         "headshot": "https://a.espncdn.com/i/headshots/mlb/players/full/3.png"},
    ]}]}
    demo = PhotoStore(tmp_path / "photos-two", get=net, clock=clock, ids_are_real=False)
    assert demo.resolve("mlb", 1, "Will Smith", "C") is None
    assert demo.resolve("mlb", 1, "Will Smith", "P") == espn_photo("mlb/players/full/3.png")


def test_the_position_survives_the_map_on_disk(tmp_path, store, net, clock):
    store.resolve("nfl", 1, "Josh Allen", "QB")
    asked = len(net.asked)
    again = PhotoStore(tmp_path / "photos", get=net, clock=clock)
    assert again.resolve("nfl", 1, "Josh Allen", "LB") == espn_photo("nfl/players/full/3915189.png")
    assert len(net.asked) == asked


def test_a_map_written_before_positions_is_built_again(tmp_path, clock, net):
    folder = tmp_path / "photos" / "maps"
    folder.mkdir(parents=True)
    (folder / "nfl.json").write_text(json.dumps({"expires": clock.t + 1000, "players": {"josh allen": None}}))
    old = PhotoStore(tmp_path / "photos", get=net, clock=clock)
    assert old.resolve("nfl", 1, "Josh Allen", "QB") == espn_photo("nfl/players/full/3918298.png")  # not a week's wait
    assert f"{ESPN}football/nfl/teams" in net.urls()


def test_fetch_gives_the_face_of_the_position_and_keeps_it_for_that_name(store):
    assert store.fetch("nfl", 1, "Josh Allen", "QB") == (PNG, "image/png")
    assert store.fetch("nfl", 2, "Josh Allen", "LB") == (JPEG, "image/jpeg")
    assert store.fetch("nfl", 3, "Josh Allen") is None


def test_route_uses_the_position_the_snapshot_knows(tmp_path, store):
    c = client(tmp_path, store)
    assert c.get("/img/players/nfl/78").status_code == 200  # a pass says he is the LB
    assert c.get("/img/players/nfl/77").status_code == 204  # a gone deal does not say which Josh Allen


def test_an_initial_and_a_surname_match_the_one_athlete_they_can_be(store):
    """The live feed names players 'N. Jokić': matched to the only roster name with that initial and surname; a pair
    two athletes share keeps its initials (a wrong face is worse than none)."""
    assert store.resolve("nba", 99, "N. Jokić") == espn_photo("nba/players/full/3112335.png")
    assert store.resolve("nba", 97, "S. Gilgeous-Alexander") == espn_photo("nba/players/full/4278073.png")
    assert store.resolve("nfl", 2, "P. Nacua") == espn_photo("nfl/players/full/4426515.png")
    assert store.resolve("nfl", 1, "J. Allen") is None  # two of them, and the page did not say which position
    assert store.resolve("nfl", 1, "J. Allen", "QB") is not None  # the position tells them apart
    assert store.resolve("nba", 99, "X. Jokić") is None  # no Jokić with that initial


def test_a_miss_kept_by_an_older_name_matcher_is_asked_again_at_once(tmp_path, store, net, clock):
    """'N. Jokić' was a miss before initials matched; that miss must not hide his photo for another day."""
    folder = tmp_path / "photos" / "nba"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "99.json").write_text(json.dumps({"miss": True, "expires": clock() + 80_000, "name": "n jokic"}))
    assert store.fetch("nba", 99, "N. Jokić") is not None
    # a miss written by this matcher is kept as before
    assert store.fetch("nba", 95, "Not On A Roster") is None
    asked = len(net.asked)
    assert store.fetch("nba", 95, "Not On A Roster") is None and len(net.asked) == asked


def test_college_and_golf_players_are_found_by_espn_search_within_their_leagues(store, net):
    assert store.resolve("cfb", 5, "Jahiem White") == espn_photo(SEARCH_PHOTOS[0])
    assert search("jahiem white", "college-football") in net.urls()
    assert store.resolve("golf", 6, "Si Woo Kim") == espn_photo(SEARCH_PHOTOS[3])
    assert store.fetch("cfb", 5, "Jahiem White") == (PNG, "image/png")


def test_an_initial_and_a_surname_match_only_one_athlete_of_the_league_with_a_photo(store):
    assert store.resolve("cbb", 7, "T. Acuff") == espn_photo(SEARCH_PHOTOS[2])  # not the NBA's Darius Acuff
    assert store.resolve("cfb", 8, "J. White") is None  # Jahiem or John: no guess
    assert store.resolve("cbb", 9, "Z. Smith") is None  # more pages than one were not read: no guess
    assert store.resolve("cfb", 10, "K. Brown") is None  # Kai has a photo, Kyle has none: still two, no guess


def test_a_college_player_who_went_pro_is_found_in_the_pro_league_only_when_college_has_none(store, net):
    assert store.resolve("cbb", 11, "Trayce Jackson-Davis") == espn_photo(SEARCH_PHOTOS[2])
    assert store.resolve("cfb", 12, "Jayden Daniels") == espn_photo(SEARCH_PHOTOS[0])  # college decides first
    assert search("jayden daniels", "nfl") not in net.urls()
    assert store.resolve("cfb", 13, "Jeremiah Smith") is None  # two in college: no guess, and no pro league asked
    assert search("jeremiah smith", "nfl") not in net.urls()


def test_a_search_that_cannot_be_read_is_asked_again_not_kept_as_a_miss(store, net, clock):
    net.down = True
    assert store.fetch("cfb", 5, "Jahiem White") is None
    net.down = False
    clock.t += 60
    assert store.fetch("cfb", 5, "Jahiem White") == (PNG, "image/png")


def test_a_searched_miss_is_kept_a_while_and_not_asked_again(store, net):
    assert store.fetch("cfb", 8, "J. White") is None
    asked = len(net.asked)
    assert store.fetch("cfb", 8, "J. White") is None
    assert len(net.asked) == asked


def test_a_slow_source_never_holds_a_request_for_long():
    # A photo route waits on the public source at most this long per request it makes.
    assert photos_module.PHOTO_TIMEOUT_S <= 3
