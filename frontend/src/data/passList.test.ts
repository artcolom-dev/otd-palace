import { describe, expect, it } from "vitest";
import { CHASE, JOKIC, JUDGE, MACKINNON, MCDAVID, MURRAY, OLIVEIRA, PASS_MARKETS, SGA, THUNDER, otdOf, passSnapshot } from "../test/passScene";
import { type PassFilters, buildable, defaultSeason, passList, saleFor, shownRung, starterPick, teammatesOf } from "./passList";

const snap = passSnapshot();
const base: PassFilters = {
  level: "regular", budget: 5000, sport: "all", season: "all", soon: false, showAll: false, sort: "soon", query: "",
};
const keys = (rows: { market: { key: string } }[]) => rows.map((r) => r.market.key);

describe("the rung a pass shows", () => {
  it("is the engine's best within the budget, never one that only breaks even", () => {
    expect(shownRung(MACKINNON, null)).toMatchObject({ kind: "row", rung: { tier: "legendary" } });
    // Legendary costs 2,290: at 1,000 the best that fits is Uncommon (Epic costs 1,190).
    expect(shownRung(MACKINNON, 1000)).toMatchObject({ kind: "row", rung: { tier: "uncommon" } });
    // A past season's General pays nothing On This Day: Common, the mint and its 10 rating, is the way in.
    expect(shownRung(SGA, 5000)).toMatchObject({ kind: "row", rung: { tier: "common", route: "mint+cards" } });
  });

  it("a pass none of whose rarities pays back shows the one closest to it", () => {
    expect(shownRung(OLIVEIRA, null)).toMatchObject({ kind: "never", rung: { tier: "uncommon" } }); // the best limit for its cost
  });

  it("a team pass shows its first card-built rarity, its cost unknown", () => {
    expect(shownRung(THUNDER, null)).toMatchObject({ kind: "team", rung: { tier: "common", cost: null, pays_back: null } });
  });

  it("over the budget at every rarity that pays back", () => {
    expect(shownRung(MCDAVID, 100).kind).toBe("over");
  });
});

describe("the ranked passes", () => {
  it("can rank the picks by Rax a year per Rax spent, teams apart and the never-paying ones hidden", () => {
    const list = passList(snap, { ...base, sort: "ret" });
    const ret = list.rows.map((r) => r.rung.year_per_rax!);
    expect([...ret].sort((a, b) => b - a)).toEqual(ret);
    expect(list.top?.market.key).toBe(MACKINNON.key);
    expect(keys(list.teams)).toEqual([THUNDER.key]);
    expect(list.never).toEqual([]);
    expect(list.hidden.never).toBe(1);
    expect(keys(list.rows)).not.toContain(OLIVEIRA.key);
  });

  it("never makes a pass already held the top pick: the next best takes its place, the list keeps it", () => {
    const all = passList(snap, base);
    const held = passList(snap, { ...base, held: new Set([MACKINNON.key]) });
    expect(held.top?.market.key).not.toBe(MACKINNON.key);
    expect(held.top?.market.key).toBe(all.rows.find((r) => r.market.key !== MACKINNON.key)!.market.key);
    expect(keys(held.rows)).toContain(MACKINNON.key);
    expect(held.candidates).toBe(all.candidates - 1);
    expect(passList(snap, { ...base, held: new Set(keys(all.rows)) }).top).toBeNull();
  });

  it("Show all reveals the passes that never pay back", () => {
    const list = passList(snap, { ...base, showAll: true });
    expect(keys(list.never)).toEqual([OLIVEIRA.key]);
    expect(list.hidden.never).toBe(0);
  });

  it("filters by sport, season and name, and counts each sport's passes", () => {
    expect(keys(passList(snap, { ...base, sport: "nhl" }).rows).sort()).toEqual([MACKINNON.key, MCDAVID.key].sort());
    expect(keys(passList(snap, { ...base, season: "current" }).rows)).toEqual([CHASE.key]);
    expect(keys(passList(snap, { ...base, season: "past" }).rows)).not.toContain(CHASE.key);
    expect(keys(passList(snap, { ...base, query: "jokic" }).rows)).toEqual([JOKIC.key]);
    const { counts } = passList(snap, base);
    expect(counts).toMatchObject({ all: 6, nba: 3, nhl: 2, nfl: 1 });
    expect(counts.ufc ?? 0).toBe(0);
  });

  it("sorts by soonest payback, cheapest and most a year", () => {
    const soon = passList(snap, { ...base, sort: "soon" }).rows.map((r) => r.rung.payback_months!);
    expect([...soon].sort((a, b) => a - b)).toEqual(soon);
    const cheap = passList(snap, { ...base, sort: "cheap" }).rows.map((r) => r.rung.cost!);
    expect([...cheap].sort((a, b) => a - b)).toEqual(cheap);
    const year = passList(snap, { ...base, sort: "year" }).rows.map((r) => r.rung.year_rax);
    expect([...year].sort((a, b) => b - a)).toEqual(year);
  });

  it("the budget changes the rarity shown, and counts what it hides", () => {
    const list = passList(snap, { ...base, budget: 1000 });
    expect(list.rows.find((r) => r.market.key === MACKINNON.key)?.rung.tier).toBe("uncommon");
    expect(list.rows.every((r) => r.rung.cost! <= 1000)).toBe(true);
    expect(passList(snap, { ...base, budget: 100 }).hidden.over).toBe(6);
  });

  it("can be built within 3 weeks: only passes whose rating is on sale now (a mint needs no card)", () => {
    const list = passList(snap, { ...base, soon: true });
    expect(keys(list.rows).sort()).toEqual([JOKIC.key, MACKINNON.key, MCDAVID.key].sort());
    expect(list.hidden.notSoon).toBe(3);
    expect(keys(list.rows)).not.toContain(MURRAY.key);
    // A season being played still has a General, the mint alone: nothing to find on the shelf.
    const general = CHASE.rungs.find((r) => r.tier === "general")!;
    expect(general.route).toBe("mint");
    expect(buildable(CHASE, general, snap.rules.otd)).toBe(true);
  });

  it("New: past seasons by default, and what takes more than a year to pay back is left out", () => {
    expect(defaultSeason("new")).toBe("past");
    expect(defaultSeason("regular")).toBe("all");
    const slow = passList(snap, { ...base, level: "new", season: "past", budget: null });
    expect(slow.rows.every((r) => r.rung.payback_months! <= 12)).toBe(true);
  });

  it("ranks by payback from today by default, so a pass whose season is months away is not the top pick", () => {
    // 16 November-like: the MLB pass pays the most a year per Rax, but nothing until March.
    const withMlb = passSnapshot({ sports: ["nba", "nhl", "nfl", "mlb"], otd: otdOf([...PASS_MARKETS, JUDGE]) });
    expect(passList(withMlb, { ...base, sort: "ret" }).rows[0]!.market.key).toBe(JUDGE.key);
    const list = passList(withMlb, base);
    const soon = list.rows.map((r) => r.rung.payback_months!);
    expect([...soon].sort((a, b) => a - b)).toEqual(soon);
    expect(list.top?.market.key).toBe(MACKINNON.key);
    expect(list.rows[0]!.market.key).not.toBe(JUDGE.key);
  });

  it("no top pick when nothing fits", () => {
    expect(passList(snap, { ...base, query: "nobody" }).top).toBeNull();
  });
});

describe("around the list", () => {
  it("the cheapest way to start: the best Common or Uncommon entry in a sport not held, never a projection", () => {
    expect(starterPick(snap, new Set())).toMatchObject({ market: { key: MACKINNON.key } });
    const nba = starterPick(snap, new Set(["nhl"]))!;
    expect(nba.market.key).toBe(JOKIC.key);
    expect(["common", "uncommon"]).toContain(nba.rung.tier);
    // NFL's only pass is a season in progress: a projection is no way to start.
    expect(starterPick(snap, new Set(["nhl", "nba"]))).toBeNull();
  });

  it("what is on sale toward a rung: the server's figure for the best rung, counted here for the others", () => {
    const best = MACKINNON.rungs.find((r) => r.tier === MACKINNON.best)!;
    expect(saleFor(MACKINNON, best, snap.rules.otd)).toMatchObject(MACKINNON.on_sale!);
    const common = MACKINNON.rungs.find((r) => r.tier === "common")!;
    const sale = saleFor(MACKINNON, common, snap.rules.otd);
    expect(sale.enough).toBe(true);
    expect(sale.on_sale_rating).toBeGreaterThanOrEqual(common.rating_to_add);
  });

  it("teammates are the passes of the same team, season and ladder", () => {
    expect(teammatesOf(JOKIC, snap.otd.markets).map((m) => m.key)).toEqual([MURRAY.key]);
    expect(teammatesOf(THUNDER, snap.otd.markets)).toEqual([]);
    expect(teammatesOf(MCDAVID, snap.otd.markets)).toEqual([]);
  });
});
