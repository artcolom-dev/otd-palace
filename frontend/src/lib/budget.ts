// "What can I do with 840 Rax?": passes first. The passes a balance can build (each pays its player's game days again,
// a year on, and this season's games live), the best set of deals it can buy, and which of the two gives more back over
// the next 12 months, on one yardstick: the Rax back within a year on top of what was paid (a pass's year of pay; a
// deal's margin after Real's fees if the cards are resold at their usual price). Pure, and worked out on this device from
// the served snapshot; nothing leaves the page.
//
// Why passes usually win (the internal research notes, headline 2 and 6): a Common on a top earner
// pays back in about 2 to 3.5 months in NBA, NHL, NFL and college basketball, a Legendary in 2.3 to 4.4; the median deal
// is a 70-Rax card bought at 40 that leaves about +3 Rax after fees, and 47 % of the deals shown lose Rax if resold.
// Where the data says otherwise the advice follows the data: a pass whose sport is idle for months (a past MLB season
// in November) is not offered now but named for later, with the month to buy it in (`paysLater`); a balance below the
// cheapest pass that pays back goes to deals. Deals are counted as one round: our data does not show flips repeating
// at a margin (deals are rare, half lose after fees, and a quarter of listed value does not sell).
import { filterDeals } from "../data/filters";
import type { LevelKey, Prefs } from "../data/prefs";
import type { Deal, Otd, OtdRules, PassMarket, PassRung, PassSport, Snapshot } from "../data/types";
import { about, monthWord, paysLaterText, spanText, titleText } from "../content/passWords";
import { formatRax } from "./format";
import { OFFER_ACCEPTED, OFFER_LEVEL, type OfferHint, offerHint, oneIn } from "./offers";
import { type Holding, type PassBasis, breaksEvenAtBest, dayOf, isLiquid, monthName, payFrom, paybackTogether, paysLater, planHoldings } from "./passes";
import { sportLabel } from "./words";

/** A set of deals to buy: what it costs, what the cards usually sell for, and the difference. */
export interface Basket {
  deals: Deal[]; // the biggest saving first
  spent: number;
  usual: number; // the usual prices of the cards, added
  saved: number; // usual − spent
  left: number; // the balance not spent
}

/** The balance is counted in steps this small at most this many times: a big balance rounds each price up to a step. */
const MAX_STEPS = 3000;

const groupOf = (d: Deal) => `${d.sport}:${d.season}:${d.player_id}`;
const saving = (d: Deal) => d.reference - d.price;

function basketOf(deals: Deal[], balance: number): Basket {
  const sorted = [...deals].sort((a, b) => saving(b) - saving(a) || a.price - b.price || a.listing_id - b.listing_id);
  const spent = sorted.reduce((sum, d) => sum + d.price, 0);
  const usual = sorted.reduce((sum, d) => sum + d.reference, 0);
  return { deals: sorted, spent, usual, saved: usual - spent, left: balance - spent };
}

/**
 * The deals that save the most Rax within `balance`, with at most one deal of any player-season (a card of one
 * player-season is the same market; a listing's target and its bid are one pick). An exact search (each player-season
 * is one choice: skip it or take one of its deals), not a greedy pass; a balance over 3,000 Rax is counted in coarser
 * steps with every price rounded up, so the total never goes past the balance.
 */
export function bestBasket(deals: readonly Deal[], balance: number): Basket {
  const money = Number.isFinite(balance) ? Math.max(0, Math.floor(balance)) : 0;
  const groups = new Map<string, Deal[]>();
  for (const d of deals) {
    if (d.price > money || saving(d) <= 0) continue;
    groups.set(groupOf(d), [...(groups.get(groupOf(d)) ?? []), d]);
  }
  if (money === 0 || groups.size === 0) return basketOf([], money);

  const step = Math.max(1, Math.ceil(money / MAX_STEPS));
  const cap = Math.floor(money / step);
  const width = cap + 1;
  const choices = [...groups.values()].map((g) => g.sort((a, b) => a.price - b.price || a.listing_id - b.listing_id));
  const took = new Int16Array(choices.length * width).fill(-1);
  let best = new Float64Array(width);
  choices.forEach((options, g) => {
    const next = best.slice();
    options.forEach((d, k) => {
      const weight = Math.ceil(d.price / step);
      const value = saving(d);
      for (let c = weight; c <= cap; c++) {
        const v = best[c - weight]! + value;
        if (v > next[c]!) {
          next[c] = v;
          took[g * width + c] = k;
        }
      }
    });
    best = next;
  });

  const picked: Deal[] = [];
  let c = cap;
  for (let g = choices.length - 1; g >= 0; g--) {
    const k = took[g * width + c]!;
    if (k < 0) continue;
    const d = choices[g]![k]!;
    picked.push(d);
    c -= Math.ceil(d.price / step);
  }
  return basketOf(picked, money);
}

/** The pass a balance could go into: one rung of one pass. */
export interface PassStep {
  market: PassMarket;
  rung: PassRung;
}

/** Whether rung `a` goes before rung `b`: more Rax a year, then the better return per Rax, then the lower cost. */
function before(a: PassRung, b: PassRung): boolean {
  if (a.year_rax !== b.year_rax) return a.year_rax > b.year_rax;
  const ar = a.year_per_rax ?? -Infinity;
  const br = b.year_per_rax ?? -Infinity;
  if (ar !== br) return ar > br;
  return (a.cost ?? Infinity) < (b.cost ?? Infinity);
}

/**
 * The passes a balance could go into, at most `count`: for each pass, the rung the balance reaches that pays the most
 * Rax a year among those that pay back and can be priced; then the passes in that same order (more Rax a year, then
 * the better return per Rax, then the lower cost). These are the server's figures for a pass on its own: an estimate
 * for the visitor, who may already hold part of it.
 */
export function bestPassSteps(markets: readonly PassMarket[], balance: number, count: number): PassStep[] {
  const steps: PassStep[] = [];
  for (const market of markets) {
    let top: PassRung | null = null;
    for (const rung of market.rungs) {
      if (rung.cost === null || rung.cost <= 0 || rung.cost > balance || rung.pays_back !== true || !(rung.year_rax > 0)) continue;
      if (!top || before(rung, top)) top = rung;
    }
    if (top) steps.push({ market, rung: top });
  }
  steps.sort((a, b) => (before(a.rung, b.rung) ? -1 : before(b.rung, a.rung) ? 1 : 0));
  return steps.slice(0, Math.max(0, count));
}

/** The one pass rung the balance reaches that pays the most Rax a year (see bestPassSteps), or null. */
export function bestPassStep(markets: readonly PassMarket[], balance: number): PassStep | null {
  return bestPassSteps(markets, balance, 1)[0] ?? null;
}

// ---------- passes first ----------

/** A pass the balance builds: one rung of one pass, and what its cards would cost by offers. */
export interface RoutePick {
  market: PassMarket;
  rung: PassRung & { cost: number };
  offer: OfferHint | null;
}

/** A pass worth building later: its sport pays only from `from` (a calendar month); buy it in `buy`. */
export interface LaterPick {
  market: PassMarket;
  rung: PassRung & { cost: number };
  from: number;
  buy: number;
}

/** The passes a balance can build now, together. */
export interface PassRoute {
  picks: RoutePick[]; // most Rax a year first
  spent: number;
  year: number; // what they pay in the next 12 months, together (each wins its claims: at most the sport's claims a day)
  payback_months: number | null; // when they have paid `spent` back, together; null after the next 12 months
  payback_month: string | null; // "YYYY-MM"
  first_pay: number | null; // the first month that pays, 0 = this one; null when nothing pays within 12 months
  offer_spent: number | null; // the same passes with their cards bought by offers (lib/offers.ts); null: no card to buy
  cheapest: number | null; // the cheapest pass that pays back now, whatever the balance; null: none
  later: LaterPick | null; // the best pass that only pays months from now, for when to buy it
}

export interface RouteOptions {
  level: LevelKey;
  sport?: string; // one sport, or "all" / "mine" / absent for every sport
  holdings?: readonly Holding[]; // the passes this device holds: they take claims, and are never offered again
  held?: readonly PassBasis[]; // the markets those passes resolve against (the snapshot's, plus stored ones)
  sports?: Record<string, PassSport>;
}

/**
 * Whether the advice builds this rung (the budget buddy's route, Deals' pass deals): it pays back, can be priced, pays
 * something, does more than break even; for New, it is no projection and pays back within a year.
 */
export function routeRungOk(r: PassRung, level: LevelKey): r is PassRung & { cost: number } {
  return (
    r.pays_back === true && r.cost !== null && r.cost > 0 && r.year_rax > 0 && !breaksEvenAtBest(r) &&
    (level !== "new" || (!r.projected && (r.payback_months ?? Infinity) <= 12))
  );
}

/**
 * The live passes (not spent) the visitor holds in each sport: each takes one of the sport's claims a day, so the advice
 * builds at most `claims_per_sport_day` minus this many more there (the budget buddy's route, Deals' pass deals).
 */
export function liveBySport(holdings: readonly Holding[], markets: readonly PassBasis[], rules: OtdRules, sports?: Record<string, PassSport>): Record<string, number> {
  const live: Record<string, number> = {};
  if (holdings.length === 0) return live;
  for (const p of planHoldings(holdings, markets, rules, sports).held) {
    if (!p.spent) live[p.market.sport] = (live[p.market.sport] ?? 0) + 1;
  }
  return live;
}

/** Passes of one sport kept for the search: the most promising this many by return per Rax, and as many by pay a year. */
const ROUTE_TOP = 12;

type Option = { cost: number; year: number; picks: { market: PassMarket; rung: PassRung & { cost: number } }[] };

/** The sets of at most `allow` passes of one sport within the balance, one rung each, that no other set beats on both
 * cost and pay (the rest can never be the best). */
function sportOptions(cands: { market: PassMarket; rungs: (PassRung & { cost: number })[] }[], allow: number, balance: number): Option[] {
  const byRatio = [...cands].sort((a, b) => Math.max(...b.rungs.map((r) => r.year_rax / r.cost)) - Math.max(...a.rungs.map((r) => r.year_rax / r.cost)));
  const byYear = [...cands].sort((a, b) => Math.max(...b.rungs.map((r) => r.year_rax)) - Math.max(...a.rungs.map((r) => r.year_rax)));
  const kept = [...new Set([...byRatio.slice(0, ROUTE_TOP), ...byYear.slice(0, ROUTE_TOP)])];
  const all: Option[] = [{ cost: 0, year: 0, picks: [] }];
  const walk = (start: number, depth: number, base: Option) => {
    for (let i = start; i < kept.length; i++) {
      for (const rung of kept[i]!.rungs) {
        const cost = base.cost + rung.cost;
        if (cost > balance) continue;
        const next: Option = { cost, year: base.year + rung.year_rax, picks: [...base.picks, { market: kept[i]!.market, rung }] };
        all.push(next);
        if (depth + 1 < allow) walk(i + 1, depth + 1, next);
      }
    }
  };
  if (allow > 0) walk(0, 0, all[0]!);
  all.sort((a, b) => a.cost - b.cost || b.year - a.year);
  const front: Option[] = [];
  for (const o of all) if (front.length === 0 || o.year > front[front.length - 1]!.year) front.push(o);
  return front;
}

/**
 * The passes a balance builds now that pay the most over the next 12 months, together: at most as many in a sport as it
 * pays claims a day (counting the live passes held there), so each wins every claim it is eligible for and its own
 * figures add up. Never a team pass (its rating has no price), one that does not trade, one already held, one that only
 * breaks even, or one whose pay is months away (that one is `later`). New: paid back within a year, never a projection.
 * An exact search over each sport's most promising passes; a balance over 3,000 Rax is counted in coarser steps, every
 * price rounded up, so the total never goes past it.
 */
export function passRoute(otd: Pick<Otd, "markets" | "as_of" | "sports">, rules: OtdRules, balance: number, options: RouteOptions): PassRoute {
  const money = Number.isFinite(balance) ? Math.max(0, Math.floor(balance)) : 0;
  const today = dayOf(otd.as_of);
  const only = sportOf(options.sport ?? "all");
  const holdings = options.holdings ?? [];
  const heldKeys = new Set(holdings.map((h) => h.key));
  const live = liveBySport(holdings, options.held ?? otd.markets, rules, options.sports ?? otd.sports);
  const ok = (r: PassRung) => routeRungOk(r, options.level);

  let cheapest: number | null = null;
  let later: LaterPick | null = null;
  const bySport = new Map<string, { market: PassMarket; rungs: (PassRung & { cost: number })[] }[]>();
  for (const market of otd.markets) {
    if (market.kind === "team" || !isLiquid(market) || heldKeys.has(market.key)) continue;
    if (only !== null && market.sport !== only) continue;
    const rungs = market.rungs.filter(ok);
    if (rungs.length === 0) continue;
    const wait = paysLater(market, rules, today);
    if (wait) {
      const best = rungs.reduce((a, b) => (b.year_rax / b.cost > a.year_rax / a.cost ? b : a));
      if (!later || best.year_rax / best.cost > later.rung.year_rax / later.rung.cost) later = { market, rung: best, ...wait };
      continue;
    }
    for (const r of rungs) cheapest = cheapest === null ? r.cost : Math.min(cheapest, r.cost);
    const fits = rungs.filter((r) => r.cost <= money);
    if (fits.length === 0) continue;
    const list = bySport.get(market.sport);
    if (list) list.push({ market, rungs: fits });
    else bySport.set(market.sport, [{ market, rungs: fits }]);
  }

  // Each sport is one choice among its sets; the sports together, a knapsack on the balance.
  const groups = [...bySport.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([sport, cands]) => sportOptions(cands, Math.max(0, rules.claims_per_sport_day - (live[sport] ?? 0)), money).slice(1));
  const step = Math.max(1, Math.ceil(money / MAX_STEPS));
  const cap = Math.floor(money / step);
  const width = cap + 1;
  const took = new Int32Array(Math.max(1, groups.length * width)).fill(-1);
  let best = new Float64Array(width);
  groups.forEach((opts, g) => {
    const next = best.slice();
    opts.forEach((o, k) => {
      const w = Math.ceil(o.cost / step);
      for (let c = w; c <= cap; c++) {
        const v = best[c - w]! + o.year;
        if (v > next[c]!) {
          next[c] = v;
          took[g * width + c] = k;
        }
      }
    });
    best = next;
  });
  const chosen: RoutePick[] = [];
  let c = cap;
  for (let g = groups.length - 1; g >= 0; g--) {
    const k = took[g * width + c]!;
    if (k < 0) continue;
    const o = groups[g]![k]!;
    for (const p of o.picks) chosen.push({ ...p, offer: offerHint(p.market, p.rung, rules, today) });
    c -= Math.ceil(o.cost / step);
  }
  chosen.sort((a, b) => b.rung.year_rax - a.rung.year_rax || a.rung.cost - b.rung.cost || (a.market.key < b.market.key ? -1 : 1));

  const spent = chosen.reduce((s, p) => s + p.rung.cost, 0);
  const year = chosen.reduce((s, p) => s + p.rung.year_rax, 0);
  const flows = chosen.map((p) => payFrom(p.market, p.rung.mult, p.rung.limit, rules, today));
  const back = chosen.length ? paybackTogether(flows, spent, today) : null;
  const firstPay = chosen.length ? Array.from({ length: 12 }, (_, i) => flows.reduce((s, f) => s + (f[i] ?? 0), 0)).findIndex((v) => v > 1e-9) : -1;
  const offered = chosen.some((p) => p.offer !== null);
  return {
    picks: chosen,
    spent,
    year,
    payback_months: back ? back.months : null,
    payback_month: back ? back.month : null,
    first_pay: firstPay >= 0 ? firstPay : null,
    offer_spent: offered ? chosen.reduce((s, p) => s + (p.offer ? p.offer.cost : p.rung.cost), 0) : null,
    cheapest,
    later,
  };
}

/** Which route gives more back over the next 12 months: "none" when neither has anything. */
export type Lead = "passes" | "deals" | "none";

export interface BuddyPlan {
  basket: Basket;
  route: PassRoute;
  dealNet: number; // what the basket's deals leave after Real's fees if resold at their usual price (can be negative)
  lead: Lead;
}

/** The sport a plan is about: the chosen one, or none ("all", and "mine", which is followed players, not a sport). */
const sportOf = (sport: string): string | null => (sport === "all" || sport === "mine" || sport === "" ? null : sport);

/** The yardstick: passes lead when they pay more within a year than the deals leave after fees. */
export function leadOf(route: PassRoute, basket: Basket, dealNet: number): Lead {
  if (route.picks.length > 0 && route.year > dealNet) return "passes";
  if (basket.deals.length > 0) return "deals";
  return route.picks.length > 0 ? "passes" : "none";
}

/**
 * The plan for a balance at a level: the passes it builds (`passRoute`, in the visitor's sport, around the passes they
 * hold) and the deals that level shows (its discount, confidence, kinds and bid window), still on by the clock, never a
 * falling one at any level (its usual price may be above what it sells for now), in the sport the visitor chose
 * (every sport when none is), whatever their own budget (the balance is the budget). `route` can be passed in when it
 * was worked out already (it does not depend on the clock).
 */
export function buddyPlan(
  snap: Snapshot,
  level: LevelKey,
  balance: number,
  nowMs: number,
  sport = "all",
  route?: PassRoute,
  options: Omit<RouteOptions, "level" | "sport"> = {},
): BuddyPlan {
  const only = sportOf(sport);
  const prefs: Prefs = { sport: only ?? "all", budget: null, level, sort: "best", tab: "today", passBudget: null };
  const deals = filterDeals(snap.deals, prefs, snap.levels, nowMs).filter((d) => !d.falling);
  const basket = bestBasket(deals, balance);
  const dealNet = basket.deals.reduce((sum, d) => sum + d.flip_margin, 0);
  const passes = route ?? passRoute(snap.otd, snap.rules.otd, balance, { ...options, level, sport });
  return { basket, route: passes, dealNet, lead: leadOf(passes, basket, dealNet) };
}

/** "paid back in about 4 months (by March)", or "paid back after more than a year". */
export function paybackWords(route: Pick<PassRoute, "payback_months" | "payback_month">, today: string): string {
  if (route.payback_months === null || route.payback_month === null) return "paid back after more than a year";
  return `paid back in about ${spanText(route.payback_months)} (by ${monthWord(route.payback_month, today)})`;
}

/** The line on top: the best you can do right now with a balance, passes first, or why it cannot be said (paused data). */
export function buddySentence(balance: number, plan: BuddyPlan, paused: boolean, sport = "all", today?: string): string {
  const rax = formatRax(balance);
  const only = sportOf(sport);
  const scope = only === null ? "" : sportLabel(only);
  if (paused) {
    return `Prices are paused right now, so we cannot say what ${rax} Rax can do. Try again when the live dot is back.`;
  }
  const { deals, spent, usual, saved } = plan.basket;
  const route = plan.route;
  if (plan.lead === "passes") {
    const n = route.picks.length;
    const where = scope ? ` in ${scope}` : "";
    const day = today ?? new Date().toISOString().slice(0, 10);
    const head = `With ${rax} Rax, passes pay you most${where}: ${n} ${n === 1 ? "pass" : "passes"} for about ${about(route.spent)} Rax should pay about ${about(route.year)} Rax over the next 12 months, ${paybackWords(route, day)}.`;
    if (deals.length === 0) return head;
    const net = Math.round(plan.dealNet);
    return `${head} The best deals would save about ${formatRax(saved)} on paper, ${net > 0 ? `about ${formatRax(net)}` : "nothing"} after fees if you resell.`;
  }
  if (deals.length === 0) return `With ${rax} Rax, no ${scope ? `${scope} ` : ""}deal fits right now.`;
  const n = deals.length;
  return `With ${rax} Rax, the best you can do right now${scope ? ` in ${scope}` : ""} is ${n} ${n === 1 ? "deal" : "deals"}: ${formatRax(spent)} Rax for ${
    n === 1 ? "a card" : "cards"
  } usually worth ${formatRax(usual)}, so you save about ${formatRax(saved)}.`;
}

/** "Starts paying this month." / "Starts paying in December."; null when nothing pays within a year. */
export function startLine(route: PassRoute, today: string): string | null {
  if (route.picks.length === 0 || route.first_pay === null) return null;
  if (route.first_pay === 0) return "Starts paying this month.";
  const month = Number(today.slice(5, 7));
  return `Starts paying in ${monthName(month + route.first_pay)}.`;
}

/** How much under the usual price an offer goes, in words: "20%". */
export const offerUnder = () => `${Math.round((1 - OFFER_LEVEL) * 100)}%`;

/** The passes with their cards bought by offers: an expectation, never a promise. */
export function offerRouteLine(route: PassRoute): string | null {
  if (route.offer_spent === null || route.picks.length === 0 || !(route.offer_spent < route.spent)) return null;
  const one = route.picks.length === 1;
  const these = one ? "this pass costs" : "these passes cost";
  // Measured on the feed's accepted offers, the level is theirs, not the fixed 20 % under (lib/offers.ts).
  const how = route.picks.some((p) => p.offer?.measured)
    ? `offer under the usual price on many of ${one ? "its" : "their"} cards, near what accepted offers on them have cleared at`
    : `offer about ${offerUnder()} under the usual price on many of ${one ? "its" : "their"} cards`;
  return `Cheaper with offers: ${how}. Most offers are refused (about 1 in ${oneIn(
    OFFER_ACCEPTED,
  )} is accepted in what we measured), so send many: if enough are accepted, ${these} about ${about(route.offer_spent)} Rax instead of ${about(route.spent)}.`;
}

/** For a balance that builds no pass yet: the cheapest one that pays back, and what is missing. */
export function saveUpLine(balance: number, route: PassRoute): string | null {
  if (route.picks.length > 0 || route.cheapest === null || route.cheapest <= balance) return null;
  return `No pass that pays back fits ${formatRax(balance)} Rax yet: the cheapest costs about ${about(route.cheapest)}, so about ${about(
    route.cheapest - balance,
  )} to go. Offers under the usual price can build it for less.`;
}

/** The best pass whose sport pays only months from now, and when to buy it. */
export function laterLine(route: PassRoute): string | null {
  if (!route.later) return null;
  const { market, from, buy } = route.later;
  return `Later: ${sportLabel(market.sport)} ${paysLaterText({ from, buy }).replace("Pays", "pays")}, not sooner (${titleText(market)}).`;
}
