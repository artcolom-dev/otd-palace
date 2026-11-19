// The members' "Pass deals" block (passDeals) and the free site's teaser (advisor/pass_deals.py) find the same passes
// on the same snapshot: tests/fixtures/pass_deals_parity.json, the server's own output for a few passes, says what each
// level must find, and tests/test_pass_deals_parity.py holds the server to the same `expect`.
import { existsSync, readFileSync } from "node:fs";
import { cwd } from "node:process";
import { describe, expect, it } from "vitest";
import type { LevelKey } from "../data/prefs";
import type { Otd, OtdRules } from "../data/types";
import { PASS_DEALS_SHOWN, lockedWords } from "../components/PassDeals";
import { type PassDeal, passDeals } from "./passDeals";

interface Parity {
  rules: OtdRules;
  budgets: Record<LevelKey, number | null>;
  why: Record<string, string>;
  expect: Record<LevelKey, { passes: number; best_pct: number | null; keys: string[]; body: string; title: string }>;
  otd: Otd;
}
// The tests run from frontend/ (npm --prefix frontend test) or from the repository's root.
const PATH = [`${cwd()}/../tests/fixtures/pass_deals_parity.json`, `${cwd()}/tests/fixtures/pass_deals_parity.json`].find(existsSync)!;
const PARITY = JSON.parse(readFileSync(PATH, "utf-8")) as Parity;
const LEVELS: LevelKey[] = ["new", "regular", "pro"];

/** The pass deals a member of `level` gets with the level's default budget, holding nothing, on `sport`. */
const dealsAt = (level: LevelKey, sport = "all") =>
  passDeals(PARITY.otd, PARITY.rules, { level, sport, budget: PARITY.budgets[level], held: new Set() });

/** A deal's saving, a share of its rarity's usual cost (the mint in it), as advisor/pass_deals.py counts it. */
const saving = (d: PassDeal) => (d.rung.cost - d.cost) / d.rung.cost;

/** advisor/pass_deals.py best_pct: whole percent rounded down to 5, at most 50. */
const bestPct = (share: number) => Math.max(0, Math.min(50, Math.floor((share * 100) / 5 + 1e-9) * 5));

describe("Pass deals: the members' block and the free site's teaser agree", () => {
  for (const level of LEVELS) {
    it(`at ${level}: the same passes, in the same order, and the same best saving, the deepest of the first ones`, () => {
      const want = PARITY.expect[level];
      const found = dealsAt(level);
      expect(found.map((d) => d.market.key)).toEqual(want.keys);
      expect(found.length).toBe(want.passes);
      const first = found.slice(0, PASS_DEALS_SHOWN); // what the block lists on "all", where a member lands
      expect(first.length === 0 ? null : bestPct(Math.max(...first.map(saving)))).toBe(want.best_pct);
    });

    it(`at ${level}: the locked teaser reads the same words`, () => {
      const want = PARITY.expect[level];
      const words = lockedWords(want.passes, want.best_pct);
      expect({ body: words.body, title: words.title }).toEqual({ body: want.body, title: want.title });
    });

    it(`at ${level}: each pass counted is on its sport's tab`, () => {
      const found = dealsAt(level);
      for (const sport of new Set(found.map((d) => d.market.sport))) {
        const tab = dealsAt(level, sport).slice(0, PASS_DEALS_SHOWN);
        expect(tab.map((d) => d.market.key)).toEqual(found.filter((d) => d.market.sport === sport).map((d) => d.market.key));
      }
    });

    it(`at ${level}: the pass with the saving said shows a rate a point at least that far under the usual one`, () => {
      const want = PARITY.expect[level];
      const first = dealsAt(level).slice(0, PASS_DEALS_SHOWN);
      if (want.best_pct === null) return;
      const best = first.reduce((a, b) => (saving(b) > saving(a) ? b : a));
      // The member's row says "8.5 Rax a rating point (usual 10.0)": the cards' own saving a point is never smaller
      // than the saving on the whole rarity, the mint in it, that the teaser says.
      expect(1 - best.per_point / best.usual_rate).toBeGreaterThanOrEqual(want.best_pct / 100);
      expect(saving(best)).toBeGreaterThanOrEqual(want.best_pct / 100);
    });
  }

  it("every pass is there for a reason", () => {
    const keys = [...PARITY.otd.markets, ...(PARITY.otd.current_markets ?? [])].map((m) => m.key);
    expect(Object.keys(PARITY.why).sort()).toEqual(keys.sort());
  });
});
