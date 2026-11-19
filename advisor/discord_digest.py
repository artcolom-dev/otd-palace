"""The words of the Discord poster's weekly digest and season-clock alerts (the poster, `advisor.discord_post.Poster`,
decides when and where; this module only chooses and words).

THE DIGEST, "This week in the market", in #market-talk on Mondays from DISCORD_DIGEST_HOUR_UTC (UTC), or up to
DISCORD_DIGEST_LATE_H later after a restart, once per ISO week: the best deals still open at that moment
(`pick_deals`, the same bar as #live-deals, at most DISCORD_DIGEST_DEALS), the snapshot's biggest price moves today (at
most DISCORD_DIGEST_MOVERS risers and as many fallers), the On This Day pick of the week (the first of the daily
picks) and one season-clock line (advisor/season_clock.py). A week with fewer than DISCORD_DIGEST_MIN_ITEMS of the
first three parts is skipped, and so is a stale snapshot: the digest would say old prices.

A SEASON ALERT is one post for one dated event of the season clock, DISCORD_SEASON_ALERT_DAYS days ahead, once ever.

Both end with a footer that holds a marker ("Week 2026-W47", "Season clock · mlb-...") the poster looks for in the
channel's last posts before sending, so a wiped disk does not send them twice.
"""

from datetime import datetime, timezone

from advisor import season_clock
from advisor.discord_post import (
    FOOTER,
    _number,
    _pct,
    _plain,
    _rax,
    _sport,
    otd_picks,
    pick_deals,
)
from advisor.rules import (
    DISCORD_DIGEST_DEALS,
    DISCORD_DIGEST_HOUR_UTC,
    DISCORD_DIGEST_LATE_H,
    DISCORD_DIGEST_MIN_ITEMS,
    DISCORD_DIGEST_MOVERS,
)

COLOR = 0x4C8EEA
SEASON_COLOR = 0xE8A23A


def week_id(moment: datetime) -> str:
    """The ISO week of `moment`: "2026-W47"."""
    iso = moment.isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"


def digest_window(moment: datetime) -> bool:
    """Whether `moment` (UTC) is inside Monday's sending window."""
    return moment.weekday() == 0 and DISCORD_DIGEST_HOUR_UTC <= moment.hour < DISCORD_DIGEST_HOUR_UTC + DISCORD_DIGEST_LATE_H


def _moves(snapshot: dict, key: str) -> list[dict]:
    moves = snapshot.get("moves")
    rows = moves.get(key) if isinstance(moves, dict) else None
    good = []
    for row in rows if isinstance(rows, list) else ():
        if (isinstance(row, dict) and isinstance(row.get("player_name"), str) and isinstance(row.get("sport"), str)
                and all(_number(row.get(k)) for k in ("change", "median_recent", "median_base"))):
            good.append(row)
    return good[:DISCORD_DIGEST_MOVERS]


def digest_parts(snapshot: dict, now_s: float, public_url: str) -> dict:
    """What the week's digest has to say, as text lines per part: {"deals": [...], "moves": [...], "otd": [...]},
    each empty when there is nothing to say."""
    deals = []
    for row in pick_deals(snapshot, now_s)[:DISCORD_DIGEST_DEALS]:
        deals.append(f"[{_plain(row['player_name']) or 'A player'}]({public_url}/d/{row['listing_id']}) · "
                     f"{_sport(row['sport'])} {row['season']} · {_rax(row['price'])}, {_pct(row['discount'])} under, "
                     f"{row['flip_margin']:+,} Rax after fees")
    moves = []
    for symbol, key in (("▲", "risers"), ("▼", "fallers")):
        for row in _moves(snapshot, key):
            moves.append(f"{symbol} {_plain(row['player_name'])} · {_sport(row['sport'])} · "
                         f"{row['change'] * 100:+.0f}% (median {_rax(row['median_recent'])}, was "
                         f"{_rax(row['median_base'])})")
    picks = otd_picks(snapshot, now_s)[:1]
    otd = []
    for pick in picks:
        season = _plain(str(pick["season"]), 12) if pick["season"] is not None else ""
        months = max(1, round(pick["payback_months"]))
        idle = season_clock.pays_from(pick["sport"], datetime.fromtimestamp(now_s, timezone.utc).date())
        otd.append(f"**{_plain(pick['player_name'])}** · {_sport(pick['sport'])} {season} · "
                   f"{_plain(pick['tier'], 16).capitalize()} pass · {_rax(pick['cost'])} · about "
                   f"{_rax(pick['year_rax'])} a year · {idle + ' · ' if idle else ''}"
                   f"pays back in {months} month{'s' if months != 1 else ''}")
    return {"deals": deals, "moves": moves, "otd": otd}


def digest_message(parts: dict, public_url: str, moment: datetime) -> dict | None:
    """The digest as one embed, or None when fewer than DISCORD_DIGEST_MIN_ITEMS parts have something to say."""
    if sum(1 for key in ("deals", "moves", "otd") if parts[key]) < DISCORD_DIGEST_MIN_ITEMS:
        return None
    sections = []
    if parts["deals"]:
        sections.append("**Best deals still open**\n" + "\n".join(parts["deals"]))
    if parts["moves"]:
        sections.append("**Biggest price moves today**\n" + "\n".join(parts["moves"]))
    if parts["otd"]:
        sections.append("**On This Day pick of the week**\n" + "\n".join(parts["otd"]))
    tip = season_clock.tip_for(moment.date())
    if tip:
        sections.append("**Season clock**\n" + tip)
    embed = {
        "title": "This week in the market",
        "url": public_url,
        "description": "\n\n".join(sections),
        "color": COLOR,
        "footer": {"text": f"Week {week_id(moment)} · Yearly figures assume you claim every claim day. {FOOTER}"},
    }
    return {"embeds": [embed], "allowed_mentions": {"parse": []}}


def season_message(event: tuple, public_url: str) -> dict:
    """The one-time heads-up for a season-clock event: its title, its line and its date."""
    ident, day, sport, title, line = event
    embed = {
        "title": f"Season clock · {title}",
        "url": public_url,
        "description": f"{line}\n\n{sport} · about {day.strftime('%b')} {day.day}",
        "color": SEASON_COLOR,
        "footer": {"text": f"Season clock · {ident}"},
    }
    return {"embeds": [embed], "allowed_mentions": {"parse": []}}


def marker_of(message: dict) -> str:
    """The text the channel scan looks for to know this post went out: the start of its embed's footer, before the
    " · " that opens the footer's own words ("Week 2026-W47", "Season clock · mlb-...")."""
    text = message["embeds"][0]["footer"]["text"]
    if text.startswith("Week "):  # the digest: its week alone, whatever words follow (they change between versions)
        return text.split(" · ", 1)[0]
    return text.removesuffix(f" · {FOOTER}")
