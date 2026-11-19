"""The free site's snapshot: what anyone who is not a member of our Discord server gets while the gate is on.

OTD Palace is free for everyone. Without Discord a visitor gets a real, useful site: the best few deals, a summary of
the prices moving, each sport's best passes and the guides. Members of our Discord server (free too) get everything.
This module builds the visitor's snapshot from the whole one, once per version (see `advisor.store`), field by field
from allowlists: a field added to the snapshot later is never published to visitors by accident, and nothing a member
alone may see (the other deals, the deals that just went away, the other moves, the other passes, a deal's list of
recent sales, the alerts' key, the pass deals) can reach a visitor through it. `locked` says how much more there is,
as counts only, so the page can say "See all 42 deals", "7 passes cost less to build today" or "Legendary 4" on the
locked rarity strip without holding them.
"""

import math

from advisor.pass_deals import said as pass_deals_said, teaser as pass_deals_teaser
from advisor.real import RARITY_NAMES
from advisor.rules import PUBLIC_DEALS, PUBLIC_MOVES, PUBLIC_PASSES_PER_SPORT
from advisor.share import safe_deals
from advisor.snapshot import otd_version

# The fields of a deal a visitor gets: all the page draws a deal with, but not `recent_sales` (a member's price history).
DEAL_KEYS = (
    "listing_id", "card_id", "sport", "season", "player_id", "player_name", "card_label", "rarity", "rating", "bucket",
    "mint", "kind", "price", "reference", "ref_source", "ref_tier", "ref_sample", "confidence", "discount", "gap",
    "flip_margin", "num_bids", "ends_at", "url", "per_point", "ref_per_point", "listed_at", "falling", "seen_at",
    "real_estimate", "injury", "resale",
)
MOVE_KEYS = (
    "sport", "season", "player_id", "player_name", "bucket", "median_recent", "median_base", "change", "sales_recent",
    "injury",
)
# The whole-snapshot parts that are the same for everyone: constants (levels, rules) and counts (pulse, bids, taken).
SHARED_KEYS = ("version", "generated_at", "sports", "levels", "rules", "pulse", "taken_10m", "challenges", "bidding")
# Marks the public variant's ETag ("7p", "7p-gz"), so a member's tag never matches a visitor's answer or the reverse.
PUBLIC_TAG = "p"


def _rows(value: object) -> list[dict]:
    return [row for row in value if isinstance(row, dict)] if isinstance(value, list) else []


def _pick(row: dict, keys: tuple[str, ...]) -> dict:
    return {key: row[key] for key in keys if key in row}


def _number(value: object) -> float | None:
    return float(value) if type(value) in (int, float) and math.isfinite(value) else None


def _rank(row: dict) -> tuple:
    """Best after fees first, as the page's own "best" sort: a deal that leaves Rax after Real's fees before one that
    does not, then the most left, then the deepest discount, then the lower listing id."""
    margin = _number(row.get("flip_margin")) or 0.0
    return (margin <= 0, -margin, -row["discount"], row["listing_id"])


def public_deals(snapshot: dict, limit: int = PUBLIC_DEALS) -> list[dict]:
    """The `limit` best deals anybody may be pointed at (`share.safe_deals`: the New level's, no auction, no falling
    market, no player likely to miss the next game), one per player and season, trimmed to DEAL_KEYS."""
    best: dict[tuple, dict] = {}
    for row in safe_deals(snapshot):
        group = (row["sport"], row["season"], row["player_id"])
        if group not in best or _rank(row) < _rank(best[group]):
            best[group] = row
    return [_pick(row, DEAL_KEYS) for row in sorted(best.values(), key=_rank)[:limit]]


def rarity_counts(deals: list[dict]) -> dict[str, int]:
    """How many of `deals` are of each of Real's eight rarities, keyed "0".."7" (all eight, 0 included). A rarity that
    is not one of them (missing, out of range, not a whole number) is counted under none: the feed's "General" for a
    card Real gave no rarity cannot be told apart from a real General, but anything else odd stays out of every chip."""
    counts = {str(index): 0 for index in range(len(RARITY_NAMES))}
    for row in deals:
        rarity = row.get("rarity")
        if type(rarity) is int and 0 <= rarity < len(RARITY_NAMES):
            counts[str(rarity)] += 1
    return counts


def _public_otd(otd: object) -> dict | None:
    """Each sport's PUBLIC_PASSES_PER_SPORT best passes and its starter pass: the picks, the starters and only the
    markets they name. None when the snapshot has no pass section."""
    if not isinstance(otd, dict):
        return None
    picks = otd.get("picks") if isinstance(otd.get("picks"), dict) else {}
    starters = otd.get("starters") if isinstance(otd.get("starters"), dict) else {}
    kept_picks = {sport: [key for key in keys if isinstance(key, str)][:PUBLIC_PASSES_PER_SPORT]
                  for sport, keys in picks.items() if isinstance(sport, str) and isinstance(keys, list)}
    kept_starters = {sport: key for sport, key in starters.items() if isinstance(sport, str) and isinstance(key, str)}
    named = {key for keys in kept_picks.values() for key in keys} | set(kept_starters.values())
    markets = [dict(market) for market in _rows(otd.get("markets"))
               if isinstance(market.get("key"), str) and market["key"] in named]
    return {
        "as_of": otd["as_of"] if isinstance(otd.get("as_of"), str) else "",
        "sports": otd.get("sports") if isinstance(otd.get("sports"), dict) else {},
        "markets": markets,
        "picks": kept_picks,
        "starters": kept_starters,
    }


def _support(value: object) -> dict | None:
    """The gift's account and link as the free site repeats them: a plain name and a link or None, nothing else."""
    if not isinstance(value, dict) or not isinstance(value.get("account"), str) or not value["account"]:
        return None
    url = value.get("url")
    return {"account": value["account"], "url": url if isinstance(url, str) else None}


def bare_snapshot(snapshot: dict) -> dict:
    """The free site's snapshot with nothing from the market in it: what a visitor gets should `public_snapshot` ever
    fail on a snapshot it cannot read (never the whole one instead)."""
    out = {key: snapshot[key] for key in ("version", "generated_at") if key in snapshot}
    return out | {"sports": [], "deals": [], "gone": [], "moves": {"risers": [], "fallers": []},
                  "links": {"community": None, "push": None, "accounts": False},
                  "locked": {"deals": 0, "risers": 0, "fallers": 0, "passes": 0, "alerts": False, "accounts": False,
                             "pass_deals": {"passes": 0, "best_pct": None}, "by_rarity": rarity_counts([])}}


def public_snapshot(snapshot: dict) -> dict:
    """The visitor's snapshot of `snapshot` (see the module's docstring). Same keys as the whole one, so the page reads
    it the same way, plus `locked`."""
    out = {key: snapshot[key] for key in SHARED_KEYS if key in snapshot}
    deals = _rows(snapshot.get("deals"))
    moves = snapshot.get("moves") if isinstance(snapshot.get("moves"), dict) else {}
    risers, fallers = _rows(moves.get("risers")), _rows(moves.get("fallers"))
    links = snapshot.get("links") if isinstance(snapshot.get("links"), dict) else {}
    out["deals"] = public_deals(snapshot)
    out["gone"] = []  # the deals that just went away are the whole list's: a member's
    out["moves"] = {
        "risers": [_pick(row, MOVE_KEYS) for row in risers[:PUBLIC_MOVES]],
        "fallers": [_pick(row, MOVE_KEYS) for row in fallers[:PUBLIC_MOVES]],
    }
    otd = _public_otd(snapshot.get("otd"))
    if otd is not None:
        out["otd"] = otd
        out["otd_version"] = otd_version(otd)
    # The invite stays (it is how people join); the alerts and the account link are for members.
    community = links.get("community")
    out["links"] = {"community": community if isinstance(community, str) else None, "push": None, "accounts": False}
    support = _support(links.get("support"))  # where a gift of Rax goes: said to everyone, as the invite is
    if support is not None:
        out["links"]["support"] = support
    full_otd = snapshot.get("otd") if isinstance(snapshot.get("otd"), dict) else {}
    out["locked"] = {
        "deals": len(deals),
        "risers": len(risers),
        "fallers": len(fallers),
        "passes": len(_rows(full_otd.get("markets"))),
        "alerts": bool(links.get("push")),
        "accounts": links.get("accounts") is True,
        # "Pass deals" is a member's block: two numbers of it per level, what the block shows (advisor/pass_deals.py).
        "pass_deals": pass_deals_said(pass_deals_teaser(full_otd)),
        # The locked rarity strip: how many of every deal a member sees are of each rarity. Eight counts, nothing else.
        "by_rarity": rarity_counts(deals),
    }
    return out
