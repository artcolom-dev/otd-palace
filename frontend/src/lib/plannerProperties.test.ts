// Properties of the planner over many random scenes (a seeded generator: the same scenes every run).
import { describe, expect, it } from "vitest";
import type { OtdRules, PassMarket, PassSport } from "../data/types";
import { OTD_RULES } from "../test/fixtures";
import { TODAY, served } from "../test/passScene";
import { NOW } from "../test/scene";
import { passMoves } from "./nextRax";
import { type Holding, nextBest } from "./passes";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const FLAT = Array.from({ length: 12 }, (_, i) => ([10, 11, 12, 1, 2, 3, 4, 5, 6].includes(i + 1) ? 1 / 9 : 0));

/** Two sports with few claim days, teammates, seasons in progress, passes held at a rarity or a rating. */
function scene(seed: number) {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const rules: OtdRules = { ...OTD_RULES, claims_per_sport_day: pick([1, 2, 2, 3]) };
  const sports: Record<string, PassSport> = {};
  for (const s of ["nba", "nhl"]) sports[s] = { claim_days: 3 + Math.floor(r() * 25), months: [10, 11, 12, 1, 2, 3, 4, 5, 6] };
  const markets: PassMarket[] = [];
  for (let i = 0, n = 4 + Math.floor(r() * 26); i < n; i++) {
    const sport = pick(["nba", "nhl"]);
    const season = pick([2023, 2024, 2025]);
    const current = r() < 0.4;
    const C = sports[sport]!.claim_days!;
    markets.push(served({
      key: `${sport}:${season}:player:${i + 1}`, sport, season, season_label: String(season), season_state: current ? "current" : "past",
      player_id: i + 1, player_name: `P${i + 1}`, team_id: r() < 0.7 ? Math.floor(r() * 4) : null, position: null, kind: "player",
      base_1x: Math.round(20 + r() * (r() < 0.5 ? 300 : 3000)), season_progress: current ? 0.1 + r() * 0.9 : 1,
      game_days: r() < 0.1 ? null : 1 + Math.floor(r() * (C + 3)), game_days_measured: true, month_share: FLAT,
      rate_traded: r() < 0.1 ? null : 0.5 + r() * 20, rate_sales: Math.floor(r() * 10), shelf: [], shelf_count: Math.floor(r() * 3),
      mint_cost: 200, mintable: r() < 0.7,
    }, TODAY));
  }
  const holdings: Holding[] = [];
  for (const m of markets) {
    if (r() < 0.5) continue;
    const h: Holding = { key: m.key };
    if (r() < 0.5) h.tier = pick(rules.ladders.player!)[0];
    else h.rating = Math.floor(r() * 600);
    if (r() < 0.1) h.spent = true;
    holdings.push(h);
  }
  return { rules, sports, markets, holdings };
}

const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1);

describe("the planner over 400 random scenes", () => {
  it("a pass to add never claims to add more than it pays alone (a joining teammate re-spreads the replay's days)", () => {
    for (const seed of SEEDS) {
      const { rules, sports, markets, holdings } = scene(seed);
      for (const p of nextBest(holdings, markets, rules, { n: 3, today: TODAY, sports })) {
        expect(p.gain, `seed ${seed} ${p.market.key}`).toBeLessThanOrEqual(p.rung.year_rax + 1e-9);
      }
    }
  });

  it("a next move never claims more than its pass pays alone, nor a lift more than it adds alone", () => {
    for (const seed of SEEDS) {
      const { rules, sports, markets, holdings } = scene(seed);
      const snap = { rules: { ...OTD_RULES, otd: rules } as never, otd: { as_of: `${TODAY}T12:00:00Z`, sports, markets, picks: {}, starters: {} } };
      const input = { holdings, level: "regular" as const, budget: null, passBudget: null, balance: null, now: NOW, paused: true, n: 8 };
      for (const m of passMoves(snap, input)) {
        const alone = m.kind === "slot" ? m.rung!.year_rax : (m.rung as unknown as { extra_year: number }).extra_year;
        expect(m.year!, `seed ${seed} ${m.key}`).toBeLessThanOrEqual(alone + 1e-9);
      }
    }
  });
});
