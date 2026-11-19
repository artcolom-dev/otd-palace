// "Earn more Rax": which plan a visitor starts on, and the two small calculators (a sale after fees, the daily
// streak). The fees come from the snapshot's rules (advisor/rules.py SELLER_FEE and LISTING_FEE) through afterFees,
// the same sum the list price helper uses. The streak's pay is Real's: 2 right picks in a row cash out 5 Rax, and
// each more doubles it, up to 8 (320 Rax).
import type { LevelKey } from "../data/prefs";
import { afterFees } from "./sell";

export type GuideTier = "start" | "beginner" | "growing" | "big";

export const GUIDE_TIERS: readonly GuideTier[] = ["start", "beginner", "growing", "big"];

/** The plan that fits a visitor: from the balance they typed when there is one, else from their level. */
export function guideTier(level: LevelKey, balance: number | null): GuideTier {
  if (balance !== null) {
    if (balance >= 100_000) return "big";
    if (balance >= 10_000) return "growing";
    if (balance >= 300) return "beginner";
    return "start";
  }
  return level === "pro" ? "growing" : level === "regular" ? "beginner" : "start";
}

export interface SaleCompare {
  price: number;
  normal: number; // kept after Real's share and the listing fee
  quick: number; // kept with Quick List, which has no listing fee
}

/** What a sale at `price` leaves, listed normally and with Quick List; null for a price that is not a positive number. */
export function saleCompare(price: number, fee: number, listingFee: number): SaleCompare | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  return { price, normal: afterFees(price, fee, listingFee), quick: afterFees(price, fee, 0) };
}

export const STREAK_MIN = 2;
export const STREAK_MAX = 8;
const STREAK_FIRST_PAY = 5;

/** The Rax a run of `k` right picks cashes out: 5 for 2, doubling to 320 for 8; nothing under 2. */
export const streakPay = (k: number): number => (k < STREAK_MIN ? 0 : STREAK_FIRST_PAY * 2 ** (Math.min(k, STREAK_MAX) - STREAK_MIN));

/**
 * The Rax a day, on average, of always riding to `k` before cashing out, at one pick a day and a share `p` right.
 * A run reaches k with chance p^k and lasts (1 - p^k) / (1 - p) picks on average, a failed pick included.
 */
export function streakDaily(p: number, k: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return streakPay(k) / k;
  const reach = p ** k;
  return (reach * streakPay(k) * (1 - p)) / (1 - reach);
}

export interface StreakPlan {
  rate: number; // the share right, clamped to 0-1
  target: number; // the run to cash out at
  perDay: number; // Rax a day at that target
  atTwo: number; // Rax a day cashing out at 2
}

/** The cash-out point that pays the most a day at this share of right picks. */
export function bestStreak(p: number): StreakPlan {
  const rate = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
  let target = STREAK_MIN;
  let perDay = streakDaily(rate, STREAK_MIN);
  for (let k = STREAK_MIN + 1; k <= STREAK_MAX; k++) {
    const v = streakDaily(rate, k);
    if (v > perDay) {
      target = k;
      perDay = v;
    }
  }
  return { rate, target, perDay, atTwo: streakDaily(rate, STREAK_MIN) };
}
