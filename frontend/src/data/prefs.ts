// What the visitor chose, kept in this browser only: a level, a budget, a sport, a rarity, a sort, the last tab, the
// most to spend on one daily-pay pass and the rarity passes are built to. Nothing about who they are.
import { isRarity } from "../content/real";
import { STORAGE_KEY } from "../lib/tabHint";
import type { Level } from "./types";

export type LevelKey = "new" | "regular" | "pro";
// "best": what reselling at the usual price leaves after fees; "under": the biggest % under the usual price;
// "rarest": Real's rarity, rarest first; "passes": what the card returns through the pass it builds (lib/dealPass.ts
// passSortValue).
export type SortKey = "best" | "ending" | "newest" | "cheapest" | "under" | "rarest" | "passes";
export type TabKey = "today" | "deals" | "prices" | "passes" | "plan";

export interface Prefs {
  sport: string; // "all", "mine" (followed players) or a sport of the snapshot
  budget: number | null; // in RAX; null means no limit
  level: LevelKey;
  sort: SortKey;
  tab: TabKey;
  passBudget: number | null; // the most to spend on one daily-pay pass, in RAX; null means no limit
  // The rarity strip on Deals: Real's rarity index 0..7 the deals are narrowed to, and with `rarer` that rarity and every
  // rarer one. Null means every rarity. Optional so a Prefs made in code for its own count (lib/budget, lib/nextRax,
  // lib/recycle) means every rarity without saying so; the saved prefs always carry both.
  rarity?: number | null;
  rarer?: boolean;
  // "Build to" on Passes (lib/buildToSwitch.ts): Real's rarity index 1 (Common) to 7 (Iconic) every pass is priced at;
  // null is "Best for each", each pass at its own best rung. Optional for the same reason as `rarity`.
  buildTo?: number | null;
}

/** A Build to rarity: one of Real's rarities from Common (1) to Iconic (7). General pays nothing On This Day. */
export const isBuildTo = (value: unknown): value is number => isRarity(value) && value >= 1;

export const LEVEL_KEYS: readonly LevelKey[] = ["new", "regular", "pro"];
export const SORT_KEYS: readonly SortKey[] = ["best", "ending", "newest", "cheapest", "under", "rarest", "passes"];
// A sort saved under an older name, read as the one it now is: "profit" (Rax left after fees) is the best.
const OLD_SORTS: Readonly<Record<string, SortKey>> = { profit: "best" };
export const TAB_KEYS: readonly TabKey[] = ["today", "deals", "prices", "passes", "plan"];

const oneOf = <T extends string>(keys: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (keys as readonly string[]).includes(value);

/** The positive whole number typed in a budget field, with "," and spaces allowed as thousands separators; else null. */
export function parseBudget(input: string): number | null {
  const digits = input.replace(/[,\s]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isBudget(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** The budget a visitor of this level starts with; null (any) while the levels are not known. */
export function defaultBudget(level: LevelKey, levels?: Record<string, Level>): number | null {
  return levels?.[level]?.default_budget ?? null;
}

/** The most a visitor of this level starts out spending on one pass; null (any) while the levels are not known. */
export function defaultPassBudget(level: LevelKey, levels?: Record<string, Level>): number | null {
  return levels?.[level]?.otd_default_budget ?? null;
}

/** A first visit: New, at New's own budgets, every sport and rarity, the best deals first, on Today. */
export function defaultPrefs(levels?: Record<string, Level>): Prefs {
  return {
    sport: "all", budget: defaultBudget("new", levels), level: "new", sort: "best", tab: "today",
    passBudget: defaultPassBudget("new", levels), rarity: null, rarer: false, buildTo: null,
  };
}

/**
 * The saved preferences, each field falling back to its default when missing or not acceptable. A budget that was
 * never chosen (or cannot be read) is the saved level's own default budget; a saved null is "any price".
 */
export function loadPrefs(levels?: Record<string, Level>): Prefs {
  const defaults = defaultPrefs(levels);
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return defaults;
    const { sport, budget, level, sort, tab, passBudget, rarity, rarer, buildTo } = stored as Record<string, unknown>;
    const lvl = oneOf(LEVEL_KEYS, level) ? level : defaults.level;
    return {
      sport: typeof sport === "string" && sport !== "" ? sport : defaults.sport,
      budget: budget === null || isBudget(budget) ? budget : defaultBudget(lvl, levels),
      level: lvl,
      sort: oneOf(SORT_KEYS, sort) ? sort : (typeof sort === "string" && OLD_SORTS[sort]) || defaults.sort,
      tab: oneOf(TAB_KEYS, tab) ? tab : defaults.tab,
      passBudget: passBudget === null || isBudget(passBudget) ? passBudget : defaultPassBudget(lvl, levels),
      // Saved before the rarity strip, or not one of Real's eight: every rarity.
      rarity: isRarity(rarity) ? rarity : null,
      rarer: rarer === true,
      // Saved before Build to, or not Common to Iconic: Best for each.
      buildTo: isBuildTo(buildTo) ? buildTo : null,
    };
  } catch {
    return defaults;
  }
}

/** Remembers the preferences; a browser that refuses to store them just forgets them. */
export function savePrefs(prefs: Prefs): void {
  try {
    const { sport, budget, level, sort, tab, passBudget } = prefs;
    const rarity = isRarity(prefs.rarity) ? prefs.rarity : null;
    const rarer = prefs.rarer === true;
    const buildTo = isBuildTo(prefs.buildTo) ? prefs.buildTo : null;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sport, budget, level, sort, tab, passBudget, rarity, rarer, buildTo }));
  } catch {
    // Storage is blocked or full: the choice lasts until the page closes.
  }
}
