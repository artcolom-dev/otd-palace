import { describe, expect, it } from "vitest";
import { OTD_RULES } from "../test/fixtures";
import { JOKIC, MACKINNON, MCDAVID, TODAY, passSnapshot } from "../test/passScene";
import { type SnowballInput, playOrder, snowball } from "./snowball";

const snap = passSnapshot();
const input = (balance: number, over: Partial<SnowballInput> = {}): SnowballInput => ({
  balance,
  holdings: [],
  markets: snap.otd.markets,
  rules: OTD_RULES,
  sports: snap.otd.sports,
  today: TODAY,
  ...over,
});
const steps = (r: ReturnType<typeof snowball>) => r.steps.map((s) => `${s.after}:${s.market.player_name}:${s.tier}:${s.cost}`);

describe("snowball: golden numbers (the scene's markets, today 2026-11-12)", () => {
  it("400 Rax and no pass: buys the best pass it reaches, then the next as the pay comes in", () => {
    const r = snowball(input(400));
    expect(steps(r)).toEqual([
      "0:Nathan MacKinnon:uncommon:365",
      "2:Nikola Jokić:common:300",
      "3:Ja'Marr Chase:common:320",
      "4:Connor McDavid:common:310",
      "5:Jamal Murray:common:290",
      "6:Shai Gilgeous-Alexander:common:600",
    ]);
    // A General pays nothing On This Day, so Shai Gilgeous-Alexander is bought at Common, later, once 600 is there.
    expect(r.steps.map((s) => Math.round(s.gain))).toEqual([1500, 1000, 1000, 800, 600, 903]); // the last two share NBA claims
    expect(r.series).toHaveLength(13);
    expect(r.series.map((p) => Math.round(p.year))).toEqual([1500, 1500, 2500, 3500, 4300, 4900, 5803, 5803, 5803, 5803, 5803, 5803, 5803]);
    expect(Math.round(r.series[0]!.cash)).toBe(35);
    expect(Math.round(r.series[1]!.cash)).toBe(145); // 35 + the part of November left (19 of 30 days) and its share of the season
    expect(Math.round(r.series[2]!.cash)).toBe(18);
    expect(Math.round(r.start)).toBe(0);
    expect(Math.round(r.end)).toBe(5803);
    expect(Math.round(r.earned)).toBe(4375);
    expect(Math.round(r.cash)).toBe(2590);
  });

  it("holding a pass already: it pays from today and the same rule buys what comes next", () => {
    const r = snowball(input(400, { holdings: [{ key: MACKINNON.key, tier: "uncommon" }] }));
    expect(Math.round(r.start)).toBe(1500);
    expect(steps(r)[0]).toBe("0:Nikola Jokić:common:300"); // Chase's season is being played: his live pay fills his limit (B9)
    expect(r.series[0]!.year).toBeGreaterThan(r.start);
  });

  it("a held pass the app says is maxed pays nothing and is not counted", () => {
    const r = snowball(input(0, { holdings: [{ key: MACKINNON.key, tier: "uncommon", spent: true }] }));
    expect(r.earned).toBe(0);
    expect(r.start).toBe(0);
  });
});

describe("snowball: edges", () => {
  it("nothing in hand and nothing held: no step, a flat zero line", () => {
    const r = snowball(input(0));
    expect(r.steps).toEqual([]);
    expect(r.series.every((p) => p.year === 0 && p.cash === 0)).toBe(true);
    expect(r.earned).toBe(0);
  });

  it("a balance that cannot be read counts as 0", () => {
    for (const bad of [-50, Number.NaN, Number.POSITIVE_INFINITY]) expect(snowball(input(bad)).steps).toEqual([]);
  });

  it("holding passes but no cash: the pay builds the cash, and the first buy waits for it", () => {
    const r = snowball(input(0, { holdings: [{ key: MACKINNON.key, tier: "epic" }] }));
    expect(r.start).toBeGreaterThan(0);
    expect(r.steps[0]!.after).toBeGreaterThan(0);
    expect(r.series[0]!.cash).toBe(0);
  });

  it("is bounded and sane on any balance: 13 points, no negative cash, run-rate never falls, buys at most 6 a month", () => {
    for (const b of [1, 99, 365, 1000, 5000, 100000]) {
      const r = snowball(input(b));
      expect(r.series).toHaveLength(13);
      expect(r.series.every((p) => p.cash >= -1e-9)).toBe(true);
      expect(r.series.map((p) => p.year)).toEqual([...r.series.map((p) => p.year)].sort((a, c) => a - c));
      for (let m = 0; m < 12; m++) expect(r.steps.filter((s) => s.after === m).length).toBeLessThanOrEqual(6);
      expect(r.steps.every((s) => s.cost > 0 && s.gain >= 0)).toBe(true);
      const spent = r.steps.reduce((sum, s) => sum + s.cost, 0);
      expect(spent + r.cash).toBeCloseTo(b + r.earned, 6); // every Rax is accounted for
    }
  });

  it("never buys one pass twice", () => {
    const keys = snowball(input(100000)).steps.map((s) => s.market.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("snowball: the engine against an independent calculation", () => {
  it("one pass bought now pays its season's share each month until its lifetime limit, to the Rax", () => {
    const r = playOrder(input(365), [{ key: MACKINNON.key, tier: "uncommon" }]);
    // 1,560 a season (3x of 520) over the NHL's 9 months; November has 19 of 30 days left; December to June, then
    // October of next year: 8 whole months more. The 1,500 limit is not reached in the 12 months.
    const expected = (1560 / 9) * (19 / 30 + 8);
    expect(r.earned).toBeCloseTo(expected, 6);
    expect(r.cash).toBeCloseTo(expected, 6);
    expect(r.series[0]).toMatchObject({ month: 0, cash: 0 });
    expect(r.series[1]!.cash).toBeCloseTo((1560 / 9) * (19 / 30), 6);
    expect(r.series[8]!.cash).toBeCloseTo((1560 / 9) * (19 / 30 + 7), 6); // after July, August and September: nothing
    expect(r.series[9]!.cash).toBeCloseTo((1560 / 9) * (19 / 30 + 7), 6);
  });

  it("a buy that cannot be afforded yet waits, and is made the month the cash arrives", () => {
    const r = playOrder(input(365, { holdings: [{ key: JOKIC.key, tier: "common" }] }), [{ key: MACKINNON.key, tier: "uncommon" }]);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]).toMatchObject({ after: 0, tier: "uncommon", cost: 365 });
    const later = playOrder(input(200, { holdings: [{ key: JOKIC.key, tier: "common" }] }), [{ key: MACKINNON.key, tier: "uncommon" }]);
    expect(later.steps[0]!.after).toBeGreaterThan(0);
    expect(later.series[0]!.cash).toBe(200); // nothing could be bought with 200 at first
  });

  it("an order skips what is held, unknown or unpriced, and plays the rest", () => {
    const r = playOrder(input(1000, { holdings: [{ key: JOKIC.key, tier: "common" }] }), [
      { key: JOKIC.key, tier: "rare" },
      { key: "nba:1999:player:0", tier: "common" },
      { key: MACKINNON.key, tier: "nope" },
      { key: MACKINNON.key, tier: "uncommon" },
    ]);
    expect(steps(r)).toEqual(["0:Nathan MacKinnon:uncommon:365"]);
  });
});

describe("snowball: the planner against every order of a small set", () => {
  // Small inputs: three passes, two or three rarities each, every order of up to 3 buys.
  const markets = [JOKIC, MACKINNON, MCDAVID];
  const items = markets.flatMap((m) => ["common", "uncommon", "rare"].map((tier) => ({ key: m.key, tier })));
  const orders: { key: string; tier: string }[][] = [[]];
  const grow = (cur: { key: string; tier: string }[]) => {
    if (cur.length >= 3) return;
    for (const it of items) {
      if (cur.some((c) => c.key === it.key)) continue;
      orders.push([...cur, it]);
      grow([...cur, it]);
    }
  };
  grow([]);
  const small = (balance: number) => input(balance, { markets });

  it("its first buy is the affordable pass with the best return per Rax, as the brute force finds", () => {
    for (const balance of [300, 400, 600, 900]) {
      const first = snowball(small(balance)).steps[0]!;
      let best = 0;
      for (const m of markets) {
        for (const r of m.rungs) {
          if (r.cost !== null && r.cost > 0 && r.cost <= balance && r.pays_back) best = Math.max(best, r.year_rax / r.cost);
        }
      }
      expect(first.gain / first.cost).toBeCloseTo(best, 9);
    }
  });

  it("is a rule, not the best possible order: it earns at least half what the best order of the set earns", () => {
    for (const balance of [150, 300, 400, 600, 900]) {
      const mine = snowball(small(balance)).earned;
      const best = Math.max(...orders.map((o) => playOrder(small(balance), o).earned));
      expect(mine).toBeGreaterThanOrEqual(best * 0.5);
      expect(best).toBeGreaterThanOrEqual(0);
    }
  });

  it("an order of its own steps gives the same year as the planner", () => {
    const r = snowball(small(900));
    const again = playOrder(small(900), r.steps.map((s) => ({ key: s.market.key, tier: s.tier })));
    expect(again.earned).toBeCloseTo(r.earned, 9);
    expect(again.series).toEqual(r.series);
  });
});

describe("snowball: unused scene passes stay out when they cannot pay back", () => {
  it("a team pass, which cannot be priced, is never bought", () => {
    const keys = snowball(input(100000)).steps.map((s) => s.market.key);
    expect(keys.some((k) => k.includes(":team:"))).toBe(false);
  });
});
