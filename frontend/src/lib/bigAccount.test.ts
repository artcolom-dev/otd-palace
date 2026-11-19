// A big account (2,149 passes, as the biggest analysed so far) on this device: the plan and the next moves stay
// quick enough to work out on a phone, and every pass held counts.
import { describe, expect, it } from "vitest";
import type { PassMarket } from "../data/types";
import { JOKIC, MACKINNON, otdOf, passSnapshot } from "../test/passScene";
import { NOW } from "../test/scene";
import { nextRax } from "./nextRax";
import { type Holding, IDLE_SHARE, dayOf, idlePasses, nextBest, planHoldings } from "./passes";
import { snowball } from "./snowball";

/** `n` markets of one sport, 30 teams, several seasons, every one its own player. */
function many(template: PassMarket, n: number, from: number): PassMarket[] {
  return Array.from({ length: n }, (_, i) => {
    const id = from + i;
    const season = template.season - (i % 4);
    return { ...template, key: `${template.sport}:${season}:player:${id}`, player_id: id, team_id: 1000 + (i % 30), season, player_name: `P${id}` };
  });
}

const markets = [...many(JOKIC, 1300, 1), ...many(MACKINNON, 1300, 5000)];
const snap = passSnapshot({ otd: otdOf(markets) });
const holdings: Holding[] = markets.slice(0, 2149).map((m, i) => ({ key: m.key, rating: (i * 37) % 300 }));

const timed = <T,>(f: () => T): [T, number] => {
  const t = performance.now();
  const out = f();
  return [out, performance.now() - t];
};

describe("a 2,149-pass account on this device", () => {
  it("counts every pass, and plans them quickly", () => {
    planHoldings(holdings, markets, snap.rules.otd, snap.otd.sports); // warm up
    const [plan, ms] = timed(() => planHoldings(holdings, markets, snap.rules.otd, snap.otd.sports));
    expect(plan.held).toHaveLength(2149);
    expect(ms).toBeLessThan(400);
  });

  it("finds its passes that hardly ever get a claim at once: most of them, none that wins a quarter of its claims", () => {
    const plan = planHoldings(holdings, markets, snap.rules.otd, snap.otd.sports);
    const [idle, ms] = timed(() => idlePasses(plan));
    expect(ms).toBeLessThan(50);
    expect(idle.length).toBeGreaterThan(1000); // 2 claims a day per sport: a 2,149-pass account cannot claim with most
    expect(idle.length).toBeLessThan(plan.held.length);
    for (const x of idle) expect(x.gets).toBeLessThan(IDLE_SHARE * x.alone);
    for (let i = 1; i < idle.length; i++) expect(idle[i - 1]!.alone - idle[i - 1]!.gets).toBeGreaterThanOrEqual(idle[i]!.alone - idle[i]!.gets);
  });

  it("works out its next moves quickly", () => {
    const input = { holdings, level: "regular" as const, budget: null, passBudget: null, balance: null, now: NOW, paused: true, n: 5 };
    nextRax(snap, input); // warm up
    const [r, ms] = timed(() => nextRax(snap, input));
    expect(r.moves.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(800);
  });

  it("finds the best passes to add next quickly", () => {
    const [picks, ms] = timed(() => nextBest(holdings, markets, snap.rules.otd, { n: 3, today: dayOf(snap.otd.as_of), sports: snap.otd.sports }));
    expect(picks.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(1500);
  });

  it("plays a year of buying out quickly", () => {
    const input = { balance: 20_000, holdings, markets, rules: snap.rules.otd, sports: snap.otd.sports, today: dayOf(snap.otd.as_of) };
    const [, ms] = timed(() => snowball(input));
    expect(ms).toBeLessThan(6000); // a guard against a blow-up, loose enough for a busy machine
  });
});
