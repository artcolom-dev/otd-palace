"""Posts in our Discord server: the best new deals in #live-deals, and the day's pass picks in #otd-picks.

It runs with the Discord gate's settings (the bot's token, our server's id and the site's address, see
`advisor.discord_gate`) and stays off without them, with ADVISOR_DISCORD_POST=0, or on sample data. A thread
(`run_poster`) looks at the snapshot store every DISCORD_POST_CHECK_S seconds and hands each new snapshot to
`Poster.round`, which never raises: the market goes on whatever Discord does.

Which deals: what the safest level of the site (New) shows (a target price, a high-confidence usual price at least 25 %
above it, a market that is not falling), that also resells at its usual price for a profit once Real's 10 % and the
10-rax listing fee are paid, on a usual price of at least AFTER_FEES_MIN_REF (under it the fees eat the margin), with no
injury note at all, its listing read within DISCORD_MAX_READ_AGE_S and at least DISCORD_MIN_LEFT_S left. The biggest
discount goes first. Each listing is posted once ever: the listings posted (with their message, so a deal that goes
away gets "Gone" on its post) are kept in discord-posts.json of the data directory, with the times of the last posts
and pings and the day of the last pass post, so a restart neither posts again nor resets a cap. At most
DISCORD_DEALS_PER_ROUND go out from one snapshot (so a first round after a start posts the best few, never the whole
list), DISCORD_DEALS_PER_HOUR in any hour and DISCORD_DEALS_PER_DAY in any 24 hours.

The Deal Alerts role is pinged, with that role alone allowed to be mentioned, for an exceptional deal only: at least
DISCORD_PING_MIN_DISCOUNT under and DISCORD_PING_MIN_MARGIN rax of profit after fees, never slow to resell, at most
DISCORD_PINGS_PER_DAY in any 24 hours. Every other post allows no mention at all.

The pass picks: once a day from DISCORD_OTD_HOUR_UTC (UTC), or later the same afternoon after a restart, never twice
the same day: the best passes the site picks (at least DISCORD_OTD_MIN_PICKS, or no post) (its per-sport picks, ranked across sports by their best rung's rax a year
per rax spent), at most DISCORD_OTD_PER_SPORT of a sport, in one embed. Not on stale data, nor on pass figures
measured more than DISCORD_OTD_MAX_AGE_H ago: the post then waits for fresh ones within its window.

No player floods #live-deals: at most DISCORD_PLAYER_PER_DAY posts about one player in any 24 hours, and the same
card at the same price (a seller listing it again) is never posted twice in that time. A deal held back by either is
not marked posted: it goes out later if it is still open when the player's day has room.

Three more posts, each once, kept in the same file (and looked for in the channel's last posts before sending, so a wiped
disk never sends one twice):
- "What's new" in #announcements: each entry of advisor/whatsnew.json, quiet on the first run (see `advisor.whatsnew`).
- "This week in the market" in #market-talk, Mondays from DISCORD_DIGEST_HOUR_UTC, never on stale data (see
  `advisor.discord_digest`).
- A season-clock heads-up in #market-talk, DISCORD_SEASON_ALERT_DAYS days before a dated event (advisor/season_clock.py).

Channels and the role are found by name through the bot (#live-deals, #otd-picks, #announcements, #market-talk,
"Deal Alerts") once, unless ADVISOR_DISCORD_DEALS_CHANNEL, ADVISOR_DISCORD_OTD_CHANNEL, ADVISOR_DISCORD_ANNOUNCE_CHANNEL,
ADVISOR_DISCORD_TALK_CHANNEL or ADVISOR_DISCORD_ALERTS_ROLE name their ids. When Discord
says to wait (429) the poster waits retry_after; when it does not answer (a timeout, a 5xx) it waits DISCORD_BACKOFF_S,
doubled each time, up to DISCORD_BACKOFF_CAP_S; a channel it may not post in or that is gone (403, 404) is dropped until
the next restart, said once in the log; a refused token (401) turns the poster off until then. Nothing here logs the
token or what Discord said beyond its HTTP status and error code.

    uv run python -m advisor.discord_post --dry-run snapshot.json    # the posts it would make, as JSON; no network
"""

import argparse
import hashlib
import json
import logging
import math
import os
import re
import sys
import tempfile
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from advisor.discord_gate import (
    _OPENER,
    API,
    USER_AGENT_VERSION,
    Transport,
    _url_transport,
)
from advisor.discord_gate import config_from_env as gate_config_from_env
from advisor import season_clock, whatsnew
from advisor.push import fits
from advisor.rules import (
    AFTER_FEES_MIN_REF,
    DISCORD_ANNOUNCE_SCAN,
    DISCORD_BACKOFF_CAP_S,
    DISCORD_BACKOFF_S,
    DISCORD_DEALS_PER_DAY,
    DISCORD_DEALS_PER_HOUR,
    DISCORD_DEALS_PER_ROUND,
    DISCORD_GONE_EDIT_H,
    DISCORD_GONE_EDITS_PER_ROUND,
    DISCORD_MAX_READ_AGE_S,
    DISCORD_MIN_LEFT_S,
    DISCORD_OTD_HOUR_UTC,
    DISCORD_OTD_LATE_H,
    DISCORD_OTD_MAX_AGE_H,
    DISCORD_OTD_MIN_PICKS,
    DISCORD_OTD_PER_SPORT,
    DISCORD_OTD_PICKS,
    DISCORD_PING_MIN_DISCOUNT,
    DISCORD_PING_MIN_MARGIN,
    DISCORD_PINGS_PER_DAY,
    DISCORD_PLAYER_PER_DAY,
    DISCORD_POST_CHECK_S,
    DISCORD_POSTED_KEPT,
    DISCORD_RETRY_AFTER_CAP_S,
    DISCORD_SEASON_ALERT_DAYS,
    DISCORD_WHATSNEW_PER_ROUND,
    RESALE_MIN_LISTED,
)
from advisor.share import (
    GONE_WORDS,
    PLAIN_NAME,
    _season,
    valid_deal,
)
from advisor.real import RARITY_COLORS, RARITY_EMOJI, RARITY_NAMES, rarity_index, sport_label

log = logging.getLogger(__name__)

SWITCH_ENV = "ADVISOR_DISCORD_POST"  # "0" turns the posts off
DEALS, OTD, ANNOUNCE, TALK = "deals", "otd", "announce", "talk"
CHANNEL_ENV = {DEALS: "ADVISOR_DISCORD_DEALS_CHANNEL", OTD: "ADVISOR_DISCORD_OTD_CHANNEL",
               ANNOUNCE: "ADVISOR_DISCORD_ANNOUNCE_CHANNEL", TALK: "ADVISOR_DISCORD_TALK_CHANNEL"}
ROLE_ENV = "ADVISOR_DISCORD_ALERTS_ROLE"
CHANNEL_NAMES = {DEALS: "live-deals", OTD: "otd-picks", ANNOUNCE: "announcements", TALK: "market-talk"}
KEPT_IDS = 300  # "What's new" ids and season-clock events remembered as sent (the files hold a few dozen)
ROLE_NAME = "deal alerts"  # compared without case
TEXT_CHANNELS = frozenset({0, 5})  # a text channel, or an announcement channel
FOOTER = "Prices move fast. Check before you buy."
OTD_FOOTER = ("Yearly figures assume you claim every claim day. Cheaper with offers: offer under the usual price on many "
              "cards; most are refused, the accepted ones are the cheapest rating. Offers need Real Pro. Based on today's "
              "prices. Check before you buy.")
GONE_COLOR = 0x6B6A73
OTD_COLOR = 0x3FB68B
# The share of recent listings that sold for the site's two resale tags (frontend/src/lib/resale.ts says the same).
RESALE_WELL, RESALE_SLOW = 0.6, 0.25
NAME_MAX_CHARS = 80
HOUR, DAY = 3600, 86400
# Discord's error codes told apart: the message is gone (deleted by hand), not the channel.
_UNKNOWN_MESSAGE = 10008

_SNOWFLAKE = re.compile(r"\d{15,21}")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_MARKDOWN = re.compile(r"([\\*_~`|>\[\]()])")
_DECORATION = re.compile(r"^[^a-z0-9]+")


# --- settings -------------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class PostConfig:
    """What the poster needs: the bot's token (left out of the repr), our server, the site's address, and the ids
    the settings may name instead of a lookup by name."""

    bot_token: str = field(repr=False)
    guild_id: str
    public_url: str
    deals_channel: str | None = None
    otd_channel: str | None = None
    alerts_role: str | None = None
    announce_channel: str | None = None
    talk_channel: str | None = None


def _snowflake(env, name: str) -> str | None:
    value = (env.get(name) or "").strip()
    if not value:
        return None
    if not _SNOWFLAKE.fullmatch(value):
        log.warning("%s is not a Discord id (a number of 15 to 21 digits); it is looked up by name instead", name)
        return None
    return value


def config_from_env(env) -> PostConfig | None:
    """The poster's settings: the gate's, when they are all set, and ADVISOR_DISCORD_POST is not "0"; else None.

    Settings the gate refuses raise its ValueError: the server stops on them before it gets here."""
    if (env.get(SWITCH_ENV) or "").strip() == "0":
        return None
    gate = gate_config_from_env(env)
    if gate is None:
        return None
    return PostConfig(
        bot_token=gate.bot_token, guild_id=gate.guild_id, public_url=gate.public_url,
        deals_channel=_snowflake(env, CHANNEL_ENV[DEALS]), otd_channel=_snowflake(env, CHANNEL_ENV[OTD]),
        alerts_role=_snowflake(env, ROLE_ENV),
        announce_channel=_snowflake(env, CHANNEL_ENV[ANNOUNCE]), talk_channel=_snowflake(env, CHANNEL_ENV[TALK]),
    )


# --- which deals ----------------------------------------------------------------------------------------------------


def _time(value: object) -> float | None:
    """An ISO time with its zone in Unix seconds, or None."""
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment.timestamp() if moment.tzinfo is not None else None


def _number(value: object) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def _is_demo(snapshot: dict) -> bool:
    rules = snapshot.get("rules")
    return not isinstance(rules, dict) or rules.get("demo") is not False


def resale_tag(resale: object) -> str | None:
    """The site's resale words for a deal's counts: "Resells well" (6 in 10 or more sold), "Slow to resell" (1 in 4 or
    fewer), or None in between, on too few listings or on anything that is not a clean count."""
    if not isinstance(resale, dict):
        return None
    listed, sold = resale.get("listed"), resale.get("sold")
    if type(listed) is not int or type(sold) is not int or listed < RESALE_MIN_LISTED or not 0 <= sold <= listed:
        return None
    share = sold / listed
    return "Resells well" if share >= RESALE_WELL else "Slow to resell" if share <= RESALE_SLOW else None


def postable(row: object, now_s: float) -> bool:
    """Whether a deal row is one to post: see the module's docstring."""
    if not valid_deal(row) or not _number(row.get("flip_margin")) or not isinstance(row.get("confidence"), str):
        return False
    ends = _time(row.get("ends_at"))
    if ends is None or ends - now_s < DISCORD_MIN_LEFT_S:
        return False
    seen = row.get("seen_at")
    if seen is not None and (_time(seen) is None or now_s - _time(seen) > DISCORD_MAX_READ_AGE_S):
        return False
    if row.get("injury") is not None:  # any note, not only "out": a usual price from before it may not hold
        return False
    if row["flip_margin"] <= 0 or row["reference"] < AFTER_FEES_MIN_REF:
        return False
    # The safest level's own filter, as the alerts and the page apply it.
    return fits(row, {"level": "new", "budget": None}, datetime.fromtimestamp(now_s, timezone.utc))


def exceptional(row: dict) -> bool:
    """Whether a postable deal is worth pinging the Deal Alerts role for."""
    return (
        row["discount"] >= DISCORD_PING_MIN_DISCOUNT
        and row["flip_margin"] >= DISCORD_PING_MIN_MARGIN
        and resale_tag(row.get("resale")) != "Slow to resell"
    )


def pick_deals(snapshot: dict, now_s: float) -> list[dict]:
    """The deals worth posting from a snapshot, best first (the biggest discount, then the biggest profit, then the
    lower listing id), one row per listing; none from sample data."""
    if not isinstance(snapshot, dict) or _is_demo(snapshot):
        return []
    rows = snapshot.get("deals")
    best: dict[int, dict] = {}
    for row in rows if isinstance(rows, list) else ():
        if postable(row, now_s):
            have = best.get(row["listing_id"])
            if have is None or row["discount"] > have["discount"]:
                best[row["listing_id"]] = row
    return sorted(best.values(), key=lambda row: (-row["discount"], -row["flip_margin"], row["listing_id"]))


# --- the posts ------------------------------------------------------------------------------------------------------


def _plain(value: object, limit: int = NAME_MAX_CHARS) -> str:
    """Text from the data as Discord shows it: control characters out, cut, and Markdown escaped."""
    text = _CONTROL.sub("", value if isinstance(value, str) else "").strip()[:limit]
    return _MARKDOWN.sub(r"\\\1", text)


def _rax(amount: float) -> str:
    return f"{round(amount):,} Rax"


def _pct(share: float) -> str:
    return f"{int(share * 100 + 0.5)}%"


def _sport(sport: object) -> str:
    sport = _CONTROL.sub("", sport if isinstance(sport, str) else "")[:16]
    return sport_label(sport) if sport else ""


def _photo(row: dict, public_url: str, photo_sports) -> str | None:
    """The player's photo through our own proxy, when the site is on https and has photos of that sport."""
    sport = row["sport"]
    if not public_url.startswith("https://") or not PLAIN_NAME.fullmatch(sport) or sport not in photo_sports:
        return None
    return f"{public_url}/img/players/{sport}/{row['player_id']}"


def deal_message(row: dict, public_url: str, photo_sports, role: str | None = None, gone: str | None = None) -> dict:
    """The message for one deal: one embed (who, the card, price, usual price, how far under, the profit after fees,
    the resale words when there are some, a link to its page on the site), the role's mention when `role` is given,
    and only that role allowed to be mentioned. `gone`, a reason of the gone rows, makes it the post of a deal that
    went away: grey, "Gone" in front, and why."""
    name = _plain(row["player_name"]) or "A player"
    meta = (f"{_sport(row['sport'])} {_season(row)} · {row['rating']:.1f} rating · "
            f"{RARITY_EMOJI[row['rarity']]} {RARITY_NAMES[row['rarity']]}")
    unit = "" if row["kind"] == "target" else " top bid"
    fields = [
        {"name": "Price", "value": _rax(row["price"]) + unit, "inline": True},
        {"name": "Usual price", "value": _rax(row["reference"]), "inline": True},
        {"name": "Under", "value": _pct(row["discount"]), "inline": True},
        {"name": "Profit after fees", "value": f"{row['flip_margin']:+,} Rax", "inline": True},
    ]
    tag = resale_tag(row.get("resale"))
    if tag is not None:
        fields.append({"name": "Resale", "value": tag, "inline": True})
    embed = {
        "title": f"{name} · {_pct(row['discount'])} under",
        "url": f"{public_url}/d/{row['listing_id']}",
        "description": meta,
        "color": int(RARITY_COLORS[row["rarity"]].lstrip("#"), 16),
        "fields": fields,
        "footer": {"text": FOOTER},
    }
    photo = _photo(row, public_url, photo_sports)
    if photo is not None:
        embed["thumbnail"] = {"url": photo}
    if gone is not None:
        embed["title"] = "Gone · " + embed["title"]
        embed["description"] = f"Gone: {GONE_WORDS.get(gone, 'It is no longer on sale.')}\n{meta}"
        embed["color"] = GONE_COLOR
    message: dict = {"embeds": [embed], "allowed_mentions": {"parse": []}}
    if role is not None:
        message["content"] = f"<@&{role}>"
        message["allowed_mentions"] = {"parse": [], "roles": [role]}
    return message


def otd_picks(snapshot: dict, now_s: float) -> list[dict]:
    """The passes for the daily post: the site's picks of every sport, each at its best rung, ranked as the site's
    "Pays back soonest" does, by how soon it pays back from today (an idle sport's passes count the months until their
    pay opens), then by rax a year per rax spent, at most DISCORD_OTD_PER_SPORT of a sport and DISCORD_OTD_PICKS in all. None from
    sample data, nor from pass figures measured more than DISCORD_OTD_MAX_AGE_H ago."""
    if not isinstance(snapshot, dict) or _is_demo(snapshot):
        return []
    coverage = snapshot["rules"].get("coverage")
    measured = _time(coverage.get("otd_as_of")) if isinstance(coverage, dict) else None
    if measured is not None and now_s - measured > DISCORD_OTD_MAX_AGE_H * HOUR:
        return []
    otd = snapshot.get("otd")
    markets = otd.get("markets") if isinstance(otd, dict) else None
    picks = otd.get("picks") if isinstance(otd, dict) else None
    if not isinstance(markets, list) or not isinstance(picks, dict):
        return []
    by_key = {market["key"]: market for market in markets if isinstance(market, dict) and isinstance(market.get("key"), str)}
    found = []
    for keys in picks.values():
        for key in keys if isinstance(keys, list) else ():
            pick = _pick(by_key.get(key)) if isinstance(key, str) else None
            if pick is not None:
                found.append(pick)
    found.sort(key=lambda pick: (pick["payback_months"], -pick["year_per_rax"], -pick["year_rax"], pick["player_name"]))
    chosen, per_sport = [], {}
    for pick in found:
        if per_sport.get(pick["sport"], 0) < DISCORD_OTD_PER_SPORT:
            chosen.append(pick)
            per_sport[pick["sport"]] = per_sport.get(pick["sport"], 0) + 1
    return chosen[:DISCORD_OTD_PICKS]


def _pick(market: object) -> dict | None:
    """A market at its best rung, as the daily post needs it, or None when it does not have one that pays back."""
    if not isinstance(market, dict) or not isinstance(market.get("player_name"), str) or not isinstance(market.get("sport"), str):
        return None
    rungs = market.get("rungs")
    best = market.get("best")
    rung = next((r for r in rungs if isinstance(r, dict) and r.get("tier") == best), None) if isinstance(rungs, list) else None
    if rung is None or rung.get("pays_back") is not True or not isinstance(best, str):
        return None
    numbers = ("cost", "year_rax", "year_per_rax", "payback_months")
    if not all(_number(rung.get(key)) for key in numbers) or rung["cost"] <= 0:
        return None
    season = market.get("season_label") if isinstance(market.get("season_label"), str) else market.get("season")
    return {"player_name": market["player_name"], "sport": market["sport"], "season": season, "tier": best,
            **{key: rung[key] for key in numbers}}


def _emoji(tier: object) -> str:
    """Real's mark for a rarity and a space ("🟣 "), or nothing for a tier Real does not have."""
    index = rarity_index(tier) if isinstance(tier, str) else -1
    return f"{RARITY_EMOJI[index]} " if index >= 0 else ""


def otd_message(picks: list[dict], public_url: str, day: datetime) -> dict:
    """The daily pass post: one embed, one line per pass (who, the pass, its cost, its pay over the next 12 months and
    when it pays back), linking to the passes on the site."""
    lines = []
    for n, pick in enumerate(picks, 1):
        season = _plain(str(pick["season"]), 12) if pick["season"] is not None else ""
        months = max(1, round(pick["payback_months"]))
        idle = season_clock.pays_from(pick["sport"], day.date())
        lines.append(
            f"**{n}. {_plain(pick['player_name'])}** · {_sport(pick['sport'])} {season} · "
            f"{_emoji(pick['tier'])}{_plain(pick['tier'], 16).capitalize()} pass · {_rax(pick['cost'])} · "
            f"about {_rax(pick['year_rax'])} a year · {idle + ' · ' if idle else ''}"
            f"pays back in {months} month{'s' if months != 1 else ''}"
        )
    embed = {
        "title": f"On This Day picks · {day.strftime('%b')} {day.day}",
        "url": f"{public_url}/#passes",
        "description": "\n".join(lines),
        "color": OTD_COLOR,
        "footer": {"text": OTD_FOOTER},
    }
    return {"embeds": [embed], "allowed_mentions": {"parse": []}}


# --- what is remembered ---------------------------------------------------------------------------------------------


class PostLog:
    """What the poster remembers across restarts, in one small JSON file: the listings posted (their message, the
    channel, when, and whether the post says Gone yet; the newest DISCORD_POSTED_KEPT), the times of the posts and
    pings of the last 24 hours, the times of the last 24 hours' posts per player and per card-and-price (the caps that
    keep one player from flooding #live-deals), the day of the last pass post, the "What's new" ids sent and the day
    that feature first ran, the week of the last digest and the season-clock events sent. A file that cannot be read is set aside as
    `<name>.corrupt` and the poster starts empty; a row that does not check out is dropped."""

    def __init__(self, path: Path):
        self.path = path
        self.posted: OrderedDict[int, list] = OrderedDict()  # listing id -> [message id, channel, at, gone]
        self.deal_times: list[float] = []
        self.ping_times: list[float] = []
        self.otd_day: str | None = None
        self.player_times: dict[str, list[float]] = {}  # "sport:player id" -> times of its posts in the last 24 hours
        self.signatures: dict[str, float] = {}  # card and price -> when it was posted, last 24 hours
        self.news_started: str | None = None  # the day "What's new" first ran: older entries are never announced
        self.news_seen: list[str] = []
        self.digest_week: str | None = None
        self.season_sent: list[str] = []
        self._load()

    def _load(self) -> None:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except (OSError, ValueError) as error:
            log.warning("Discord posts: %s could not be read (%s); starting empty", self.path.name, type(error).__name__)
            self._set_aside()
            return
        if not isinstance(data, dict):
            self._set_aside()
            return
        for row in data.get("posted") if isinstance(data.get("posted"), list) else ():
            if (isinstance(row, list) and len(row) == 5 and type(row[0]) is int
                    and (row[1] is None or isinstance(row[1], str)) and row[2] in (DEALS, OTD)
                    and _number(row[3]) and isinstance(row[4], bool)):
                self.posted[row[0]] = row[1:]
        while len(self.posted) > DISCORD_POSTED_KEPT:
            self.posted.popitem(last=False)
        for name in ("deal_times", "ping_times"):
            times = data.get(name)
            setattr(self, name, [t for t in times if _number(t)] if isinstance(times, list) else [])
        day = data.get("otd_day")
        self.otd_day = day if isinstance(day, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", day) else None
        started = data.get("news_started")
        self.news_started = started if isinstance(started, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", started) else None
        for name in ("news_seen", "season_sent"):
            ids = data.get(name)
            setattr(self, name, [i for i in ids if isinstance(i, str) and len(i) <= 80][-KEPT_IDS:]
                    if isinstance(ids, list) else [])
        week = data.get("digest_week")
        self.digest_week = week if isinstance(week, str) and re.fullmatch(r"\d{4}-W\d{2}", week) else None
        players = data.get("player_times")
        for key, times in (players.items() if isinstance(players, dict) else ()):
            if isinstance(key, str) and len(key) <= 60 and isinstance(times, list):
                self.player_times[key] = [t for t in times if _number(t)][-DISCORD_PLAYER_PER_DAY * 4:]
        sigs = data.get("signatures")
        for key, at in (sigs.items() if isinstance(sigs, dict) else ()):
            if isinstance(key, str) and len(key) <= 100 and _number(at):
                self.signatures[key] = float(at)

    def _set_aside(self) -> None:
        try:
            os.replace(self.path, self.path.with_name(self.path.name + ".corrupt"))
        except OSError:
            pass

    def add(self, listing_id: int, message_id: str | None, channel: str, at: float, ping: bool,
            sent: bool = True) -> None:
        """Remembers a listing as posted. `sent` False: Discord refused it for good, so it is not tried again and does
        not count toward the caps. `message_id` None: there is no post to mark Gone later."""
        self.posted.pop(listing_id, None)
        self.posted[listing_id] = [message_id, channel, at, False]
        while len(self.posted) > DISCORD_POSTED_KEPT:
            self.posted.popitem(last=False)
        if sent:
            self.deal_times.append(at)
            if ping:
                self.ping_times.append(at)

    def recent(self, times: list[float], now_s: float, window_s: float) -> int:
        return sum(1 for t in times if 0 <= now_s - t < window_s)

    def held_back(self, player: str, signature: str, now_s: float) -> bool:
        """Whether a deal on `player` (a "sport:player id") is held back: DISCORD_PLAYER_PER_DAY posts about them in
        the last 24 hours already, or the same card at the same price (`signature`) was posted in that time."""
        at = self.signatures.get(signature)
        if at is not None and 0 <= now_s - at < DAY:
            return True
        return self.recent(self.player_times.get(player, []), now_s, DAY) >= DISCORD_PLAYER_PER_DAY

    def note_player(self, player: str, signature: str, at: float) -> None:
        self.player_times.setdefault(player, []).append(at)
        self.signatures[signature] = at

    def remember(self, name: str, ident: str) -> None:
        """Notes a "What's new" id or a season-clock event as sent (`name`: "news_seen" or "season_sent")."""
        ids = getattr(self, name)
        if ident not in ids:
            ids.append(ident)
            del ids[:-KEPT_IDS]

    def save(self, now_s: float | None = None) -> None:
        """Writes the file through a temporary one next to it, so a crash never leaves half a file. A failed write
        is logged; the poster goes on with what it has in memory."""
        if now_s is not None:
            self.deal_times = [t for t in self.deal_times if now_s - t < DAY][-4 * DISCORD_DEALS_PER_DAY:]
            self.ping_times = [t for t in self.ping_times if now_s - t < DAY][-4 * DISCORD_PINGS_PER_DAY:]
            kept = {key: [t for t in times if 0 <= now_s - t < DAY] for key, times in self.player_times.items()}
            self.player_times = {key: times for key, times in kept.items() if times}
            self.signatures = {key: at for key, at in self.signatures.items() if 0 <= now_s - at < DAY}
        data = {
            "posted": [[lid, *entry] for lid, entry in self.posted.items()],
            "deal_times": self.deal_times, "ping_times": self.ping_times, "otd_day": self.otd_day,
            "player_times": self.player_times, "signatures": self.signatures, "news_started": self.news_started,
            "news_seen": self.news_seen, "digest_week": self.digest_week, "season_sent": self.season_sent,
        }
        tmp_name = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=self.path.parent,
                                             prefix=f".{self.path.name}.", suffix=".tmp", delete=False) as tmp:
                tmp_name = tmp.name
                json.dump(data, tmp, separators=(",", ":"))
            os.replace(tmp_name, self.path)
        except OSError as error:
            log.warning("Discord posts: %s could not be written (%s)", self.path.name, type(error).__name__)
            if tmp_name is not None:
                try:
                    os.unlink(tmp_name)
                except OSError:
                    pass


# --- the poster -----------------------------------------------------------------------------------------------------


def _digest():
    """advisor.discord_digest, which uses this module's helpers: imported when first needed, not at the top."""
    from advisor import discord_digest

    return discord_digest


def _parse(raw: bytes) -> object:
    try:
        return json.loads(raw) if raw else {}
    except ValueError:
        return {}


class Poster:
    """Posts what a snapshot makes due (see the module's docstring). One thread uses it; `round` never raises.

    `transport` carries the calls (urllib's, without proxy or redirect, by default; a fake one in tests); `clock`
    gives the time in seconds since the epoch."""

    def __init__(self, config: PostConfig, path: Path, transport: Transport | None = None,
                 clock: Callable[[], float] = time.time, news: list[dict] | None = None):
        self._config = config
        self._news = news  # the "What's new" entries; None: read advisor/whatsnew.json at the first round that needs it
        self._send = transport or _url_transport(_OPENER.open)
        self._clock = clock
        self._agent = f"DiscordBot ({config.public_url}, {USER_AGENT_VERSION})"
        self.log = PostLog(path)
        self.channels: dict[str, str] = {}  # deals / otd -> the channel id, while it may be posted in
        self.role: str | None = None
        self._resolved = False
        self._off = False  # a refused token: nothing more until a restart
        self._wait_until = 0.0
        self._fails = 0

    # Discord.

    def _call(self, method: str, path: str, body: dict | None = None) -> tuple[int | None, object]:
        """(status, parsed answer); (None, {}) when Discord did not answer at all."""
        headers = {"User-Agent": self._agent, "Authorization": f"Bot {self._config.bot_token}"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()
        try:
            status, raw = self._send(method, API + path, headers, data)
        except Exception as error:  # noqa: BLE001 - a timeout, a refused connection, a fake's error: only its class
            log.warning("Discord posts: Discord did not answer (%s)", type(error).__name__)
            return None, {}
        return status, _parse(raw)

    def _transient(self, status: int | None, answer: object, now_s: float) -> bool:
        """Handles a 429, a 5xx or no answer at all (the poster then waits); False for any other answer."""
        if status == 429:
            retry = answer.get("retry_after") if isinstance(answer, dict) else None
            wait = min(float(retry), DISCORD_RETRY_AFTER_CAP_S) if _number(retry) and retry >= 0 else DISCORD_BACKOFF_S
            self._wait_until = now_s + wait
            log.info("Discord posts: rate limited, waiting %.1f s", wait)
            return True
        if status is None or status >= 500:
            self._fails += 1
            wait = min(DISCORD_BACKOFF_S * 2 ** (self._fails - 1), DISCORD_BACKOFF_CAP_S)
            self._wait_until = now_s + wait
            if status is not None:
                log.warning("Discord posts: Discord answered HTTP %d, waiting %d s", status, wait)
            return True
        return False

    def _refused(self, status: int) -> None:
        """A 401: the token is refused. Off until restart, said once."""
        self._off = True
        log.error("Discord posts are off until restart: Discord refused the bot (HTTP %d)", status)

    def _drop(self, key: str, status: int, answer: object) -> None:
        """A channel the bot may not post in, or that is gone: dropped until restart, said once."""
        if self.channels.pop(key, None) is not None:
            code = answer.get("code") if isinstance(answer, dict) else None
            log.warning("Discord posts: no more posts in #%s until restart (HTTP %d, code %s)",
                        CHANNEL_NAMES[key], status, code)

    def _resolve(self, now_s: float) -> bool:
        """Finds the channels and the role, once; False while it could not (the poster waits or is off)."""
        if self._resolved:
            return True
        cfg = self._config
        channels = {DEALS: cfg.deals_channel, OTD: cfg.otd_channel, ANNOUNCE: cfg.announce_channel,
                    TALK: cfg.talk_channel}
        if None in channels.values():
            status, answer = self._call("GET", f"/guilds/{cfg.guild_id}/channels")
            if self._transient(status, answer, now_s):
                return False
            if status != 200 or not isinstance(answer, list):
                if status == 401:
                    self._refused(status)
                elif status == 200:  # an answer past the transport's cap reads as nothing: a server with many channels
                    self._off = True
                    log.error("Discord posts are off until restart: the server's channel list was too big to read; "
                              "set %s to the channels' ids", ", ".join(CHANNEL_ENV.values()))
                else:
                    self._lookup_failed("channels", status)
                return False
            for key, have in channels.items():
                if have is None:
                    channels[key] = self._find_channel(answer, CHANNEL_NAMES[key])
        role = cfg.alerts_role
        if role is None:
            status, answer = self._call("GET", f"/guilds/{cfg.guild_id}/roles")
            if self._transient(status, answer, now_s):
                return False
            if status == 200 and isinstance(answer, list):
                found = next((r for r in answer if isinstance(r, dict) and isinstance(r.get("name"), str)
                              and r["name"].strip().casefold() == ROLE_NAME and _SNOWFLAKE.fullmatch(str(r.get("id")))),
                             None)
                role = None if found is None else str(found["id"])
                if found is not None and found.get("mentionable") is False:
                    log.warning("Discord posts: the Deal Alerts role is not mentionable, so its pings notify nobody "
                                "unless the bot may mention everyone")
            if role is None:
                log.warning("Discord posts: no Deal Alerts role found, so no deal pings it")
        self.channels = {key: cid for key, cid in channels.items() if cid is not None}
        for key in channels:
            if key not in self.channels:
                log.warning("Discord posts: no #%s channel found, so nothing goes there", CHANNEL_NAMES[key])
        self.role = role
        self._resolved = True
        self._fails = 0
        return True

    def _lookup_failed(self, what: str, status: int | None) -> None:
        self._off = True
        log.error("Discord posts are off until restart: the server's %s could not be read (HTTP %s)", what, status)

    @staticmethod
    def _find_channel(channels: list, name: str) -> str | None:
        for channel in channels:
            if not isinstance(channel, dict) or channel.get("type") not in TEXT_CHANNELS:
                continue
            cid, cname = str(channel.get("id")), channel.get("name")
            if isinstance(cname, str) and _SNOWFLAKE.fullmatch(cid) and _DECORATION.sub("", cname.casefold()) == name:
                return cid
        return None

    def _post(self, key: str, method: str, path: str, body: dict, now_s: float) -> tuple[str, object]:
        """One call to a channel: ("ok", answer), ("skip", None) when Discord refused this one for good (a 400, a
        deleted message), or ("stop", None) when the round must stop (waiting, or the channel was dropped)."""
        status, answer = self._call(method, path, body)
        if self._transient(status, answer, now_s):
            return "stop", None
        if 200 <= status < 300:
            self._fails = 0
            return "ok", answer
        code = answer.get("code") if isinstance(answer, dict) else None
        if status == 401:
            self._refused(status)
            return "stop", None
        if status == 404 and code == _UNKNOWN_MESSAGE:
            return "skip", None
        if status in (403, 404):
            self._drop(key, status, answer)
            return "stop", None
        log.warning("Discord posts: Discord refused a post in #%s (HTTP %d, code %s)", CHANNEL_NAMES[key], status, code)
        return "skip", None

    # One round.

    def round(self, snapshot: dict | None, fresh: bool, ended: Callable[[int], dict | None] | None = None) -> None:
        """Posts what `snapshot` makes due. `fresh`: the data is not stale. `ended(listing_id)` remembers the gone row
        of a deal that went away (the store's memory), beside the snapshot's own gone rows. Never raises."""
        try:
            self._round(snapshot, fresh, ended)
        except Exception:  # noqa: BLE001 - posts are never worth the server
            log.exception("a Discord post round failed")

    def _round(self, snapshot: dict | None, fresh: bool, ended) -> None:
        now_s = self._clock()
        if self._paused(now_s) or not isinstance(snapshot, dict) or _is_demo(snapshot):
            return
        if not self._resolve(now_s):
            return
        changed = False
        try:
            # Each step goes only while Discord has not said to wait (a 429, a failure) or refused the bot.
            changed |= self._mark_gone(snapshot, ended, now_s)
            if fresh and not self._paused(now_s):
                changed |= self._post_deals(snapshot, now_s)
            if not self._paused(now_s):
                self._post_otd(snapshot, fresh, now_s)
            # The three once-only posts: each step goes on only while Discord has not said to wait.
            for step in (self._post_news, self._post_digest, self._post_season):
                if self._paused(now_s):
                    break
                try:
                    changed |= step(snapshot, fresh, now_s)
                except Exception:  # noqa: BLE001 - one broken post never stops the others, nor the market
                    log.exception("a Discord post step failed")
        finally:
            if changed:
                self.log.save(now_s)

    def _paused(self, now_s: float) -> bool:
        return self._off or now_s < self._wait_until

    def _photo_sports(self, snapshot: dict) -> set[str]:
        sports = snapshot["rules"].get("photo_sports")
        return {s for s in sports if isinstance(s, str)} if isinstance(sports, list) else set()

    def _post_deals(self, snapshot: dict, now_s: float) -> bool:
        if DEALS not in self.channels:
            return False
        room = min(
            DISCORD_DEALS_PER_ROUND,
            DISCORD_DEALS_PER_HOUR - self.log.recent(self.log.deal_times, now_s, HOUR),
            DISCORD_DEALS_PER_DAY - self.log.recent(self.log.deal_times, now_s, DAY),
        )
        if room <= 0:
            return False
        fresh = [row for row in pick_deals(snapshot, now_s) if row["listing_id"] not in self.log.posted]
        photo_sports = self._photo_sports(snapshot)
        changed = False
        sent = 0
        for row in fresh:
            if sent >= room:
                break
            player = f"{row['sport']}:{row['player_id']}"
            signature = f"{player}:{row['season']}:{row['rating']}:{row['price']}"
            if self.log.held_back(player, signature, now_s):
                continue  # a hot player never floods the channel, nor a listing posted again as it was
            ping = (self.role is not None and exceptional(row)
                    and self.log.recent(self.log.ping_times, now_s, DAY) < DISCORD_PINGS_PER_DAY)
            channel = self.channels.get(DEALS)
            if channel is None:
                break
            body = deal_message(row, self._config.public_url, photo_sports, role=self.role if ping else None)
            # The same nonce twice within minutes makes one message: a post Discord made but whose answer never came
            # back (a timeout, a 5xx) is not doubled when the next round tries it again.
            body |= {"nonce": f"d{row['listing_id']}"[:25], "enforce_nonce": True}
            outcome, answer = self._post(DEALS, "POST", f"/channels/{channel}/messages", body, now_s)
            if outcome == "stop":
                break
            message_id = answer.get("id") if outcome == "ok" and isinstance(answer, dict) else None
            self.log.add(row["listing_id"], message_id if isinstance(message_id, str) else None, DEALS, now_s,
                         ping and outcome == "ok", sent=outcome == "ok")
            if outcome == "ok":
                self.log.note_player(player, signature, now_s)
                sent += 1
            self.log.save(now_s)  # at once: a redeploy may end the thread before the round does
            changed = True
        return changed

    def _mark_gone(self, snapshot: dict, ended, now_s: float) -> bool:
        """Edits the post of a deal that went away to say "Gone", once, for posts of the last DISCORD_GONE_EDIT_H."""
        channel = self.channels.get(DEALS)
        if channel is None:
            return False
        rows = snapshot.get("gone")
        gone = {row["listing_id"]: row for row in rows if valid_deal(row)} if isinstance(rows, list) else {}
        changed, edits = False, 0
        for listing_id, entry in list(self.log.posted.items()):
            message_id, key, at, done = entry
            if done or message_id is None or key != DEALS or now_s - at > DISCORD_GONE_EDIT_H * HOUR:
                continue
            row = gone.get(listing_id)
            if row is None and ended is not None:
                row = ended(listing_id)
            if not valid_deal(row):
                continue
            if edits >= DISCORD_GONE_EDITS_PER_ROUND:
                break
            edits += 1
            reason = row.get("reason") if isinstance(row.get("reason"), str) else ""
            body = deal_message(row, self._config.public_url, self._photo_sports(snapshot), gone=reason)
            outcome, _ = self._post(DEALS, "PATCH", f"/channels/{channel}/messages/{message_id}", body, now_s)
            if outcome == "stop":
                break
            entry[3] = True
            self.log.save(now_s)
            changed = True
        return changed

    def _post_otd(self, snapshot: dict, fresh: bool, now_s: float) -> None:
        channel = self.channels.get(OTD)
        moment = datetime.fromtimestamp(now_s, timezone.utc)
        day = moment.date().isoformat()
        if channel is None or self.log.otd_day == day or not fresh:
            return
        if not DISCORD_OTD_HOUR_UTC <= moment.hour < DISCORD_OTD_HOUR_UTC + DISCORD_OTD_LATE_H:
            return
        picks = otd_picks(snapshot, now_s)
        if len(picks) < DISCORD_OTD_MIN_PICKS:
            return
        body = otd_message(picks, self._config.public_url, moment) | {"nonce": f"otd{day}", "enforce_nonce": True}
        outcome, _ = self._post(OTD, "POST", f"/channels/{channel}/messages", body, now_s)
        if outcome != "stop":  # posted, or refused for good: either way not again today
            self.log.otd_day = day
            self.log.save(now_s)


    # The once-only posts.

    def _already_there(self, key: str, marker: str, now_s: float) -> bool | None:
        """Whether one of the channel's last DISCORD_ANNOUNCE_SCAN posts is the bot's own with `marker` in its embed's
        footer (so a wiped disk does not send a post twice); None when the channel could not be read now."""
        channel = self.channels.get(key)
        if channel is None:
            return None
        status, answer = self._call("GET", f"/channels/{channel}/messages?limit={DISCORD_ANNOUNCE_SCAN}")
        if self._transient(status, answer, now_s):
            return None
        if status == 401:
            self._refused(status)
            return None
        if status in (403, 404):
            self._drop(key, status, answer)
            return None
        if status != 200 or not isinstance(answer, list):
            return None
        for message in answer:
            author = message.get("author") if isinstance(message, dict) else None
            if not (isinstance(author, dict) and author.get("bot") is True):
                continue
            for embed in message.get("embeds") if isinstance(message.get("embeds"), list) else ():
                footer = embed.get("footer") if isinstance(embed, dict) else None
                text = footer.get("text") if isinstance(footer, dict) else None
                if isinstance(text, str) and (text == marker or text.startswith(marker + " ·")):
                    return True
        return False

    def _send_once(self, key: str, body: dict, marker: str, now_s: float) -> bool | None:
        """Sends `body` to the channel unless its `marker` is there already: True when it is there after this (sent, or
        found), False when Discord refused it for good (not tried again), None when the round must stop or try again
        later (a wait, a dropped channel, an unreadable channel)."""
        there = self._already_there(key, marker, now_s)
        if there is None:
            return None
        if there:
            return True
        nonce = hashlib.sha1(marker.encode()).hexdigest()[:24]
        body = body | {"nonce": nonce, "enforce_nonce": True}
        outcome, _ = self._post(key, "POST", f"/channels/{self.channels[key]}/messages", body, now_s)
        if outcome == "stop":
            return None
        return outcome == "ok"

    def _post_news(self, snapshot: dict, fresh: bool, now_s: float) -> bool:
        """Announces each new "What's new" entry once, quietly on the poster's first day (see `advisor.whatsnew`)."""
        if ANNOUNCE not in self.channels:
            return False
        if self._news is None:
            self._news = whatsnew.load()
        today = datetime.fromtimestamp(now_s, timezone.utc).date().isoformat()
        changed = False
        if self.log.news_started is None:
            self.log.news_started, changed = today, True
        post, quiet = whatsnew.split(self._news, set(self.log.news_seen), self.log.news_started, today)
        for entry in quiet:
            self.log.remember("news_seen", entry["id"])
            changed = True
        for entry in post[:DISCORD_WHATSNEW_PER_ROUND]:
            body = whatsnew.message(entry, self._config.public_url)
            done = self._send_once(ANNOUNCE, body, _digest().marker_of(body), now_s)
            if done is None:
                break
            self.log.remember("news_seen", entry["id"])  # sent, found there already, or refused for good: never again
            changed = True
        if changed:
            self.log.save(now_s)
        return changed

    def _post_digest(self, snapshot: dict, fresh: bool, now_s: float) -> bool:
        """Mondays from DISCORD_DIGEST_HOUR_UTC: "This week in the market", once per ISO week, never on stale data."""
        moment = datetime.fromtimestamp(now_s, timezone.utc)
        week = _digest().week_id(moment)
        if TALK not in self.channels or not fresh or self.log.digest_week == week or not _digest().digest_window(moment):
            return False
        parts = _digest().digest_parts(snapshot, now_s, self._config.public_url)
        body = _digest().digest_message(parts, self._config.public_url, moment)
        if body is None:
            return False  # too little to say now: the window may bring more
        if self._send_once(TALK, body, _digest().marker_of(body), now_s) is None:
            return False
        self.log.digest_week = week
        self.log.save(now_s)
        return True

    def _post_season(self, snapshot: dict, fresh: bool, now_s: float) -> bool:
        """A season-clock heads-up, DISCORD_SEASON_ALERT_DAYS days before its date, once ever (one post a round)."""
        if TALK not in self.channels:
            return False
        today = datetime.fromtimestamp(now_s, timezone.utc).date()
        due = season_clock.due_events(today, DISCORD_SEASON_ALERT_DAYS, set(self.log.season_sent))
        if not due:
            return False
        body = _digest().season_message(due[0], self._config.public_url)
        if self._send_once(TALK, body, _digest().marker_of(body), now_s) is None:
            return False
        self.log.remember("season_sent", due[0][0])
        self.log.save(now_s)
        return True


def run_poster(poster, store, stop: threading.Event, check_s: float = DISCORD_POST_CHECK_S) -> None:
    """Hands each new snapshot of `store` to `poster`, with whether it is fresh, every `check_s` seconds until `stop`
    is set. A failure is logged and the next snapshot tried; nothing here stops the server."""
    seen = None
    while not stop.is_set():
        try:
            health = store.health()
            version = health.get("version")
            if version is not None and version != seen:
                current = store.current()
                if current is not None:
                    seen = version
                    poster.round(json.loads(current[0]), bool(health.get("ok")), ended=store.ended)
        except Exception:  # noqa: BLE001 - the next snapshot is tried all the same
            log.exception("the Discord poster could not read a snapshot")
        if stop.wait(check_s):
            return


# --- by hand --------------------------------------------------------------------------------------------------------


def dry_run(snapshot: dict, public_url: str, now_s: float | None = None) -> dict:
    """The posts a snapshot would make right now, without the caps or the memory: every deal picked, the pass post and
    the week's digest (whatever day it is)."""
    now_s = time.time() if now_s is None else now_s
    sports = snapshot.get("rules", {}).get("photo_sports", []) if isinstance(snapshot.get("rules"), dict) else []
    photo_sports = {s for s in sports if isinstance(s, str)} if isinstance(sports, list) else set()
    deals = pick_deals(snapshot, now_s)
    picks = otd_picks(snapshot, now_s)
    moment = datetime.fromtimestamp(now_s, timezone.utc)
    digest = _digest()
    return {
        "deals": [{"exceptional": exceptional(row), **deal_message(row, public_url, photo_sports)} for row in deals],
        "otd": otd_message(picks, public_url, moment) if picks else None,
        "digest": digest.digest_message(digest.digest_parts(snapshot, now_s, public_url), public_url, moment),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="The Discord posts a snapshot would make, as JSON. No network.")
    parser.add_argument("--dry-run", metavar="SNAPSHOT", required=True, help="a snapshot's JSON file, or - for stdin")
    parser.add_argument("--public-url", default=os.environ.get("ADVISOR_PUBLIC_URL", "https://example.com"))
    args = parser.parse_args(argv)
    text = sys.stdin.read() if args.dry_run == "-" else Path(args.dry_run).read_text(encoding="utf-8")
    json.dump(dry_run(json.loads(text), args.public_url.rstrip("/")), sys.stdout, indent=2, ensure_ascii=False)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
