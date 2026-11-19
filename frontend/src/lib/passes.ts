// The browser's daily-pay pass planner. `rungs`, `bestRung` and `weakRungs` are the engine of advisor/otd.py line
// for line, checked against the same golden vectors (tests/fixtures/otd_vectors.json); the planner (`climb`,
// `planHoldings`, `nextBest`) is built on them for what only this device knows: the passes its visitor holds.
// Pure functions of a market's inputs, the shipped rules (snapshot.rules.otd) and a UTC day ("YYYY-MM-DD").
import type { OtdRules, PassKind, PassMarket, PassOnSale, PassRung, PassSport } from "../data/types";
import { buildRate, cleanBuildFields } from "./passRates";

/** What the engine needs of one pass: the market as served, without the figures the server derived from it. */
export type PassBasis = Omit<PassMarket, "rungs" | "best" | "weak" | "on_sale" | "month_share_estimated">;

/** A pass this device holds: by its rarity, or by the exact rating its cards add up to; `spent` when the app says
 * it is maxed (it pays nothing more). A linked account's passes also carry what Real itself says (`rarity`, its
 * actual rung; `mult`; `cap`, its lifetime limit (it counts all the pass has `earned`, live pay included); `label`, "Rare 1"; `level`), preferred
 * to what the rating suggests, and `from: "real"` (the link brought it; a pass added by hand has no `from`). */
export interface Holding {
  key: string;
  tier?: string;
  rating?: number;
  spent?: boolean;
  rarity?: string;
  mult?: number;
  cap?: number; // Real's On This Day limit for the pass (0 for a General); never "what is left": see `realCap`
  earned?: number;
  label?: string;
  level?: number;
  from?: "real";
}

// Sums of floats drift by a few units in the last place; a payback that lands exactly on a month's end must not slip
// into the next month because of it (advisor/otd.py _ROUNDING).
const ROUNDING = 1e-9;

/** Python's float sum (compensated since 3.12), so the month weights match the engine's to the last bit. */
function fsum(values: readonly number[]): number {
  let sum = 0;
  let c = 0;
  for (const v of values) {
    const t = sum + v;
    c += Math.abs(sum) >= Math.abs(v) ? sum - t + v : v - t + sum;
    sum = t;
  }
  return sum + c;
}

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const ym = (year: number, month: number) => `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;

function parseDay(day: string): [number, number, number] {
  const [y, m, d] = day.split("-").map(Number);
  return [y ?? 1970, m ?? 1, d ?? 1];
}

/** The snapshot's own UTC day, from `otd.as_of` ("2026-11-12T18:00:00Z" -> "2026-11-12"). */
export const dayOf = (iso: string): string => iso.slice(0, 10);

/** Whether the month shares cannot be used (missing, all zero or not 12), so the sport's months stand in. */
export function monthShareEstimated(market: Pick<PassBasis, "month_share">): boolean {
  return market.month_share.length !== 12 || fsum(market.month_share.map((s) => Math.max(0, s))) <= 0;
}

/** The share of a season's pay in each calendar month, January first, adding up to 1. */
export function monthWeights(market: Pick<PassBasis, "month_share" | "sport">, rules: OtdRules): number[] {
  if (!monthShareEstimated(market)) {
    const shares = market.month_share.map((s) => Math.max(0, s));
    const total = fsum(shares);
    return shares.map((s) => s / total);
  }
  const months = rules.sport_months[market.sport];
  const run = months && months.length > 0 ? months : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  return Array.from({ length: 12 }, (_, i) => (run.includes(i + 1) ? 1 / run.length : 0));
}

export interface Payback {
  pays_back: boolean;
  months: number | null;
  month: string | null;
}

/**
 * advisor/otd.py _payback: the month-by-month walk from today until `cost` is covered, within the horizon. A pass
 * whose lifetime does not beat its cost (one that only breaks even) never pays back.
 */
export function payback(cost: number, full: number, weights: readonly number[], lifetime: number, today: string, rules: OtdRules): Payback {
  let [year, month, day] = parseDay(today);
  if (cost <= 0) return { pays_back: true, months: 0, month: ym(year, month) };
  if (full <= 0 || lifetime <= cost * (1 + ROUNDING)) return { pays_back: false, months: null, month: null };
  const horizon = 12 * rules.payback_horizon_years;
  const days = daysIn(year, month);
  let length = (days - day + 1) / days;
  let paid = 0;
  let elapsed = 0;
  while (elapsed < horizon) {
    length = Math.min(length, horizon - elapsed);
    const perMonth = full * (weights[month - 1] ?? 0);
    if (perMonth > 0 && paid + perMonth * length >= cost * (1 - ROUNDING)) {
      return { pays_back: true, months: elapsed + (cost - paid) / perMonth, month: ym(year, month) };
    }
    paid += perMonth * length;
    elapsed += length;
    length = 1;
    if (month === 12) {
      year += 1;
      month = 1;
    } else month += 1;
    day = 1;
  }
  return { pays_back: false, months: null, month: null };
}

/** The tier's lifetime limit (null: none) and whether it is an estimate (advisor/otd.py _limit). A tier that pays
 * nothing On This Day (General) has a limit of 0. */
export function limitOf(market: Pick<PassBasis, "kind" | "sport">, tier: string, mult: number, rules: OtdRules): [number | null, boolean] {
  if ((rules.no_otd_tiers ?? ["general"]).includes(tier)) return [0, false]; // an older payload: Real's rule still holds
  const estimated = rules.limit_estimated_kinds.includes(market.kind) || rules.limit_estimated_sports.includes(market.sport);
  if (market.kind === "team" && !estimated) return [rules.team_limits[tier] ?? null, false];
  if ((rules.no_limit[market.kind] ?? []).includes(tier)) return [null, estimated];
  const fighter = rules.fighter_limits?.[tier];
  if (market.kind === "fighter" && !estimated && fighter != null) return [fighter, false];
  return [rules.player_limit_per_mult * mult, estimated];
}

/** The season as a whole: its share played and its full 1x pay (a season in progress projected to its end). */
function seasonOf(market: PassBasis, rules: OtdRules) {
  const current = market.season_state === "current";
  const progress = current ? Math.min(1, market.season_progress) : 1;
  return { current, progress, season1x: market.base_1x / progress, projected: current && progress < rules.projection_below };
}

/**
 * What a pass at multiplier `mult` pays: a whole season, the part paid again on anniversaries, the live rest, and
 * `flow`, what the month-by-month walks spread over the months: the whole season, or only its live games for a tier
 * that pays nothing On This Day (limit 0; an approximation, capped by the lifetime, as in advisor/otd.py).
 */
function payAt(market: PassBasis, mult: number, limit: number | null, rules: OtdRules) {
  const { progress, season1x } = seasonOf(market, rules);
  const full = season1x * mult;
  const played = full * progress;
  const live = full - played;
  // Live pay is never stopped by the limit but fills it (habits audit 4f, B9): On This Day keeps only what the live
  // games to come leave of it (advisor/otd.py `room`). Medium confidence on the live part: the live games are projected.
  const room = limit === null ? null : Math.max(0, limit - live);
  return {
    full,
    played,
    live,
    flow: limit === 0 ? live : full,
    year: live + (room === null ? played : Math.min(played, room)),
    lifetime: room === null ? full * rules.no_limit_horizon_years : room + live,
  };
}

/**
 * advisor/otd.py rungs: one rung per tier of the pass's ladder that takes more rating than `heldRating`, lowest first.
 * Not held (0, and not `minted`: a General held at 0 rating) and mintable, the cost includes the mint; cards are priced
 * at the build rate (lib/passRates.ts buildRate: the feed's cheapest cell with enough sales, else the traded rate as
 * before). General, the mint alone, pays nothing On This Day: it is a rung only while live games are left.
 */
export function rungs(
  market: PassBasis,
  rules: OtdRules,
  { today, heldRating = 0, minted = false }: { today: string; heldRating?: number; minted?: boolean },
): PassRung[] {
  const ladder = rules.ladders[market.kind];
  const { progress, projected } = seasonOf(market, rules);
  if (!ladder || progress <= 0) return [];
  const weights = monthWeights(market, rules);
  const held = Math.abs(heldRating);
  const withMint = held === 0 && market.mintable && !minted;
  const mint = market.mint_cost ?? rules.mint_cost[market.kind] ?? 0;
  const rate = buildRate(market).rate;
  const out: PassRung[] = [];
  for (const [tier, rating, mult] of ladder) {
    const mintOnly = withMint && rating === 0;
    if (rating <= held && !mintOnly) continue;
    const ratingToAdd = rating - held;
    let cost: number | null = null;
    if (mintOnly) cost = mint;
    else if (rate !== null) cost = (withMint ? mint : 0) + ratingToAdd * rate;
    const [limit, limitEstimated] = limitOf(market, tier, mult, rules);
    const pay = payAt(market, mult, limit, rules);
    if (limit === 0 && pay.live <= 0) continue; // pays nothing On This Day and has no game left to pay live
    const back: Payback | null = cost === null ? null : payback(cost, pay.flow, weights, pay.lifetime, today, rules);
    out.push({
      tier,
      rating,
      mult,
      limit,
      limit_estimated: limitEstimated,
      rating_to_add: ratingToAdd,
      cost,
      route: mintOnly ? "mint" : withMint ? "mint+cards" : "cards",
      year_rax: pay.year,
      year_capped: !!limit && pay.played > Math.max(0, limit - pay.live), // a General's 0 is no cap: it never pays On This Day
      projected,
      per_game_day: market.game_days ? pay.full / market.game_days : null,
      years_to_limit: limit && pay.full > 0 ? limit / pay.full : null, // none for a General's 0: never reached
      year_per_rax: cost ? pay.year / cost : null,
      lifetime_per_rax: cost ? pay.lifetime / cost : null,
      pays_back: back ? back.pays_back : null,
      payback_months: back ? back.months : null,
      payback_month: back ? back.month : null,
    });
  }
  return out;
}

/** advisor/otd.py best_rung: the most Rax a year per Rax spent among the rungs that pay back within `budget`; the
 * lower rung on a tie. */
export function bestRung(ladder: readonly PassRung[], budget: number | null = null): PassRung | null {
  let best: PassRung | null = null;
  for (const r of ladder) {
    if (!r.pays_back || r.year_per_rax === null || r.cost === null || (budget !== null && r.cost > budget)) continue;
    if (best === null || r.year_per_rax > best.year_per_rax!) best = r;
  }
  return best;
}

/** advisor/otd.py weak_rungs: the tiers whose lifetime pay per Rax is below both neighbours', among rungs with a
 * limit. */
export function weakRungs(ladder: readonly PassRung[]): Set<string> {
  const limited = ladder.filter((r) => r.limit !== null);
  const weak = new Set<string>();
  for (let i = 1; i < limited.length - 1; i++) {
    const [a, b, c] = [limited[i - 1]!.lifetime_per_rax, limited[i]!.lifetime_per_rax, limited[i + 1]!.lifetime_per_rax];
    if (a !== null && b !== null && c !== null && b < a && b < c) weak.add(limited[i]!.tier);
  }
  return weak;
}

/** A rung whose whole life pays at most its cost (its lifetime limit no more than its price): never recommended. */
export const breaksEvenAtBest = (r: PassRung): boolean => r.lifetime_per_rax !== null && r.lifetime_per_rax <= 1;

/** The rung the site recommends: the engine's best among the rungs that do more than break even. */
export function recommendedRung(ladder: readonly PassRung[], budget: number | null = null): PassRung | null {
  return bestRung(ladder.filter((r) => !breaksEvenAtBest(r)), budget);
}

/** A market without what the engine derives from it (its rungs are most of its size): what a device stores. */
export function toBasis(market: PassMarket | PassBasis): PassBasis {
  const { rungs: _r, best: _b, weak: _w, on_sale: _o, month_share_estimated: _m, ...basis } = market as PassMarket;
  return basis;
}

/** What a device keeps of a valuation: its basis without the shelf nor the live auctions, since the cards on sale when
 * it was kept are not the cards on sale now (their count stays: it says the cards trade); the feed's build rate and
 * offers only when they fit (lib/passRates.ts cleanBuildFields). */
export const toStored = (market: PassMarket | PassBasis): PassBasis => cleanBuildFields({ ...toBasis(market), shelf: [] });

/**
 * A stored market back in the shape the snapshot serves (advisor/snapshot.py _pass_market_json), its rungs walked
 * from `today`, so a valuation kept for weeks pays back from the day it is read, not the day it was kept.
 */
export function marketOf(basis: PassBasis, rules: OtdRules, today: string): PassMarket {
  const ladder = rungs(basis, rules, { today });
  const best = bestRung(ladder);
  const weak = weakRungs(ladder);
  let sale: PassOnSale | null = null;
  if (best !== null && best.route !== "mint") {
    const { on_sale_rating, on_sale_cost, enough, firm } = onSale(basis, best.rating_to_add, rules);
    sale = firm === undefined ? { on_sale_rating, on_sale_cost, enough } : { on_sale_rating, on_sale_cost, enough, firm };
  }
  return {
    ...basis,
    month_share_estimated: monthShareEstimated(basis),
    rungs: ladder,
    best: best === null ? null : best.tier,
    weak: ladder.filter((r) => weak.has(r.tier)).map((r) => r.tier),
    on_sale: sale,
  };
}

/** The tier a rating has reached on a ladder, with its entry rating, multiplier and place on the ladder. */
export function tierAt(kind: PassKind | string, rating: number, rules: OtdRules) {
  const ladder = rules.ladders[kind] ?? [];
  let index = 0;
  ladder.forEach(([, entry], i) => {
    if (Math.abs(rating) >= entry) index = i;
  });
  const [tier, entry, mult] = ladder[index] ?? ["general", 0, 1];
  return { tier, rating: entry, mult, index };
}

/** The rarity's place on its ladder, 0 (General) to 7 (Iconic): the index of its colour token. */
export function tierIndex(kind: PassKind | string, tier: string, rules: OtdRules): number {
  return Math.max(0, (rules.ladders[kind] ?? []).findIndex(([t]) => t === tier));
}

/**
 * advisor/otd.py on_sale on the served shelf: cheapest per rating point first, parked asks (over `ignore_ask_above` times
 * the build rate) left out (`ignored`), ratings counted in hundredths as Real shows them (and as the server counts
 * them). When the feed sent the shelf's live auctions (`auctions`), each card is priced at its pay and `firm` says
 * whether every card taken is at a pay a buyer can count on now; `firmOnly` leaves the openings out (a pass deal).
 */
export function onSale(
  market: Pick<PassBasis, "shelf" | "rate_traded" | "rate_sales" | "rate_build" | "rate_build_from" | "auctions">,
  needRating: number,
  rules: OtdRules,
  { firmOnly = false }: { firmOnly?: boolean } = {},
): PassOnSale & { ignored: number } {
  const need = Math.round(Math.max(0, needRating) * 100);
  const build = buildRate(market);
  const ceiling = build.rate !== null && build.sales >= rules.ignore_ask_min_sales ? rules.ignore_ask_above * build.rate : null;
  const auctions = market.auctions;
  const cards: (readonly [number, number, boolean])[] = auctions
    ? auctions.filter(([, , firm]) => firm === 1 || !firmOnly).map(([rating, pay, firm]) => [rating, pay, firm === 1] as const)
    : market.shelf.map(([rating, ask]) => [rating, ask, true] as const);
  const usable = cards.filter(([rating, ask]) => rating !== 0 && ask > 0);
  const offers = usable
    .filter(([rating, ask]) => ceiling === null || ask / Math.abs(rating) <= ceiling)
    .map(([rating, ask, firm]) => [ask / Math.abs(rating), ask, Math.round(Math.abs(rating) * 100), firm] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || Number(a[3]) - Number(b[3]));
  let hundredths = 0;
  let cost = 0;
  let firmAll = true;
  for (const [, ask, rating, firm] of offers) {
    if (hundredths >= need) break;
    hundredths += rating;
    cost += ask;
    firmAll = firmAll && firm;
  }
  const out = { on_sale_rating: hundredths / 100, on_sale_cost: cost, enough: hundredths >= need, ignored: usable.length - offers.length };
  return auctions ? { ...out, firm: firmAll } : out;
}

// ---------- the rating planner ----------

export interface ClimbOption extends PassRung {
  extra_year: number; // what the climb adds in the next 12 months over the rarity held now
  extra_pays_back: boolean | null; // the climb's cost back from that extra pay, within the horizon; null unpriced
  extra_payback_months: number | null;
}

export interface Climb {
  tier: string; // the rarity the rating has reached (`all`: every higher rarity in `options`, not only the next two)
  rating: number; // that rarity's entry rating
  mult: number;
  year: number; // what the pass pays in the next 12 months at that rarity
  unused: number; // rating above the entry that pays nothing until the next rarity
  next: { tier: string; rating: number } | null;
  rungs: PassRung[]; // the engine's rungs from the held rating (the golden vectors)
  options: ClimbOption[]; // the next two rarities, with what each adds
  sell: number | null; // the unused rating at the build rate (lib/passRates.ts); null without one
}

/**
 * "I have 212 rating on this pass": the rarity it reached, what the rest of it does, and the next two steps. `minted`:
 * the pass is held even at 0 rating (a General), so its next rarity costs the cards alone, never the mint again.
 */
export function climb(
  market: PassBasis,
  held: number,
  rules: OtdRules,
  today: string,
  { minted = false, used = 0, mult, all = false }: { minted?: boolean; used?: number; mult?: number; all?: boolean } = {},
): Climb {
  const rating = Math.max(0, held);
  const at = tierAt(market.kind, rating, rules);
  if (mult !== undefined) at.mult = mult; // Real's own multiplier for the rung held
  const ladder = rules.ladders[market.kind] ?? [];
  const nextTier = ladder[at.index + 1];
  // `used`: all the pass has earned already (`earnedSoFar`): every limit is that much less.
  const left = (limit: number | null) => (limit === null ? null : Math.max(0, limit - used));
  const [limitNow] = limitOf(market, at.tier, at.mult, rules);
  const now = payAt(market, at.mult, left(limitNow), rules);
  const weights = monthWeights(market, rules);
  const up = rungs(market, rules, { today, heldRating: rating, minted });
  const options = (rating > 0 ? up : up.filter((r) => r.rating > 0)).slice(0, all ? undefined : 2).map((r): ClimbOption => {
    const then = payAt(market, r.mult, left(r.limit), rules);
    const back = r.cost === null ? null : payback(r.cost, then.flow - now.flow, weights, then.lifetime - now.lifetime, today, rules);
    return {
      ...r,
      extra_year: then.year - now.year,
      extra_pays_back: back ? back.pays_back : null,
      extra_payback_months: back ? back.months : null,
    };
  });
  const unused = nextTier ? rating - at.rating : 0;
  const rate = buildRate(market).rate;
  return {
    tier: at.tier,
    rating: at.rating,
    mult: at.mult,
    year: now.year,
    unused,
    next: nextTier ? { tier: nextTier[0], rating: nextTier[1] } : null,
    rungs: up,
    options,
    sell: rate === null ? null : unused * rate,
  };
}

// ---------- my passes: a modelled year of claims, per sport ----------

const PHI = 0.6180339887498949;

export interface HeldPass {
  holding: Holding;
  market: PassBasis;
  tier: string;
  mult: number;
  rating: number; // the exact rating when given (within Real's rung when it names one), else the tier's entry
  limit: number | null; // its On This Day limit: Real's cap when it says, else the rung's modelled lifetime limit
  cap: number | null; // Real's cap (0: it earns nothing On This Day); null when Real did not say
  used: number; // all it has earned so far that counts against a limit (`earnedSoFar`; 0: unknown, or a season being played)
  liftUnknown: boolean; // Real names a lower rung than the rating reaches: no lift can be priced from the rating
  year: number; // what it pays in the next 12 months on its own (its rung's year_rax)
  spent: boolean;
}

export interface SportPlan {
  sport: string;
  n: number; // passes held in the sport, maxed ones included
  claim_days: number; // the days a year the sport pays anyone
  slots: number; // 2 claims x those days
  pay_days: number; // the anniversaries the passes held pay on, between them
  used: number; // claims they win in the modelled year
  fill: number; // used / slots
  total: number; // what they pay in the next 12 months, together
  per: Record<string, number>; // each pass's share of it, by market key
  mates: string[][]; // names of passes that play on the same days (teammates of one season)
}

export interface Plan {
  held: HeldPass[];
  sports: Record<string, SportPlan>;
  total: number;
}

// The markets by key, once per markets array: a 2,000-pass account looks each of its passes up among thousands.
const BY_KEY = new WeakMap<readonly PassBasis[], Map<string, PassBasis>>();
function marketByKey(markets: readonly PassBasis[], key: string): PassBasis | undefined {
  let index = BY_KEY.get(markets);
  if (!index) {
    index = new Map();
    for (const m of markets) if (!index.has(m.key)) index.set(m.key, m);
    BY_KEY.set(markets, index);
  }
  return index.get(key);
}

/**
 * The rung a holding is at: Real's own (`rarity`, with its `mult`) when it says, else the rung its exact rating
 * reaches, else the rarity given by hand. Under Real's rung the rating is kept within that rung's range, so the
 * next rung's cost counts from it; `liftUnknown` when the rating already reaches a higher rung than Real names (Real
 * then wants more than rating, so no lift can be priced from it). Pure: no market needed, the ladder is the kind's.
 */
export function heldRung(
  h: Holding,
  kind: string,
  rules: OtdRules,
): { tier: string; mult: number; rating: number; index: number; liftUnknown: boolean } {
  const ladder = rules.ladders[kind] ?? [];
  const exact = typeof h.rating === "number" && Number.isFinite(h.rating) ? Math.max(0, h.rating) : undefined;
  const real = h.rarity ? ladder.findIndex(([t]) => t === h.rarity) : -1;
  if (real >= 0) {
    const [tier, entry, mult] = ladder[real]!;
    const next = ladder[real + 1]?.[1];
    const rating = Math.min(Math.max(exact ?? entry, entry), next !== undefined ? Math.max(entry, next - 0.1) : Infinity);
    const liftUnknown = exact !== undefined && next !== undefined && exact >= next;
    return { tier, rating, mult: h.mult !== undefined && h.mult > 0 ? h.mult : mult, index: real, liftUnknown };
  }
  const named = h.tier ? ladder.find(([t]) => t === h.tier) : undefined;
  const rating = exact ?? named?.[1] ?? 0;
  const at = tierAt(kind, rating, rules);
  return { tier: at.tier, rating, mult: at.mult, index: at.index, liftUnknown: false };
}

/** Real's On This Day limit for a holding (`cap`; 0 for a General), or null when Real did not say. */
export const realCap = (h: Holding): number | null =>
  typeof h.cap === "number" && Number.isFinite(h.cap) && h.cap >= 0 ? h.cap : null;

/**
 * All a past-season pass has earned (`earned`, live pay included), when Real states both it and a cap: the cap counts
 * all of it. Measured on 123 accounts read twice (the internal research notes, 4f): no pass at or over
 * its cap claimed (0 of 392 passes of the 2025 NFL season on an NFL anniversary, against 75 of 1,080 under it), the
 * last claim under it is paid whole, and a lift to a higher rarity reopens the pass for what the new limit leaves.
 * 0 when unknown, and for a season being played (its live pay has no limit, and Real states no cap for it).
 */
export const earnedSoFar = (h: Holding, market: Pick<PassBasis, "season_state">): number =>
  market.season_state !== "current" && realCap(h) !== null && typeof h.earned === "number" && Number.isFinite(h.earned) && h.earned > 0
    ? h.earned
    : 0;

/** A holding as a pass at its rarity; null when its market is not in today's data. Real's cap, when it says, is the
 * pass's On This Day limit in place of the modelled one (0: it earns nothing On This Day). */
export function resolveHolding(h: Holding, markets: readonly PassBasis[], rules: OtdRules): HeldPass | null {
  const market = marketByKey(markets, h.key);
  if (!market) return null;
  const at = heldRung(h, market.kind, rules);
  const cap = realCap(h);
  const used = earnedSoFar(h, market);
  const limit = cap !== null ? Math.max(0, cap - used) : limitOf(market, at.tier, at.mult, rules)[0];
  return {
    holding: h,
    market,
    tier: at.tier,
    mult: at.mult,
    rating: at.rating,
    limit,
    cap,
    used,
    liftUnknown: at.liftUnknown,
    year: payAt(market, at.mult, limit, rules).year,
    spent: h.spent === true,
  };
}

const claimDaysOf = (sport: string, rules: OtdRules, sports?: Record<string, PassSport>) =>
  Math.max(1, Math.round(sports?.[sport]?.claim_days ?? rules.sport_days[sport]?.[0] ?? 365));

/** A fixed pseudo-random number in [0, 1) for an integer (mulberry32's step): the same on every run and device. */
function hash01(a: number): number {
  let t = (a + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * A weekly sport's season, as the days one pass plays on. NFL and college football games are not spread over the
 * sport's days: in a season nearly every team plays on the same weekend dates (public schedules, 2023-2025: 18 NFL
 * Sundays, about 14 college Saturdays, each played by about three teams in four, carrying 78-80 % of a team's games),
 * and two seasons share few dates (1-8 %: the year is not part of a day, a weekday moves by one every year). So a
 * season has `H` shared days among its `C`; a pass plays on `share` of its games' worth of them, sitting out the
 * others (byes, and the Thursday or Monday it plays instead), and puts its remaining games on days outside them,
 * spread evenly. Which shared days a pass sits out looks random from one pass to the next, as the teams' do, and is
 * the same on every run. Medium confidence: whole teams' schedules, every player taken to play every game.
 */
function weeklyDays(sport: string, rules: OtdRules, C: number) {
  const spec = rules.weekly_days?.[sport];
  if (!spec || !(spec[0] >= 1) || spec[0] >= C || !(spec[1] > 0 && spec[1] <= 1)) return null;
  const [H, share] = spec;
  const hotSlots = Array.from({ length: H }, (_, h) => Math.floor(((h + 0.5) * C) / H));
  const taken = new Set(hotSlots);
  const coldSlots = Array.from({ length: C }, (_, d) => d).filter((d) => !taken.has(d));
  /** The `G` days of the `nth` pass of a season (0 first), earliest first. `salt` tells apart two seasons that share
   * their days (`same_weekdays`): without it the nth pass of each would sit out the very same shared days. */
  return (G: number, nth: number, salt = 0): number[] => {
    const nh = Math.min(H, Math.round(share * G));
    const nc = Math.min(coldSlots.length, G - nh);
    const seed = (nth + salt) * 7919;
    const rank = Array.from({ length: H }, (_, h) => h).sort((a, b) => hash01(seed + a * 104729 + 1) - hash01(seed + b * 104729 + 1) || a - b);
    const pos = rank.slice(H - nh).map((h) => hotSlots[h]!);
    const off = (nth * PHI) % 1;
    for (let k = 0; k < nc; k++) pos.push(coldSlots[Math.floor(((k + off) * coldSlots.length) / nc)]!);
    return pos.sort((a, b) => a - b);
  };
}

/**
 * One sport's year of claims. Each pass's game days are spread evenly over the days the sport pays (teammates of
 * one season on the same days, other passes offset by the golden ratio), and each day Real pays the
 * `claims_per_sport_day` passes that pay most that day, until each reaches its limit. A pass alone, or with one
 * other, wins every claim and pays exactly its rung's year; a season in progress adds its live games on top.
 * NFL and college football are the exception (`weeklyDays`): each season has its own days, and the passes of one
 * season, whatever the team, crowd onto the same shared ones, so a third pass of a season wins only about half.
 * Golf too: a season's tournaments end on the same 43 Sundays for every golfer, and seasons whose years have the
 * same weekdays (`same_weekdays`) replay those Sundays together (the internal research notes).
 */
export function replaySport(sport: string, passes: readonly HeldPass[], rules: OtdRules, sports?: Record<string, PassSport>): SportPlan {
  const C = claimDaysOf(sport, rules, sports);
  const weekly = weeklyDays(sport, rules, C);
  const live = passes.filter((p) => !p.spent);
  type Claimer = { p: HeldPass; perClaim: number; days: number; G: number; got: number; live: number };
  const claimers: Claimer[] = live.map((p) => {
    const g = p.market.game_days ?? rules.sport_days[sport]?.[1] ?? C;
    const G = Math.min(C, Math.max(1, Math.round(g)));
    const pay = payAt(p.market, p.mult, p.limit, rules);
    const { progress } = seasonOf(p.market, rules);
    const days = progress >= 1 ? G : Math.max(1, Math.round(progress * G));
    return { p, perClaim: pay.played / days, days, G, got: 0, live: pay.live };
  });
  const groups: { key: string; season: number; members: Claimer[] }[] = [];
  const groupOf = new Map<string, { key: string; season: number; members: Claimer[] }>();
  for (const c of claimers) {
    const m = c.p.market;
    const key = m.team_id !== null ? `${m.team_id}|${m.season}` : m.key;
    const group = groupOf.get(key);
    if (group) group.members.push(c);
    else {
      const fresh = { key, season: m.season, members: [c] };
      groupOf.set(key, fresh);
      groups.push(fresh);
    }
  }
  // One calendar of `C` days, or for a weekly sport one per season held (two seasons share almost no dates).
  const calendars = new Map<number, Claimer[][]>();
  const calendarOf = (season: number) => {
    const key = weekly ? season : 0;
    let days = calendars.get(key);
    if (!days) calendars.set(key, (days = Array.from({ length: C }, () => [])));
    return days;
  };
  // Golf: seasons whose years have the same weekdays replay the same tournament dates, on `same` of their days.
  const same = weekly ? rules.same_weekdays?.[sport] ?? 0 : 0;
  const inSeason = new Map<number, number>(); // the groups placed so far in each season: the next one's offset
  groups.forEach((group, j) => {
    const slots = calendarOf(group.season);
    const G = Math.max(...group.members.map((c) => c.G));
    const nth = weekly ? inSeason.get(group.season) ?? 0 : j;
    inSeason.set(group.season, nth + 1);
    const phi = (nth * PHI) % 1;
    const pos = weekly ? weekly(G, nth, same > 0 ? group.season * 101 : 0) : Array.from({ length: G }, (_, k) => Math.floor(((k + phi) * C) / G));
    const n = pos.length;
    for (const c of group.members) {
      for (let k = 0; k < c.days; k++) slots[pos[Math.floor((k * n) / c.G)] ?? 0]!.push(c);
    }
  });
  // The days in the order of the year: each calendar's day i, season by season. Seasons with the same weekdays
  // (`same_weekdays`, told by the weekday of their 1 July) are one day on `same` of their days: there the passes of
  // both claim against each other, as teammates' do.
  const seasons = [...calendars.keys()].sort((a, b) => a - b);
  const twins = new Map<number, number[]>();
  for (const season of seasons) {
    const key = same > 0 ? new Date(Date.UTC(season, 6, 1)).getUTCDay() - 7 : season; // -7..-1: never a season
    const list = twins.get(key);
    if (list) list.push(season);
    else twins.set(key, [season]);
  }
  const year: Claimer[][] = [];
  for (let d = 0; d < C; d++) {
    for (const group of twins.values()) {
      if (group.length > 1 && hash01(d * 7919 + group[0]! * 31 + 7) < same) year.push(group.flatMap((season) => calendars.get(season)![d]!));
      else for (const season of group) year.push(calendars.get(season)![d]!);
    }
  }
  let used = 0;
  // The live games to come fill the limit first (B9): the claims have what they leave.
  const room = (c: Claimer) => (c.p.limit === null ? Infinity : Math.max(0, c.p.limit - c.live) - c.got);
  // Real pays the day's best claims by what each pays that day: a claim that only has a little room left pays that little.
  const worth = (c: Claimer) => Math.min(c.perClaim, room(c));
  const before = (a: Claimer, b: Claimer) => worth(b) - worth(a) || a.p.market.key.localeCompare(b.p.market.key);
  const k = rules.claims_per_sport_day;
  const top: Claimer[] = [];
  for (const day of k > 0 ? year : []) {
    // The day's `k` best with room left, best first: what sorting the day and taking `k` gives, in one pass (a
    // 2,000-pass account fills a day with hundreds of claimers, and this runs for every replay of every move).
    top.length = 0;
    for (const c of day) {
      if (room(c) <= ROUNDING) continue;
      if (top.length === k && before(c, top[k - 1]!) >= 0) continue;
      let i = Math.min(top.length, k - 1);
      while (i > 0 && before(c, top[i - 1]!) < 0) i--;
      top.splice(i, 0, c);
      if (top.length > k) top.length = k;
    }
    for (const c of top) {
      c.got += Math.min(c.perClaim, room(c));
      used++;
    }
  }
  const per: Record<string, number> = {};
  for (const p of passes) per[p.market.key] = 0;
  for (const c of claimers) per[c.p.market.key] = c.got + c.live;
  const claimDays = Math.max(C, year.length); // a weekly sport: its seasons' days, twins' shared days counted once
  const slotsN = rules.claims_per_sport_day * claimDays;
  return {
    sport,
    n: passes.length,
    claim_days: claimDays,
    slots: slotsN,
    pay_days: claimers.reduce((s, c) => s + c.days, 0),
    used,
    fill: used / slotsN,
    total: claimers.reduce((s, c) => s + c.got + c.live, 0),
    per,
    mates: groups.filter((g) => g.members.length > 1).map((g) => g.members.map((c) => c.p.market.player_name)),
  };
}

/** Every pass this device holds, sport by sport: how full each sport's claims are and what they pay together. */
export function planHoldings(holdings: readonly Holding[], markets: readonly PassBasis[], rules: OtdRules, sports?: Record<string, PassSport>): Plan {
  const held = holdings.map((h) => resolveHolding(h, markets, rules)).filter((p): p is HeldPass => p !== null);
  const bySport = new Map<string, HeldPass[]>();
  for (const p of held) {
    const list = bySport.get(p.market.sport);
    if (list) list.push(p);
    else bySport.set(p.market.sport, [p]);
  }
  const out: Record<string, SportPlan> = {};
  let total = 0;
  for (const [sport, passes] of bySport) {
    out[sport] = replaySport(sport, passes, rules, sports);
    total += out[sport].total;
  }
  return { held, sports: out, total };
}

/** A pass that hardly ever gets a claim: what it could pay a year by itself, and what it gets in its sport. */
export interface IdlePass {
  pass: HeldPass;
  alone: number;
  gets: number;
}

/** Under this share of what it could pay alone, a pass hardly ever gets a claim. */
export const IDLE_SHARE = 0.25;

/**
 * The passes held that hardly ever get a claim: each could pay `alone` a year by itself, but passes that pay more play
 * on its days and take the sport's daily claims, so it gets under a quarter of that (`gets`, live pay included). Not a
 * maxed pass or one that pays nothing by itself (a General, a reached limit): those have their own words. The most
 * unused Rax first. As sure as `replaySport`'s days: exact for teammates of one season, an estimate otherwise.
 */
export function idlePasses(plan: Plan): IdlePass[] {
  const out: IdlePass[] = [];
  for (const p of plan.held) {
    if (p.spent || !(p.year > 0)) continue;
    const gets = plan.sports[p.market.sport]?.per[p.market.key] ?? 0;
    if (gets < IDLE_SHARE * p.year) out.push({ pass: p, alone: p.year, gets });
  }
  return out.sort((a, b) => b.alone - b.gets - (a.alone - a.gets) || a.pass.market.key.localeCompare(b.pass.market.key));
}

export interface NextPick {
  market: PassBasis;
  rung: PassRung;
  gain: number; // what it adds a year to the passes held (an estimate: the claims model)
  score: number; // gain per Rax spent
}

/** Whether a pass can be built at all: its cards trade, or some are on sale (advisor/otd.py is_liquid). */
export const isLiquid = (m: Pick<PassBasis, "rate_sales" | "shelf_count">) => m.rate_sales > 0 || m.shelf_count > 0;

/**
 * The `n` passes that add the most a year per Rax spent to the passes held, one after another (each pick counted
 * as held for the next): only rungs that pay back, do more than break even and fit the budget.
 */
export function nextBest(
  holdings: readonly Holding[],
  markets: readonly (PassBasis & { rungs?: PassRung[] })[],
  rules: OtdRules,
  {
    budget = null, n = 3, today, sports, plan: planned, memo, replays: most = NEXT_BEST_REPLAYS,
  }: {
    budget?: number | null;
    n?: number;
    today?: string;
    sports?: Record<string, PassSport>;
    plan?: Plan;
    // What a replay found, kept by the caller across calls (the snowball asks every month): a sport whose passes have
    // not changed gives the same gain, so it is not replayed again.
    memo?: Map<string, number>;
    replays?: number; // the most crowded-sport candidates weighed a step (NEXT_BEST_REPLAYS)
  } = {},
): NextPick[] {
  const day = today ?? new Date().toISOString().slice(0, 10);
  const ladders = new Map(markets.map((m) => [m.key, m.rungs ?? rungs(m, rules, { today: day })]));
  const held = [...holdings];
  const picks: NextPick[] = [];
  for (let step = 0; step < n; step++) {
    // The plan of `holdings` may come in hand (the caller just worked it out): the first step takes it.
    const plan = step === 0 && planned ? planned : planHoldings(held, markets, rules, sports);
    const heldKeys = new Set(held.map((h) => h.key));
    const mineOf = new Map<string, HeldPass[]>();
    const liveOf = new Map<string, number>();
    for (const p of plan.held) {
      const list = mineOf.get(p.market.sport);
      if (list) list.push(p);
      else mineOf.set(p.market.sport, [p]);
      if (!p.spent) liveOf.set(p.market.sport, (liveOf.get(p.market.sport) ?? 0) + 1);
    }
    // Every rung that could be bought, in the order the engine meets them (`at`, which settles a tie as it always
    // did), then worked through best upper bound first: what a pass pays alone is the most it can add, so once no
    // bound beats the best found, nothing left can. A crowded sport's replays stop after NEXT_BEST_REPLAYS a step.
    const cands: { m: PassBasis; r: PassRung & { cost: number }; bound: number; at: number }[] = [];
    for (const m of markets) {
      if (m.kind === "team" || !isLiquid(m) || heldKeys.has(m.key)) continue;
      for (const r of ladders.get(m.key) ?? []) {
        if (!r.pays_back || r.cost === null || r.cost <= 0 || breaksEvenAtBest(r) || (budget !== null && r.cost > budget)) continue;
        cands.push({ m, r: r as PassRung & { cost: number }, bound: r.year_rax / r.cost, at: cands.length });
      }
    }
    cands.sort((a, b) => b.bound - a.bound || a.at - b.at);
    let best: (NextPick & { at: number }) | null = null;
    let replays = most;
    for (const { m, r, bound, at } of cands) {
      if (best !== null && bound < best.score - 1e-12) break;
      const mine = mineOf.get(m.sport) ?? [];
      let gain = r.year_rax;
      if ((liveOf.get(m.sport) ?? 0) + 1 > rules.claims_per_sport_day) {
        // The budget counts the candidates weighed this way, remembered or not: the same passes give the same
        // answer from one call to the next, and a remembered one costs nothing.
        if (replays <= 0) continue;
        replays--;
        const before = plan.sports[m.sport]?.total ?? 0;
        const k = `${m.sport}|${mine.length}|${before}|${m.key}|${r.tier}`;
        const known = memo?.get(k);
        if (known !== undefined) gain = known;
        else {
          const cand = resolveHolding({ key: m.key, tier: r.tier }, markets, rules)!;
          // Capped at what it pays alone: a teammate joining with more game days re-spreads the group's days in the
          // replay, which can credit the held ones with claims no real pass would win (a model artefact).
          gain = Math.min(r.year_rax, replaySport(m.sport, [...mine, cand], rules, sports).total - before);
          memo?.set(k, gain);
        }
      }
      const score = gain / r.cost;
      if (best === null || score > best.score + 1e-12 || (score >= best.score - 1e-12 && at < best.at)) best = { market: m, rung: r, gain, score, at };
    }
    if (!best) break;
    picks.push({ market: best.market, rung: best.rung, gain: best.gain, score: best.score });
    held.push({ key: best.market.key, tier: best.rung.tier });
  }
  return picks;
}

/** The most replays of a crowded sport one step of `nextBest` makes (a few milliseconds each on a 1,000-pass sport). */
export const NEXT_BEST_REPLAYS = 12;

// ---------- when it pays ----------

/**
 * When a pass's pay is mostly months away (a past MLB season in November): the month it starts paying and the month
 * before it, to buy in; null when it pays soon enough, or never. "Mostly months away": the next
 * `rules.later.window_months` months from today (today's month from today on) hold under `share_below` of what its
 * next 12 months pay, both walked on its month weights. Its pay starts in the first month holding at least
 * `start_share` of its season after one that does not (a trace of pay in an off month does not count, nor do the last
 * weeks of a season ending now).
 */
export function paysLater(market: PassBasis, rules: OtdRules, today: string): { from: number; buy: number } | null {
  if (!rules.later || !(market.base_1x > 0)) return null;
  const { window_months: window, share_below: below, start_share: start } = rules.later;
  const weights = monthWeights(market, rules);
  const [y0, m0, d0] = parseDay(today);
  let soon = 0;
  let year = 0;
  let elapsed = 0;
  let length = (daysIn(y0, m0) - d0 + 1) / daysIn(y0, m0);
  for (let i = 0; elapsed < 12 - ROUNDING; i++) {
    length = Math.min(length, 12 - elapsed);
    const w = weights[((m0 - 1 + i) % 12)] ?? 0;
    year += w * length;
    if (elapsed < window) soon += w * Math.min(length, window - elapsed);
    elapsed += length;
    length = 1;
  }
  if (year <= 0 || soon >= below * year) return null;
  // The first such month after a quiet one: the last weeks of a season ending now are not when it "starts paying".
  let quiet = false;
  for (let i = 0; i < 12; i++) {
    const month = ((m0 - 1 + i) % 12) + 1;
    const real = (weights[month - 1] ?? 0) >= start;
    if (real && quiet) return { from: month, buy: month === 1 ? 12 : month - 1 };
    if (!real) quiet = true;
  }
  return null;
}

const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthName = (m: number) => MONTH[(m - 1 + 12) % 12]!;
export const monthShort = (m: number) => MON[(m - 1 + 12) % 12]!;

export interface MonthBars {
  months: number[]; // the next 12 calendar months, today's first
  pay: number[]; // what the rung pays in each (today's month from today on), stopping at its lifetime
  payback_index: number | null; // the bar its payback month falls on, when within these 12 months
  limit_index: number | null; // the bar where it reaches its lifetime, when within these 12 months
  quiet: string | null; // the months it pays nothing before that, in words: "nothing Jul–Sep"
  first_pay: string | null; // when today's month pays nothing: the month it starts paying
}

/** The next 12 months of one rung, on the same walk as the payback: a season's pay spread by its month weights. */
export function monthBars(market: PassBasis, rung: PassRung, rules: OtdRules, today: string): MonthBars {
  const [y0, m0, d0] = parseDay(today);
  const weights = monthWeights(market, rules);
  const pay = payAt(market, rung.mult, rung.limit, rules);
  const months: number[] = [];
  const bars: number[] = [];
  let paid = 0;
  let limitIndex: number | null = null;
  for (let i = 0; i < 12; i++) {
    const month = ((m0 - 1 + i) % 12) + 1;
    const length = i === 0 ? (daysIn(y0, m0) - d0 + 1) / daysIn(y0, m0) : 1;
    const want = pay.flow * (weights[month - 1] ?? 0) * length;
    const got = Math.max(0, Math.min(want, pay.lifetime - paid));
    paid += got;
    if (limitIndex === null && rung.limit && want > 0 && paid >= pay.lifetime * (1 - ROUNDING)) limitIndex = i;
    months.push(month);
    bars.push(got);
  }
  let paybackIndex: number | null = null;
  if (rung.pays_back && rung.payback_month) {
    const [py, pm] = rung.payback_month.split("-").map(Number);
    const i = ((py ?? y0) - y0) * 12 + ((pm ?? m0) - m0);
    paybackIndex = i >= 0 && i < 12 ? i : null;
  }
  const end = limitIndex ?? 11;
  const runs: [number, number][] = [];
  let open: [number, number] | null = null;
  bars.forEach((v, i) => {
    if (i > end) return;
    if (v < ROUNDING) {
      if (open) open[1] = i;
      else runs.push((open = [i, i]));
    } else open = null;
  });
  const quiet = runs.length
    ? "nothing " + runs.map(([a, b]) => (a === b ? `in ${monthName(months[a]!)}` : `${monthShort(months[a]!)}–${monthShort(months[b]!)}`)).join(" or ")
    : null;
  const firstIndex = bars.findIndex((v) => v >= ROUNDING);
  return {
    months,
    pay: bars,
    payback_index: paybackIndex,
    limit_index: limitIndex,
    quiet,
    first_pay: bars[0]! < ROUNDING && firstIndex > 0 ? monthName(months[firstIndex]!) : null,
  };
}

/**
 * What a pass at `mult` and `limit` pays in each of the next 12 calendar months (today's first, from today on) when it
 * is bought at the start of month `from` (0 = now): its season's shares, until its lifetime limit counted from the buy.
 */
export function payFrom(market: PassBasis, mult: number, limit: number | null, rules: OtdRules, today: string, from = 0): number[] {
  const [y0, m0, d0] = parseDay(today);
  const weights = monthWeights(market, rules);
  const pay = payAt(market, mult, limit, rules);
  const out: number[] = [];
  let paid = 0;
  for (let i = 0; i < 12; i++) {
    if (i < from) {
      out.push(0);
      continue;
    }
    const month = ((m0 - 1 + i) % 12) + 1;
    const length = i === 0 ? (daysIn(y0, m0) - d0 + 1) / daysIn(y0, m0) : 1;
    const got = Math.max(0, Math.min(pay.flow * (weights[month - 1] ?? 0) * length, pay.lifetime - paid));
    paid += got;
    out.push(got);
  }
  return out;
}

/** Months from today until the pass has paid its lifetime limit, on the payback walk; null without a limit. */
export function monthsToLimit(market: PassBasis, rung: PassRung, rules: OtdRules, today: string): number | null {
  if (!rung.limit) return null; // none, or a General's 0: it pays its live games, never a limit
  const pay = payAt(market, rung.mult, rung.limit, rules);
  const back = payback(pay.lifetime, pay.flow, monthWeights(market, rules), Infinity, today, { ...rules, payback_horizon_years: 30 });
  return back.months;
}

/**
 * The payback walk of one rung at another cost (cards bought below the traded rate, by offers): the engine's own walk
 * (`payback`), on the rung's multiplier and limit, from `today`.
 */
export function paybackAtCost(
  market: PassBasis,
  rung: Pick<PassRung, "mult" | "limit">,
  cost: number,
  rules: OtdRules,
  today: string,
): Payback {
  const pay = payAt(market, rung.mult, rung.limit, rules);
  return payback(cost, pay.flow, monthWeights(market, rules), pay.lifetime, today, rules);
}

/**
 * When passes bought today together pay back what they cost: their `payFrom` months added, walked as `payback` walks
 * one pass (today's month counts from today). Null when it takes more than those 12 months. A pass that reaches its
 * limit inside a month slows that month's rate a little: a month-level estimate, like every payback here.
 */
export function paybackTogether(flows: readonly (readonly number[])[], cost: number, today: string): { months: number; month: string } | null {
  let [year, month, day] = parseDay(today);
  if (cost <= 0) return { months: 0, month: ym(year, month) };
  let paid = 0;
  let elapsed = 0;
  for (let i = 0; i < 12; i++) {
    const length = i === 0 ? (daysIn(year, month) - day + 1) / daysIn(year, month) : 1;
    const got = flows.reduce((sum, f) => sum + (f[i] ?? 0), 0);
    if (got > 0 && paid + got >= cost * (1 - ROUNDING)) {
      return { months: elapsed + ((cost - paid) / got) * length, month: ym(year, month) };
    }
    paid += got;
    elapsed += length;
    if (month === 12) {
      year += 1;
      month = 1;
    } else month += 1;
    day = 1;
  }
  return null;
}
