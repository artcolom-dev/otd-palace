// Rung pricing on the feed's build rate and the shelf's live auctions: the browser (passes.ts, passRates.ts,
// passDeals.ts) finds what the server finds (advisor/otd.py, pass_rates.py, pass_deals.py) on the same passes.
// tests/fixtures/pass_build_parity.json is the server's own snapshot for them and what both sides must find;
// tests/test_pass_build_parity.py holds the server to the same `expect`.
import { existsSync, readFileSync } from "node:fs";
import { cwd } from "node:process";
import { describe, expect, it } from "vitest";
import type { LevelKey } from "../data/prefs";
import type { Otd, OtdRules, PassMarket } from "../data/types";
import { dayOf, onSale, rungs, toBasis } from "./passes";
import { buildRate } from "./passRates";
import { passDeals } from "./passDeals";

interface Found {
  build: { rate: number | null; thin: boolean; bucket: string | null; rarity: string | null; sales: number };
  costs: Record<string, number | null>;
  on_sale: Record<string, { rating: number; cost: number; enough: boolean; firm: boolean | null }>;
}
interface Parity {
  as_of: string;
  rules: OtdRules;
  budgets: Record<LevelKey, number | null>;
  why: Record<string, string>;
  expect: { passes: Record<string, Found>; pass_deals: Record<LevelKey, [key: string, cost: number][]> };
  otd: Otd;
}
const PATH = [`${cwd()}/../tests/fixtures/pass_build_parity.json`, `${cwd()}/tests/fixtures/pass_build_parity.json`].find(existsSync)!;
const PARITY = JSON.parse(readFileSync(PATH, "utf-8")) as Parity;
const MARKETS: PassMarket[] = [...PARITY.otd.markets, ...(PARITY.otd.current_markets ?? [])];
const TODAY = dayOf(PARITY.otd.as_of);
const LEVELS: LevelKey[] = ["new", "regular", "pro"];
const WEMBY = "nba:2027:player:9001";
const CONTROL = "nba:2027:player:9002";

/** What the browser makes of one served pass, in the server's terms (advisor's `_found`). */
function found(m: PassMarket): Found {
  const ladder = rungs(toBasis(m), PARITY.rules, { today: TODAY });
  const sale = (tier: string) => {
    const s = onSale(m, ladder.find((r) => r.tier === tier)!.rating_to_add, PARITY.rules);
    return { rating: s.on_sale_rating, cost: s.on_sale_cost, enough: s.enough, firm: s.firm ?? null };
  };
  return {
    build: buildRate(m),
    costs: Object.fromEntries(ladder.map((r) => [r.tier, r.cost])),
    on_sale: { common: sale("common"), rare: sale("rare") },
  };
}

describe("the build rate: the browser prices what the server prices", () => {
  for (const m of MARKETS) {
    it(`${m.key}: the same build rate, rung costs and cards on sale`, () => {
      const want = PARITY.expect.passes[m.key]!;
      const got = found(m);
      expect(got.build).toEqual(want.build);
      expect(got.on_sale).toEqual(want.on_sale);
      expect(Object.keys(got.costs)).toEqual(Object.keys(want.costs));
      for (const [tier, cost] of Object.entries(want.costs)) {
        if (cost === null) expect(got.costs[tier]).toBeNull();
        else expect(got.costs[tier]).toBeCloseTo(cost, 9);
      }
      // ... and the same rungs the server served (rounded as served).
      expect(m.rungs.map((r) => r.cost)).toEqual(Object.values(want.costs).map((c) => (c === null ? null : Math.round(c))));
    });
  }

  it("every pass is there for a reason", () => {
    expect(Object.keys(PARITY.why).sort()).toEqual(MARKETS.map((m) => m.key).sort());
  });
});

describe("pass deals on the build rate and the real pay", () => {
  const deals = (level: LevelKey) =>
    passDeals(PARITY.otd, PARITY.rules, { level, sport: "all", budget: PARITY.budgets[level], held: new Set() });
  const dealsAt = (level: LevelKey) => deals(level).map((d) => d.market.key);

  for (const level of LEVELS) {
    it(`at ${level}: the same pass deals as the server, at the same cost`, () => {
      const want = PARITY.expect.pass_deals[level];
      const got = deals(level);
      expect(got.map((d) => d.market.key)).toEqual(want.map(([key]) => key));
      got.forEach((d, i) => expect(d.cost).toBeCloseTo(want[i]![1], 9));
    });
  }

  it("a firm cheap shelf is a pass deal, the opening left out", () => {
    const firm = deals("regular").find((d) => d.market.key === "nhl:2025:player:9007")!;
    expect(firm.cost).toBeCloseTo(200 + 60 + 48 + 48, 9);
    expect(firm.usual_rate).toBe(20);
  });

  it("a Wembanyama-shaped scene (shelf pays 38 to 60 a point, firm, against a build rate of 30.36) yields no pass deal", () => {
    const wemby = MARKETS.find((m) => m.key === WEMBY)!;
    expect(wemby.rate_build).toBe(30.36);
    expect(wemby.auctions!.every(([, , firm]) => firm === 1)).toBe(true);
    const perPoint = wemby.auctions!.map(([rating, pay]) => pay / rating);
    expect(Math.min(...perPoint)).toBeGreaterThan(37.9);
    expect(Math.max(...perPoint)).toBeLessThan(60.3);
    for (const level of LEVELS) expect(dealsAt(level)).not.toContain(WEMBY);
    // The same pass as served today (floor openings against the traded rate) was one: the contrast.
    expect(LEVELS.some((level) => dealsAt(level).includes(CONTROL))).toBe(true);
  });
});
