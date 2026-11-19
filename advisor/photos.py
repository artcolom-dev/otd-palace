"""Player photos: found on public league sources, kept on disk, served from our own origin.

Never from Real's own media server. MLB and NHL photos come straight from the player id (Real's id is the league's);
NBA, WNBA and NFL photos are matched by name on ESPN's public team rosters, UFC fighters on ESPN's MMA rankings, college
football, college basketball and golf players through ESPN's public player search, within the sport's leagues. Every
other sport has none, and the page shows the player's initials.

A name two athletes share is told apart by the position the page knows (a pass says it), else it has no photo.

The demo's players carry real names but invented ids, so its store (`ids_are_real=False`) never uses an id: MLB and
NHL are matched by name on ESPN's rosters like the others, and a face is never one a stranger's id points to.

Every request out goes through `_get`: https only, to the hosts of `PHOTO_HOSTS` only, no redirect followed, with a
timeout and a size cap. A photo is kept `PHOTO_TTL_S`; a player found without one is not asked about again for
`PHOTO_MISS_TTL_S`. Nothing here raises into a request: any failure is "no photo".

A photo is kept small (`shrink`): no bigger than `PHOTO_SIDE_MAX` on its short side and re-encoded as WebP, whenever
that is smaller than what came. A phone shows a face at 76 px at most, and NHL's 336 px PNGs weigh about 100 KB each.
"""

import io
import json
import logging
import os
import re
import tempfile
import threading
import time
import unicodedata
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from PIL import Image

from advisor.rules import (
    PHOTO_BY_ID,
    PHOTO_ESPN_API,
    PHOTO_ESPN_NAME_ROSTERS,
    PHOTO_ESPN_RANKINGS,
    PHOTO_ESPN_ROSTERS,
    PHOTO_ESPN_SEARCH,
    PHOTO_ESPN_SEARCH_API,
    PHOTO_ESPN_SIZE,
    PHOTO_HOSTS,
    PHOTO_MAP_DEADLINE_S,
    PHOTO_MAP_WORKERS,
    PHOTO_MAX_BYTES,
    PHOTO_MISS_TTL_S,
    PHOTO_PIXELS_MAX,
    PHOTO_RETRY_S,
    PHOTO_ROSTER_MAX_BYTES,
    PHOTO_SIDE_MAX,
    PHOTO_TIMEOUT_S,
    PHOTO_TTL_S,
    PHOTO_TYPES,
    PHOTO_USER_AGENT,
    PHOTO_WEBP_QUALITY,
)

log = logging.getLogger(__name__)

# What asks the network: (url, most bytes) -> (body, content type), or None for any failure.
Getter = Callable[[str, int], tuple[bytes, str] | None]
Photo = tuple[bytes, str]  # the image and its content type

ESPN_SPORTS = frozenset(PHOTO_ESPN_ROSTERS) | frozenset(PHOTO_ESPN_RANKINGS) | frozenset(PHOTO_ESPN_SEARCH)
PHOTO_SPORTS = frozenset(PHOTO_BY_ID) | ESPN_SPORTS


class _NoRedirect(HTTPRedirectHandler):
    """A redirect is no photo: NHL answers a missing mug with a redirect to a silhouette, and a redirect could lead
    off the allowed hosts. urllib then raises the 3xx as an error."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201 - urllib's signature
        return None


_OPENER = build_opener(_NoRedirect)
_CHUNK = 64 * 1024


def allowed(url: str) -> bool:
    """Whether `url` is https on the default port to one of `PHOTO_HOSTS`, with no credentials in it."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    return (
        parts.scheme == "https"
        and parts.hostname in PHOTO_HOSTS
        and port in (None, 443)
        and parts.username is None
        and parts.password is None
    )


def _get(url: str, max_bytes: int = PHOTO_MAX_BYTES) -> Photo | None:
    """The body and content type of a 200 answer from an allowed host, or None: another host, a redirect, an error,
    more than `max_bytes`, or longer than `PHOTO_TIMEOUT_S` in all."""
    if not allowed(url):
        log.warning("photo request refused: %s is not an allowed host", urlsplit(url).hostname)
        return None
    request = Request(url, headers={"User-Agent": PHOTO_USER_AGENT, "Accept": "image/*,application/json;q=0.9"})
    deadline = time.monotonic() + PHOTO_TIMEOUT_S
    try:
        with _OPENER.open(request, timeout=PHOTO_TIMEOUT_S) as response:
            if response.status != 200:
                return None
            declared = response.headers.get("Content-Length", "")
            if declared.isdigit() and int(declared) > max_bytes:
                return None
            body = bytearray()
            while chunk := response.read(min(_CHUNK, max_bytes + 1 - len(body))):
                body += chunk
                if len(body) > max_bytes or time.monotonic() > deadline:
                    return None
            return bytes(body), response.headers.get_content_type()
    except Exception as error:  # noqa: BLE001 - any failure out there is "no photo", never an error in a request
        log.info("photo request failed: %s (%s)", url, error.__class__.__name__)
        return None


# Letters NFKD leaves whole, spelled the way rosters spell them.
_LETTERS = str.maketrans({"ø": "o", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "æ": "ae", "œ": "oe", "ß": "ss", "ı": "i"})
_SUFFIXES = frozenset({"jr", "sr", "ii", "iii", "iv", "v"})


def normalise(name: str) -> str:
    """A name as rosters are matched on: no accents, no case, no punctuation, no suffix.

    "Nikola Jokić" -> "nikola jokic", "Shai Gilgeous-Alexander" -> "shai gilgeous alexander",
    "P.J. Washington Jr." -> "pj washington", "De'Aaron Fox" -> "deaaron fox".
    """
    text = unicodedata.normalize("NFKD", name.lower().translate(_LETTERS))
    text = "".join(char for char in text if not unicodedata.combining(char))
    text = re.sub(r"[-‐‑–—_/]", " ", text)  # a hyphen parts two words
    text = re.sub(r"[^a-z0-9 ]", "", text)  # a dot or an apostrophe joins them
    return " ".join(word for word in text.split() if word not in _SUFFIXES)


_ESPN_HEADSHOT = re.compile(r"https://a\.espncdn\.com(/i/headshots/[a-z0-9_/-]+\.(?:png|jpg))")


def _espn_photo(headshot: Any) -> str | None:
    """An ESPN headshot ("https://a.espncdn.com/i/headshots/..." or {"href": ...}) as its resized image, or None."""
    href = headshot.get("href") if isinstance(headshot, dict) else headshot
    match = _ESPN_HEADSHOT.fullmatch(href) if isinstance(href, str) else None
    if match is None:
        return None
    width, height = PHOTO_ESPN_SIZE
    return f"https://a.espncdn.com/combiner/i?img={match[1]}&w={width}&h={height}"


_HEADSHOT_ID = re.compile(r"/i/headshots/[a-z0-9_-]+/players/full/(\d+)\.(?:png|jpg)")


def espn_id_of(url: Any) -> str | None:
    """The ESPN athlete id in a headshot url, plain or resized; None for anything else (an NHL mug has none)."""
    match = _HEADSHOT_ID.search(url) if isinstance(url, str) else None
    return match[1] if match else None


def _athlete_name(athlete: dict) -> str:
    name = athlete.get("fullName") or athlete.get("displayName")
    return name if isinstance(name, str) else ""


def _team_ids(data: Any) -> list[str]:
    """The team ids of an ESPN teams list."""
    try:
        teams = data["sports"][0]["leagues"][0]["teams"]
    except (KeyError, IndexError, TypeError):
        return []
    ids = (entry.get("team", {}).get("id") for entry in teams if isinstance(entry, dict))
    return [str(team) for team in ids if str(team).isdigit()]


def _roster_athletes(data: Any) -> list[dict]:
    """The athletes of an ESPN roster: a flat list (NBA, WNBA), or groups by position with their items (NFL)."""
    found: list[dict] = []
    for item in data.get("athletes", []) if isinstance(data, dict) else []:
        if isinstance(item, dict) and isinstance(item.get("items"), list):
            found += [athlete for athlete in item["items"] if isinstance(athlete, dict)]
        elif isinstance(item, dict):
            found.append(item)
    return found


def _ranked_athletes(data: Any) -> list[dict]:
    """The fighters of ESPN's MMA rankings, every division and pound-for-pound list."""
    found: list[dict] = []
    for ranking in data.get("rankings", []) if isinstance(data, dict) else []:
        for rank in ranking.get("ranks", []) if isinstance(ranking, dict) else []:
            athlete = rank.get("athlete") if isinstance(rank, dict) else None
            if isinstance(athlete, dict):
                found.append(athlete)
    return found


def _position(athlete: dict) -> str:
    """The athlete's position as ESPN abbreviates it ("QB", "WR", "PG"), or ""."""
    position = athlete.get("position")
    abbreviation = position.get("abbreviation") if isinstance(position, dict) else None
    return abbreviation if isinstance(abbreviation, str) else ""


MAP_VERSION = 3  # the layout of a map on disk; one of another version is built again (1 had no positions, 2 no namesakes without a photo)
Seen = dict[str, list[tuple[str, str]]]  # normalised name -> (position, photo url or "") of each athlete found by it


def _add(seen: Seen, athletes: list[dict]) -> None:
    """Notes each athlete's position and photo under their normalised name. An athlete with no headshot is noted too,
    with no url: he has no face to give, but he is a person, and a name he shares is not unique."""
    for athlete in athletes:
        key = normalise(_athlete_name(athlete))
        if key:
            seen.setdefault(key, []).append((_position(athlete), _espn_photo(athlete.get("headshot")) or ""))


def _settle(seen: Seen) -> dict[str, Any]:
    """The map of names to photos: a url; or, for a name two different athletes share, the url of each position that
    only one of them plays (the page knows a pass's position), or None when none can be told apart. A name whose
    athletes have no photo at all is there too, as None: it is taken. A wrong face is worse than initials, so a guess
    is never made."""
    players: dict[str, Any] = {}
    for key, found in seen.items():
        urls = {url for _, url in found}
        if len(urls) == 1:  # one athlete (or one listed on two teams): his photo, or none
            players[key] = found[0][1] or None
            continue
        by_position: dict[str, set[str]] = {}
        for position, url in found:
            if position:
                by_position.setdefault(position, set()).add(url)
        told_apart = {position: next(iter(urls)) for position, urls in by_position.items() if len(urls) == 1}
        players[key] = {position: url for position, url in told_apart.items() if url} or None
    return players


# Which way names are matched. A miss kept by an older way (before "N. Jokić" matched "Nikola Jokić") is asked again
# at once instead of hiding a photo for another day.
MATCHER = 2


def _by_initial(players: dict[str, Any], key: str) -> Any:
    """The photo of an initial and a surname ("n jokic", as the live feed writes "N. Jokić"): the entry of the only
    roster name with that first letter and exactly that surname; None when there is none or more than one, as a wrong
    face is worse than initials."""
    words = key.split()
    if len(words) < 2 or len(words[0]) != 1:
        return None
    initial, surname = words[0], words[1:]
    matches = [k for k in players if (w := k.split()) and w[0].startswith(initial) and len(w[0]) > 1 and w[1:] == surname]
    return players[matches[0]] if len(matches) == 1 else None


_SIGNATURES = {"image/png": (b"\x89PNG\r\n\x1a\n",), "image/jpeg": (b"\xff\xd8\xff",), "image/webp": (b"RIFF",)}


def _image(got: Photo | None) -> Photo | None:
    """`got` if it is an image of an allowed type whose bytes say the same; else None."""
    if got is None:
        return None
    body, content_type = got
    if content_type not in PHOTO_TYPES or not body.startswith(_SIGNATURES[content_type]):
        return None
    if content_type == "image/webp" and body[8:12] != b"WEBP":
        return None
    return body, content_type


def shrink(photo: Photo) -> Photo:
    """`photo` no bigger than PHOTO_SIDE_MAX on its short side, as a WebP (transparency kept), when that is smaller;
    else `photo` as it came. A WebP, an image claiming more than PHOTO_PIXELS_MAX pixels (never decoded) or bytes no
    decoder reads are kept as they came too. Never raises."""
    body, content_type = photo
    if content_type == "image/webp":
        return photo
    try:
        with Image.open(io.BytesIO(body), formats=("PNG", "JPEG")) as image:
            width, height = image.size
            if width < 1 or height < 1 or width * height > PHOTO_PIXELS_MAX:
                return photo
            image.load()
            alpha = image.mode in ("RGBA", "LA", "PA") or "transparency" in image.info
            picture = image.convert("RGBA" if alpha else "RGB")
        short = min(width, height)
        if short > PHOTO_SIDE_MAX:
            size = (max(1, round(width * PHOTO_SIDE_MAX / short)), max(1, round(height * PHOTO_SIDE_MAX / short)))
            picture = picture.resize(size, Image.Resampling.LANCZOS)
        out = io.BytesIO()
        picture.save(out, "WEBP", quality=PHOTO_WEBP_QUALITY, alpha_quality=PHOTO_WEBP_QUALITY, method=6)
    except Exception:  # noqa: BLE001 - a photo that cannot be re-encoded is served as it came
        return photo
    small = out.getvalue()
    return (small, "image/webp") if len(small) < len(body) else photo


def _write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(handle, "wb") as file:
            file.write(data)
        os.replace(temp, path)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise


def _read_json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_bytes())
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


class PhotoStore:
    """Player photos kept under `root`: `root/<sport>/<id>.img` with its `.json` record, and each name-matched
    sport's map in `root/maps/<sport>.json`.

    `get` asks the network (`_get` by default; a test passes a fake). `ids_are_real` False is for players whose ids are
    invented (the demo): no id is ever turned into a photo url, so every sport with a public name source is matched
    by name, MLB and NHL included. Use a root of its own for it, so invented ids never mix with real ones.
    Thread-safe: one fetch per player at a time, one map build per sport at a time, and a request never waits for a
    map another one is building.
    """

    def __init__(
        self, root: Path, get: Getter = _get, clock: Callable[[], float] = time.time, ids_are_real: bool = True
    ):
        self._root = root
        self._get = get
        self._clock = clock
        self.ids_are_real = ids_are_real
        # MLB and NHL rosters are read too, by name: a photo there still comes from the id (see `_source`), but the
        # injury list needs the ESPN athlete of a name (`espn_id`).
        self._rosters = PHOTO_ESPN_ROSTERS | PHOTO_ESPN_NAME_ROSTERS
        self._named = frozenset(self._rosters) | frozenset(PHOTO_ESPN_RANKINGS)  # the sports matched by name
        self._lock = threading.Lock()
        self._maps: dict[str, tuple[float, dict[str, Any] | None]] = {}  # sport -> (expires, players)
        self._building = {sport: threading.Lock() for sport in self._named}
        self._stripes = [threading.Lock() for _ in range(64)]  # one fetch per player: their stripe's lock

    # --- where a photo comes from ---------------------------------------------------------------------------------

    def resolve(self, sport: str, player_id: int, name: str, position: str | None = None) -> str | None:
        """The public source url of the player's photo, or None: a sport without one, or no match. `position` (as
        ESPN abbreviates it, when the page knows it) tells apart two athletes of one name."""
        try:
            return self._source(sport, player_id, name, position)[1]
        except Exception:  # noqa: BLE001 - never into a request
            log.exception("photo source failed for %s %s", sport, player_id)
            return None

    def _source(self, sport: str, player_id: int, name: str, position: str | None = None) -> tuple[bool, str | None]:
        """(settled, url): settled is False while the sport's map is not there yet, so "no url" is not an answer
        worth remembering."""
        if self.ids_are_real and sport in PHOTO_BY_ID:
            return True, PHOTO_BY_ID[sport].format(id=int(player_id))
        if sport in PHOTO_ESPN_SEARCH:
            return self._searched(sport, name)
        if sport in self._named:
            players = self._players(sport)
            if players is None:
                return False, None
            key = normalise(name)
            found = players.get(key)
            if found is None and key not in players:
                found = _by_initial(players, key)
            if isinstance(found, dict):  # a name two athletes share: only the position can tell
                found = found.get(position or "")
            return True, found if isinstance(found, str) else None
        return True, None

    def _map_now(self, sport: str) -> dict[str, Any] | None:
        """The sport's map as it stands, however old, from memory or from disk: never the network, never a build."""
        with self._lock:
            entry = self._maps.get(sport)
        if entry is None:
            entry = self._read_map(sport)
            if entry is not None:
                with self._lock:
                    entry = self._maps.setdefault(sport, entry)
        return entry[1] if entry else None

    def has_map(self, sport: str) -> bool:
        """Whether the sport has a name-to-athlete map to join on right now (see `espn_id`)."""
        return sport in self._rosters and self._map_now(sport) is not None

    def espn_id(self, sport: str, name: str, position: str | None = None) -> str | None:
        """The ESPN athlete id of a player of an ESPN-rostered sport (NBA, WNBA, NFL), read from the sport's map as it
        stands, however old and whether in memory or on disk: this never asks the network and never builds a map, so
        a snapshot can ask it for a hundred players. The id is the one in the athlete's headshot, which ESPN's injury
        list carries too. None: another sport, no map yet, no such name, no headshot, or a name two athletes share
        that `position` does not tell apart (a guess is never made)."""
        if sport not in self._rosters:
            return None
        players = self._map_now(sport)
        if players is None:
            return None
        key = normalise(name)
        found = players.get(key)
        if found is None and key not in players:
            found = _by_initial(players, key)
        if isinstance(found, dict):  # a name two athletes share: only the position can tell
            found = found.get(position or "")
        return espn_id_of(found)

    def _searched(self, sport: str, name: str) -> tuple[bool, str | None]:
        """(settled, url) from ESPN's player search, in the sport's leagues one after the other: the first league with
        any athlete of that name decides, and only when exactly one fits (with a photo or without: one without still
        makes a name ambiguous). A full name is asked as it is; an initial and a surname ("J. White") only in the
        sport's own league, and only when every page of the answer was read. Not settled when a search could not be
        read, so the miss is not kept."""
        key = normalise(name)
        words = key.split()
        if len(words) < 2:
            return True, None
        initial = len(words[0]) == 1
        query = " ".join(words[1:]) if initial else key
        leagues = PHOTO_ESPN_SEARCH[sport][:1] if initial else PHOTO_ESPN_SEARCH[sport]
        for league in leagues:
            data = self._json(f"{PHOTO_ESPN_SEARCH_API}?query={quote(query)}&limit=25&type=player&league={league}")
            if not isinstance(data, dict) or not isinstance(data.get("items"), list):
                return False, None
            athletes = [(normalise(_athlete_name(item)), _espn_photo(item.get("headshot")))
                        for item in data["items"] if isinstance(item, dict) and item.get("league") == league]
            if initial:
                pages = data.get("pageCount")
                if not (isinstance(pages, int) and pages <= 1):
                    return True, None
                fits = [url for found, url in athletes
                        if (w := found.split()) and len(w[0]) > 1 and w[0].startswith(words[0]) and w[1:] == words[1:]]
            else:
                fits = [url for found, url in athletes if found == key]
            if fits:
                return True, fits[0] if len(fits) == 1 else None
        return True, None

    def _players(self, sport: str) -> dict[str, Any] | None:
        """The sport's map of normalised names to photos, built from ESPN when missing or older than PHOTO_TTL_S;
        None while there is none to read (being built by another request, or not readable)."""
        now = self._clock()
        with self._lock:
            entry = self._maps.get(sport)
        if entry is None:
            entry = self._read_map(sport)
            if entry is not None:
                with self._lock:
                    entry = self._maps.setdefault(sport, entry)
        if entry is not None and entry[0] > now:
            return entry[1]
        building = self._building[sport]
        if not building.acquire(blocking=False):  # another request is building it: make do with the old one
            return entry[1] if entry else None
        try:
            with self._lock:
                latest = self._maps.get(sport)
            if latest is not None and latest[0] > now:  # built while this request was on its way
                return latest[1]
            built = self._build_map(sport)
            if built is None:
                players = entry[1] if entry else None
                expires = now + (PHOTO_MISS_TTL_S if players is not None else PHOTO_RETRY_S)
            else:
                players, complete = built
                expires = now + (PHOTO_TTL_S if complete else PHOTO_MISS_TTL_S)
            with self._lock:
                self._maps[sport] = (expires, players)
            self._write_map(sport, expires, players)
            return players
        finally:
            building.release()

    def _json(self, url: str) -> Any:
        got = self._get(url, PHOTO_ROSTER_MAX_BYTES)
        if got is None:
            return None
        try:
            return json.loads(got[0])
        except ValueError:
            return None

    def _build_map(self, sport: str) -> tuple[dict[str, Any], bool] | None:
        """(players, complete) read from ESPN, or None when nothing could be read."""
        seen: Seen = {}
        if sport in PHOTO_ESPN_RANKINGS:
            data = self._json(f"{PHOTO_ESPN_API}{PHOTO_ESPN_RANKINGS[sport]}/rankings")
            if data is None:
                return None
            _add(seen, _ranked_athletes(data))
            return _settle(seen), True
        path = self._rosters[sport]
        teams = _team_ids(self._json(f"{PHOTO_ESPN_API}{path}/teams"))
        if not teams:
            return None
        deadline = time.monotonic() + PHOTO_MAP_DEADLINE_S
        read = 0
        pool = ThreadPoolExecutor(max_workers=PHOTO_MAP_WORKERS, thread_name_prefix=f"photos-{sport}")
        try:
            rosters = [pool.submit(self._json, f"{PHOTO_ESPN_API}{path}/teams/{team}/roster") for team in teams]
            for roster in rosters:  # in team order, so a name two teams share is judged the same way every time
                data = roster.result(timeout=max(0.0, deadline - time.monotonic()))
                if data is not None:
                    read += 1
                    _add(seen, _roster_athletes(data))
        except TimeoutError:  # past the deadline: what was read so far, rebuilt sooner
            pass
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
        if read == 0:
            return None
        return _settle(seen), read == len(teams)

    def warm(self) -> None:
        """Build every name-matched sport's map that is missing or old, so no visitor waits for one (a server's
        start runs this in the background)."""
        for sport in sorted(self._named):
            try:
                self._players(sport)
            except Exception:  # noqa: BLE001 - a map that cannot be built is built on demand later
                log.exception("photo map for %s not built", sport)

    def _read_map(self, sport: str) -> tuple[float, dict[str, Any] | None] | None:
        data = _read_json(self._root / "maps" / f"{sport}.json")
        if data is None or data.get("version") != MAP_VERSION or not isinstance(data.get("expires"), (int, float)):
            return None
        players = data.get("players")
        return float(data["expires"]), players if isinstance(players, dict) else None

    def _write_map(self, sport: str, expires: float, players: dict[str, Any] | None) -> None:
        try:
            body = json.dumps({"version": MAP_VERSION, "expires": expires, "players": players}, ensure_ascii=False).encode()
            _write_atomic(self._root / "maps" / f"{sport}.json", body)
        except OSError:
            log.warning("photo map for %s not saved", sport, exc_info=True)

    # --- the photo itself -----------------------------------------------------------------------------------------

    def fetch(self, sport: str, player_id: int, name: str | None = None, position: str | None = None) -> Photo | None:
        """The player's photo and its content type, or None: `lookup` without the word on whether None is settled."""
        return self.lookup(sport, player_id, name, position)[0]

    def lookup(
        self, sport: str, player_id: int, name: str | None = None, position: str | None = None
    ) -> tuple[Photo | None, bool]:
        """(photo, settled): the player's photo and its content type, or None; `settled` is False when None only means
        the sport's name map is not there yet (a fresh server), so the answer is not worth remembering.
        `position` is the player's, when the page knows it.

        Kept on disk: a photo for PHOTO_TTL_S, a player found without one for PHOTO_MISS_TTL_S. `name` None means
        the player is not one the site shows right now: only what is on disk answers, and nothing is asked.
        """
        if sport not in PHOTO_SPORTS or isinstance(player_id, bool) or not isinstance(player_id, int) or player_id < 0:
            return None, True
        try:
            with self._stripes[hash((sport, player_id)) % len(self._stripes)]:
                return self._fetch(sport, player_id, name, position)
        except Exception:  # noqa: BLE001 - never into a request
            log.exception("photo fetch failed for %s %s", sport, player_id)
            return None, False

    def _fetch(self, sport: str, player_id: int, name: str | None, position: str | None) -> tuple[Photo | None, bool]:
        now = self._clock()
        # A photo found by name is kept with the name it was found for: under the same id, another name (the demo's
        # fixture was regenerated) is another player, and the old face must not follow the id.
        who = normalise(name) if name is not None and (sport in self._named or sport in PHOTO_ESPN_SEARCH) else None
        record, kept = self._read_photo(sport, player_id, who)
        if record is not None and record.get("miss") and record.get("matcher") != MATCHER:
            record = None  # a miss of an older matcher: ask again
        if name is None or (record is not None and record["expires"] > now):
            return self._kept_small(sport, player_id, record, kept, who), True
        settled, url = self._source(sport, player_id, name, position)
        image = _image(self._get(url, PHOTO_MAX_BYTES)) if url else None
        if image is not None:
            image = shrink(image)
            self._write_photo(sport, player_id, image, now + PHOTO_TTL_S, who)
            return image, True
        if not settled:
            return kept, kept is not None
        if kept is not None:  # no fresher one: keep the one there is, and ask again after a day
            self._write_record(sport, player_id, {"type": kept[1], "expires": now + PHOTO_MISS_TTL_S}, who)
            return kept, True
        self._write_record(sport, player_id, {"miss": True, "expires": now + PHOTO_MISS_TTL_S, "matcher": MATCHER}, who)
        return None, True

    def _kept_small(self, sport: str, player_id: int, record: dict | None, kept: Photo | None, who: str | None) -> Photo | None:
        """A photo an older server kept as it came, made small once (`shrink`) and kept so, with the same expiry; the
        record then says `small`, so one that cannot be made smaller is not tried again on every request."""
        if record is None or kept is None or record.get("small"):
            return kept
        image = shrink(kept)
        if image is not kept:
            try:
                _write_atomic(self._paths(sport, player_id)[1], image[0])
            except OSError:
                log.warning("photo of %s %s not saved", sport, player_id, exc_info=True)
                return kept
        self._write_record(sport, player_id, {"type": image[1], "expires": record["expires"], "small": True}, who)
        return image

    def _paths(self, sport: str, player_id: int) -> tuple[Path, Path]:
        folder = self._root / sport
        return folder / f"{player_id}.json", folder / f"{player_id}.img"

    def _read_photo(self, sport: str, player_id: int, who: str | None = None) -> tuple[dict | None, Photo | None]:
        """The player's record on disk (None without one, or one made for another name than `who`), and the photo it
        keeps (None for a miss)."""
        record_path, image_path = self._paths(sport, player_id)
        record = _read_json(record_path)
        if record is None or not isinstance(record.get("expires"), (int, float)):
            return None, None
        if who is not None and record.get("name", who) != who:
            return None, None
        content_type = record.get("type")
        if record.get("miss") or content_type not in PHOTO_TYPES:
            return record, None
        try:
            kept = _image((image_path.read_bytes(), content_type))
        except OSError:
            return None, None
        return (record, kept) if kept is not None else (None, None)

    def _write_photo(self, sport: str, player_id: int, image: Photo, expires: float, who: str | None = None) -> None:
        try:
            _write_atomic(self._paths(sport, player_id)[1], image[0])
        except OSError:
            log.warning("photo of %s %s not saved", sport, player_id, exc_info=True)
            return
        self._write_record(sport, player_id, {"type": image[1], "expires": expires, "small": True}, who)

    def _write_record(self, sport: str, player_id: int, record: dict, who: str | None = None) -> None:
        if who is not None:
            record = {**record, "name": who}
        try:
            _write_atomic(self._paths(sport, player_id)[0], json.dumps(record).encode())
        except OSError:
            log.warning("photo record of %s %s not saved", sport, player_id, exc_info=True)
