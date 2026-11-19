"""The snapshot the public site serves: the engine's results as plain JSON.

Everything served is built field by field from the dataclasses below, never from their
whole `__dict__`, so a field added to the model later is not published by accident.
"""

import copy
import hashlib
import json
import logging
from collections import Counter
from collections.abc import Mapping
from datetime import date, datetime, timedelta, timezone
from typing import Any

from advisor.deals import Deal, find_deals
from advisor.links import REAL_HOME
from advisor.model import PassMarket, RawData, Sale
from advisor.moves import Move, market_moves
from advisor.otd import Rung, best_rung, on_sale, pass_picks, rungs, starters, weak_rungs
from advisor.pass_rates import live_auctions, offer_cells
from advisor.photos import PHOTO_SPORTS
from advisor.rules import (
    AFTER_FEES_MIN_REF,
    BUDGET_PRESETS,
    COMMUNITY_URL,
    LEVELS,
    LISTING_FEE,
    OTD_BUDGET_PRESETS,
    OTD_CLAIMS_PER_SPORT_DAY,
    OTD_FULL_AT,
    OTD_IGNORE_ASK_ABOVE,
    OTD_IGNORE_ASK_MIN_SALES,
    OTD_LADDERS,
    OTD_FIGHTER_LIMITS,
    OTD_LIMIT_ESTIMATED_KINDS,
    OTD_LIMIT_ESTIMATED_SPORTS,
    OTD_MINT_COST,
    OTD_NO_LIMIT,
    OTD_NO_LIMIT_HORIZON_YEARS,
    OTD_NO_OTD_TIERS,
    OTD_LATER_SHARE_BELOW,
    OTD_LATER_START_SHARE,
    OTD_LATER_WINDOW_MONTHS,
    OTD_PAYBACK_HORIZON_YEARS,
    OTD_PLAYER_LIMIT_PER_MULT,
    OTD_PROJECTION_BELOW,
    OTD_SHELF_KEEP,
    OTD_SPORT_DAYS,
    OTD_SPORT_MONTHS,
    OTD_STARTER_TIERS,
    OTD_TEAM_LIMITS,
    OTD_SAME_WEEKDAYS,
    OTD_WEEKLY_DAYS,
    OTD_TOP,
    OTD_VERSION_CHARS,
    POLL_S,
    PRICE_CURVE_ON,
    PULSE_WINDOW_MIN,
    QUICKSELL_PER_POINT,
    SELL_CURVE,
    SELLER_FEE,
    SPORTS_RANK_WINDOW_H,
    STALE_AFTER_S,
    SUPPORT_ACCOUNT,
    SUPPORT_URL,
    TWIN_MAX,
    TWIN_PRICE_BAND,
)


log = logging.getLogger(__name__)


def iso_z(moment: datetime) -> str:
    """A UTC time to the second, such as 2026-11-12T18:00:00Z."""
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _noted(row: dict, injuries: Any, sport: str, player_id: int, name: str) -> dict:
    """`row` with ESPN's note on the player's health under "injury" when there is one. No note is no key at all: it
    is not "healthy", only unsaid. A view that fails says nothing; it never breaks a snapshot."""
    try:
        note = None if injuries is None else injuries.of(sport, player_id, name)
    except Exception:  # noqa: BLE001 - a third party's list must not break the market
        log.exception("injury note failed for %s %s", sport, player_id)
        note = None
    if note is not None:
        row["injury"] = note
    return row


def _resold(row: dict, resale: Any, sport: str, player_id: int, name: str, rating: float) -> dict:
    """`row` with the counts of recent listings of cards like this one (the player's, in this card's rating band) that
    sold, under "resale", when the view has them. No count is no key at all. A view that fails says nothing; it never
    breaks a snapshot."""
    try:
        counts = None if resale is None else resale.of(sport, player_id, name, rating)
    except Exception:  # noqa: BLE001 - a third party's table must not break the market
        log.exception("resale counts failed for %s %s", sport, player_id)
        counts = None
    if counts is not None:
        row["resale"] = counts
    return row


def _resale_available(resale: Any) -> bool:
    try:
        return bool(resale.available())
    except Exception:  # noqa: BLE001 - see _resold
        log.exception("resale availability failed")
        return False


def _injury_sports(injuries: Any) -> list[str]:
    """The sports whose injury list is fresh (sorted), or none when the view cannot say."""
    try:
        return sorted(injuries.sports())
    except Exception:  # noqa: BLE001 - see _noted
        log.exception("injury sports failed")
        return []


def _deal_json(deal: Deal, demo: bool) -> dict:
    """A deal as served. Sample data links to Real's home page, never to a listing: its listings are invented, and
    their links would open someone's real auction or nothing at all."""
    return {
        "listing_id": deal.listing_id,
        "card_id": deal.card_id,
        "sport": deal.sport,
        "season": deal.season,
        "player_id": deal.player_id,
        "player_name": deal.player_name,
        "card_label": deal.card_label,
        "rarity": deal.rarity,
        "rating": deal.rating,
        "bucket": deal.bucket,
        "mint": deal.mint,
        "kind": deal.kind,
        "price": deal.price,
        "reference": deal.reference,
        "ref_source": deal.ref_source,
        "ref_tier": deal.ref_tier,
        "ref_sample": deal.ref_sample,
        "confidence": deal.confidence,
        "discount": deal.discount,
        "gap": deal.gap,
        "flip_margin": deal.flip_margin,
        "num_bids": deal.num_bids,
        "ends_at": iso_z(deal.ends_at),
        "url": REAL_HOME if demo else deal.url,
        "per_point": deal.per_point,
        "ref_per_point": deal.ref_per_point,
        "listed_at": None if deal.listed_at is None else iso_z(deal.listed_at),
        "falling": deal.falling,
        "seen_at": None if deal.seen_at is None else iso_z(deal.seen_at),
        "real_estimate": deal.real_estimate,
        "recent_sales": [list(sale) for sale in deal.recent_sales],
    }


def _move_json(move: Move) -> dict:
    return {
        "sport": move.sport,
        "season": move.season,
        "player_id": move.player_id,
        "player_name": move.player_name,
        "bucket": move.bucket,
        "median_recent": move.median_recent,
        "median_base": move.median_base,
        "change": move.change,
        "sales_recent": move.sales_recent,
    }


def _curved(row: dict, history: Any, move: Move, now: datetime) -> dict:
    """`row` with "curve", its market's finished days as [days ago, middle sale, sales], oldest first, when `history`
    (advisor/price_history.py) holds any and PRICE_CURVE_ON; else `row` as it was. A history that fails costs the
    curve, never the move."""
    if history is None or not PRICE_CURVE_ON:
        return row
    try:
        curve = history.series((move.sport, move.season, move.player_id, move.bucket), now)
    except Exception:  # noqa: BLE001 - a curve is never worth a snapshot
        log.exception("the price history could not give a curve")
        return row
    return {**row, "curve": curve} if curve else row


def _round(value: float | None, digits: int | None = None) -> float | int | None:
    """`value` rounded for the page (to a whole number without `digits`), None kept."""
    return None if value is None else round(value, digits)


def _rung_json(rung: Rung) -> dict:
    return {
        "tier": rung.tier,
        "rating": rung.rating,
        "mult": rung.mult,
        "limit": _round(rung.limit),
        "limit_estimated": rung.limit_estimated,
        "rating_to_add": _round(rung.rating_to_add, 1),
        "cost": _round(rung.cost),
        "route": rung.route,
        "year_rax": _round(rung.year_rax),
        "year_capped": rung.year_capped,
        "projected": rung.projected,
        "per_game_day": _round(rung.per_game_day, 1),
        "years_to_limit": _round(rung.years_to_limit, 2),
        "year_per_rax": _round(rung.year_per_rax, 2),
        "lifetime_per_rax": _round(rung.lifetime_per_rax, 2),
        "pays_back": rung.pays_back,
        "payback_months": _round(rung.payback_months, 1),
        "payback_month": rung.payback_month,
    }


def _on_sale_json(market: PassMarket, best: Rung | None, auctions=None) -> dict | None:
    """What the shelf holds toward the best rung's rating; None without a best rung, or when the best is General (a
    season being played: the mint alone), which takes no card. Read from the live auctions when the feed sent them,
    with `firm` (whether every card taken is at a pay a buyer can count on now)."""
    if best is None or best.route == "mint":
        return None
    sale = on_sale(market, best.rating_to_add, auctions)
    out = {"on_sale_rating": sale.on_sale_rating, "on_sale_cost": sale.on_sale_cost, "enough": sale.enough}
    return out if sale.firm is None else {**out, "firm": sale.firm}


def _build_json(market: PassMarket, auctions) -> dict:
    """The feed's new pass fields as the browser needs them, each only when the feed sent it, so a row without them
    is served exactly as before: `rate_bucket`; `rate_build` (null: measured, but no cell has enough sales, so the
    traded rate stands in, thin) with its cell `rate_build_from`; `offers`, the accepted-offer cells measured on
    enough offers (advisor/pass_rates.py offer_cells); `auctions`, the shelf's auctions still open at the snapshot's
    moment as [rating, pay, firm (1) or opening (0)] (live_auctions). The raw rates by bucket and the auctions' own
    figures stay on the server."""
    out: dict = {}
    if market.rate_bucket is not None:
        out["rate_bucket"] = market.rate_bucket
    if market.measured or market.rate_build is not None:
        out["rate_build"] = market.rate_build
    if market.rate_build_from is not None:
        out["rate_build_from"] = dict(market.rate_build_from)
    cells = offer_cells(market.rates_by_bucket)
    if cells:
        out["offers"] = cells
    if auctions is not None:
        out["auctions"] = [[rating, pay, int(firm)] for rating, pay, firm in auctions[:OTD_SHELF_KEEP]]
    return out


def _pass_market_json(market: PassMarket, today: date, now: datetime | None = None) -> dict:
    """One pass as served: its inputs, the engine's figures and, when the feed sent them, its build rate and live
    auctions (judged at `now`; without one, none are served)."""
    ladder = rungs(market, today=today)
    best = best_rung(ladder)
    weak = weak_rungs(ladder)
    auctions = None if now is None else live_auctions(market, now)
    # Cheapest a rating point first, bounded: the cards a builder would take first.
    shelf = sorted(market.shelf, key=lambda card: (card[1] / abs(card[0]) if card[0] else float("inf"), card[1]))
    return {
        "key": market.key,
        "sport": market.sport,
        "season": market.season,
        "season_label": market.season_label,
        "season_state": market.season_state,
        "player_id": market.player_id,
        "player_name": market.player_name,
        "team_id": market.team_id,
        "position": market.position,
        "kind": market.kind,
        "base_1x": market.base_1x,
        "season_progress": market.season_progress,
        "game_days": market.game_days,
        "game_days_measured": market.game_days_measured,
        "month_share": list(market.month_share),
        "month_share_estimated": market.month_share_estimated,
        "rate_traded": market.rate_traded,
        "rate_sales": market.rate_sales,
        "shelf": [[rating, ask] for rating, ask in shelf[:OTD_SHELF_KEEP]],
        "shelf_count": market.shelf_count,
        "mint_cost": market.mint_cost,
        "mintable": market.mintable,
        **_build_json(market, auctions),
        "rungs": [_rung_json(rung) for rung in ladder],
        "best": None if best is None else best.tier,
        "weak": [rung.tier for rung in ladder if rung.tier in weak],
        "on_sale": _on_sale_json(market, best, auctions),
    }


def _otd_json(markets: tuple[PassMarket, ...], now: datetime) -> dict:
    """The daily-pay passes: every market with its rungs, then the picks and starters per sport by key.

    A season still being played (`season_state` "current") is served apart, in "current_markets". The feed sends one
    for each player with a deal, valued on weaker data than a past season's (no earnings log: game days from
    the sport's table, the months spread evenly), and it is for Deals (a deal's pass line, "Pass deals", the "For
    passes" sort) and for valuing a pass the member holds, never a suggestion: it is no pick and no starter, and
    "markets", what the Passes tab, the plan, Today's moves and the Discord picks read, holds the past seasons only.
    Their sports' calendars are in "sports" all the same: the browser walks their pay with them.

    "Today" for the payback walks is the snapshot's own day, in UTC.
    """
    today = now.astimezone(timezone.utc).date()
    ordered = sorted(markets, key=lambda m: (m.sport, m.season, m.kind, m.player_id, m.key))
    past = tuple(market for market in markets if market.season_state != "current")
    sports = sorted({market.sport for market in markets})
    return {
        "as_of": iso_z(now),
        "sports": {
            sport: {
                "claim_days": OTD_SPORT_DAYS[sport][0] if sport in OTD_SPORT_DAYS else None,
                "months": list(OTD_SPORT_MONTHS.get(sport, ())),
            }
            for sport in sports
        },
        "markets": [_pass_market_json(market, today, now) for market in ordered if market.season_state != "current"],
        "current_markets": [_pass_market_json(market, today, now) for market in ordered if market.season_state == "current"],
        "picks": pass_picks(past, today=today),
        "starters": starters(past, today=today),
    }


def otd_version(otd: dict) -> str:
    """A short content hash of the "otd" section, so a poll that already holds these passes can do without them.

    `as_of` counts only by its day, the only part of it the page reads: the hash moves when the passes do (or the day
    turns), not at every round."""
    content = {**otd, "as_of": otd.get("as_of", "")[:10]}
    text = json.dumps(content, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode()).hexdigest()[:OTD_VERSION_CHARS]


def _otd_rules() -> dict:
    """The pass constants the browser's planner needs, so it and the server agree."""
    return {
        "claims_per_sport_day": OTD_CLAIMS_PER_SPORT_DAY,
        "ladders": {kind: [[tier, rating, mult] for tier, rating, mult in tiers] for kind, tiers in OTD_LADDERS.items()},
        "player_limit_per_mult": OTD_PLAYER_LIMIT_PER_MULT,
        "no_limit": {kind: sorted(tiers) for kind, tiers in OTD_NO_LIMIT.items()},
        "team_limits": dict(OTD_TEAM_LIMITS),
        "fighter_limits": dict(OTD_FIGHTER_LIMITS),
        "limit_estimated_kinds": sorted(OTD_LIMIT_ESTIMATED_KINDS),
        "limit_estimated_sports": sorted(OTD_LIMIT_ESTIMATED_SPORTS),
        "no_limit_horizon_years": OTD_NO_LIMIT_HORIZON_YEARS,
        "payback_horizon_years": OTD_PAYBACK_HORIZON_YEARS,
        "mint_cost": dict(OTD_MINT_COST),
        "sport_months": {sport: list(months) for sport, months in OTD_SPORT_MONTHS.items()},
        "sport_days": {sport: list(days) for sport, days in OTD_SPORT_DAYS.items()},
        "weekly_days": {sport: list(days) for sport, days in OTD_WEEKLY_DAYS.items()},
        "same_weekdays": dict(OTD_SAME_WEEKDAYS),
        "projection_below": OTD_PROJECTION_BELOW,
        "full_at": OTD_FULL_AT,
        "ignore_ask_above": OTD_IGNORE_ASK_ABOVE,
        "ignore_ask_min_sales": OTD_IGNORE_ASK_MIN_SALES,
        "starter_tiers": list(OTD_STARTER_TIERS),
        "top": OTD_TOP,
        "budget_presets": list(OTD_BUDGET_PRESETS),
        "no_otd_tiers": sorted(OTD_NO_OTD_TIERS),
        "later": {
            "window_months": OTD_LATER_WINDOW_MONTHS,
            "share_below": OTD_LATER_SHARE_BELOW,
            "start_share": OTD_LATER_START_SHARE,
        },
    }


def _sales_by_sport(sales: tuple[Sale, ...], now: datetime, window: timedelta) -> Counter[str]:
    """How many sales each sport had in (now - window, now]."""
    since = now - window
    return Counter(sale.sport for sale in sales if since < sale.sold_at <= now)


def _pulse(sales: tuple[Sale, ...], now: datetime) -> dict:
    """Each sport's sales in the last PULSE_WINDOW_MIN minutes, busiest first, then by name; quiet sports left out."""
    counts = _sales_by_sport(sales, now, timedelta(minutes=PULSE_WINDOW_MIN))
    return {
        "window_min": PULSE_WINDOW_MIN,
        "sales": [[sport, count] for sport, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))],
    }


def _sports(raw: RawData, now: datetime) -> list[str]:
    """The sports with listings, busiest first by sales in the last SPORTS_RANK_WINDOW_H hours, then by name.

    A sport with no sales in that window counts zero, so it comes after every sport that has some.
    """
    counts = _sales_by_sport(raw.sales, now, timedelta(hours=SPORTS_RANK_WINDOW_H))
    return sorted({listing.sport for listing in raw.listings}, key=lambda sport: (-counts[sport], sport))


def _coverage_json(coverage: Mapping[str, object]) -> dict:
    """What the live feed says it covers, the four fields and no more: the sports it reads, whether its listings are
    all of them, how many hours of sales its prices rest on and when its pass figures were measured."""
    return {key: coverage[key] for key in ("sports", "listings_complete", "sales_window_h", "otd_as_of")}


def _challenges_json(challenges, now: datetime) -> list[dict]:
    """The challenges still running, soonest-ending first (those with no end last)."""
    live = [c for c in challenges if c.ends_at is None or c.ends_at > now]
    live.sort(key=lambda c: (c.ends_at is None, c.ends_at or now))
    return [{"title": c.title, "reward": c.reward, "ends_at": None if c.ends_at is None else iso_z(c.ends_at)}
            for c in live]


def _bidding_json(coverage) -> dict:
    """Bids heard in the last 10 minutes, per sport whose live bid stream is up (the live feed only)."""
    bids = (coverage or {}).get("bids") or {}
    return {sport: {"bids_10m": row["bids_10m"], "bidders_10m": row["bidders_10m"]}
            for sport, row in sorted(bids.items()) if row.get("live")}


def _push_json(push: dict | None) -> dict | None:
    """What the page needs to offer alerts: the public key and how often the server checks; None while push is off."""
    return None if push is None else {"public_key": push["public_key"], "check_s": push["check_s"]}


def build_snapshot(
    raw: RawData,
    now: datetime,
    version: int,
    demo: bool = False,
    push: dict | None = None,
    injuries: Any = None,
    resale: Any = None,
    accounts: bool = False,
    history: Any = None,
) -> dict:
    """The JSON-serialisable snapshot of the market as of `now`; the key names are the site's contract.

    `demo` says the data is the bundled sample (the fixture or its replay), not the live market: the screens
    then tag it "Sample data", and every deal links to Real's home page. `otd_version` names the "otd" section's
    content (see `otd_version`). `push` is the alerts dispatcher's link (its public key and check interval), or None
    while alerts are off: the page then offers none. A source that says what it covers (`raw.coverage`) puts it in
    "rules.coverage"; the screens then say honestly what the figures rest on. `injuries` (see `advisor.injuries`)
    adds ESPN's note on a hurt player to the deals and the moves ("injury"), and names the sports it covers right now
    ("rules.injury_sports"); without it nothing is said about health at all. `resale` (see `advisor.resale`) adds how
    many recent listings of cards like a deal's (its player's, in its rating band) sold ("resale") and says whether it
    has a table ("rules.resale"). `history` (see `advisor.price_history`) adds each move's market's finished days
    ("curve"), which the Prices page draws; without it, or with PRICE_CURVE_ON off, a move is served as before.
    """

    moves = market_moves(raw.sales, now)
    otd = _otd_json(raw.otd, now)
    rules = {
        "stale_after_s": STALE_AFTER_S,
        "poll_s": POLL_S,
        "fee": SELLER_FEE,
        "listing_fee": LISTING_FEE,
        "quicksell_per_point": QUICKSELL_PER_POINT,  # Rax Real's Quick Sell pays a card's rating point (measured)
        "after_fees_min_ref": AFTER_FEES_MIN_REF,
        "budget_presets": list(BUDGET_PRESETS),
        "demo": demo,
        "sell_curve": [[price, share] for price, share in SELL_CURVE],
        "twins": {"price_band": TWIN_PRICE_BAND, "max": TWIN_MAX},
        "otd": _otd_rules(),
        "photo_sports": sorted(PHOTO_SPORTS),  # every other sport shows initials: the page asks for no photo
    }
    if resale is not None:  # whether the resale table is there to speak from right now
        rules["resale"] = _resale_available(resale)
    if injuries is not None:  # the sports ESPN's list speaks for right now, none when it is out of reach
        rules["injury_sports"] = _injury_sports(injuries)
    if raw.coverage is not None:  # only a source that says what it covers (the live feed) adds it
        rules["coverage"] = _coverage_json(raw.coverage)
    return {
        "version": version,
        "generated_at": iso_z(now),
        "sports": _sports(raw, now),
        "deals": [
            _resold(
                _noted(_deal_json(deal, demo), injuries, deal.sport, deal.player_id, deal.player_name),
                resale, deal.sport, deal.player_id, deal.player_name, deal.rating,
            )
            for deal in find_deals(raw, now)
        ],
        "moves": {
            "risers": [
                _curved(_noted(_move_json(move), injuries, move.sport, move.player_id, move.player_name), history, move, now)
                for move in moves["risers"]
            ],
            "fallers": [
                _curved(_noted(_move_json(move), injuries, move.sport, move.player_id, move.player_name), history, move, now)
                for move in moves["fallers"]
            ],
        },
        "otd": otd,
        "otd_version": otd_version(otd),
        "levels": copy.deepcopy(LEVELS),
        "rules": rules,
        "pulse": _pulse(raw.sales, now),
        # our Discord invite, or None while there is none; the alerts' public key, or None while they are off
        # "support": the Real account a gift of Rax goes to, and one of its cards' links when set
        "links": {"community": COMMUNITY_URL, "push": _push_json(push), "accounts": accounts,
                  "support": {"account": SUPPORT_ACCOUNT, "url": SUPPORT_URL}},
        # what Real pays rax or packs for right now (the live feed only; empty otherwise)
        "challenges": _challenges_json(raw.challenges, now),
        # bids heard in the last 10 minutes per sport (the live feed's bid stream; empty otherwise)
        "bidding": _bidding_json(raw.coverage),
    }
