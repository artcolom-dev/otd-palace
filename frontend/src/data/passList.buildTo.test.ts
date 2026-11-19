// "Build to" a rarity: every pass priced at that one rung, ranked by Rax a year per Rax spent, and the passes that
// cannot be built to it or do not pay back at it set apart with why.
import { describe, expect, it } from "vitest";
import type { Owned } from "../lib/owned";
import { buildRate } from "../lib/passRates";
import { toBasis } from "../lib/passes";
import { OTD_RULES } from "../test/fixtures";
import { CHASE, JOKIC, MACKINNON, MCDAVID, MURRAY, OLIVEIRA, PASS_MARKETS, SGA, THUNDER, otdOf, passSnapshot, served } from "../test/passScene";
import type { PassMarket } from "./types";
import { BUILD_TO_TIERS, type PassFilters, buildToRank, passList } from "./passList";

const snap = passSnapshot();
const base: PassFilters = {
  level: "pro", budget: null, sport: "all", season: "all", soon: false, showAll: false, sort: "soon", query: "",
};
const keys = (rows: { market: { key: string } }[]) => rows.map((r) => r.market.key);
const at = (m: PassMarket, tier: string) => m.rungs.find((r) => r.tier === tier)!;

describe("the Build to rarities", () => {
  it("are Common to Iconic, Real's names in Real's order", () => {
    expect(BUILD_TO_TIERS).toEqual(["common", "uncommon", "rare", "epic", "legendary", "mystic", "iconic"]);
  });
});

describe("a list built to one rarity", () => {
  it("prices every pass at that rung, the server's own figures", () => {
    const list = passList(snap, { ...base, buildTo: "legendary" });
    expect(list.rows.length).toBeGreaterThan(0);
    for (const row of list.rows) {
      expect(row.rung).toEqual(at(row.market, "legendary"));
      expect(row.kind).toBe("row");
    }
    for (const row of list.out!) expect(row.rung.tier).toBe("legendary");
  });

  it("ranks by Rax a year per Rax spent, whatever the sort chosen", () => {
    for (const sort of ["soon", "cheap", "year", "ret"] as const) {
      const list = passList(snap, { ...base, sort, buildTo: "rare" });
      const ret = list.rows.map((r) => r.rung.year_per_rax!);
      expect([...ret].sort((a, b) => b - a)).toEqual(ret);
    }
  });

  it("reprices when the rarity changes: Common and Legendary cost what their rungs cost", () => {
    const common = passList(snap, { ...base, buildTo: "common" }).rows.find((r) => r.market.key === MACKINNON.key)!;
    const legendary = passList(snap, { ...base, buildTo: "legendary" }).rows.find((r) => r.market.key === MACKINNON.key)!;
    expect(common.rung.cost).toBe(at(MACKINNON, "common").cost);
    expect(legendary.rung.cost).toBe(at(MACKINNON, "legendary").cost);
    expect(legendary.rung.cost).toBeGreaterThan(common.rung.cost!);
    expect(legendary.rung.year_rax).toBeGreaterThan(common.rung.year_rax);
  });

  it("takes every pass of the snapshot, not only the best-for-each picks, at most the tab's few per sport", () => {
    // Jokić's teammate Murray is a pick, but a pass that is not a pick today is still priced at the rarity.
    const notPicked = served({ ...toBasis(MURRAY), key: "nba:2024:player:1002", season: 2024, season_label: "2023-24" });
    const markets = [...PASS_MARKETS, notPicked];
    const otd = otdOf(markets);
    const s = passSnapshot({ otd: { ...otd, picks: { ...otd.picks, nba: otd.picks.nba!.filter((k) => k !== notPicked.key) } } });
    const list = passList(s, { ...base, buildTo: "common" });
    expect(keys([...list.rows, ...list.out!])).toContain(notPicked.key);
    const capped = passList(passSnapshot({ rules: { ...snap.rules, otd: { ...OTD_RULES, top: 1 } } }), { ...base, buildTo: "common" });
    const bySport = new Map<string, number>();
    for (const r of capped.rows) bySport.set(r.market.sport, (bySport.get(r.market.sport) ?? 0) + 1);
    expect([...bySport.values()].every((n) => n === 1)).toBe(true);
    expect(capped.counts.all).toBe(capped.rows.length);
  });

  it("sets apart, with why, a pass that never pays back at the rarity, and a team pass stays with the teams", () => {
    const list = passList(snap, { ...base, buildTo: "legendary" });
    const oliveira = list.out!.find((r) => r.market.key === OLIVEIRA.key)!;
    expect(oliveira.why).toBe("never");
    expect(keys(list.rows)).not.toContain(OLIVEIRA.key);
    expect(list.never).toEqual([]);
    expect(keys(list.teams)).toEqual([THUNDER.key]);
    expect(list.teams[0]!.rung.tier).toBe("legendary");
  });

  it("a pass over the budget at that rarity reads over budget, set apart, not hidden", () => {
    const list = passList(snap, { ...base, budget: 1000, buildTo: "legendary" }); // MacKinnon's Legendary costs 2,290
    const mac = list.out!.find((r) => r.market.key === MACKINNON.key)!;
    expect(mac.why).toBe("over");
    expect(list.hidden.over).toBe(0);
  });

  it("orders the set-apart passes over budget first, then never, then unpriced, each by Rax a year per Rax", () => {
    const list = passList(snap, { ...base, budget: 1000, buildTo: "legendary" });
    const order = ["over", "never", "even", "unpriced", "none"];
    const whys = list.out!.map((r) => order.indexOf(r.why!));
    expect([...whys].sort((a, b) => a - b)).toEqual(whys);
  });

  it("a pass with no price at the rarity is set apart as unpriced, one whose cards never trade as none", () => {
    const unpriced = served({ ...toBasis(SGA), rate_traded: null, rate_sales: 0, shelf_count: 1, shelf: [[5, 400]] });
    const dead = served({ ...toBasis(JOKIC), rate_sales: 0, shelf_count: 0, shelf: [] });
    const markets = PASS_MARKETS.map((m) => (m.key === SGA.key ? unpriced : m.key === JOKIC.key ? dead : m));
    const list = passList(passSnapshot({ otd: otdOf(markets) }), { ...base, buildTo: "rare" });
    expect(list.out!.find((r) => r.market.key === SGA.key)?.why).toBe("unpriced");
    expect(list.out!.find((r) => r.market.key === JOKIC.key)?.why).toBe("none");
  });

  it("keeps the season, sport and search filters, and New's year rule and the 3-week toggle as hidden counts", () => {
    const past = passList(snap, { ...base, season: "past", buildTo: "common" });
    expect(keys(past.rows)).not.toContain(CHASE.key);
    const nhl = passList(snap, { ...base, sport: "nhl", buildTo: "common" });
    expect(new Set(nhl.rows.map((r) => r.market.sport))).toEqual(new Set(["nhl"]));
    expect(nhl.counts.nba).toBeGreaterThan(0); // the sport tabs still count every sport
    const q = passList(snap, { ...base, query: "mcdav", buildTo: "common" });
    expect(keys(q.rows)).toEqual([MCDAVID.key]);
    const iconicNew = passList(snap, { ...base, level: "new", buildTo: "iconic" });
    expect(iconicNew.rows.every((r) => (r.rung.payback_months ?? Infinity) <= 12)).toBe(true);
  });

  it("a pass held lower is priced as the lift from it; one held at the rarity or higher is owned", () => {
    const owned = new Map<string, Owned>([
      [MACKINNON.key, { tier: "rare", index: 3, rating: 80, mult: 4, cap: null, earned: 0, liftUnknown: false }],
      [JOKIC.key, { tier: "mystic", index: 6, rating: 1380, mult: 75, cap: null, earned: 0, liftUnknown: false }],
    ]);
    const list = passList(snap, { ...base, owned, buildTo: "legendary" });
    const mac = [...list.rows, ...list.out!].find((r) => r.market.key === MACKINNON.key)!;
    expect(mac.held).toBe("rare");
    expect(mac.rung.rating_to_add).toBe(300); // 380 - 80
    expect(mac.rung.cost!).toBeLessThan(at(MACKINNON, "legendary").cost!);
    const jokic = list.rows.find((r) => r.market.key === JOKIC.key)!;
    expect(jokic.owned).toBe("mystic");
    expect(list.top?.market.key).not.toBe(JOKIC.key);
    expect(list.top?.market.key).not.toBe(MACKINNON.key);
  });

  it("the top pick is the first pass not held of the ranked list", () => {
    const list = passList(snap, { ...base, buildTo: "epic" });
    expect(list.top).toBe(list.rows[0]);
    const held = passList(snap, { ...base, held: new Set([list.rows[0]!.market.key]), buildTo: "epic" });
    expect(held.top?.market.key).toBe(list.rows[1]!.market.key);
  });

  it("Best for each (no rarity) is the list of before, untouched", () => {
    for (const buildTo of [undefined, null]) {
      expect(passList(snap, { ...base, buildTo })).toEqual(passList(snap, base));
    }
  });
});

describe("certainty", () => {
  const thin = served({ ...toBasis(MCDAVID), rate_build: null, rate_bucket: "7+" });
  it("a thin pass is marked, a pass on a build rate or an old row is not", () => {
    expect(buildRate(thin).thin).toBe(true);
    const list = passList(passSnapshot({ otd: otdOf(PASS_MARKETS.map((m) => (m.key === MCDAVID.key ? thin : m))) }), { ...base, buildTo: "rare" });
    expect(list.rows.find((r) => r.market.key === MCDAVID.key)?.thin).toBe(true);
    expect(list.rows.filter((r) => r.market.key !== MCDAVID.key).every((r) => !r.thin)).toBe(true);
  });

  it("puts a certain pass ahead of a thin one only when their keys tie", () => {
    const row = (m: PassMarket, ypr: number, yr: number, isThin: boolean) => ({
      market: m, kind: "row" as const, thin: isThin, rung: { ...at(m, "rare"), year_per_rax: ypr, year_rax: yr },
    });
    // Tied on Rax a year per Rax and Rax a year: the certain one first, though its id is the bigger.
    expect(buildToRank(row(MACKINNON, 0.5, 1000, true), row(MCDAVID, 0.5, 1000, false))).toBeGreaterThan(0);
    // Not tied: the pay per Rax order stands, thin or not.
    expect(buildToRank(row(MACKINNON, 0.6, 1000, true), row(MCDAVID, 0.5, 1000, false))).toBeLessThan(0);
    expect(buildToRank(row(MACKINNON, 0.5, 1200, true), row(MCDAVID, 0.5, 1000, false))).toBeLessThan(0);
  });
});
