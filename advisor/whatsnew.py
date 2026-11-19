"""The site's "What's new", read from one small versioned file (advisor/whatsnew.json) and announced in #announcements
by the Discord poster, once per entry.

The file is a JSON list; each entry is {"id", "date", "title", "body", "link"?, "announce"?}:

- `id`: a short unique slug (lower case, digits, dashes). It is what makes an update announced once, never twice: the
  poster remembers the ids it announced, and also looks for the id in the channel's recent posts, so a wiped disk does
  not announce it again.
- `date`: the day it went live (YYYY-MM-DD, UTC). An entry dated after today waits for its day.
- `title` (80 characters at most) and `body` (600 at most): plain, short and friendly, in English.
- `link`: optional, a path on the site ("/", "/#passes"), shown as the post's link.
- `announce`: optional, true to announce an entry that is not newer than the poster's first run.

QUIET FIRST RUN: the first time the poster ever runs (nothing remembered) it notes that day as its start date, and
announces only entries dated after it or flagged `announce: true`; every older entry is marked as seen without a post,
so a new server (or a new poster) never dumps the whole history into the channel.

An entry that does not check out is left out of the list and said once in the log; the rest still go.
"""

import json
import logging
import re
from datetime import date
from pathlib import Path

log = logging.getLogger(__name__)

PATH = Path(__file__).with_name("whatsnew.json")
ID = re.compile(r"[a-z0-9][a-z0-9-]{2,63}")
TITLE_MAX, BODY_MAX = 80, 600
FOOTER = "What's new"  # the post's footer reads "What's new · <id>": the id is the marker the channel scan looks for
COLOR = 0xFF7A1A
_LINK = re.compile(r"/[A-Za-z0-9#/_?=&.-]{0,100}")
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def _day(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value).isoformat() if len(value) == 10 else None
    except ValueError:
        return None


def _entry(raw: object) -> dict | None:
    if not isinstance(raw, dict):
        return None
    ident, day, title, body = raw.get("id"), _day(raw.get("date")), raw.get("title"), raw.get("body")
    if not (isinstance(ident, str) and ID.fullmatch(ident) and day and isinstance(title, str) and isinstance(body, str)):
        return None
    title, body = _CONTROL.sub("", title).strip(), _CONTROL.sub("", body).strip()
    if not title or not body or len(title) > TITLE_MAX or len(body) > BODY_MAX:
        return None
    link = raw.get("link")
    if link is not None and not (isinstance(link, str) and _LINK.fullmatch(link)):
        return None
    announce = raw.get("announce")
    if announce is not None and not isinstance(announce, bool):
        return None
    return {"id": ident, "date": day, "title": title, "body": body, "link": link, "announce": announce is True}


def load(path: Path = PATH) -> list[dict]:
    """The valid entries, oldest first (by date, then id); an id seen twice keeps its first entry. A file that cannot
    be read gives an empty list, said in the log."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        log.warning("What's new: %s could not be read (%s)", path.name, type(error).__name__)
        return []
    if not isinstance(raw, list):
        log.warning("What's new: %s must hold a list", path.name)
        return []
    found: dict[str, dict] = {}
    for n, item in enumerate(raw):
        entry = _entry(item)
        if entry is None:
            log.warning("What's new: entry %d of %s does not fit and is left out", n + 1, path.name)
        elif entry["id"] not in found:
            found[entry["id"]] = entry
    return sorted(found.values(), key=lambda e: (e["date"], e["id"]))


def split(entries: list[dict], seen: set[str], started_day: str, today: str) -> tuple[list[dict], list[dict]]:
    """(to announce, to mark seen quietly) among the entries not seen yet, oldest first: an entry dated after today
    waits; one flagged `announce` or dated after `started_day` (the poster's first day) is announced; the others are
    older than the poster and only noted."""
    post, quiet = [], []
    for entry in entries:
        if entry["id"] in seen or entry["date"] > today:
            continue
        (post if entry["announce"] or entry["date"] > started_day else quiet).append(entry)
    return post, quiet


def message(entry: dict, public_url: str) -> dict:
    """The announcement: one embed (the title, the text, the link when there is one), nobody mentioned."""
    embed = {"title": entry["title"], "description": entry["body"], "color": COLOR,
             "footer": {"text": f"{FOOTER} · {entry['id']}"}}
    if entry["link"]:
        embed["url"] = public_url + entry["link"]
    return {"embeds": [embed], "allowed_mentions": {"parse": []}}
