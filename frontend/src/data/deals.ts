// Which deals a visitor sees, in what order, and which one leads the page. All of it runs in the browser on the
// served snapshot, so a change of level, budget, sport or sort is instant.
import { RARITIES, isRarity } from "../content/real";
import { passSortValue } from "../lib/dealPass";
import { foldName } from "../lib/words";
import { filterDeals, filterGone } from "./filters";
import type { LevelKey, Prefs, SortKey } from "./prefs";
import type { Deal, GoneDeal, GoneReason, Snapshot } from "./types";

/** A deal is its listing and its kind: a listing can be a dimmed target row and a live bid row at once. */
export const dealKey = (deal: Pick<Deal, "listing_id" | "kind">) => `${deal.listing_id}:${deal.kind}`;

/** A followed player, as this device stores it: "nba:123". */
export const playerKey = (deal: Pick<Deal, "sport" | "player_id">) => `${deal.sport}:${deal.player_id}`;

/** The sorts every level offers. The default, "best", is what reselling at the usual price leaves after fees: a card
 * far under its usual price can still lose once Real's fees are paid (the internal research notes). */
export function sortsFor(_level: LevelKey): SortKey[] {
  return ["best", "ending", "newest", "cheapest", "under", "rarest", "passes"];
}

/** A sort's label; New reads "cheaper" where the others read "under". */
export function sortLabel(sort: SortKey, level: LevelKey): string {
  switch (sort) {
    case "best":
      return "Best after fees";
    case "under":
      return level === "new" ? "Biggest % cheaper" : "Biggest % under";
    case "ending":
      return "Ending soon";
    case "newest":
      return "Newest";
    case "cheapest":
      return "Cheapest";
    case "rarest":
      return "Rarest first";
    case "passes":
      return "For passes";
  }
}

const time = (iso: string | null) => (iso === null ? Number.NaN : Date.parse(iso));
const orNever = (ms: number, never: number) => (Number.isNaN(ms) ? never : ms);

const best = (a: Deal, b: Deal) => b.flip_margin - a.flip_margin || b.discount - a.discount;
/** A deal's rarity for "Rarest first": Real's index 0..7, and -1 (after General) for a card of unknown rarity. */
const rarityRank = (deal: Deal) => (isRarity(deal.rarity) ? deal.rarity : -1);

/** A deal's figure for the "For passes" sort (lib/dealPass.ts passSortValue); null: it builds no tracked pass. */
export type PassValue = (deal: Deal) => number | null;

const COMPARE: Record<Exclude<SortKey, "passes">, (a: Deal, b: Deal) => number> = {
  best,
  under: (a, b) => b.discount - a.discount,
  ending: (a, b) => orNever(time(a.ends_at), Infinity) - orNever(time(b.ends_at), Infinity) || b.discount - a.discount,
  newest: (a, b) => orNever(time(b.listed_at), -Infinity) - orNever(time(a.listed_at), -Infinity),
  cheapest: (a, b) => a.price - b.price,
  rarest: (a, b) => rarityRank(b) - rarityRank(a) || best(a, b),
};

/** "For passes": the most a year per Rax through the deal's pass first; the deals that build no tracked pass after,
 * best after fees first. */
function byPass(value: PassValue): (a: Deal, b: Deal) => number {
  return (a, b) => {
    const [va, vb] = [value(a), value(b)];
    if (va !== null && vb !== null) return vb - va || best(a, b);
    if (va !== null || vb !== null) return va === null ? 1 : -1;
    return best(a, b);
  };
}

/**
 * The deals in the chosen order, followed players' deals pinned above the rest; ties keep the server's order. The
 * "For passes" sort needs each deal's pass figure (`passValue`); without one it is the best after fees.
 */
export function sortDeals<T extends Deal>(
  deals: readonly T[],
  sort: SortKey,
  follows: ReadonlySet<string>,
  passValue: PassValue = () => null,
): T[] {
  const by = sort === "passes" ? byPass(passValue) : COMPARE[sort];
  return deals
    .map((deal, index) => ({ deal, index, pinned: follows.has(playerKey(deal)) }))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || by(a.deal, b.deal) || a.index - b.index)
    .map(({ deal }) => deal);
}

/** Whether a deal is about a player whose name contains what was typed, accents and case aside. */
export function matchesQuery(deal: Pick<Deal, "player_name">, query: string): boolean {
  const q = foldName(query.trim());
  return q === "" || foldName(deal.player_name).includes(q);
}

/** The sport filter as `filterDeals` understands it: the mine tab filters by player afterwards. */
const sportFilter = (prefs: Prefs): Prefs => (prefs.sport === "mine" ? { ...prefs, sport: "all" } : prefs);

/** The deals this visitor sees: level, budget, sport (or followed players), an optional search, then sorted. */
export function visibleDeals(
  snap: Snapshot,
  prefs: Prefs,
  follows: ReadonlySet<string>,
  nowMs: number,
  query = "",
): Deal[] {
  const deals = filterDeals(snap.deals, sportFilter(prefs), snap.levels, nowMs).filter(
    (deal) => (prefs.sport !== "mine" || follows.has(playerKey(deal))) && matchesQuery(deal, query),
  );
  return sortDeals(deals, prefs.sort, follows, prefs.sort === "passes" ? passSortValue(snap) : undefined);
}

/**
 * How many deals this visitor's level leaves out only because the player is hurt: the deals the list would show if
 * the level did not hide them, less the ones it shows. It goes through `visibleDeals`, as the list does (My players,
 * search), and `keep` narrows it as the page's own scope does (a pass's cards). 0 for a level that hides none. The page
 * says so, so a hidden deal is a known choice and not a silent one.
 */
export function hurtHidden(
  snap: Snapshot,
  prefs: Prefs,
  follows: ReadonlySet<string>,
  nowMs: number,
  query = "",
  keep: (deal: Deal) => boolean = () => true,
): number {
  const level = snap.levels[prefs.level];
  if (!level?.hide_hurt) return 0;
  const relaxed = { ...snap, levels: { ...snap.levels, [prefs.level]: { ...level, hide_hurt: false } } };
  const count = (s: Snapshot) => visibleDeals(s, prefs, follows, nowMs, query).filter(keep).length;
  return count(relaxed) - count(snap);
}

/** The same filters with no rarity chosen: for a count that is not about the rarity (a budget's, a search's, the
 * strip's own). */
export const anyRarity = (prefs: Prefs): Prefs => ({ ...prefs, rarity: null });

/**
 * The deals that just went away this visitor would have seen, one per listing and kind (the newest), leaving out
 * the keys in `skip` (deals still live, or the hero).
 */
export function visibleGone(
  snap: Snapshot,
  prefs: Prefs,
  follows: ReadonlySet<string>,
  skip: ReadonlySet<string>,
  query = "",
): GoneDeal[] {
  const seen = new Set<string>();
  return filterGone(snap.gone, sportFilter(prefs), snap.levels).filter((row) => {
    const key = dealKey(row);
    if (seen.has(key) || skip.has(key)) return false;
    seen.add(key);
    return (prefs.sport !== "mine" || follows.has(playerKey(row))) && matchesQuery(row, query);
  });
}

/** Whether a deal is safe: it can be started, it is not falling, its usual price rests on 5+ recent sales. */
export const isHeroMaterial = (d: Deal) => d.kind === "target" && d.confidence === "high" && !d.falling;

export interface SportCounts {
  all: number;
  mine: number;
  bySport: Record<string, number>;
}

/**
 * How many deals each sport tab would show at this level and budget, leaving out the rows shown elsewhere (Today's
 * top three), given by key.
 */
export function sportCounts(
  snap: Snapshot,
  prefs: Prefs,
  follows: ReadonlySet<string>,
  nowMs: number,
  exclude: ReadonlySet<string> = new Set(),
  query = "",
): SportCounts {
  const any = filterDeals(snap.deals, { ...prefs, sport: "all" }, snap.levels, nowMs).filter((deal) =>
    matchesQuery(deal, query),
  );
  const deals = any.filter((deal) => !exclude.has(dealKey(deal)));
  const bySport: Record<string, number> = {};
  for (const deal of deals) bySport[deal.sport] = (bySport[deal.sport] ?? 0) + 1;
  return {
    all: deals.length,
    mine: deals.filter((d) => follows.has(playerKey(d))).length,
    bySport,
  };
}

export interface RarityCounts {
  all: number; // every deal under the other filters, a card of unknown rarity included
  byRarity: number[]; // by Real's rarity index 0..7: always eight counts
}

/**
 * How many deals each chip of the rarity strip would show: the level, budget, sport (or My players) and search as they
 * are, whatever rarity is chosen, leaving out the rows shown elsewhere (Today's top three), given by key. A card whose
 * rarity is not one of Real's eight counts under All and under no rarity.
 */
export function rarityCounts(
  snap: Snapshot,
  prefs: Prefs,
  follows: ReadonlySet<string>,
  nowMs: number,
  exclude: ReadonlySet<string> = new Set(),
  query = "",
): RarityCounts {
  const deals = visibleDeals(snap, anyRarity(prefs), follows, nowMs, query).filter((deal) => !exclude.has(dealKey(deal)));
  const byRarity = RARITIES.map(() => 0);
  for (const deal of deals) if (isRarity(deal.rarity)) byRarity[deal.rarity]! += 1;
  return { all: deals.length, byRarity };
}

/**
 * When the budget is what hides every deal: the cheapest deal this level and sport would show at any price, and
 * the smallest preset that reaches it (null when only "any price" does). Null when there is no budget, or nothing
 * to nudge towards. `only` narrows the deals that count (the hero looks only at the safe ones).
 */
export function budgetNudge(
  snap: Snapshot,
  prefs: Prefs,
  follows: ReadonlySet<string>,
  nowMs: number,
  only: (deal: Deal) => boolean = () => true,
): { cheapest: number; next: number | null } | null {
  if (prefs.budget === null) return null;
  const budget = prefs.budget;
  const over = visibleDeals(snap, { ...prefs, budget: null }, follows, nowMs).filter((d) => d.price > budget && only(d));
  if (over.length === 0) return null;
  const cheapest = Math.min(...over.map((d) => d.price));
  const next = snap.rules.budget_presets.find((p): p is number => p !== null && p >= cheapest) ?? null;
  return { cheapest, next };
}

/**
 * How many more deals the next level up would show at this budget and sport (for New's empty state): its deals that
 * New does not show, so never the ones already on screen (Today's tiles above an empty list).
 */
export function hiddenByLevel(snap: Snapshot, prefs: Prefs, follows: ReadonlySet<string>, nowMs: number): number {
  if (prefs.level !== "new") return 0;
  const shown = new Set(visibleDeals(snap, prefs, follows, nowMs).map(dealKey));
  return visibleDeals(snap, { ...prefs, level: "regular" }, follows, nowMs).filter((d) => !shown.has(dealKey(d))).length;
}

const REASONS: Record<GoneReason, string> = {
  countdown_started: "Someone started the countdown",
  outbid: "Outbid",
  ended: "Ended",
  price_moved: "Price changed",
  no_longer_a_deal: "No longer a deal",
};

/** Why a deal went away, in plain words. */
export const goneReasonText = (reason: GoneReason) => REASONS[reason] ?? "No longer a deal";

/** Whether a row is a deal that went away. */
export const isGone = (row: Deal | GoneDeal): row is GoneDeal => "reason" in row;
