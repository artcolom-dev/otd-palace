// The Passes tab's own choices for this visit (sport, season, toggles, sort, the phone's view, the planner's inputs),
// kept across tab switches but not across visits, and the plan of the passes this device holds.
import { useCallback, useSyncExternalStore } from "react";
import { useApp } from "../AppContext";
import { useHeldMarkets } from "../hooks/useHeldMarkets";
import { local, useLocal } from "../data/local";
import { type PassSeason, type PassSort, defaultSeason } from "../data/passList";
import type { LevelKey } from "../data/prefs";
import { type Plan, dayOf, planHoldings } from "../lib/passes";

export interface PassUi {
  sport: string;
  season: PassSeason;
  soon: boolean;
  showAll: boolean;
  sort: PassSort;
  view: "best" | "mine"; // the phone's two views
  mineOpen: boolean; // the list of held passes, unfolded
  planKey: string | null; // the rating planner's pass
  planRating: string; // what was typed, as typed
  level: LevelKey | null; // the level the season default was set for
  introHidden: boolean; // the line on what a daily-pay pass is, dismissed for this visit
  flash: string | null; // the pass just added, to mark once in My passes
}

const FRESH: PassUi = {
  sport: "all", season: "all", soon: false, showAll: false, sort: "soon", view: "best", mineOpen: false,
  planKey: null, planRating: "212", level: null, introHidden: false, flash: null,
};

let ui: PassUi = FRESH;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const setPassUi = (patch: Partial<PassUi>) => {
  ui = { ...ui, ...patch };
  for (const l of listeners) l();
};

/** Forgets this visit's choices (tests start afresh). */
export function resetPassUi() {
  ui = FRESH;
}

/** The tab's choices; a level change puts the season back to that level's default (New: past seasons). */
export function usePassUi(level: LevelKey): [PassUi, (patch: Partial<PassUi>) => void] {
  const state = useSyncExternalStore(subscribe, () => ui, () => ui);
  if (state.level !== level) {
    ui = { ...ui, level, season: defaultSeason(level), soon: false, showAll: false };
    return [ui, setPassUi];
  }
  return [state, setPassUi];
}

// The last plan, shared by every panel that shows it (the total, the sports, the list, the share card): a big
// account's plan is worked out once per change, not once per panel.
let lastPlan: { args: readonly unknown[]; plan: Plan } | null = null;

function planOf(...args: Parameters<typeof planHoldings>): Plan {
  if (lastPlan && lastPlan.args.length === args.length && lastPlan.args.every((a, i) => a === args[i])) return lastPlan.plan;
  const plan = planHoldings(...args);
  lastPlan = { args, plan };
  return plan;
}

/** The snapshot's day, the passes this device holds and their plan, recomputed when either changes. */
export function usePassPlan(): { plan: Plan; today: string } {
  const { snap } = useApp();
  const { passes } = useLocal();
  const markets = useHeldMarkets();
  const today = dayOf(snap.otd.as_of);
  const plan = planOf(passes, markets, snap.rules.otd, snap.otd.sports);
  return { plan, today };
}

export const useRemovePass = () => useCallback((key: string) => local.removePass(key), []);
