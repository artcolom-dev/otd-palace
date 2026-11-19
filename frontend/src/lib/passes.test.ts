import { existsSync, readFileSync } from "node:fs";
import { cwd } from "node:process";
import { describe, expect, it } from "vitest";
import type { PassRung } from "../data/types";
import { OTD_RULES } from "../test/fixtures";
import {
  type PassBasis,
  bestRung,
  breaksEvenAtBest,
  climb,
  idlePasses,
  marketOf,
  monthBars,
  monthShareEstimated,
  nextBest,
  paysLater,
  onSale,
  planHoldings,
  recommendedRung,
  rungs,
  tierAt,
  toBasis,
  weakRungs,
} from "./passes";

// The same golden vectors the Python engine (advisor/otd.py) is checked against, read from the repository.
interface VectorCase {
  name: string;
  market: PassBasis;
  held_rating: number;
  today: string;
  expect: { rungs: Record<string, unknown>[]; best: string | null; weak: string[]; month_share_estimated: boolean };
}
// The tests run from frontend/ (npm --prefix frontend test) or from the repository's root.
const VECTOR_PATH = [`${cwd()}/../tests/fixtures/otd_vectors.json`, `${cwd()}/tests/fixtures/otd_vectors.json`].find(existsSync)!;
const VECTORS = JSON.parse(readFileSync(VECTOR_PATH, "utf-8")) as { tolerance: number; cases: VectorCase[] };
const TOL = VECTORS.tolerance;

/** The fields of `got` that differ from the vector's: numbers beyond the tolerance, anything else not identical. */
function mismatches(got: PassRung, want: Record<string, unknown>): Record<string, [unknown, unknown]> {
  const wrong: Record<string, [unknown, unknown]> = {};
  for (const [name, value] of Object.entries(want)) {
    const actual = (got as unknown as Record<string, unknown>)[name];
    const ok =
      typeof value === "number"
        ? typeof actual === "number" && Math.abs(actual - value) <= TOL
        : actual === value;
    if (!ok) wrong[name] = [actual, value];
  }
  return wrong;
}

const caseNamed = (name: string) => VECTORS.cases.find((c) => c.name === name)!;
const ruleOf = (c: VectorCase) => ({ today: c.today, heldRating: c.held_rating });

describe("the golden vectors", () => {
  it("are all there", () => {
    expect(VECTORS.cases.length).toBeGreaterThanOrEqual(25);
  });

  it.each(VECTORS.cases.map((c) => [c.name, c] as const))("%s: rungs, best, weak and month shares agree", (_, c) => {
    const got = rungs(c.market, OTD_RULES, ruleOf(c));
    expect(got.map((r) => r.tier)).toEqual(c.expect.rungs.map((r) => r.tier));
    got.forEach((rung, i) => expect([rung.tier, mismatches(rung, c.expect.rungs[i]!)]).toEqual([rung.tier, {}]));
    expect(bestRung(got)?.tier ?? null).toBe(c.expect.best);
    expect([...weakRungs(got)].sort()).toEqual([...c.expect.weak].sort());
    expect(monthShareEstimated(c.market)).toBe(c.expect.month_share_estimated);
  });

  it("the rating planner climbs exactly as the engine does from a held rating", () => {
    const held = VECTORS.cases.filter((c) => c.held_rating > 0);
    expect(held.length).toBeGreaterThanOrEqual(2);
    for (const c of held) {
      const got = climb(c.market, c.held_rating, OTD_RULES, c.today).rungs;
      expect(got.map((r) => r.tier)).toEqual(c.expect.rungs.map((r) => r.tier));
      got.forEach((rung, i) => expect([c.name, rung.tier, mismatches(rung, c.expect.rungs[i]!)]).toEqual([c.name, rung.tier, {}]));
    }
  });

  it("one pass alone in its sport pays what its rung says, at every rarity of every vector", () => {
    let checked = 0;
    for (const c of VECTORS.cases.filter((v) => v.held_rating === 0)) {
      for (const want of c.expect.rungs) {
        const tier = want.tier as string;
        const plan = planHoldings([{ key: c.market.key, tier }], [c.market], OTD_RULES);
        const sport = plan.sports[c.market.sport]!;
        expect([c.name, tier, Math.abs(sport.total - (want.year_rax as number)) <= TOL]).toEqual([c.name, tier, true]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(150);
  });
});

/** A past NBA season like the vectors': 600 at 1x over 80 game days, cards at 10 a rating point. */
function market(over: Partial<PassBasis> = {}): PassBasis {
  const base = caseNamed("held_212_epic_reached").market;
  return { ...base, ...over };
}

describe("a stored market (toBasis) read back (marketOf)", () => {
  const fresh = VECTORS.cases.filter((c) => c.held_rating === 0);

  it.each(fresh.map((c) => [c.name, c] as const))("%s: the same rungs, best, weak and month shares as the engine", (_, c) => {
    const got = marketOf(toBasis({ ...c.market, rungs: [], best: "x", weak: ["x"], on_sale: null, month_share_estimated: true }), OTD_RULES, c.today);
    expect(got.rungs.map((r) => r.tier)).toEqual(c.expect.rungs.map((r) => r.tier));
    got.rungs.forEach((rung, i) => expect([rung.tier, mismatches(rung, c.expect.rungs[i]!)]).toEqual([rung.tier, {}]));
    expect(got.best).toBe(c.expect.best);
    expect(got.weak).toEqual(c.expect.weak);
    expect(got.month_share_estimated).toBe(c.expect.month_share_estimated);
  });

  it("keeps none of the derived figures, and is several times smaller", () => {
    const c = fresh[0]!;
    const full = marketOf(c.market, OTD_RULES, c.today);
    const basis = toBasis(full);
    for (const k of ["rungs", "best", "weak", "on_sale", "month_share_estimated"]) expect(basis).not.toHaveProperty(k);
    expect(basis).toEqual(c.market);
    expect(JSON.stringify(basis).length * 3).toBeLessThan(JSON.stringify(full).length);
  });

  it("says what is on sale toward the best rung, and nothing when the best is the mint alone", () => {
    const c = fresh.find((v) => v.expect.best !== null)!;
    const shelf: [number, number][] = [[10, 50], [5, 40]];
    const got = marketOf({ ...c.market, shelf, shelf_count: 2 }, OTD_RULES, c.today);
    const best = got.rungs.find((r) => r.tier === got.best)!;
    if (best.route === "mint") expect(got.on_sale).toBeNull();
    else {
      const { on_sale_rating, on_sale_cost, enough } = onSale({ ...c.market, shelf }, best.rating_to_add, OTD_RULES);
      expect(got.on_sale).toEqual({ on_sale_rating, on_sale_cost, enough });
    }
  });
});

describe("tiers and the engine's choices", () => {
  it("a rating falls in the tier it has reached", () => {
    expect(tierAt("player", 0, OTD_RULES)).toMatchObject({ tier: "general", rating: 0, mult: 1, index: 0 });
    expect(tierAt("player", 212, OTD_RULES)).toMatchObject({ tier: "epic", rating: 180, mult: 10, index: 4 });
    expect(tierAt("team", 30, OTD_RULES)).toMatchObject({ tier: "common", mult: 1.2 });
    expect(tierAt("player", 99999, OTD_RULES).tier).toBe("iconic");
  });

  it("the best rung within a budget is the best of those that fit", () => {
    const ladder = rungs(market(), OTD_RULES, { today: "2026-11-01" });
    const fits = bestRung(ladder, 1000)!;
    expect(fits.cost).toBeLessThanOrEqual(1000);
    expect(ladder.filter((r) => r.pays_back && r.cost !== null && r.cost <= 1000).every((r) => r.year_per_rax! <= fits.year_per_rax!)).toBe(true);
    expect(bestRung(ladder, 100)).toBeNull();
  });

  it("a rung that only breaks even is never the recommended one", () => {
    // Common at 900 to mint plus 100 of cards, for a lifetime of 1,000: it only breaks even, so it never pays back.
    const ladder = rungs(market({ mint_cost: 900 }), OTD_RULES, { today: "2026-11-01" });
    expect(ladder[0]).toMatchObject({ tier: "common", pays_back: false });
    expect(breaksEvenAtBest(ladder[0]!)).toBe(true);
    expect(recommendedRung(ladder)?.tier).not.toBe("common");
    // A team pass's rungs cannot be priced: no best rung, and none recommended.
    const team = caseNamed("team_ladder_nba");
    const teamLadder = rungs(team.market, OTD_RULES, ruleOf(team));
    expect(bestRung(teamLadder)).toBeNull();
    expect(recommendedRung(teamLadder)).toBeNull();
    const player = rungs(market(), OTD_RULES, { today: "2026-11-01" });
    expect(recommendedRung(player)?.tier).toBe(bestRung(player)?.tier);
  });
});

describe("General pays nothing On This Day", () => {
  it("a General held on a past season earns 0, on its own and among a sport's claims", () => {
    const m = market();
    const plan = planHoldings([{ key: m.key, tier: "general" }], [m], OTD_RULES);
    expect(plan.held[0]).toMatchObject({ tier: "general", limit: 0, year: 0 });
    expect(plan.sports[m.sport]!).toMatchObject({ total: 0, used: 0 });
  });

  it("a General held on a season being played still earns its live games, unchanged", () => {
    // Half played, 300 so far: 300 of live games left at 1x, and nothing On This Day for the half played.
    const m = market({ season_state: "current", season_progress: 0.5, base_1x: 300 });
    const plan = planHoldings([{ key: m.key, tier: "general" }], [m], OTD_RULES);
    expect(plan.held[0]!.year).toBeCloseTo(300, 6);
    expect(plan.sports[m.sport]!.total).toBeCloseTo(300, 6);
  });

  it("a season being played: its live pay fills the limit, so it is not paid again On This Day (B9)", () => {
    // Half played, 300 so far (season 600 at 1x): Common's live half (600) leaves 400 of its 1,000 limit.
    const m = market({ season_state: "current", season_progress: 0.5, base_1x: 300 });
    const plan = planHoldings([{ key: m.key, tier: "common" }], [m], OTD_RULES);
    expect(plan.held[0]!.year).toBeCloseTo(1000, 6); // not 600 live + 600 On This Day
    expect(plan.sports[m.sport]!.total).toBeCloseTo(1000, 6);
    const common = rungs(m, OTD_RULES, { today: "2026-11-01" }).find((r) => r.tier === "common")!;
    expect(common.year_rax).toBeCloseTo(1000, 6);
    expect(common.year_capped).toBe(true);
    expect(common.lifetime_per_rax! * common.cost!).toBeCloseTo(1000, 6); // the limit, not limit plus live
  });

  it("a General held at 0 rating climbs to Common with its cards alone, never the mint again", () => {
    const c = climb(market(), 0, OTD_RULES, "2026-11-01", { minted: true });
    expect(c.tier).toBe("general");
    const [common] = c.options;
    // 10 rating at the traded 10 a point; Common pays min(1,200, 1,000) = 1,000 a year where General paid nothing.
    expect(common).toMatchObject({ tier: "common", rating_to_add: 10, cost: 100, route: "cards" });
    expect(common!.extra_year).toBeCloseTo(1000, 6);
    expect(common!.extra_pays_back).toBe(true);
  });
});

describe("a pass whose pay is mostly months away", () => {
  const flat = (months: number[]) => Array.from({ length: 12 }, (_, i) => (months.includes(i + 1) ? 1 / months.length : 0));
  const of = (sport: string, months: number[]) => market({ sport, month_share: flat(months) });

  it("names the month its pay starts and the month before, to buy in (a fixed day: 16 November 2026)", () => {
    expect(paysLater(of("mlb", [3, 4, 5, 6, 7, 8, 9, 10]), OTD_RULES, "2026-11-16")).toEqual({ from: 3, buy: 2 });
    expect(paysLater(of("wnba", [5, 6, 7, 8, 9, 10]), OTD_RULES, "2026-11-16")).toEqual({ from: 5, buy: 4 });
  });

  it("says nothing of a sport paying now, or soon enough", () => {
    expect(paysLater(of("nba", [10, 11, 12, 1, 2, 3, 4, 5, 6]), OTD_RULES, "2026-11-16")).toBeNull();
    expect(paysLater(of("golf", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), OTD_RULES, "2026-11-16")).toBeNull();
    // MLB in February: March is within the next 3 months.
    expect(paysLater(of("mlb", [3, 4, 5, 6, 7, 8, 9, 10]), OTD_RULES, "2027-02-01")).toBeNull();
  });

  it("starts at the first month that holds a real share of the season, not a trace", () => {
    // MLB as measured: 3 % in March, then 13-15 % a month. From 16 November nothing comes before March.
    const mlb = market({ sport: "mlb", month_share: [0, 0, 0.03, 0.14, 0.14, 0.13, 0.13, 0.15, 0.15, 0.13, 0, 0] });
    expect(paysLater(mlb, OTD_RULES, "2026-11-16")).toEqual({ from: 3, buy: 2 });
    const trace = market({ sport: "mlb", month_share: [0.01, 0, 0.02, 0.14, 0.14, 0.13, 0.13, 0.15, 0.15, 0.13, 0, 0] });
    expect(paysLater(trace, OTD_RULES, "2026-11-16")).toEqual({ from: 3, buy: 2 });
  });

  it("at the end of a season, names the month the next one starts, not the tail of the one ending", () => {
    // The note's measured MLB and NFL month shares.
    const mlb = market({ sport: "mlb", month_share: [0, 0, 0.03, 0.14, 0.14, 0.13, 0.13, 0.15, 0.15, 0.12, 0, 0] });
    expect(paysLater(mlb, OTD_RULES, "2026-10-10")).toEqual({ from: 3, buy: 2 });
    const nfl = market({ sport: "nfl", month_share: [0.19, 0.02, 0, 0, 0, 0, 0, 0, 0.18, 0.19, 0.2, 0.22] });
    expect(paysLater(nfl, OTD_RULES, "2027-02-10")).toEqual({ from: 9, buy: 8 });
  });

  it("a season that pays nothing is not 'later': it never pays", () => {
    expect(paysLater(market({ base_1x: 0, sport: "mlb", month_share: flat([3, 4, 5]) }), OTD_RULES, "2026-11-16")).toBeNull();
  });
});

describe("cards on sale now", () => {
  it("takes the cheapest per point first until the rating is reached, leaving out parked asks", () => {
    const m = market({
      rate_traded: 10,
      rate_sales: 20,
      shelf: [[5, 60], [10, 90], [4, 1000], [3.3, 40]],
    });
    // 90/10 = 9 a point, 40/3.3 = 12.1, 60/5 = 12; 1000/4 = 250 > 5 x 10: parked.
    expect(onSale(m, 12, OTD_RULES)).toEqual({ on_sale_rating: 15, on_sale_cost: 150, enough: true, ignored: 1 });
    expect(onSale(m, 30, OTD_RULES)).toEqual({ on_sale_rating: 18.3, on_sale_cost: 190, enough: false, ignored: 1 });
    // Too few trades to judge an ask: the dear card counts.
    expect(onSale({ ...m, rate_sales: 4 }, 30, OTD_RULES).on_sale_rating).toBe(22.3);
  });

  it("counts ratings to the hundredth, as Real shows them and as the server does (advisor/otd.py on_sale)", () => {
    const m = (shelf: [number, number][]) => market({ rate_traded: 10, rate_sales: 20, shelf });
    // 7.25 + 2.7 is 9.95, short of 10 (counted in tenths, 7.25 made 7.3 here and 7.2 on the server).
    expect(onSale(m([[7.25, 40], [2.7, 20]]), 10, OTD_RULES)).toEqual({ on_sale_rating: 9.95, on_sale_cost: 60, enough: false, ignored: 0 });
    expect(onSale(m([[4.72, 47], [5.27, 53]]), 10, OTD_RULES)).toEqual({ on_sale_rating: 9.99, on_sale_cost: 100, enough: false, ignored: 0 });
    expect(onSale(m([[7.25, 72], [2.75, 28]]), 10, OTD_RULES)).toEqual({ on_sale_rating: 10, on_sale_cost: 100, enough: true, ignored: 0 });
  });
});

describe("the rating planner", () => {
  it("212 on a pass: Epic, 32 of it unused until Legendary, and what each next rarity adds", () => {
    const c = climb(market(), 212, OTD_RULES, "2026-11-01");
    expect(c).toMatchObject({ tier: "epic", mult: 10, unused: 32, next: { tier: "legendary", rating: 380 } });
    expect(c.sell).toBe(320); // 32 at the traded 10 a point
    // Epic pays min(6,000, 5,000) = 5,000 now; Legendary 12,500 capped: +7,500.
    const [legendary, mystic] = c.options;
    expect(legendary).toMatchObject({ tier: "legendary", rating_to_add: 168, cost: 1680 });
    expect(legendary!.extra_year).toBeCloseTo(7500, 6);
    expect(mystic!.extra_year).toBeCloseTo(37500 - 5000, 6);
    // The extra 9,000 a season at 1,000 a month pays the 1,680 back in under 2 months.
    expect(legendary!.extra_pays_back).toBe(true);
    expect(legendary!.extra_payback_months).toBeGreaterThan(1);
    expect(legendary!.extra_payback_months).toBeLessThan(2);
    expect(c.options).toHaveLength(2);
  });

  it("at the top rarity there is nothing to climb", () => {
    const c = climb(market(), 4000, OTD_RULES, "2026-11-01");
    expect(c).toMatchObject({ tier: "iconic", unused: 0, next: null, options: [] });
  });

  it("without a traded rate the climb cannot be priced", () => {
    const c = climb(market({ rate_traded: null }), 212, OTD_RULES, "2026-11-01");
    expect(c.sell).toBeNull();
    expect(c.options[0]).toMatchObject({ cost: null, extra_pays_back: null });
  });
});

describe("my passes: the claims a sport offers", () => {
  // Three NBA passes of 600 at 1x over 80 days (Common: 1,200 a season, capped at 1,000).
  const team = (id: number, teamId: number | null, over: Partial<PassBasis> = {}) =>
    market({ key: `nba:2025:player:${id}`, player_id: id, player_name: `Player ${id}`, team_id: teamId, ...over });

  // At 400 a season, Common pays 800 a season: under its 1,000 limit, so every claim of the year pays.
  it("two teammates fill the same days and are both paid: 2 claims a day", () => {
    const a = team(1, 7, { base_1x: 400 });
    const b = team(2, 7, { base_1x: 400 });
    const plan = planHoldings([{ key: a.key, tier: "common" }, { key: b.key, tier: "common" }], [a, b], OTD_RULES);
    const nba = plan.sports.nba!;
    expect(nba.total).toBeCloseTo(1600, 6);
    expect(nba.mates).toEqual([["Player 1", "Player 2"]]);
    expect(nba.claim_days).toBe(210);
    expect(nba.used).toBe(160);
    expect(nba.fill).toBeCloseTo(160 / 420, 9);
  });

  it("a third teammate on the same days wins no claim: the two that pay most per day take them", () => {
    const a = team(1, 7, { base_1x: 400 });
    const b = team(2, 7, { base_1x: 400 });
    const c = team(3, 7, { base_1x: 300 });
    const plan = planHoldings(
      [{ key: a.key, tier: "common" }, { key: b.key, tier: "common" }, { key: c.key, tier: "common" }],
      [a, b, c],
      OTD_RULES,
    );
    expect(plan.sports.nba!.total).toBeCloseTo(1600, 6);
    expect(plan.sports.nba!.per[c.key]).toBe(0);
  });

  it("a pass that reached its limit stops claiming, so a third one gets those days", () => {
    const a = team(1, 7); // Common: 1,200 a season, stops at 1,000
    const b = team(2, 7);
    const c = team(3, 7, { base_1x: 300 });
    const plan = planHoldings(
      [{ key: a.key, tier: "common" }, { key: b.key, tier: "common" }, { key: c.key, tier: "common" }],
      [a, b, c],
      OTD_RULES,
    );
    expect(plan.sports.nba!.per[a.key]).toBeCloseTo(1000, 6);
    expect(plan.sports.nba!.per[c.key]).toBeGreaterThan(0);
  });

  // Common is 2x: a pass of 300 a season could pay 600 a year by itself.
  it("the passes that hardly ever get a claim: a third and a fourth teammate, the most unused Rax first", () => {
    const a = team(1, 7, { base_1x: 400 });
    const b = team(2, 7, { base_1x: 400 });
    const c = team(3, 7, { base_1x: 200 });
    const d = team(4, 7, { base_1x: 300 });
    const plan = planHoldings([a, b, c, d].map((m) => ({ key: m.key, tier: "common" })), [a, b, c, d], OTD_RULES);
    const idle = idlePasses(plan);
    expect(idle.map((x) => x.pass.market.key)).toEqual([d.key, c.key]);
    expect(idle[0]!.gets).toBe(0);
    expect(idle[0]!.alone).toBeCloseTo(600, 6);
    expect(idle[1]!.alone).toBeCloseTo(400, 6);
  });

  it("a pass that wins most of its claims is not one of them, nor a maxed pass, nor a General", () => {
    const a = team(1, 7, { base_1x: 400 });
    const b = team(2, 8, { base_1x: 400 });
    const c = team(3, 9, { base_1x: 300 }); // another team: other days, so it wins most of its claims
    const maxed = team(4, 7, { base_1x: 100 });
    const general = team(5, 7, { base_1x: 100 });
    const plan = planHoldings(
      [
        { key: a.key, tier: "common" },
        { key: b.key, tier: "common" },
        { key: c.key, tier: "common" },
        { key: maxed.key, tier: "legendary", spent: true },
        { key: general.key, tier: "general" },
      ],
      [a, b, c, maxed, general],
      OTD_RULES,
    );
    expect(plan.sports.nba!.per[c.key]).toBeGreaterThan(300);
    expect(idlePasses(plan)).toEqual([]);
  });

  it("a pass the app says is maxed pays nothing and takes no claim", () => {
    const a = team(1, 7);
    const plan = planHoldings([{ key: a.key, tier: "legendary", spent: true }], [a], OTD_RULES);
    expect(plan.sports.nba).toMatchObject({ total: 0, used: 0, n: 1 });
  });

  it("an exact rating counts at the tier it reaches; a pass not in today's data is left out", () => {
    const a = team(1, 7);
    const plan = planHoldings([{ key: a.key, rating: 212 }, { key: "nba:1999:player:9" }], [a], OTD_RULES);
    expect(plan.held).toHaveLength(1);
    expect(plan.held[0]).toMatchObject({ tier: "epic", rating: 212 });
    expect(plan.total).toBeCloseTo(5000, 6); // Epic: 6,000 a season capped at its 5,000 limit
  });

  it("best to add next: what each adds a year with the passes held, cheapest return first, within the budget", () => {
    const a = team(1, 7);
    const b = team(2, 8);
    const c = team(3, 9, { base_1x: 300 });
    const markets = [a, b, c];
    const picks = nextBest([{ key: a.key, tier: "common" }], markets, OTD_RULES, { budget: 1000, today: "2026-11-01" });
    expect(picks.length).toBeGreaterThan(0);
    expect(picks.length).toBeLessThanOrEqual(2); // only b and c are not held
    for (const p of picks) {
      expect(p.market.key).not.toBe(a.key);
      expect(p.rung.cost).toBeLessThanOrEqual(1000);
      expect(breaksEvenAtBest(p.rung)).toBe(false);
    }
    // With one NBA pass held, a second one still wins all its claims: it adds its own year.
    expect(picks[0]!.gain).toBeCloseTo(picks[0]!.rung.year_rax, 6);
  });
});

describe("football passes of one season share their game days", () => {
  // The public NFL and college football schedules of 2023-2025 (the internal research notes): in a
  // season nearly every team plays on the same weekend dates, so k passes of one season on different teams win
  // fewer claims than k passes spread evenly would. What k random teams' game days really win under Real's 2 claims
  // a day, in units of one pass alone (claims won / the games of one team), mean of three seasons.
  const MEASURED: Record<string, Record<number, number>> = {
    nfl: { 3: 2.54, 4: 2.86, 5: 3.11, 8: 3.73, 15: 5.01 },
    cfb: { 3: 2.56, 4: 2.93, 5: 3.19, 8: 3.8, 15: 5.02 },
  };
  const GAMES: Record<string, number> = { nfl: 17, cfb: 13 };
  const OF = (sport: string, season: number, n: number, over: Partial<PassBasis> = {}) =>
    Array.from({ length: n }, (_, i) =>
      market({
        key: `${sport}:${season}:player:${season * 100 + i}`, sport, season, player_id: season * 100 + i, player_name: `P${season}-${i}`,
        team_id: season * 100 + i, base_1x: 300, game_days: GAMES[sport], month_share: [0.2, 0.2, 0, 0, 0, 0, 0, 0, 0.15, 0.15, 0.15, 0.15], ...over,
      }),
    );
  const hold = (markets: PassBasis[], sport: string, rules = OTD_RULES) =>
    planHoldings(markets.map((m) => ({ key: m.key, tier: "epic" })), markets, rules).sports[sport]!;
  const alone = (sport: string) => hold(OF(sport, 2025, 1), sport).total;

  it.each(["nfl", "cfb"])("%s: two passes of one season on different teams are both paid in full", (sport) => {
    const plan = hold(OF(sport, 2025, 2), sport);
    expect(plan.total).toBeCloseTo(2 * alone(sport), 6);
    expect(plan.used).toBe(2 * GAMES[sport]!);
  });

  it.each(["nfl", "cfb"])("%s: three to fifteen passes of one season win what the schedules say, within 12 points over or 5 under", (sport) => {
    for (const [k, units] of Object.entries(MEASURED[sport]!)) {
      const got = hold(OF(sport, 2025, Number(k)), sport).total / alone(sport);
      expect([sport, k, got >= units * 0.95 && got <= units * 1.12]).toEqual([sport, k, true]);
    }
  });

  it("a third, fourth and fifth pass of one season pay about a half, a third and a quarter of what each pays alone", () => {
    const total = (k: number) => hold(OF("nfl", 2025, k), "nfl").total / alone("nfl");
    expect(total(3) - total(2)).toBeGreaterThan(0.4);
    expect(total(3) - total(2)).toBeLessThan(0.75);
    expect(total(4) - total(3)).toBeGreaterThan(0.2);
    expect(total(4) - total(3)).toBeLessThan(0.45);
    expect(total(5) - total(4)).toBeGreaterThan(0.1);
    expect(total(5) - total(4)).toBeLessThan(0.35);
  });

  it("passes of different seasons share almost no dates: each season is replayed on its own days", () => {
    const one = hold(OF("nfl", 2025, 3), "nfl");
    const two = hold([...OF("nfl", 2025, 3), ...OF("nfl", 2024, 3)], "nfl");
    expect(two.total).toBeCloseTo(2 * one.total, 6);
    expect(two.used).toBe(2 * one.used);
    // Two passes in each of four seasons are all paid in full.
    const spread = hold([2022, 2023, 2024, 2025].flatMap((y) => OF("nfl", y, 2)), "nfl");
    expect(spread.total).toBeCloseTo(8 * alone("nfl"), 6);
  });

  it("the sport's days and slots are those of every season held", () => {
    const one = hold(OF("nfl", 2025, 3), "nfl");
    const two = hold([...OF("nfl", 2025, 3), ...OF("nfl", 2024, 1)], "nfl");
    expect([one.claim_days, one.slots]).toEqual([62, 124]);
    expect([two.claim_days, two.slots]).toEqual([124, 248]);
    expect(two.fill).toBeCloseTo(two.used / 248, 9);
  });

  it("teammates of one season play the very same days: the third one wins nothing", () => {
    const mates = OF("nfl", 2025, 3).map((m) => ({ ...m, team_id: 9 }));
    const plan = hold(mates, "nfl");
    expect(plan.total).toBeCloseTo(2 * alone("nfl"), 6);
    expect(plan.mates).toHaveLength(1);
  });

  it("a payload without weekly_days (an older one), and every other sport, spread their days evenly as before", () => {
    const { weekly_days: _w, ...older } = OTD_RULES;
    const markets = OF("nfl", 2025, 5);
    expect(hold(markets, "nfl", older).total).toBeCloseTo(5 * alone("nfl"), 6);
    const nba = Array.from({ length: 5 }, (_, i) => market({ key: `nba:2025:player:${i}`, player_id: i, team_id: i, base_1x: 400 }));
    expect(planHoldings(nba.map((m) => ({ key: m.key, tier: "common" })), nba, OTD_RULES).sports.nba!.used).toBe(5 * 80);
  });

  it("a third pass of a season already held twice is credited with what it really adds", () => {
    const held = OF("nfl", 2025, 2);
    const third = OF("nfl", 2025, 3)[2]!;
    const picks = nextBest(held.map((m) => ({ key: m.key, tier: "epic" })), [...held, third], OTD_RULES, { n: 1, today: "2026-11-17" });
    expect(picks).toHaveLength(1);
    expect(picks[0]!.market.key).toBe(third.key);
    // Not its whole year: on the shared days it plays on, the two held already take the day's claims (the third wins
    // its own where it pays more than they do, and takes theirs: only what it adds counts).
    expect(picks[0]!.gain).toBeLessThan(0.95 * picks[0]!.rung.year_rax);
    expect(picks[0]!.gain).toBeGreaterThan(0.3 * picks[0]!.rung.year_rax);
  });
});

// Golf (the internal research notes): a season's tournaments end on the same 41 to 45 Sundays for everyone,
// and a regular player is paid on about 20 of them. Measured on the per-date pay of 12 seasons (2014-2025).
describe("golf: a season's passes are paid on the same tournament dates", () => {
  // What the top k golfers of one season pay together, in passes' worth of a year (their Rax with 2 claims a day over
  // their Rax alone, times k; no limit, as Iconic): the mean of the 12 seasons, replayed on the real dates.
  const MEASURED: Record<number, number> = { 3: 2.7, 4: 3.2, 5: 3.57, 6: 3.93, 8: 4.36, 10: 4.73 };
  // The same for the top k of each of two seasons with the same weekdays (2014 and 2025, 2017 and 2023, 2019 and 2024,
  // 2016 and 2022, 2015 and 2020): the mean of those five pairs.
  const TWINS: Record<number, number> = { 2: 3.43, 3: 4.37, 5: 5.53 };
  const OF = (season: number, n: number) =>
    Array.from({ length: n }, (_, i) =>
      market({
        key: `golf:${season}:player:${season * 100 + i}`, sport: "golf", season, season_label: String(season), player_id: season * 100 + i,
        player_name: `G${season}-${i}`, team_id: null, base_1x: 300, game_days: 20, month_share: Array.from({ length: 12 }, () => 1 / 12),
      }),
    );
  const hold = (markets: PassBasis[], rules = OTD_RULES) =>
    planHoldings(markets.map((m) => ({ key: m.key, tier: "iconic" })), markets, rules).sports.golf!;
  const alone = hold(OF(2024, 1)).total;

  it("two passes of one season are both paid in full: 2 claims a day", () => {
    expect(hold(OF(2024, 2)).total).toBeCloseTo(2 * alone, 6);
  });

  it("three to ten passes of one season win what the tournament dates say, within 12 %", () => {
    for (const [k, units] of Object.entries(MEASURED)) {
      const got = hold(OF(2024, Number(k))).total / alone;
      expect([k, got >= units * 0.88 && got <= units * 1.12]).toEqual([k, true]);
    }
  });

  it("seasons with other weekdays share no dates: 2018 and 2021 pay as two seasons apart", () => {
    expect(hold([...OF(2018, 3), ...OF(2021, 3)]).total).toBeCloseTo(hold(OF(2018, 3)).total + hold(OF(2021, 3)).total, 6);
  });

  it("seasons with the same weekdays replay the same Sundays: 2019 with 2024 win what the dates say, within 12 %", () => {
    for (const [k, units] of Object.entries(TWINS)) {
      const got = hold([...OF(2019, Number(k)), ...OF(2024, Number(k))]).total / alone;
      expect([k, got >= units * 0.88 && got <= units * 1.12]).toEqual([k, true]);
    }
    // 2015, 2020 and 2026 are three such seasons.
    const three = hold([...OF(2015, 2), ...OF(2020, 2), ...OF(2026, 2)]).total / alone;
    expect(three).toBeLessThan(5.5);
    expect(three).toBeGreaterThan(3.5);
  });

  it("the sport's days are those of the seasons held, a shared day counted once", () => {
    expect(hold(OF(2024, 3)).claim_days).toBe(180);
    expect(hold([...OF(2018, 1), ...OF(2021, 1)]).claim_days).toBe(360);
    const twins = hold([...OF(2019, 1), ...OF(2024, 1)]);
    expect(twins.claim_days).toBeGreaterThan(180);
    expect(twins.claim_days).toBeLessThan(360);
    expect(twins.slots).toBe(2 * twins.claim_days);
  });

  it("a payload without golf's days (an older one) spreads golf evenly, as before", () => {
    const { same_weekdays: _s, ...rest } = OTD_RULES;
    const older = { ...rest, weekly_days: { nfl: OTD_RULES.weekly_days!.nfl!, cfb: OTD_RULES.weekly_days!.cfb! } };
    expect(hold(OF(2024, 3), older).total).toBeCloseTo(3 * alone, -2); // 20 days each over 180: hardly ever 3 on a day
  });
});

describe("when it pays", () => {
  it("spreads a season over its months from today's, and stops at the limit", () => {
    const flat = caseNamed("past_general_is_no_rung");
    const m = flat.market;
    const common = rungs(m, OTD_RULES, ruleOf(flat))[0]!;
    const bars = monthBars(m, common, OTD_RULES, flat.today);
    expect(bars.months).toEqual([11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(bars.pay.reduce((a, b) => a + b, 0)).toBeCloseTo(common.year_rax, 6);
    expect(bars.payback_index).toBe(5); // April, as its payback month says
  });

  it("an NBA season pays nothing in July to September", () => {
    const c = caseNamed("nba_bought_in_november");
    const ladder = rungs(c.market, OTD_RULES, ruleOf(c));
    const bars = monthBars(c.market, ladder[1]!, OTD_RULES, c.today);
    expect(bars.quiet).toBe("nothing Jul–Sep");
  });
});
