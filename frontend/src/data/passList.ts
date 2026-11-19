// The Passes list: which passes this visitor sees, at which rarity, in which order, and what the filters hide.
// Every number comes from the snapshot's rungs; the browser only chooses among them.
import type { Owned } from "../lib/owned";
import { buildRate } from "../lib/passRates";
import { breaksEvenAtBest, climb, dayOf, earnedSoFar, isLiquid, onSale, recommendedRung } from "../lib/passes";
import { foldName } from "../lib/words";
import type { LevelKey } from "./prefs";
import type { OtdRules, PassMarket, PassOnSale, PassRung, Snapshot } from "./types";

export type PassSeason = "all" | "past" | "current";
export type PassSort = "ret" | "soon" | "cheap" | "year";

/** The sorts, the default first: paid back soonest from today, so a season months away waits for its months. */
export const PASS_SORTS: Record<PassSort, string> = {
  soon: "Pays back soonest",
  ret: "Best return",
  cheap: "Cheapest",
  year: "Most Rax a year",
};

export interface PassFilters {
  level: LevelKey;
  budget: number | null; // the most to spend on one pass; null = any
  sport: string; // "all" or a sport with passes
  season: PassSeason;
  soon: boolean; // "Can be built within 3 weeks": enough rating on sale now
  showAll: boolean; // also the passes that never pay back
  sort: PassSort;
  query: string;
  held?: ReadonlySet<string>; // the keys of the passes this device holds: never the top pick (as in "Best to add next")
  // The rungs held, by key (lib/owned): a pass held at its shown rung or higher is marked `owned`; one held lower is
  // shown at the same rung priced as the lift from the rung held (`held`). Neither is ever the top pick.
  owned?: ReadonlyMap<string, Owned>;
  // "Build to" (lib/buildToSwitch.ts): a tier every pass is priced at instead of its own best one; none, Best for each.
  buildTo?: string | null;
}

/** The rarities a list can be built to: Common to Iconic (General pays nothing On This Day). */
export const BUILD_TO_TIERS = ["common", "uncommon", "rare", "epic", "legendary", "mystic", "iconic"] as const;

/**
 * Why a pass is set apart when the list is built to one rarity, in the order they are listed: over the budget there
 * (a good pass, too dear); never paid back within the horizon; its limit no more than its cost; no price; no rung or
 * no card to build it with.
 */
export type OutReason = "over" | "never" | "even" | "unpriced" | "none";
const OUT_ORDER: readonly OutReason[] = ["over", "never", "even", "unpriced", "none"];

/** New starts on past seasons only: their figures are final. */
export const defaultSeason = (level: LevelKey): PassSeason => (level === "new" ? "past" : "all");

export type RowKind = "row" | "never" | "team";

export interface PassRow {
  market: PassMarket;
  rung: PassRung;
  kind: RowKind;
  owned?: string; // the rung the visitor holds it at, its shown rung or higher: nothing to buy
  held?: string; // the lower rung held: `rung` is priced as the lift from it
  thin?: boolean; // built to a rarity: priced on a thin rate (lib/passRates.ts buildRate), less certain
  why?: OutReason; // built to a rarity: why the pass is set apart
}

/**
 * The rung a pass is shown at: the best within the budget among those that pay back and do more than break even
 * ("row"); for a pass none of whose rungs does, the one closest to paying back ("never"); a team pass at its first
 * card-built rarity, whose cost nobody can price yet ("team"); "over" when only rungs above the budget pay back.
 */
export function shownRung(market: PassMarket, budget: number | null): { kind: RowKind | "over" | "unpriced"; rung: PassRung | null } {
  if (market.kind === "team") return { kind: "team", rung: market.rungs.find((r) => r.rating > 0) ?? market.rungs[0] ?? null };
  const best = recommendedRung(market.rungs, budget);
  if (best) return { kind: "row", rung: best };
  if (recommendedRung(market.rungs) === null) {
    const priced = market.rungs.filter((r) => r.lifetime_per_rax !== null);
    if (priced.length === 0) return { kind: "unpriced", rung: null };
    return { kind: "never", rung: priced.reduce((a, b) => (b.lifetime_per_rax! > a.lifetime_per_rax! ? b : a)) };
  }
  return { kind: "over", rung: null };
}

/** What the shelf holds toward this rung's rating: the server's figure for the best rung, else counted here. */
export function saleFor(market: PassMarket, rung: PassRung, rules: OtdRules): PassOnSale & { ignored: number } {
  const own = onSale(market, rung.rating_to_add, rules);
  if (rung.tier === market.best && market.on_sale) return { ...market.on_sale, ignored: own.ignored };
  return own;
}

/**
 * A row as the visitor sees it: theirs at this rung or higher (`owned`), or the lift from the lower rung they hold:
 * the rating still to add, its cost, and what it adds a year over the rung held (Real's cap as the limit held), so its
 * payback is the lift's own. A lift Real wants more than rating for (`liftUnknown`) is shown unpriced.
 */
function ownedRow(market: PassMarket, rung: PassRung, held: Owned | undefined, rules: OtdRules, today: string): PassRow {
  if (!held) return { market, rung, kind: "row" };
  const index = (rules.ladders[market.kind] ?? []).findIndex(([t]) => t === rung.tier);
  if (held.index >= index) return { market, rung, kind: "row", owned: held.tier };
  const unpriced = { ...rung, cost: null, year_per_rax: null, lifetime_per_rax: null, pays_back: null, payback_months: null, payback_month: null };
  if (held.liftUnknown) return { market, rung: unpriced, kind: "row", held: held.tier };
  // Real's cap is the limit of the rung held: a lift adds over what the pass pays with it.
  // What it earned already counts against the limit, as in the plan's lifts (lib/nextRax.ts).
  const used = earnedSoFar({ key: market.key, cap: held.cap ?? undefined, earned: held.earned }, market);
  const options = climb(market, held.rating, rules, today, { minted: true, used, mult: held.mult, all: true }).options;
  const o = options.find((x) => x.tier === rung.tier);
  if (!o) return { market, rung: unpriced, kind: "row", held: held.tier };
  const lift: PassRung = {
    ...o,
    year_rax: o.extra_year,
    year_per_rax: o.cost ? o.extra_year / o.cost : null,
    pays_back: o.extra_pays_back,
    payback_months: o.extra_payback_months,
  };
  return { market, rung: lift, kind: "row", held: held.tier };
}

/** The passes of the same team and season (and ladder): they play on the same days. */
export const teammatesOf = (market: PassMarket, markets: readonly PassMarket[]) =>
  market.team_id === null
    ? []
    : markets.filter(
        (m) => m !== market && m.team_id === market.team_id && m.season === market.season && m.kind === market.kind,
      );

/**
 * The cheapest way into a sport not held yet: of each such sport's starter pass (the server's), its best Common or
 * Uncommon rung that pays back and does more than break even; the first of them by `soonest`.
 */
export function starterPick(snap: Snapshot, heldSports: ReadonlySet<string>): PassRow | null {
  const rules = snap.rules.otd;
  let best: PassRow | null = null;
  for (const [sport, key] of Object.entries(snap.otd.starters)) {
    if (heldSports.has(sport)) continue;
    const market = snap.otd.markets.find((m) => m.key === key);
    if (!market) continue;
    for (const rung of market.rungs) {
      if (rung.projected || !rules.starter_tiers.includes(rung.tier) || !rung.pays_back) continue;
      if (rung.year_per_rax === null || rung.cost === null || breaksEvenAtBest(rung)) continue;
      const row: PassRow = { market, rung, kind: "row" };
      if (best === null || soonest(row, best) < 0) best = row;
    }
  }
  return best;
}

/** Whether the rung can be built now: a mint needs no card; otherwise enough rating must be on sale. */
export function buildable(market: PassMarket, rung: PassRung, rules: OtdRules): boolean {
  if (rung.route === "mint") return true;
  if (rung.tier === market.best && market.on_sale) return market.on_sale.enough;
  return onSale(market, rung.rating_to_add, rules).enough;
}

const rank = (a: PassRow, b: PassRow) =>
  b.rung.year_per_rax! - a.rung.year_per_rax! ||
  b.rung.year_rax - a.rung.year_rax ||
  a.market.player_id - b.market.player_id ||
  a.market.season - b.market.season ||
  a.market.key.localeCompare(b.market.key);

/** advisor/otd.py _rank: paid back soonest from today (walking the months its season pays in), then `rank`. */
const soonest = (a: PassRow, b: PassRow) =>
  (a.rung.payback_months ?? Infinity) - (b.rung.payback_months ?? Infinity) || rank(a, b);

const SORTERS: Record<PassSort, (a: PassRow, b: PassRow) => number> = {
  ret: rank,
  soon: soonest,
  cheap: (a, b) => (a.rung.cost ?? Infinity) - (b.rung.cost ?? Infinity) || rank(a, b),
  year: (a, b) => b.rung.year_rax - a.rung.year_rax || rank(a, b),
};

export interface PassListState {
  rows: PassRow[];
  never: PassRow[]; // shown only with Show all
  teams: PassRow[];
  hidden: { never: number; over: number; slow: number; notSoon: number; unpriced: number };
  top: PassRow | null; // the first by `soonest` among the rows not held yet: the hero
  counts: Record<string, number> & { all: number }; // rows per sport tab, every other filter applied
  candidates: number; // the rows the top pick was chosen from (those not held yet)
  out?: PassRow[]; // built to a rarity only: the passes set apart there, each with `why`
}

/** The sports with passes, the busiest first (the deals' order), then the rest by name. */
export function passSports(snap: Snapshot): string[] {
  const all = Object.keys(snap.otd.sports);
  return [...snap.sports.filter((s) => all.includes(s)), ...all.filter((s) => !snap.sports.includes(s)).sort()];
}

/** The Passes list for these filters. The rows are the server's picks; the never-paying passes come from the rest. */
export function passList(snap: Snapshot, f: PassFilters): PassListState {
  if (f.buildTo) return buildToList(snap, f, f.buildTo);
  const { otd } = snap;
  const rules = snap.rules.otd;
  const picked = new Set(Object.values(otd.picks).flat());
  const q = foldName(f.query.trim());
  const seasonOK = (m: PassMarket) => f.season === "all" || m.season_state === f.season;
  const queryOK = (m: PassMarket) => q === "" || foldName(m.player_name).includes(q);

  const rows: PassRow[] = [];
  const never: PassRow[] = [];
  const teams: PassRow[] = [];
  const hidden = { never: 0, over: 0, slow: 0, notSoon: 0, unpriced: 0 };
  const counts: Record<string, number> & { all: number } = { all: 0 };

  for (const market of otd.markets) {
    if (!seasonOK(market) || !queryOK(market)) continue;
    const sportOK = f.sport === "all" || market.sport === f.sport;
    const shown = shownRung(market, f.budget);
    if (shown.kind === "team") {
      if (sportOK && shown.rung) teams.push({ market, rung: shown.rung, kind: "team" });
      continue;
    }
    if (shown.kind === "never") {
      if (!sportOK) continue;
      if (f.showAll) never.push({ market, rung: shown.rung!, kind: "never" });
      else hidden.never++;
      continue;
    }
    if (!picked.has(market.key)) continue;
    if (shown.kind === "unpriced") {
      if (sportOK) hidden.unpriced++;
      continue;
    }
    if (shown.kind === "over") {
      if (sportOK) hidden.over++;
      continue;
    }
    const rung = shown.rung!;
    if (f.level === "new" && (rung.payback_months ?? Infinity) > 12) {
      if (sportOK) hidden.slow++;
      continue;
    }
    if (f.soon && !buildable(market, rung, rules)) {
      if (sportOK) hidden.notSoon++;
      continue;
    }
    counts.all++;
    counts[market.sport] = (counts[market.sport] ?? 0) + 1;
    if (sportOK) rows.push(ownedRow(market, rung, f.owned?.get(market.key), rules, dayOf(otd.as_of)));
  }
  rows.sort((a, b) => SORTERS[f.sort](a, b));
  never.sort((a, b) => (b.rung.lifetime_per_rax ?? 0) - (a.rung.lifetime_per_rax ?? 0) || a.market.key.localeCompare(b.market.key));
  teams.sort((a, b) => b.rung.year_rax - a.rung.year_rax || a.market.key.localeCompare(b.market.key));
  const open = rows.filter((row) => !f.held?.has(row.market.key) && !f.owned?.has(row.market.key));
  const top = open.length ? [...open].sort(soonest)[0]! : null;
  return { rows, never, teams, hidden, top, counts, candidates: open.length };
}

/**
 * The order of a list built to one rarity: `rank`'s key (the most Rax a year per Rax spent, then the bigger year); on a
 * tie of that key, a pass on a measured rate before a thin one; then the ids, as `rank`.
 */
export const buildToRank = (a: PassRow, b: PassRow) =>
  b.rung.year_per_rax! - a.rung.year_per_rax! ||
  b.rung.year_rax - a.rung.year_rax ||
  Number(a.thin === true) - Number(b.thin === true) ||
  a.market.player_id - b.market.player_id ||
  a.market.season - b.market.season ||
  a.market.key.localeCompare(b.market.key);

/** Why the pass cannot be shown built to this rung, or null: its row as the visitor sees it (`owned`, or the lift). */
function outReason(row: PassRow, budget: number | null): OutReason | null {
  const r = row.rung;
  if (r.cost === null || r.year_per_rax === null) return row.owned ? null : "unpriced";
  if (!r.pays_back) return "never";
  if (!row.held && breaksEvenAtBest(r)) return "even";
  if (!row.owned && budget !== null && r.cost > budget) return "over";
  return null;
}

/**
 * "Build to" a rarity: every pass of the snapshot priced at that one rung, from scratch or as the lift from the rung
 * held, the server's own figures (the build rate, the payback walk). The passes that pay back there, in the season,
 * search, New's year and 3-week filters as before, ranked by `buildToRank`, the tab's few per sport (`rules.top`, as
 * the server's picks); the rest set apart with why (`out`). Team passes stay apart, at that rarity, their cost unknown.
 */
function buildToList(snap: Snapshot, f: PassFilters, tier: string): PassListState {
  const { otd } = snap;
  const rules = snap.rules.otd;
  const today = dayOf(otd.as_of);
  const q = foldName(f.query.trim());
  const sportOK = (m: PassMarket) => f.sport === "all" || m.sport === f.sport;
  const ranked: PassRow[] = [];
  const out: PassRow[] = [];
  const teams: PassRow[] = [];
  const hidden = { never: 0, over: 0, slow: 0, notSoon: 0, unpriced: 0 };

  for (const market of otd.markets) {
    if (f.season !== "all" && market.season_state !== f.season) continue;
    if (q !== "" && !foldName(market.player_name).includes(q)) continue;
    const rung = market.rungs.find((r) => r.tier === tier);
    if (market.kind === "team") {
      if (sportOK(market) && rung) teams.push({ market, rung, kind: "team" });
      continue;
    }
    const thin = buildRate(market).thin || undefined;
    if (!rung || !isLiquid(market)) {
      // No such rung (a ladder that stops short of it): the top rung's facts, named this tier, with no figure at all.
      const shown = rung ?? { ...market.rungs[market.rungs.length - 1]!, tier, cost: null, year_per_rax: null,
        lifetime_per_rax: null, pays_back: null, payback_months: null, payback_month: null };
      if (sportOK(market) && market.rungs.length > 0) out.push({ market, rung: shown, kind: "row", why: "none" });
      continue;
    }
    const row: PassRow = { ...ownedRow(market, rung, f.owned?.get(market.key), rules, today), thin };
    const why = outReason(row, f.budget);
    if (why) {
      if (sportOK(market)) out.push({ ...row, why });
      continue;
    }
    if (f.level === "new" && (row.rung.payback_months ?? Infinity) > 12) {
      if (sportOK(market)) hidden.slow++;
      continue;
    }
    if (f.soon && !buildable(market, rung, rules)) {
      if (sportOK(market)) hidden.notSoon++;
      continue;
    }
    ranked.push(row);
  }
  ranked.sort(buildToRank);
  const counts: Record<string, number> & { all: number } = { all: 0 };
  const rows: PassRow[] = [];
  for (const row of ranked) {
    const sport = row.market.sport;
    if ((counts[sport] ?? 0) >= rules.top) continue;
    counts.all++;
    counts[sport] = (counts[sport] ?? 0) + 1;
    if (sportOK(row.market)) rows.push(row);
  }
  out.sort((a, b) => OUT_ORDER.indexOf(a.why!) - OUT_ORDER.indexOf(b.why!) || outRank(a, b));
  teams.sort((a, b) => b.rung.year_rax - a.rung.year_rax || a.market.key.localeCompare(b.market.key));
  const open = rows.filter((row) => !f.held?.has(row.market.key) && !f.owned?.has(row.market.key));
  return { rows, never: [], teams, hidden, top: open[0] ?? null, counts, candidates: open.length, out };
}

/** The set-apart passes within one reason: the most Rax a year per Rax first, the unpriced ones by name. */
const outRank = (a: PassRow, b: PassRow) =>
  (b.rung.year_per_rax ?? -1) - (a.rung.year_per_rax ?? -1) ||
  b.rung.year_rax - a.rung.year_rax ||
  a.market.player_name.localeCompare(b.market.player_name) ||
  a.market.key.localeCompare(b.market.key);
