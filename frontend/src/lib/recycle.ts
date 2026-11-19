// Recycle: the passes held that are done paying, what their cards would sell for today, and what to do instead, each
// linked to a pass or a deal. Pure, worked out on this device from the served snapshot and the passes held.
//
// What it rests on (the internal research notes, 3b and 4f; the internal research notes):
//  - Real's cap is a ceiling on all a past-season pass earns, live pay included; once its earnings reach it, its On This
//    Day pay stops (0 of 392 such passes claimed). Iconic player passes have no cap and never fill, so never here.
//  - A lift to a higher rarity raises the cap and reopens the pass for the new limit minus all it has earned. No Real
//    Pro needed: it is buying cards.
//  - Selling the cards lowers the pass (they ARE its rating); for a pass that pays nothing more, nothing is lost. Listing
//    cards at one's own price and making offers need Real Pro (Real's docs: "Pro accounts and other very active accounts
//    can list"; others can only Quick Sell, at Real's price). So the selling routes show only to a visitor who says they
//    have it (lib/realPro.ts), always with that said. Buying needs none.
//  - The Deals list is mostly this season's cards and the pass markets past seasons (a deal matched a pass market 1 time
//    in 211 on recent snapshots), so nothing here rests on a deal: a lift is priced from the pass market itself (the
//    typical price per point, and the cards listed now, its shelf) and the Rax goes to a pass (passRoute). A deal of the
//    same player-season that lifts a done pass alone is a bonus, when there is one (`Reopen.deal`, `recycleForDeal`).
//  - Quick Sell: Real pays for a card at once, at its own price; any account can, no Real Pro needed. It pays about
//    `rules.quicksell_per_point` (1) Rax a rating point, measured on about 97,000 quick-sold cards, Sep–Nov 2026 (the
//    same for every rarity and rating), about an eighth of what the same cards sold for. No Quick Sell of a whole pass
//    is modelled: no Real source shows one. It is never the advice while a lift reopens the pass (lifting keeps the
//    cards, which can still be quick-sold later; quick-selling them ends the lift), nor for an idle pass that still
//    wins at least as much in a year (`quickAdvice`).
//  - What the cards sell for is an estimate: their rating at the typical price per rating point of that player-season
//    (its build rate, lib/passRates.ts: the feed's cheapest cell with 5 listing sales, else `rate_traded`, the median
//    of recent trades, as before; a floor, since dearer rarities sell for more), less Real's share of a sale
//    (`rules.fee`), before the listing fee of each card listed (their number is not known). Selling many at once can
//    move that price. A lift's cost on the shelf counts only firm pays: a sum of auction openings is not a price.
import { filterDeals } from "../data/filters";
import type { LevelKey, Prefs } from "../data/prefs";
import type { Deal, OtdRules, PassMarket, PassRung, Rules, Snapshot } from "../data/types";
import { type PassRoute, passRoute } from "./budget";
import { titleText } from "../content/passWords";
import { type HeldPass, type Holding, type Plan, breaksEvenAtBest, climb, dayOf, idlePasses, isLiquid, limitOf, onSale, paysLater, tierAt } from "./passes";
import { buildRate } from "./passRates";

/** Why a pass is done paying: "full", Real says it has earned its cap; "maxed", ticked as maxed by hand; "idle", the
 * visitor's own better passes take its sport's daily claims, so it wins under a quarter of what it could pay alone. */
export type DeadWhy = "full" | "maxed" | "idle";

/** What a pass's cards would sell for now: an estimate. */
export interface CardValue {
  rating: number; // the rating its cards add up to (the exact one when known)
  rate: number; // the typical price per rating point of that player-season: its build rate (lib/passRates.ts)
  gross: number; // rating × rate
  net: number; // gross less Real's share of a sale, rounded; before each listed card's fee
  fee: number; // Real's share of a sale (rules.fee), as the words say it
  listing_fee: number; // what listing one card costs (rules.listing_fee), not taken off `net`: the cards' number is not known
  thin: boolean; // the rate rests on few trades (under rules.otd.ignore_ask_min_sales), or is thin (measured, no build cell)
}

/** What Real's Quick Sell would pay for a pass's cards, and whether it is the advice:
 * "sell", nothing better is in sight without Real Pro; "lift", a lift reopens the pass, so keep the cards and lift;
 * "keep", an idle pass that still wins at least its Quick Sell in a year. */
export type QuickAdvice = "sell" | "lift" | "keep";

export interface QuickSell {
  rating: number; // the rating its cards add up to (as `CardValue.rating`)
  per_point: number; // rules.quicksell_per_point
  rax: number; // rating × per_point, rounded: what Quick Sell pays, at once (Real's price, not an estimate of ours)
  listed: number | null; // what listing them would bring (`CardValue.net`, Real Pro); null without a price
  advice: QuickAdvice;
}

/** The Quick Sells a non-Pro visitor is advised, together. `listed` is null when one of them has no price. */
export interface QuickTotal {
  passes: number;
  rax: number;
  listed: number | null;
}

/** Whether to quick-sell a done pass's cards (see `QuickAdvice`). A lift goes first: it keeps the cards, which can still
 * be quick-sold once the pass fills again; quick-selling them ends the lift. An idle pass still wins a little: keep it
 * while a year of that is at least what its cards would bring now. */
export function quickAdvice(why: DeadWhy, lift: Reopen | null, gets: number, rax: number): QuickAdvice {
  if (lift) return "lift";
  if (why === "idle" && gets >= rax) return "keep";
  return "sell";
}

/** The lift that reopens a full pass: the next rarity that pays back, priced at the typical price and from the cards
 * listed now, and a deal that gets there for less, in the rare case there is one. */
export interface Reopen {
  tier: string;
  rating_to_add: number;
  cost: number; // the rating at the typical price (the pass is minted already)
  shelf: number | null; // the cheapest cards listed now that add up to the rating; null when they do not
  limit: number | null; // the new rarity's lifetime limit; null for one with none (Iconic)
  reopens: number | null; // that limit less all the pass has earned; null: no limit, it never fills again
  extra_year: number; // what it adds in the next 12 months (an estimate)
  payback_months: number | null; // the lift's cost back from that extra pay
  deal: Deal | null; // one card on the Deals list of that player-season that reaches the rarity alone, for less than `cost`
  best: number; // the cheapest of the three ways
  affordable: boolean | null; // `best` within the balance typed on this device; null when none was typed
}

/** Where the Rax from selling could go: a pass to build, one rarity of it. */
export interface Target {
  market: PassMarket;
  rung: PassRung & { cost: number };
}

export interface DeadPass {
  key: string; // the pass's market key
  group: string; // "sport:season:player_id": the deals of the same player-season
  market: PassMarket;
  tier: string;
  index: number; // the rarity's place on its ladder
  rating: number; // as the planner holds it (within Real's rung when it names one)
  mult: number;
  why: DeadWhy;
  earned: number; // all it has earned that counts against its cap; 0 when unknown
  cap: number | null;
  gets: number; // what it gets a year now among the passes held (an estimate)
  value: CardValue | null; // null when its cards have no price (a team pass, no trades)
  target: Target | null; // what `value.net` alone could build; null without a value or when nothing fits
  lift: Reopen | null; // full and maxed passes only
  quick: QuickSell | null; // null for a team pass, a pass with no rating, or an older server without the rule
}

export interface RecyclePlan {
  dead: DeadPass[]; // the most valuable cards first
  value: number; // all their cards together, net (the `net` of each with a value)
  sellable: number; // passes with a value
  route: PassRoute | null; // what `value` builds, passes first (lib/budget.ts passRoute); null when value is 0
  quick: QuickTotal; // the done passes whose Quick Sell is the advice ("sell"), together
  quickPerPoint: number | null; // rules.quicksell_per_point; null from an older server without it
  pro: boolean; // the visitor says they have Real Pro: the selling routes apply
  rules: OtdRules;
  byGroup: ReadonlyMap<string, DeadPass>;
}

export interface RecycleInput {
  snap: Pick<Snapshot, "otd" | "rules" | "deals" | "levels">;
  markets: readonly PassMarket[]; // the markets the passes held are valued with (the site's, then kept ones)
  holdings: readonly Holding[];
  plan: Plan; // planHoldings(holdings, markets, ...)
  level: LevelKey;
  pro: boolean;
  balance: number | null;
  nowMs: number;
}

const groupOf = (x: { sport: string; season: number; player_id: number }) => `${x.sport}:${x.season}:${x.player_id}`;

/** Why a held pass is done paying, or null. Only past seasons: a season being played still pays live, and Real states
 * no cap for it. Never Iconic (no cap) nor General (no cards to speak of; it never paid On This Day). */
export function whyDead(p: HeldPass, idle: ReadonlySet<string>): DeadWhy | null {
  if (p.market.season_state !== "past" || p.tier === "iconic" || p.tier === "general") return null;
  if (p.cap !== null && p.cap > 0 && p.used >= p.cap) return "full";
  if (p.spent) return "maxed";
  if (idle.has(p.market.key)) return "idle";
  return null;
}

/** The rating a held pass's cards add up to: the exact one when the account gave it, else the planner's. */
function cardsRating(p: HeldPass): number {
  const exact = p.holding.rating;
  return typeof exact === "number" && Number.isFinite(exact) && exact > 0 ? exact : p.rating;
}

/** What a held pass's cards would sell for at the typical price, less Real's share (`fees.fee`); null without a price. */
export function cardValue(p: HeldPass, fees: Pick<Rules, "fee" | "listing_fee">, minSales: number): CardValue | null {
  const build = buildRate(p.market);
  const rate = build.rate;
  if (p.market.kind === "team" || rate === null || !(rate > 0)) return null;
  const rating = cardsRating(p);
  if (!(rating > 0)) return null;
  const gross = rating * rate;
  const { fee, listing_fee } = fees;
  return { rating, rate, gross, net: Math.round(gross * (1 - fee)), fee, listing_fee, thin: build.thin || build.sales < minSales };
}

/** What Real's Quick Sell pays for a held pass's cards, before the advice; null for a team pass (the measure is of
 * player cards), without a rating, or without the rule. */
function quickRax(p: HeldPass, perPoint: number | undefined): { rating: number; per_point: number; rax: number } | null {
  if (p.market.kind === "team" || perPoint === undefined || !(perPoint > 0)) return null;
  const rating = cardsRating(p);
  if (!(rating > 0)) return null;
  return { rating, per_point: perPoint, rax: Math.round(rating * perPoint) };
}

/** All a done pass has earned against its limit: Real's figure, or for one ticked maxed by hand, at least its limit. */
function usedOf(p: HeldPass, rules: OtdRules): number {
  if (p.used > 0 || !p.spent) return p.used;
  return p.cap ?? limitOf(p.market, p.tier, p.mult, rules)[0] ?? 0;
}

/** The cheapest next rarity that reopens a full (or maxed) pass and pays back, as the planner's lifts are chosen
 * (lib/nextRax.ts): New only within 12 months and never on a projection. */
export function reopenOf(
  p: HeldPass,
  rules: OtdRules,
  today: string,
  level: LevelKey,
  balance: number | null,
  deals: readonly Deal[],
): Reopen | null {
  if (p.liftUnknown) return null;
  const used = usedOf(p, rules);
  for (const o of climb(p.market, p.rating, rules, today, { minted: true, used, mult: p.mult }).options) {
    if (o.cost === null || o.cost <= 0 || !(o.extra_year > 0) || o.extra_pays_back !== true) continue;
    if (level === "new" && ((o.payback_months ?? Infinity) > 12 || o.projected)) continue;
    const reopens = o.limit === null ? null : Math.max(0, o.limit - used);
    if (reopens === 0) continue;
    let deal: Deal | null = null;
    for (const d of p.market.kind === "team" ? [] : deals) {
      if (groupOf(d) !== groupOf(p.market) || !(p.rating + d.rating >= o.rating) || !(d.price < o.cost)) continue;
      if (!deal || d.price < deal.price || (d.price === deal.price && d.listing_id < deal.listing_id)) deal = d;
    }
    const sale = onSale(p.market, o.rating_to_add, rules);
    const shelf = sale.enough && sale.on_sale_cost > 0 && sale.firm !== false ? sale.on_sale_cost : null;
    const best = Math.min(o.cost, shelf ?? Infinity, deal?.price ?? Infinity);
    return {
      tier: o.tier,
      rating_to_add: o.rating_to_add,
      cost: o.cost,
      shelf,
      limit: o.limit,
      reopens,
      extra_year: o.extra_year,
      payback_months: o.extra_payback_months,
      deal,
      best,
      affordable: balance === null ? null : best <= balance,
    };
  }
  return null;
}

/** Whether rung `a` goes before rung `b` (lib/budget.ts bestPassSteps): more Rax a year, the better return, the lower cost. */
function before(a: PassRung, b: PassRung): boolean {
  if (a.year_rax !== b.year_rax) return a.year_rax > b.year_rax;
  const ar = a.year_per_rax ?? -Infinity;
  const br = b.year_per_rax ?? -Infinity;
  if (ar !== br) return ar > br;
  return (a.cost ?? Infinity) < (b.cost ?? Infinity);
}

type Priced = { market: PassMarket; rung: PassRung & { cost: number } };

/**
 * The best single pass a sum builds, among those `passRoute` would offer (the same rules: pays back, more than breaks
 * even, not a team pass, trades, not held, not paying only months from now, New within a year), in a sport with a daily
 * claim free once the done passes are sold. Built once; each question is a binary search.
 */
function passFinder(markets: readonly PassMarket[], rules: OtdRules, today: string, level: LevelKey, held: ReadonlySet<string>, live: Record<string, number>) {
  const cands: Priced[] = [];
  for (const market of markets) {
    if (market.kind === "team" || !isLiquid(market) || held.has(market.key)) continue;
    if ((live[market.sport] ?? 0) >= rules.claims_per_sport_day || paysLater(market, rules, today)) continue;
    for (const r of market.rungs) {
      if (r.pays_back !== true || r.cost === null || r.cost <= 0 || !(r.year_rax > 0) || breaksEvenAtBest(r)) continue;
      if (level === "new" && (r.projected || (r.payback_months ?? Infinity) > 12)) continue;
      cands.push({ market, rung: r as PassRung & { cost: number } });
    }
  }
  cands.sort((a, b) => a.rung.cost - b.rung.cost || (a.market.key < b.market.key ? -1 : a.market.key > b.market.key ? 1 : 0));
  const best: Priced[] = [];
  for (const c of cands) best.push(best.length && !before(c.rung, best[best.length - 1]!.rung) ? best[best.length - 1]! : c);
  return (sum: number): Priced | null => {
    let lo = 0;
    let hi = cands.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cands[mid]!.rung.cost <= sum) {
        at = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return at < 0 ? null : best[at]!;
  };
}

/** The deals the visitor's level shows now, as the budget answer takes them (lib/budget.ts buddyPlan): never falling. */
function visibleDeals(snap: RecycleInput["snap"], level: LevelKey, nowMs: number): Deal[] {
  const prefs: Prefs = { sport: "all", budget: null, level, sort: "best", tab: "today", passBudget: null };
  return filterDeals(snap.deals, prefs, snap.levels, nowMs).filter((d) => !d.falling);
}

/** The passes done paying and what to do with each; with `pro`, what their cards together would build. */
export function recyclePlan(input: RecycleInput): RecyclePlan {
  const { snap, plan, level, pro, balance } = input;
  const rules = snap.rules.otd;
  const today = dayOf(snap.otd.as_of);
  const idle = new Set(idlePasses(plan).map((x) => x.pass.market.key));
  const deals = visibleDeals(snap, level, input.nowMs);

  const found: { p: HeldPass; why: DeadWhy }[] = [];
  for (const p of plan.held) {
    const why = whyDead(p, idle);
    if (why) found.push({ p, why });
  }
  const deadKeys = new Set(found.map((x) => x.p.market.key));
  // Sold, a done pass takes no claim: the sports' free claims, and the route, count it out (as spent).
  const live: Record<string, number> = {};
  for (const p of plan.held) if (!p.spent && !deadKeys.has(p.market.key)) live[p.market.sport] = (live[p.market.sport] ?? 0) + 1;
  const held = new Set(input.holdings.map((h) => h.key));
  const findPass = pro ? passFinder(snap.otd.markets, rules, today, level, held, live) : null;

  const dead: DeadPass[] = found.map(({ p, why }) => {
    const value = cardValue(p, snap.rules, rules.ignore_ask_min_sales);
    const target: Target | null = value && findPass ? findPass(value.net) : null;
    const lift = why === "idle" ? null : reopenOf(p, rules, today, level, balance, deals);
    const gets = plan.sports[p.market.sport]?.per[p.market.key] ?? 0;
    const qs = quickRax(p, snap.rules.quicksell_per_point);
    const quick: QuickSell | null = qs && { ...qs, listed: value?.net ?? null, advice: quickAdvice(why, lift, gets, qs.rax) };
    return {
      key: p.market.key,
      group: groupOf(p.market),
      market: p.market as PassMarket,
      tier: p.tier,
      index: tierAt(p.market.kind, p.rating, rules).index,
      rating: p.rating,
      mult: p.mult,
      why,
      earned: usedOf(p, rules),
      cap: p.cap,
      gets,
      value,
      target,
      lift,
      quick,
    };
  });
  dead.sort((a, b) => (b.value?.net ?? -1) - (a.value?.net ?? -1) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const value = dead.reduce((s, d) => s + (d.value?.net ?? 0), 0);
  const quick: QuickTotal = { passes: 0, rax: 0, listed: 0 };
  for (const d of dead) {
    if (d.quick?.advice !== "sell") continue;
    quick.passes += 1;
    quick.rax += d.quick.rax;
    quick.listed = quick.listed === null || d.quick.listed === null ? null : quick.listed + d.quick.listed;
  }
  let route: PassRoute | null = null;
  if (pro && value > 0) {
    const marked = input.holdings.map((h) => (deadKeys.has(h.key) ? { ...h, spent: true } : h));
    route = passRoute(snap.otd, rules, value, { level, holdings: marked, held: input.markets, sports: snap.otd.sports });
  }
  return {
    dead,
    value,
    sellable: dead.filter((d) => d.value !== null).length,
    route,
    quick,
    quickPerPoint: snap.rules.quicksell_per_point ?? null,
    pro,
    rules,
    // Deals are player (and fighter) cards: a team pass carries its team's id, which a player's could share.
    byGroup: new Map(dead.filter((d) => d.market.kind !== "team").map((d) => [d.group, d])),
  };
}

/** The lift a done pass's line shows: with Real Pro always (selling can pay for it); without, only one the balance typed
 * on this device covers (or any, when none was typed), since buying it is then the only way. */
export function shownLift(d: DeadPass, pro: boolean): Reopen | null {
  return d.lift && (pro || d.lift.affordable !== false) ? d.lift : null;
}

/** What a deal row can say about one of the visitor's done passes: this card lifts it a rarity and reopens it. */
export interface RecycleDealLine {
  key: string; // the done pass it is about
  title: string; // "Nikola Jokić 2024-25"
  tier: string; // the rarity the card takes the pass to
  reopens: number | null; // what it reopens; null when that rarity has no limit (Iconic: it never fills again)
}

/**
 * For a deal row: does this card reopen one of the visitor's done passes? A card of the same player-season whose rating
 * lifts a full (or maxed) pass a rarity does, for the new limit less all the pass has earned; no Real Pro needed. Rare:
 * the Deals list is mostly this season's cards, the done passes past seasons. Null otherwise, or without a plan. The
 * words are `recycleDealText` (content/recycleWords.ts).
 */
export function recycleForDeal(
  deal: Pick<Deal, "sport" | "season" | "player_id" | "rating">,
  plan: RecyclePlan | null,
): RecycleDealLine | null {
  const d = plan?.byGroup.get(groupOf(deal));
  if (!plan || !d || d.why === "idle" || !(deal.rating > 0)) return null;
  const at = tierAt(d.market.kind, d.rating + deal.rating, plan.rules);
  if (at.index <= d.index) return null;
  const [limit] = limitOf(d.market, at.tier, at.mult, plan.rules);
  const reopens = limit === null ? null : Math.max(0, limit - d.earned);
  return reopens === 0 ? null : { key: d.key, title: titleText(d.market), tier: at.tier, reopens };
}
