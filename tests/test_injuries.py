"""Who is hurt: ESPN's public injury list, read through a fake fetcher (no test touches the network)."""
import gzip
import json
import threading

import pytest

from advisor import injuries as injuries_module
from advisor.injuries import Injury, InjuryBoard, InjuryView, espn_id_of, parse, run_injuries
from advisor.rules import INJURY_MAX_AGE_S, INJURY_PATHS, INJURY_RETRY_S, INJURY_TTL_S


def hs(sport: str, athlete_id: int) -> dict:
    return {"href": f"https://a.espncdn.com/i/headshots/{sport}/players/full/{athlete_id}.png"}


def row(athlete_id: int, status: str, *, part: str | None = "Knee", back: str | None = "2026-11-18", sport="nba") -> dict:
    details = {k: v for k, v in (("type", part), ("returnDate", back)) if v is not None}
    return {
        "status": status,
        "athlete": {"displayName": f"Player {athlete_id}", "headshot": hs(sport, athlete_id)},
        "details": details,
    }


def payload(*groups: list[dict]) -> dict:
    return {"injuries": [{"displayName": f"Team {i}", "injuries": rows} for i, rows in enumerate(groups)]}


def test_parse_keeps_the_hurt_players_by_their_espn_id_with_what_hurts_and_when_they_may_be_back():
    found = parse(payload([row(3146557, "Day-To-Day", part="Hip", back="2026-11-15")], [row(6583, "Out")]))
    assert found == {
        "3146557": Injury("day", "Hip", "2026-11-15"),
        "6583": Injury("out", "Knee", "2026-11-18"),
    }


def test_parse_leaves_out_players_listed_as_active_which_only_tell_two_of_one_name_apart():
    assert parse(payload([row(1, "Active"), row(2, "Out")])) == {"2": Injury("out", "Knee", "2026-11-18")}


@pytest.mark.parametrize(
    ("espn", "ours"),
    [
        ("Out", "out"),
        ("Injured Reserve", "out"),
        ("Doubtful", "doubtful"),
        ("Questionable", "questionable"),
        ("Day-To-Day", "day"),
        ("Suspension", "suspended"),
    ],
)
def test_parse_speaks_in_our_five_words_for_what_espn_calls_it(espn, ours):
    assert parse(payload([row(9, espn)]))["9"].status == ours


def test_parse_says_nothing_about_a_status_it_does_not_know_rather_than_guess():
    assert parse(payload([row(9, "Probable"), row(10, ""), row(11, "Out For Season, Maybe")])) == {}


def test_parse_keeps_a_return_date_only_when_it_is_a_real_day_and_a_body_part_only_when_it_is_plain_words():
    found = parse(
        payload(
            [
                row(1, "Out", part="Knee", back="2026-02-30"),  # no such day
                row(2, "Out", part="<script>alert(1)</script>", back="soon"),
                row(3, "Out", part="Left Ankle", back="2026-11-20"),
                row(4, "Out", part=None, back=None),
            ]
        )
    )
    assert found["1"] == Injury("out", "Knee", None)
    assert found["2"] == Injury("out", None, None)
    assert found["3"] == Injury("out", "Left Ankle", "2026-11-20")
    assert found["4"] == Injury("out", None, None)


def test_parse_keeps_the_strictest_status_when_a_player_is_listed_twice():
    found = parse(payload([row(5, "Questionable")], [row(5, "Out", part="Foot", back="2026-12-01")], [row(5, "Day-To-Day")]))
    assert found == {"5": Injury("out", "Foot", "2026-12-01")}


def test_parse_skips_a_row_with_no_photo_id_since_a_name_alone_is_never_a_match():
    bare = {"status": "Out", "athlete": {"displayName": "No Photo Guy"}}
    assert parse(payload([bare, row(7, "Out")])) == {"7": Injury("out", "Knee", "2026-11-18")}


@pytest.mark.parametrize("junk", [None, [], "x", 3, {}, {"injuries": None}, {"injuries": [None, 4, {"injuries": "no"}]}])
def test_parse_survives_a_payload_that_is_not_what_espn_sends(junk):
    assert parse(junk) == {}


def test_espn_id_of_reads_the_athlete_from_a_headshot_whether_plain_or_resized():
    assert espn_id_of("https://a.espncdn.com/i/headshots/nba/players/full/3112335.png") == "3112335"
    assert espn_id_of("https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/3918298.png&w=180&h=130") == "3918298"
    assert espn_id_of("https://assets.nhle.com/mugs/nhl/latest/8478402.png") is None
    assert espn_id_of(None) is None
    assert espn_id_of("") is None


# ---- the board: one read per sport per TTL, the last good list kept, silence when it is too old ----------------------


class Clock:
    def __init__(self, now: float = 1_000_000.0):
        self.now = now

    def __call__(self) -> float:
        return self.now


class Espn:
    """A fake ESPN: what each league answers (or None for a failed read), and every url asked."""

    def __init__(self, answers: dict[str, dict | None]):
        self.answers = answers
        self.asked: list[str] = []

    def __call__(self, url: str, max_bytes: int):
        self.asked.append(url)
        league = next(path for path in INJURY_PATHS.values() if f"/{path}/injuries" in url)
        body = self.answers[league]
        return None if body is None else (json.dumps(body).encode(), "application/json")


def board(espn: Espn, clock: Clock) -> InjuryBoard:
    return InjuryBoard(get=espn, clock=clock)


NBA_HURT = payload([row(6583, "Out")])
NFL_HURT = payload([row(3918298, "Questionable", sport="nfl", part="Ankle", back=None)])


def everyone(**over) -> dict[str, dict | None]:
    answers = {path: payload() for path in INJURY_PATHS.values()}
    answers[INJURY_PATHS["nba"]] = NBA_HURT
    answers[INJURY_PATHS["nfl"]] = NFL_HURT
    answers.update(over)
    return answers


def test_the_board_reads_every_covered_sport_and_answers_by_sport_and_espn_id():
    espn, clock = Espn(everyone()), Clock()
    b = board(espn, clock)
    b.refresh()
    assert b.lookup("nba", "6583") == Injury("out", "Knee", "2026-11-18")
    assert b.lookup("nfl", "3918298") == Injury("questionable", "Ankle", None)
    assert b.lookup("nba", "3918298") is None  # another league's athlete
    assert b.lookup("nba", "999") is None  # a healthy one
    assert b.lookup("mlb", "6583") is None  # a sport it does not cover
    assert sorted(b.sports()) == sorted(INJURY_PATHS)
    assert len(espn.asked) == len(INJURY_PATHS)


def test_the_board_asks_a_league_again_only_after_its_ttl():
    espn, clock = Espn(everyone()), Clock()
    b = board(espn, clock)
    b.refresh()
    clock.now += INJURY_TTL_S - 1
    b.refresh()
    assert len(espn.asked) == len(INJURY_PATHS)
    clock.now += 2
    b.refresh()
    assert len(espn.asked) == 2 * len(INJURY_PATHS)


def test_a_failed_read_keeps_serving_the_last_good_list_and_is_tried_again_after_the_retry_delay_only():
    espn, clock = Espn(everyone()), Clock()
    b = board(espn, clock)
    b.refresh()
    espn.answers[INJURY_PATHS["nba"]] = None
    clock.now += INJURY_TTL_S + 1
    b.refresh()
    assert b.lookup("nba", "6583") is not None  # the last good list still speaks
    asked = len(espn.asked)
    clock.now += INJURY_RETRY_S - 1
    b.refresh()
    assert len(espn.asked) == asked  # not hammered
    espn.answers[INJURY_PATHS["nba"]] = payload([row(6583, "Out"), row(77, "Doubtful")])
    clock.now += 2
    b.refresh()
    assert b.lookup("nba", "77") == Injury("doubtful", "Knee", "2026-11-18")


def test_a_list_older_than_the_max_age_stops_speaking_so_an_old_injury_is_never_shown_as_news():
    espn, clock = Espn(everyone()), Clock()
    b = board(espn, clock)
    b.refresh()
    espn.answers = {path: None for path in INJURY_PATHS.values()}  # ESPN is out of reach
    clock.now += INJURY_MAX_AGE_S + 1
    b.refresh()
    assert b.lookup("nba", "6583") is None
    assert b.lookup("nfl", "3918298") is None
    assert b.sports() == []
    espn.answers = everyone()  # ESPN is back
    clock.now += INJURY_RETRY_S + 1
    b.refresh()
    assert b.lookup("nba", "6583") is not None and "nba" in b.sports()


def test_a_sport_never_read_has_no_voice_and_the_first_failure_leaves_no_list_at_all():
    espn, clock = Espn(everyone(**{INJURY_PATHS["nba"]: None})), Clock()
    b = board(espn, clock)
    b.refresh()
    assert "nba" not in b.sports()
    assert b.lookup("nba", "6583") is None
    assert "nfl" in b.sports()


def test_the_board_does_not_trust_an_answer_that_is_not_json():
    def garbage(url: str, max_bytes: int):
        return b"<html>nope</html>", "text/html"

    b = InjuryBoard(get=garbage, clock=Clock())
    b.refresh()
    assert b.sports() == []


def test_the_default_reader_only_asks_https_hosts_we_already_use_and_decodes_gzip(monkeypatch):
    body = gzip.compress(json.dumps(NBA_HURT).encode())

    class Response:
        status = 200
        headers = type("H", (), {"get": lambda self, k, d="": {"Content-Encoding": "gzip"}.get(k, d), "get_content_type": lambda self: "application/json"})()

        def __init__(self):
            self._chunks = [body, b""]

        def read(self, n=-1):
            return self._chunks.pop(0)

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    class Opener:
        def open(self, request, timeout=None):
            assert request.full_url.startswith("https://site.web.api.espn.com/")
            assert request.get_header("Accept-encoding") == "gzip"
            return Response()

    monkeypatch.setattr(injuries_module, "_OPENER", Opener())
    got = injuries_module._get("https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/injuries", 1_000_000)
    assert got is not None and json.loads(got[0]) == NBA_HURT
    assert injuries_module._get("https://evil.example/apis/site/v2/sports/basketball/nba/injuries", 1_000_000) is None
    assert injuries_module._get("http://site.web.api.espn.com/x", 1_000_000) is None


# ---- the view a snapshot asks: a deal's player (name, as the feed writes it) -> what ESPN says, as served -----------


class Photos:
    """The photo store's `espn_id`, with a few players: (sport, name, position) -> ESPN id."""

    def __init__(self, ids: dict[tuple[str, str, str | None], str], maps: set[str] | None = None):
        self.ids, self.asked, self.maps = ids, [], set(INJURY_PATHS) if maps is None else maps

    def has_map(self, sport: str) -> bool:
        return sport in self.maps

    def espn_id(self, sport: str, name: str, position: str | None = None):
        self.asked.append((sport, name, position))
        return self.ids.get((sport, name, position))


def view_of(ids, maps: set[str] | None = None) -> tuple[InjuryView, Photos]:
    b = board(Espn(everyone()), Clock())
    b.refresh()
    photos = Photos(ids, maps)
    return InjuryView(b, photos), photos


def test_the_view_gives_what_espn_says_about_a_deals_player_as_the_json_the_page_reads():
    view, _ = view_of({("nba", "N. Jokić", None): "6583", ("nfl", "J. Allen", None): "3918298"})
    assert view.of("nba", 1, "N. Jokić") == {"status": "out", "part": "Knee", "back": "2026-11-18"}
    assert view.of("nfl", 2, "J. Allen") == {"status": "questionable", "part": "Ankle", "back": None}


def test_the_view_says_nothing_for_a_player_it_cannot_join_or_whom_espn_does_not_list():
    view, _ = view_of({("nba", "Healthy Guy", None): "12345"})
    assert view.of("nba", 1, "Healthy Guy") is None  # joined, but not on the list
    assert view.of("nba", 1, "Unknown Guy") is None  # not joined: no map, an ambiguous name, no headshot
    assert view.of("soccer", 1, "Anyone") is None  # a sport ESPN's list does not cover


def test_the_view_names_the_sports_whose_list_is_fresh():
    view, _ = view_of({})
    assert sorted(view.sports()) == sorted(INJURY_PATHS)


def test_the_view_never_raises_into_a_snapshot():
    class Broken:
        def espn_id(self, *a, **k):
            raise RuntimeError("boom")

    b = board(Espn(everyone()), Clock())
    b.refresh()
    assert InjuryView(b, Broken()).of("nba", 1, "N. Jokić") is None


def test_the_refresher_keeps_reading_until_it_is_stopped_and_an_error_does_not_end_it():
    class Flaky:
        calls = 0

        def refresh(self):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("boom")

    waits: list[float] = []

    def wait(seconds: float) -> bool:
        waits.append(seconds)
        return len(waits) >= 3

    flaky = Flaky()
    run_injuries(flaky, threading.Event(), every_s=60, wait=wait)
    assert (flaky.calls, waits) == (3, [60, 60, 60])


# ---- review fixes: one odd row must not silence a league, and an unknown status is logged once ----------------------


@pytest.mark.parametrize("odd", [{"x": 1}, ["Out"], 7, None, True])
def test_parse_skips_a_row_whose_status_is_not_text_and_keeps_the_others(odd):
    bad = row(8, "Out")
    bad["status"] = odd
    assert parse(payload([bad, row(9, "Out")])) == {"9": Injury("out", "Knee", "2026-11-18")}


def test_a_league_whose_parse_blows_up_is_a_failed_read_retried_later_and_the_others_are_still_read(monkeypatch):
    espn, clock = Espn(everyone()), Clock()
    real = injuries_module.parse

    def parse_or_blow(data):
        if data == NBA_HURT:
            raise RuntimeError("an odd row")
        return real(data)

    monkeypatch.setattr(injuries_module, "parse", parse_or_blow)
    b = board(espn, clock)
    b.refresh()
    assert "nba" not in b.sports() and {"nfl", "wnba"} <= set(b.sports())
    asked = len(espn.asked)
    b.refresh()
    assert len(espn.asked) == asked  # not hammered: the retry delay holds


def test_a_status_we_do_not_know_is_logged_once_so_the_vocabulary_can_be_learned_and_is_not_shown(caplog, monkeypatch):
    monkeypatch.setattr(injuries_module, "_UNKNOWN_SEEN", set())
    odd = payload([row(1, "Physically Unable To Perform")])
    with caplog.at_level("INFO", logger="advisor.injuries"):
        assert parse(odd) == {} and parse(odd) == {}
    lines = [r.getMessage() for r in caplog.records if "Physically Unable To Perform" in r.getMessage()]
    assert len(lines) == 1


def test_the_view_speaks_only_for_the_sports_it_can_join_so_the_page_never_claims_more_than_it_does():
    view, _ = view_of({}, maps={"nba"})  # every list is fresh, but only the NBA's roster map is built yet
    assert view.sports() == ["nba"]
    view, _ = view_of({}, maps=set())
    assert view.sports() == []


def test_the_injury_list_covers_the_five_leagues_whose_rosters_ESPN_gives():
    assert set(INJURY_PATHS) == {"nba", "wnba", "nfl", "nhl", "mlb"}
