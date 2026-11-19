"""Daily-pay passes: what each rarity of a pass costs to build, what it pays, and when it pays its cost back.

A pass pays, on each anniversary of a day its player earned in that season, that day's 1x earnings times its rarity's
multiplier, until it has paid its lifetime limit. A season still being played also pays its remaining games live;
that live pay is never stopped by the limit but counts toward it. General pays nothing On This Day (OTD_NO_OTD_TIERS): only the live games of a
season still being played. Every figure here is the pass on its own: it is assumed to win each claim it is
eligible for, which holds for a visitor with at most one other pass paying on the same days in that sport (Real pays
OTD_CLAIMS_PER_SPORT_DAY passes per sport each day). In NFL and college football "the same days" means the same
season, whatever the team (OTD_WEEKLY_DAYS): a third pass of a season wins only about half of its claims, a fourth a
third. Golf passes of one season, and of seasons with the same weekdays (OTD_SAME_WEEKDAYS), share their tournament
Sundays the same way. The browser's planner replays that (lib/passes.ts replaySport); nothing here does, as nothing
here holds more than one pass.

Only the tiers' entry ratings and entry multipliers are modelled. Real's player-cards page does list the levels inside
a tier (Legendary 2-5, Mystic 2-10, Iconic 2-20, each with its rating and multiplier; the limit stays 500 x multiplier), but
the site buys to a tier's entry, so those levels are not shown yet. A number the data cannot back is None, never a guess. The one stand-in is flagged: a market whose month
shares cannot be used (PassMarket.month_share_estimated) is walked over its sport's months instead.
"""

import calendar
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date

from advisor.model import PassMarket
from advisor.pass_rates import market_build_rate
from advisor.rules import (
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
    OTD_PAYBACK_HORIZON_YEARS,
    OTD_PLAYER_LIMIT_PER_MULT,
    OTD_PROJECTION_BELOW,
    OTD_SPORT_MONTHS,
    OTD_STARTER_TIERS,
    OTD_TEAM_LIMITS,
    OTD_TOP,
)

# Sums of floats drift by a few units in the last place; a payback that lands exactly on a month's end must not slip
# into the next month because of it.
_ROUNDING = 1e-9


@dataclass(frozen=True)
class Rung:
    """One rarity a pass can be built to, from the rating already held: its cost, its pay and its payback."""

    tier: str
    rating: int  # the rating that enters the tier
    mult: float  # the tier's multiplier at entry
    limit: float | None  # the most the pass pays over its life; None when the tier has no limit
    limit_estimated: bool  # Real states no limit for this pass; `limit` follows the player law as an estimate
    rating_to_add: float
    cost: float | None  # the mint (when the pass is not held yet) plus the rating at the traded rate; None if unpriced
    route: str  # "mint" (General, a season being played: the mint alone), "mint+cards" or "cards"
    year_rax: float  # what it pays in the next 12 months
    year_capped: bool  # the limit cuts what the season's anniversaries would pay
    projected: bool  # the season is under OTD_PROJECTION_BELOW played, so its whole-season total is a projection
    per_game_day: float | None  # the mean pay of one game day at this rarity
    years_to_limit: float | None  # years of full seasons' pay to reach the limit; None without one (or at 0)
    year_per_rax: float | None  # the next 12 months' pay per rax spent: the ranking figure
    lifetime_per_rax: float | None  # the limit (live pay counts toward it) per rax spent; an unlimited tier counts its horizon
    pays_back: bool | None  # paid back within OTD_PAYBACK_HORIZON_YEARS, its lifetime beating its cost; None if unpriced
    payback_months: float | None  # months from today until it has paid its cost back
    payback_month: str | None  # the calendar month that happens in, "YYYY-MM"


@dataclass(frozen=True)
class OnSale:
    """The cards on sale now toward a rating: cheapest per point first, the parked asks left out."""

    on_sale_rating: float
    on_sale_cost: int
    enough: bool  # the shelf holds the whole rating asked for
    # Read from the shelf's auctions (advisor/pass_rates.py live_auctions): whether every card taken is at a pay a buyer
    # can count on now; False when one is only an auction opening at its pay. None for the old shelf (asks).
    firm: bool | None = None


def is_liquid(market: PassMarket) -> bool:
    """Whether the pass can be built at all: its cards trade, or some are on sale."""
    return market.rate_sales > 0 or market.shelf_count > 0


def _limit(market: PassMarket, tier: str, mult: float) -> tuple[float | None, bool]:
    """The tier's lifetime limit and whether it is an estimate.

    A player pass stops at 500 x its multiplier (Iconic has no limit); a team pass and a fighter's pass follow their
    own schedules. Real never states a limit for any soccer pass, so those get the player law, flagged. A tier that
    pays nothing On This Day (General) has a limit of 0, stated by Real for every pass.
    """
    if tier in OTD_NO_OTD_TIERS:
        return 0.0, False
    estimated = market.kind in OTD_LIMIT_ESTIMATED_KINDS or market.sport in OTD_LIMIT_ESTIMATED_SPORTS
    if market.kind == "team" and not estimated:
        return OTD_TEAM_LIMITS[tier], False
    if tier in OTD_NO_LIMIT.get(market.kind, ()):
        return None, estimated
    if market.kind == "fighter" and not estimated:
        return OTD_FIGHTER_LIMITS[tier], False
    return OTD_PLAYER_LIMIT_PER_MULT * mult, estimated


def _month_weights(market: PassMarket) -> list[float]:
    """The share of a season's pay that falls in each calendar month, January first, adding up to exactly 1.

    Shares that do not add up to 1 are scaled. Unusable ones (market.month_share_estimated) give way to the sport's
    months, evenly, or to every month of the year for a sport whose months are unknown.
    """
    if not market.month_share_estimated:
        shares = [max(0.0, share) for share in market.month_share]
        total = sum(shares)
        return [share / total for share in shares]
    months = OTD_SPORT_MONTHS.get(market.sport) or range(1, 13)
    return [1 / len(months) if month in months else 0.0 for month in range(1, 13)]


def _payback(
    cost: float, full: float, weights: list[float], lifetime: float, today: date
) -> tuple[bool, float | None, str | None]:
    """(pays back, months from today, "YYYY-MM") for a pass paying `full` a year, spread over the months by
    `weights`, that stops after `lifetime` in all.

    The walk goes month by month from today: each month pays `full` times its share, today's month only for the
    days left in it, and the walk goes on into the following years, for OTD_PAYBACK_HORIZON_YEARS at most, until
    the cost is covered. It never is when the lifetime does not beat the cost (a pass that only breaks even, its
    limit no more than its price, does not pay back), when the season pays nothing, or when the horizon ends first.
    """
    if cost <= 0:
        return True, 0.0, f"{today.year:04d}-{today.month:02d}"
    if full <= 0 or lifetime <= cost * (1 + _ROUNDING):
        return False, None, None
    horizon = 12.0 * OTD_PAYBACK_HORIZON_YEARS  # in months from today
    year, month = today.year, today.month
    days = calendar.monthrange(year, month)[1]
    length = (days - today.day + 1) / days  # today's month counts from today on
    paid = elapsed = 0.0
    while elapsed < horizon:
        length = min(length, horizon - elapsed)  # the horizon ends part-way into the month today falls in
        per_month = full * weights[month - 1]
        if per_month > 0 and paid + per_month * length >= cost * (1 - _ROUNDING):
            return True, elapsed + (cost - paid) / per_month, f"{year:04d}-{month:02d}"
        paid += per_month * length
        elapsed += length
        length = 1.0
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return False, None, None


def rungs(market: PassMarket, *, today: date, held_rating: float = 0, minted: bool = False) -> list[Rung]:
    """One rung per tier of the pass's ladder that takes more rating than `held_rating`, lowest first.

    `held_rating` is the rating the visitor already holds for this player-season (a negative card counts by its
    size); 0 means the pass is not held yet (unless `minted`: a General held with no rating), so its cost includes
    the mint when the pass can be minted. The cards are priced at the build rate per point (advisor/pass_rates.py
    build_rate: the feed's cheapest cell with enough sales, else the traded rate as before). General takes no
    rating, so the mint alone buys it; it pays nothing On This Day, only the live games left of a season being
    played, so it is a rung only while such games are left. A current season with nothing played yet cannot be
    projected and has no rungs; nor has a pass whose kind has no ladder.
    """
    ladder = OTD_LADDERS.get(market.kind)
    current = market.season_state == "current"
    progress = min(1.0, market.season_progress) if current else 1.0
    if not ladder or progress <= 0:
        return []
    season_1x = market.base_1x / progress  # a current season projected to its end
    weights = _month_weights(market)
    held = abs(held_rating)
    with_mint = held == 0 and market.mintable and not minted
    mint = market.mint_cost if market.mint_cost is not None else OTD_MINT_COST.get(market.kind, 0)
    rate = market_build_rate(market).rate
    out = []
    for tier, rating, mult in ladder:
        mint_only = with_mint and rating == 0  # General, for a pass not held yet
        if rating <= held and not mint_only:
            continue
        rating_to_add = rating - held
        cost = None
        if mint_only:
            cost = mint  # no card to price
        elif rate is not None:
            cost = (mint if with_mint else 0) + rating_to_add * rate
        limit, limit_estimated = _limit(market, tier, mult)
        full = season_1x * mult  # a whole season's pay at this rarity
        played = full * progress  # paid again on its anniversaries, under the limit
        live = full - played  # the games still to come pay live; live pay is never stopped by the limit...
        # ...but it fills it (habits audit 4f, B9): the limit counts everything a pass earns, so On This Day keeps only
        # what the live games to come leave of it. A pass built now has earned nothing; a held one is already passed
        # as limit minus earned by its caller. Medium confidence on the live part: the live games are projected.
        room = None if limit is None else max(0.0, limit - live)
        if limit == 0 and live <= 0:
            continue  # pays nothing On This Day and has no game left to pay live: nothing at all
        year_rax = live + (played if room is None else min(played, room))
        lifetime = full * OTD_NO_LIMIT_HORIZON_YEARS if room is None else room + live
        # What the payback walk spreads over the months: the whole season, or only its live games for a tier that pays
        # nothing On This Day (an approximation: those games are spread like the season's, capped by the lifetime).
        flow = live if limit == 0 else full
        if cost is None:
            pays_back, payback_months, payback_month = None, None, None
        else:
            pays_back, payback_months, payback_month = _payback(cost, flow, weights, lifetime, today)
        out.append(Rung(
            tier=tier,
            rating=rating,
            mult=mult,
            limit=limit,
            limit_estimated=limit_estimated,
            rating_to_add=rating_to_add,
            cost=cost,
            route="mint" if mint_only else "mint+cards" if with_mint else "cards",
            year_rax=year_rax,
            year_capped=bool(limit) and played > (room or 0.0),  # a General's 0 is no cap: it never pays On This Day
            projected=current and progress < OTD_PROJECTION_BELOW,
            per_game_day=full / market.game_days if market.game_days else None,
            years_to_limit=limit / full if limit and full > 0 else None,  # none for a General's 0: never reached
            year_per_rax=year_rax / cost if cost else None,
            lifetime_per_rax=lifetime / cost if cost else None,
            pays_back=pays_back,
            payback_months=payback_months,
            payback_month=payback_month,
        ))
    return out


def best_rung(ladder: Sequence[Rung], *, budget: float | None = None) -> Rung | None:
    """The rung paying the most in the next 12 months per rax spent, among those that pay back and cost at most
    `budget`; on a tie, the lower rung. None when no rung qualifies."""
    candidates = [
        rung for rung in ladder
        if rung.pays_back and rung.year_per_rax is not None and (budget is None or rung.cost <= budget)
    ]
    return max(candidates, key=lambda rung: rung.year_per_rax, default=None)


def weak_rungs(ladder: Sequence[Rung]) -> set[str]:
    """The tiers whose lifetime pay per rax is below both neighbours': a step that costs much more than the one
    below for little more pay.

    Only rungs with a limit are compared: an unlimited tier's lifetime is a horizon count, not a lifetime, so it is
    never a neighbour and never weak. The first and last of the rungs compared, and rungs without a cost, are never
    weak."""
    limited = [rung for rung in ladder if rung.limit is not None]
    weak = set()
    for below, rung, above in zip(limited, limited[1:], limited[2:], strict=False):
        values = (below.lifetime_per_rax, rung.lifetime_per_rax, above.lifetime_per_rax)
        if None not in values and values[1] < values[0] and values[1] < values[2]:
            weak.add(rung.tier)
    return weak


def _rank(market: PassMarket, rung: Rung) -> tuple:
    """Soonest paid back from today first (a season whose pay is months away waits for it), then the most rax a year
    per rax spent, the bigger year, the lower player id and the earlier season."""
    return (rung.payback_months, -rung.year_per_rax, -rung.year_rax, market.player_id, market.season)


def pass_picks(markets: Sequence[PassMarket], *, today: date, top: int = OTD_TOP) -> dict[str, list[str]]:
    """The keys of the `top` passes of each sport, best first by `_rank` of their best rung: paid back soonest from
    today, walking the season's months (an MLB pass bought in November waits for March), then the most rax a year
    per rax spent; ties go to the bigger year, then to the lower player id, then to the earlier season.

    A pass with no rung that pays back and can be priced, or whose cards neither trade nor sit on sale, is left out,
    and so is a sport with no pass. Budgets are applied in the browser.
    """
    by_sport: dict[str, list[tuple]] = defaultdict(list)
    for market in markets:
        if not is_liquid(market):
            continue
        best = best_rung(rungs(market, today=today))
        if best is not None:
            by_sport[market.sport].append((_rank(market, best), market.key))
    return {sport: [key for _, key in sorted(ranked)[:top]] for sport, ranked in sorted(by_sport.items())}


def on_sale(market, need_rating: float, auctions=None, *, firm_only: bool = False) -> OnSale:
    """The cards on sale toward `need_rating`, cheapest per rating point first (the cheaper card first on a tie),
    taken until the rating is reached or the shelf runs out.

    `auctions`, when the feed sent the shelf's auction state, is that shelf at the moment asked
    (advisor/pass_rates.py live_auctions: (rating, pay, firm) of each auction still open): each card is then priced at
    its `pay` and the old shelf of asks is not read; `firm` says whether every card taken is at a firm pay, and
    `firm_only` leaves the openings out (what a pass deal may count). Without them, the old shelf, as before.

    An ask above OTD_IGNORE_ASK_ABOVE times the build rate per point (advisor/pass_rates.py build_rate) is parked, not
    real supply, and is left out; that is judged only when the rate comes from at least OTD_IGNORE_ASK_MIN_SALES
    sales. Ratings are counted in hundredths, as Real shows them (7.25), so they add up exactly and the browser
    (lib/passes.ts onSale) counts the same: in tenths, a rating ending in 5 hundredths was rounded down here (a half to
    even) and up there. `market` is a PassMarket, or anything with its rate fields (advisor/pass_deals.py).
    """
    need = round(max(0.0, need_rating) * 100)
    build = market_build_rate(market)
    ceiling = None
    if build.rate is not None and build.sales >= OTD_IGNORE_ASK_MIN_SALES:
        ceiling = OTD_IGNORE_ASK_ABOVE * build.rate
    if auctions is None:
        cards = ((rating, ask, True) for rating, ask in market.shelf)
    else:
        cards = ((rating, pay, firm) for rating, pay, firm in auctions if firm or not firm_only)
    offers = sorted(
        (
            (ask / abs(rating), ask, round(abs(rating) * 100), firm)
            for rating, ask, firm in cards
            if rating != 0 and ask > 0 and (ceiling is None or ask / abs(rating) <= ceiling)
        ),
    )
    hundredths = cost = 0
    firm_all = True
    for _, ask, rating, firm in offers:
        if hundredths >= need:
            break
        hundredths += rating
        cost += ask
        firm_all = firm_all and firm
    return OnSale(on_sale_rating=hundredths / 100, on_sale_cost=cost, enough=hundredths >= need,
                  firm=None if auctions is None else firm_all)


def starters(markets: Sequence[PassMarket], *, today: date) -> dict[str, str]:
    """For each sport, the key of the pass whose OTD_STARTER_TIERS rung ranks first by `_rank` (paid back soonest from
    today, then the most rax a year per rax spent): the cheapest way in for a newcomer. Only passes that can be built and pay back count, and only on figures
    that are not projections (a past season, or a current one at least OTD_PROJECTION_BELOW played); ties as in
    `pass_picks`. A sport with none is left out."""
    best: dict[str, tuple] = {}
    for market in markets:
        if not is_liquid(market):
            continue
        for rung in rungs(market, today=today):
            if rung.projected:
                break  # every rung of a pass shares its season's projection
            if rung.tier in OTD_STARTER_TIERS and rung.pays_back and rung.year_per_rax is not None:
                ranked = (_rank(market, rung), market.key)
                if market.sport not in best or ranked < best[market.sport]:
                    best[market.sport] = ranked
    return {sport: best[sport][1] for sport in sorted(best)}
