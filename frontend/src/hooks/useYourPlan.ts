// The plan of the passes this device holds (the linked account's, and any added by hand), worked out once per change of
// the passes, the markets or the visitor's choices, and the "first passes" a visitor with none could start with.
import { useMemo } from "react";
import { useApp } from "../AppContext";
import { useLocal } from "../data/local";
import type { Holding } from "../lib/passes";
import { type YourPlan, planOf } from "../lib/yourPlan";
import { useHeldMarkets } from "./useHeldMarkets";

const NONE: readonly Holding[] = [];

function usePlanFor(holdings: readonly Holding[], ignoreBalance = false): YourPlan {
  const { snap, prefs, now } = useApp();
  const { balance: typed } = useLocal();
  const balance = ignoreBalance ? null : typed;
  const markets = useHeldMarkets();
  const minute = Math.floor(now / 60_000);
  return useMemo(
    () =>
      planOf(snap, markets, {
        holdings,
        level: prefs.level,
        budget: prefs.budget,
        passBudget: prefs.passBudget,
        balance,
        now: minute * 60_000, // once a minute is plenty for pass advice
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the rules' pass part and the markets are what planOf reads of the snapshot
    [snap.otd, snap.rules.otd, markets, holdings, prefs.level, prefs.budget, prefs.passBudget, balance, minute],
  );
}

/** What the visitor's passes can pay, their type and the best next moves. */
export function useYourPlan(): YourPlan {
  return usePlanFor(useLocal().passes);
}

/** The best first passes for a visitor who holds none (the free-player list, as moves). */
export function useFirstPasses(): YourPlan {
  return usePlanFor(NONE);
}

/** The plan whatever the typed balance: the coach says how far the balance is from a move, so it needs the move first. */
export function useCoachPlan(): YourPlan {
  return usePlanFor(useLocal().passes, true);
}
