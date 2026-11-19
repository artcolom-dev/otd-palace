// "The snowball": a year of buying the next-best pass each time the Rax allows it. From a balance, the passes held and
// today's served markets, month by month: the pay of the passes owned arrives (a sport's seasonal shares, its 2 claims
// a day, each pass's lifetime limit), and whenever the best pass the cash reaches is affordable it is bought and starts
// paying the month after. Today's prices throughout, no price changes: an estimate, not a promise. Pure and bounded
// (12 months, at most MAX_BUYS buys a month).
import type { OtdRules, PassMarket, PassSport } from "../data/types";
import { type Holding, type Plan, nextBest, payFrom, planHoldings, replaySport, resolveHolding } from "./passes";

export const SNOWBALL_MONTHS = 12;
const MAX_BUYS = 6; // buys at one moment, at most: the loop is bounded whatever the data
// A crowded sport's candidates weighed at each buy: the plan buys up to 72 times, and a big account's sports are
// crowded, so it weighs fewer than one look at the best passes does.
const SNOWBALL_REPLAYS = 4;

export interface SnowballInput {
  balance: number; // Rax in hand now
  holdings: readonly Holding[];
  markets: readonly PassMarket[];
  rules: OtdRules;
  sports?: Record<string, PassSport>;
  today: string; // the snapshot's own day, "YYYY-MM-DD"
}

export interface SnowballStep {
  after: number; // months from now: 0 is now
  market: PassMarket;
  tier: string;
  cost: number;
  gain: number; // what the passes owned pay more a year with it, an estimate
}

export interface SnowballPoint {
  month: number; // months from now, 0 to 12
  year: number; // what the passes owned then pay over a year, an estimate
  cash: number; // Rax in hand, after that month's buys
}

export interface Snowball {
  steps: SnowballStep[];
  series: SnowballPoint[]; // months 0 to 12
  start: number; // what the passes held now pay a year
  end: number; // what the passes owned at month 12 pay a year
  earned: number; // Rax received over the 12 months
  cash: number; // Rax in hand at month 12
}

interface Pick {
  market: PassMarket;
  tier: string;
  cost: number;
}

/** Chooses the next pass to buy with `cash`, the plan of what is owned in hand: null for none. A pick that costs more
 * than the cash means waiting for it. */
type Chooser = (owned: readonly Holding[], cash: number, plan: Plan) => Pick | null;

function run(input: SnowballInput, choose: Chooser): Snowball {
  const { markets, rules, sports, today } = input;
  const owned: { holding: Holding; from: number }[] = input.holdings.map((holding) => ({ holding, from: 0 }));
  // The month each pass is owned from, and each pass's twelve months of pay (the same every month): a big account
  // owns thousands, looked up twelve times.
  const fromOf = new Map<string, number>();
  for (const o of owned) if (!fromOf.has(o.holding.key)) fromOf.set(o.holding.key, o.from);
  const pays = new Map<string, number[]>();
  const plan = () => planHoldings(owned.map((o) => o.holding), markets, rules, sports);
  let cash = Math.max(0, Number.isFinite(input.balance) ? input.balance : 0);
  let earned = 0;
  let current = plan();
  // A buy changes one sport: only that sport is replayed (what planHoldings would give, sport by sport and in its
  // order, so the totals agree to the last digit).
  const withBought = (was: Plan, h: Holding): Plan => {
    const p = resolveHolding(h, markets, rules);
    if (!p) return plan();
    const held = [...was.held, p];
    const sport = p.market.sport;
    const out = { ...was.sports, [sport]: replaySport(sport, held.filter((q) => q.market.sport === sport), rules, sports) };
    let total = 0;
    for (const x of Object.values(out)) total += x.total;
    return { held, sports: out, total };
  };
  const start = current.total;
  const steps: SnowballStep[] = [];
  const series: SnowballPoint[] = [];

  for (let month = 0; month < SNOWBALL_MONTHS; month++) {
    for (let buys = 0; buys < MAX_BUYS; buys++) {
      const pick = choose(owned.map((o) => o.holding), cash, current);
      if (!pick || pick.cost > cash) break;
      owned.push({ holding: { key: pick.market.key, tier: pick.tier }, from: month });
      fromOf.set(pick.market.key, month);
      const next = withBought(current, owned[owned.length - 1]!.holding);
      steps.push({ after: month, market: pick.market, tier: pick.tier, cost: pick.cost, gain: Math.max(0, next.total - current.total) });
      cash -= pick.cost;
      current = next;
    }
    series.push({ month, year: current.total, cash });
    // This month's pay: each pass owned from its buy, shared as the sport's claims allow.
    for (const p of current.held) {
      const from = fromOf.get(p.market.key);
      if (from === undefined || p.spent) continue;
      const share = p.year > 0 ? Math.min(1, (current.sports[p.market.sport]?.per[p.market.key] ?? p.year) / p.year) : 1;
      const payKey = `${p.market.key}|${p.mult}|${p.limit}|${from}`;
      let months = pays.get(payKey);
      if (!months) pays.set(payKey, (months = payFrom(p.market, p.mult, p.limit, rules, today, from)));
      const got = (months[month] ?? 0) * share;
      cash += got;
      earned += got;
    }
  }
  series.push({ month: SNOWBALL_MONTHS, year: current.total, cash });
  return { steps, series, start, end: current.total, earned, cash };
}

/** The year when each month buys the best pass (by Rax a year per Rax) that the cash in hand reaches. */
export function snowball(input: SnowballInput): Snowball {
  const memo = new Map<string, number>();
  return run(input, (owned, cash, plan) => {
    const [pick] = nextBest(owned, input.markets, input.rules, { budget: cash, n: 1, today: input.today, sports: input.sports, plan, memo, replays: SNOWBALL_REPLAYS });
    return pick && pick.rung.cost !== null ? { market: input.markets.find((m) => m.key === pick.market.key)!, tier: pick.rung.tier, cost: pick.rung.cost } : null;
  });
}

/** The same year for a chosen order of buys, each as soon as the cash reaches it (waiting, never skipping). */
export function playOrder(input: SnowballInput, order: readonly { key: string; tier: string }[]): Snowball {
  return run(input, (owned) => {
    for (const next of order) {
      if (owned.some((h) => h.key === next.key)) continue;
      const market = input.markets.find((m) => m.key === next.key);
      const rung = market?.rungs.find((r) => r.tier === next.tier);
      if (!market || !rung || rung.cost === null || rung.cost <= 0) continue;
      return { market, tier: next.tier, cost: rung.cost };
    }
    return null;
  });
}
