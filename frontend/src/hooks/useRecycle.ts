// The visitor's Recycle plan (lib/recycle.ts) and their "I have Real Pro" answer (lib/realPro.ts). The plan is worked
// out once per change of the passes, their markets, the level, the answer, the balance or the minute (deals end), and
// shared by every panel that shows it: the summary and each row of the list.
import { useSyncExternalStore } from "react";
import { useApp } from "../AppContext";
import { useLocal } from "../data/local";
import { realProNow, subscribeRealPro } from "../lib/realPro";
import { type RecycleInput, type RecyclePlan, recyclePlan } from "../lib/recycle";
import { usePassPlan } from "../views/passState";
import { useHeldMarkets } from "./useHeldMarkets";

/** Whether the visitor says they have Real Pro; every reader follows a tick at once. */
export function useRealPro(): boolean {
  return useSyncExternalStore(subscribeRealPro, realProNow, () => false);
}

let last: { args: readonly unknown[]; out: RecyclePlan } | null = null;

function shared(input: RecycleInput): RecyclePlan {
  const args = [input.snap, input.markets, input.holdings, input.plan, input.level, input.pro, input.balance, input.nowMs];
  if (last && last.args.every((a, i) => a === args[i])) return last.out;
  const out = recyclePlan(input);
  last = { args, out };
  return out;
}

export function useRecyclePlan(): RecyclePlan {
  const { snap, prefs, now } = useApp();
  const { passes, balance } = useLocal();
  const markets = useHeldMarkets();
  const { plan } = usePassPlan();
  const pro = useRealPro();
  const minute = Math.floor(now / 60_000) * 60_000;
  return shared({ snap, markets, holdings: passes, plan, level: prefs.level, pro, balance, nowMs: minute });
}
