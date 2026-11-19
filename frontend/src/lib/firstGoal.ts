// "Your first pass": for a visitor who holds no pass, the cheapest sensible one to aim at, from the passes the server
// names as each sport's starter (`otd.starters`): a past season (its figures are final), a rarity from the starter
// tiers, one that pays back and pays back within a year. The progress toward it is the visitor's own typed balance;
// the days to go need their own typed daily Rax. Nothing here knows what a free account earns, so with no daily Rax
// typed there is no time, only what is still missing.
import type { PassMarket, PassRung, Snapshot } from "../data/types";
import { offerHint } from "./offers";
import { breaksEvenAtBest, dayOf, isLiquid } from "./passes";

export interface FirstGoal {
  market: PassMarket;
  rung: PassRung;
  cost: number;
  year: number; // what it pays a year (an estimate)
  have: number; // the balance typed, 0 when none
  need: number; // still missing, 0 when the balance reaches it
  fill: number; // 0 to 1: the share of its cost the balance covers
  days: number | null; // whole days to go at the visitor's own daily Rax; null without it or when nothing is missing
  offer: number | null; // its cost with the cards bought by offers (lib/offers.ts), if enough are accepted; null: no card
  offerNeed: number | null; // still missing at that cost
}

/** A pass that pays back within this many months is a sensible first goal. */
const SENSIBLE_MONTHS = 12;

const cheaper = (a: PassRung & { cost: number }, am: PassMarket, b: PassRung & { cost: number }, bm: PassMarket) =>
  a.cost !== b.cost ? a.cost < b.cost : (a.year_per_rax ?? 0) !== (b.year_per_rax ?? 0) ? (a.year_per_rax ?? 0) > (b.year_per_rax ?? 0) : am.key < bm.key;

/** The starter pass to aim at: the cheapest sensible one across the sports' starters, else the cheapest that pays back. */
export function firstGoalPick(snap: Snapshot): { market: PassMarket; rung: PassRung & { cost: number } } | null {
  const tiers = snap.rules.otd.starter_tiers;
  const find = (sensible: boolean) => {
    let best: { market: PassMarket; rung: PassRung & { cost: number } } | null = null;
    for (const key of Object.values(snap.otd.starters)) {
      const market = snap.otd.markets.find((m) => m.key === key);
      if (!market || market.season_state !== "past" || !isLiquid(market)) continue;
      for (const rung of market.rungs) {
        if (!tiers.includes(rung.tier) || rung.projected || rung.pays_back !== true || breaksEvenAtBest(rung)) continue;
        if (rung.cost === null || rung.cost <= 0 || !(rung.year_rax > 0)) continue;
        if (sensible && (rung.payback_months ?? Infinity) > SENSIBLE_MONTHS) continue;
        const next = { market, rung: rung as PassRung & { cost: number } };
        if (best === null || cheaper(next.rung, market, best.rung, best.market)) best = next;
      }
    }
    return best;
  };
  return find(true) ?? find(false);
}

/**
 * The first goal with the visitor's progress. `balance` is what they typed (null: none), `daily` the Rax they say they
 * make on a typical day (null: not given, so no time is ever worked out).
 */
export function firstGoal(snap: Snapshot, balance: number | null, daily: number | null): FirstGoal | null {
  const pick = firstGoalPick(snap);
  if (!pick) return null;
  const cost = pick.rung.cost;
  const have = balance !== null && Number.isFinite(balance) && balance > 0 ? balance : 0;
  const need = Math.max(0, cost - have);
  const rate = daily !== null && Number.isFinite(daily) && daily > 0 ? daily : null;
  const offer = offerHint(pick.market, pick.rung, snap.rules.otd, dayOf(snap.otd.as_of));
  return {
    market: pick.market,
    rung: pick.rung,
    cost,
    year: pick.rung.year_rax,
    have,
    need,
    fill: Math.min(1, have / cost),
    days: rate !== null && need > 0 ? Math.ceil(need / rate) : null,
    offer: offer?.cost ?? null,
    offerNeed: offer ? Math.max(0, offer.cost - have) : null,
  };
}
