// "Your next Rax": the visitor's best next moves, ranked by what each Rax returns over the next 12 months. Three kinds,
// all priced from what the snapshot already serves (the passes' rungs and sale rates, the deals and their usual
// prices): (a) a pass in a sport whose daily claims are not all taken, (b) rating that lifts a pass this device holds
// to a higher rarity, (c) a deal that still leaves a margin after Real's fees. Packs are never offered: nothing
// prices them yet. Pure; nothing leaves the page.
import { about, aboutN, tierName, titleText } from "../content/passWords";
import { filterDeals } from "../data/filters";
import type { LevelKey, Prefs } from "../data/prefs";
import type { Deal, PassMarket, PassRung, Snapshot } from "../data/types";
import { formatRax } from "./format";
import { dealOwned, ownIndex } from "./owned";
import { type Holding, type PassBasis, breaksEvenAtBest, climb, dayOf, isLiquid, paysLater, planHoldings, replaySport, resolveHolding } from "./passes";
import { sportLabel, seasonLabel } from "./words";

export type MoveKind = "slot" | "rung" | "deal";

/** Whether the Rax can come back by selling what was bought. */
export type Resell = "yes" | "partly" | "unknown";

export interface NextMove {
  key: string;
  kind: MoveKind;
  sport: string;
  title: string; // "Add a pass in NHL: a daily claim is free", "Lift Nathan MacKinnon to Epic", "Deal: Jamal Murray"
  what: string; // the pass or the card, in a few words
  cost: number; // Rax
  year: number | null; // what it adds a year (an estimate): passes only
  net: number | null; // what reselling at the usual price leaves after fees, minus the price: deals only
  returns: string; // "about 300 a year (estimate)" or "+32 after fees"
  per: number; // return per Rax: the ranking figure
  resell: Resell;
  note: string | null; // one more plain fact, when there is one
  market?: PassMarket;
  rung?: PassRung;
  deal?: Deal;
}

export interface NextRax {
  moves: NextMove[];
  free: boolean; // the visitor holds no pass yet: the free-player order applies
  paused: boolean; // the deals' prices are paused: deals are left out
}

export interface NextRaxInput {
  holdings: readonly Holding[];
  level: LevelKey;
  budget: number | null; // the most for one deal (the visitor's budget)
  passBudget: number | null; // the most for one pass
  balance: number | null; // what the visitor says they have, when they typed it: nothing costs more than this
  now: number;
  paused: boolean;
  n?: number; // how many moves at most (3 on Today, 5 on Passes)
}

/** The most replays of a crowded sport one call makes for the slots, and as many for the lifts (a few milliseconds
 * each on a 1,000-pass sport). */
export const REPLAYS = 16;

/** What a player with no pass yet should do, in order (the owner's thinking, in plain words): passes first, built
 * cheaply with offers; deals only while no pass fits (lib/budget.ts says why, with the numbers). */
export const FREE_ORDER: readonly string[] = [
  "Your free pass in each sport, on different game days.",
  "Take one to Common (10 rating) so it pays On This Day: offers under the usual price get that rating cheapest.",
  "Small, safe deals only while no pass fits your Rax.",
];

/** The visitor's best next moves: the passes' and the deals', ranked together. */
export function nextRax(snap: Snapshot, input: NextRaxInput): NextRax {
  return rankMoves([...passMoves(snap, input), ...dealMoves(snap, input)], input);
}

/** The moves ranked, best first, cut to `input.n`. */
export function rankMoves(moves: readonly NextMove[], input: Pick<NextRaxInput, "holdings" | "n" | "paused">): NextRax {
  const ranked = [...moves].sort((a, b) => (beats(a, b) ? -1 : beats(b, a) ? 1 : 0));
  return { moves: ranked.slice(0, input.n ?? 3), free: input.holdings.length === 0, paused: input.paused };
}

const affordableIn = (balance: number | null) => (cost: number) => balance === null || cost <= balance;

/**
 * The passes' moves: (a) and (b). They depend on the passes, the rules and the visitor's choices, never on the clock
 * or the deals, so a page works them out once per change of those (a big account's take tens of milliseconds) and
 * the deals' every few seconds. One claim slot of a sport is "empty" while the sport's claims are not nearly all
 * taken (rules.otd.full_at).
 */
export function passMoves(snap: Pick<Snapshot, "otd" | "rules">, input: NextRaxInput): NextMove[] {
  const { holdings, level, passBudget, balance } = input;
  const rules = snap.rules.otd;
  const markets = snap.otd.markets;
  const today = dayOf(snap.otd.as_of);
  const isNew = level === "new";
  const affordable = affordableIn(balance);
  const okRung = (r: PassRung): r is PassRung & { cost: number } =>
    r.pays_back === true && r.cost !== null && r.cost > 0 && !breaksEvenAtBest(r) &&
    (passBudget === null || r.cost <= passBudget) && affordable(r.cost) &&
    (!isNew || (!r.projected && (r.payback_months ?? Infinity) <= 12));
  const resellOf = (r: PassRung): Resell => (r.route === "cards" ? "yes" : r.route === "mint+cards" ? "partly" : "unknown");

  const plan = planHoldings(holdings, markets, rules, snap.otd.sports);
  const held = new Set(holdings.map((h) => h.key));
  const moves: NextMove[] = [];
  // A pass whose pay is mostly months away (a past MLB season in November) is no move for now: its Rax would sit idle
  // until its months come. The Passes list still shows it, saying when it pays and when to buy it.
  const laterOf = new Map<string, boolean>();
  const later = (m: PassBasis) => {
    let v = laterOf.get(m.key);
    if (v === undefined) laterOf.set(m.key, (v = paysLater(m, rules, today) !== null));
    return v;
  };

  // (a) A pass where a sport's claims are not all taken: one move per sport, the best return per Rax. The gain is what
  // it adds to the passes held (a pass among teammates, who play the same days, adds less than one on another team).
  // What a pass pays alone is an upper bound on what it adds (replaying can only lower it), so where a sport needs the
  // replay its candidates go best bound first and stop once none can beat the sport's best found: a 2,000-pass
  // account would otherwise replay its whole sport for every rung of every pass it does not hold.
  const slots = new Map<string, NextMove>();
  const mineOf = new Map<string, typeof plan.held>();
  const liveOf = new Map<string, number>(); // the passes of a sport that still pay
  for (const p of plan.held) {
    const list = mineOf.get(p.market.sport);
    if (list) list.push(p);
    else mineOf.set(p.market.sport, [p]);
    if (!p.spent) liveOf.set(p.market.sport, (liveOf.get(p.market.sport) ?? 0) + 1);
  }
  // Each replay of a crowded sport costs a few milliseconds; a call makes at most REPLAYS of them, the most promising
  // first. Below that many candidates the answer is exact; above it, the best found among the most promising.
  let replays = REPLAYS; // (a)'s; (b) has as many of its own, so the slots never spend the lifts' share
  const candidates: { m: PassMarket; r: PassRung & { cost: number } }[] = [];
  for (const m of markets) {
    if (m.kind === "team" || !isLiquid(m) || held.has(m.key)) continue;
    const sp = plan.sports[m.sport];
    if (sp && sp.fill >= rules.full_at) continue;
    if (later(m)) continue;
    for (const r of m.rungs) if (okRung(r) && r.year_rax > 0) candidates.push({ m, r });
  }
  candidates.sort((a, b) => b.r.year_rax / b.r.cost - a.r.year_rax / a.r.cost);
  for (const { m, r } of candidates) {
    const best = slots.get(m.sport);
    const mine = mineOf.get(m.sport) ?? [];
    const live = liveOf.get(m.sport) ?? 0;
    const sp = plan.sports[m.sport];
    let gain = r.year_rax;
    if (live + 1 > rules.claims_per_sport_day) {
      if (best && r.year_rax / r.cost < best.per) continue; // cannot beat it, even paying all it pays alone
      if (replays <= 0) continue;
      replays--;
      const candidate = resolveHolding({ key: m.key, tier: r.tier }, markets, rules)!;
      gain = Math.min(gain, replaySport(m.sport, [...mine, candidate], rules, snap.otd.sports).total - (sp?.total ?? 0));
    }
    if (!(gain > 0)) continue;
    const mate = mine.find((p) => p.market.team_id !== null && p.market.team_id === m.team_id && p.market.season === m.season);
    const move: NextMove = {
      key: `slot:${m.key}:${r.tier}`,
      kind: "slot",
      sport: m.sport,
      title: `Add a pass in ${sportLabel(m.sport)}: a daily claim is free`,
      what: `${titleText(m)} · ${tierName(r.tier)}`,
      cost: r.cost,
      year: gain,
      net: null,
      returns: `about ${about(gain)} a year (estimate)`,
      per: gain / r.cost,
      resell: resellOf(r),
      note: mate ? `Plays on the same days as ${mate.market.player_name}.` : null,
      market: m,
      rung: r,
    };
    if (!best || beats(move, best)) slots.set(m.sport, move);
  }
  moves.push(...slots.values());

  // (b) Rating that lifts a pass held over a rung: of the next two rarities, the one returning the most per Rax.
  // A pass held at rating 0 is a General: it pays nothing On This Day, so its move is the cards to Common (or the
  // rarity after it), priced without the mint: the pass is minted already.
  // What a lift pays alone is an upper bound: where a sport holds more live passes than it pays claims a day, the
  // lift adds only what it adds to the sport (replayed: a pass two stronger teammates outrank adds nothing). Replaying
  // can only lower a lift, so a candidate whose bound cannot beat the n-th kept is dropped unreplayed. In a crowded
  // sport the replays go first to the passes that already win claims (what they win now, at the higher rarity's
  // multiplier, is how much they stand to add), and stop after REPLAYS: a 2,000-pass account stays quick.
  const lifts: NextMove[] = [];
  for (const p of plan.held) {
    if (p.spent || p.liftUnknown || later(p.market)) continue;
    let best: NextMove | null = null;
    // From the rung held (Real's own when it says), what it earned already counted: a pass Real caps at 0 still
    // lifts, for what the higher rung's limit leaves.
    for (const o of climb(p.market, p.rating, rules, today, { minted: true, used: p.used, mult: p.mult }).options) {
      if (o.cost === null || o.cost <= 0 || !(o.extra_year > 0) || o.extra_pays_back !== true) continue;
      if ((passBudget !== null && o.cost > passBudget) || !affordable(o.cost)) continue;
      if (isNew && ((o.payback_months ?? Infinity) > 12 || o.projected)) continue;
      const move: NextMove = {
        key: `rung:${p.holding.key}:${o.tier}`,
        kind: "rung",
        sport: p.market.sport,
        title: `Lift ${p.market.player_name} to ${tierName(o.tier)}`,
        what: `${titleText(p.market)} · about ${formatRax(aboutN(o.rating_to_add))} more rating`,
        cost: o.cost,
        year: o.extra_year,
        net: null,
        returns: `adds about ${about(o.extra_year)} a year (estimate)`,
        per: o.extra_year / o.cost,
        resell: "yes",
        note: null,
        market: p.market as PassMarket,
        rung: o,
      };
      if (!best || beats(move, best)) best = move;
    }
    if (best) lifts.push(best);
  }
  let liftReplays = REPLAYS;
  const crowded = (sport: string) => (liveOf.get(sport) ?? 0) > rules.claims_per_sport_day;
  const heldNow = new Map(plan.held.map((q) => [q.market.key, q]));
  const promise = (lift: NextMove): number => {
    if (!crowded(lift.sport)) return lift.per;
    const now = heldNow.get(lift.market!.key)!;
    const wins = plan.sports[lift.sport]?.per[lift.market!.key] ?? 0;
    return Math.min(lift.year!, wins * (lift.rung!.mult / Math.max(now.mult, 1e-9) - 1)) / lift.cost;
  };
  const ranked = lifts.map((lift) => ({ lift, promise: promise(lift) })).sort((a, b) => b.promise - a.promise || b.lift.per - a.lift.per);
  const kept: NextMove[] = [];
  for (const { lift } of ranked) {
    const cap = input.n ?? 3;
    if (kept.length >= cap && lift.per <= kept[cap - 1]!.per) continue;
    const sport = lift.sport;
    const mine = mineOf.get(sport) ?? [];
    let gain = lift.year!;
    if (crowded(sport)) {
      if (liftReplays <= 0) continue;
      liftReplays--;
      const i = mine.findIndex((q) => q.market.key === lift.market!.key);
      const now = mine[i]!;
      const r = lift.rung!;
      const lifted = resolveHolding(
        {
          key: now.holding.key,
          rating: now.rating + r.rating_to_add,
          ...(now.holding.rarity ? { rarity: r.tier } : {}),
          ...(now.cap !== null ? { cap: r.limit ?? undefined } : {}), // the higher rung's limit, as Real raises it
        },
        markets,
        rules,
      );
      if (!lifted) continue;
      const after = replaySport(sport, mine.map((q, j) => (j === i ? lifted : q)), rules, snap.otd.sports).total;
      gain = Math.min(gain, after - (plan.sports[sport]?.total ?? 0));
    }
    if (!(gain > 0)) continue;
    kept.push({ ...lift, year: gain, per: gain / lift.cost, returns: `adds about ${about(gain)} a year (estimate)` });
    kept.sort((a, b) => b.per - a.per);
  }
  moves.push(...kept);
  return moves;
}

/** (c) A deal that leaves a margin after fees, never a falling market's or a thin one, nor a card of a pass held at
 * its rarity or higher. One per player-season. None while prices are paused. */
export function dealMoves(snap: Pick<Snapshot, "deals" | "levels" | "rules">, input: NextRaxInput): NextMove[] {
  const { level } = input;
  const affordable = affordableIn(input.balance);
  const moves: NextMove[] = [];
  // A card of a pass held at its rarity or higher is never a move: the visitor owns it already.
  const owned = input.holdings.length ? ownIndex(input.holdings, snap.rules.otd) : null;
  if (!input.paused) {
    const prefs: Prefs = { sport: "all", budget: input.budget, level, sort: "best", tab: "today", passBudget: null };
    const bySeason = new Map<string, NextMove>();
    for (const d of filterDeals(snap.deals, prefs, snap.levels, input.now)) {
      if (d.falling || !(d.flip_margin > 0) || d.reference < snap.rules.after_fees_min_ref || !affordable(d.price)) continue;
      if (owned && dealOwned(d, owned) !== null) continue;
      const unit = d.kind === "target" ? "to start" : "top bid";
      const move: NextMove = {
        key: `deal:${d.listing_id}`,
        kind: "deal",
        sport: d.sport,
        title: `Deal: ${d.player_name}`,
        what: `${sportLabel(d.sport)} ${seasonLabel(d.sport, d.season)} · ${formatRax(d.price)} ${unit}, usually ${formatRax(d.reference)}`,
        cost: d.price,
        year: null,
        net: d.flip_margin,
        returns: `+${formatRax(Math.round(d.flip_margin))} after fees`,
        per: d.flip_margin / d.price,
        resell: "yes",
        note: null,
        deal: d,
      };
      const group = `${d.sport}:${d.season}:${d.player_id}`;
      const best = bySeason.get(group);
      if (!best || beats(move, best)) bySeason.set(group, move);
    }
    moves.push(...bySeason.values());
  }
  return moves;
}

/** Whether `a` ranks above `b`: more return per Rax, then more return, then cheaper, then by key (a total order). */
function beats(a: NextMove, b: NextMove): boolean {
  if (a.per !== b.per) return a.per > b.per;
  const ar = a.year ?? a.net ?? 0;
  const br = b.year ?? b.net ?? 0;
  if (ar !== br) return ar > br;
  if (a.cost !== b.cost) return a.cost < b.cost;
  return a.key < b.key;
}

/** The line a move's resale gets: only what is known. */
export function resellText(resell: Resell): string {
  if (resell === "yes") return "Resellable: market cards trade";
  if (resell === "partly") return "The cards resell; the mint may not";
  return "Resale not known";
}
