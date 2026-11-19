// Deals by rarity: the filter (one rarity, or "and rarer"), the strip's counts under every other filter, the
// "Rarest first" sort, and a card of unknown rarity (shown under All, counted under no rarity).
import { describe, expect, it } from "vitest";
import { LEVELS, makeDeal, makeGone, makeSnapshot } from "../test/fixtures";
import { rarityCounts, sortDeals, sortLabel, sortsFor, visibleDeals, visibleGone } from "./deals";
import { filterDeals, filterGone, fitsRarity } from "./filters";
import type { Prefs } from "./prefs";
import type { Deal } from "./types";

const NOW = Date.parse("2026-11-12T18:00:00Z");
const PRO: Prefs = { sport: "all", budget: null, level: "pro", sort: "best", tab: "deals", passBudget: null };
const none = new Set<string>();

const deal = (listing_id: number, rarity: number, over: Partial<Deal> = {}) =>
  makeDeal({ now: NOW, listing_id, player_id: 100 + listing_id, rarity, ...over });

// Two Legendary, one Epic, one Iconic, one General, one of unknown rarity (the page only trusts 0..7).
const DEALS = [
  deal(1, 5), deal(2, 5, { sport: "nfl", price: 900 }), deal(3, 4), deal(4, 7, { flip_margin: 10 }), deal(5, 0),
  deal(6, 11), deal(7, Number.NaN),
];
const snap = makeSnapshot({ deals: DEALS, sports: ["nba", "nfl"] });
const ids = (rows: { listing_id: number }[]) => rows.map((r) => r.listing_id);

describe("fitsRarity", () => {
  it("lets every deal through with no rarity chosen, unknown ones included", () => {
    for (const d of DEALS) {
      expect(fitsRarity(d, {})).toBe(true);
      expect(fitsRarity(d, { rarity: null, rarer: true })).toBe(true);
    }
  });

  it("keeps only that rarity, or that rarity and every rarer one with 'and rarer'", () => {
    expect(DEALS.filter((d) => fitsRarity(d, { rarity: 5 })).map((d) => d.listing_id)).toEqual([1, 2]);
    expect(DEALS.filter((d) => fitsRarity(d, { rarity: 5, rarer: true })).map((d) => d.listing_id)).toEqual([1, 2, 4]);
    expect(DEALS.filter((d) => fitsRarity(d, { rarity: 0, rarer: true })).map((d) => d.listing_id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("never matches a card whose rarity is not one of Real's eight", () => {
    expect(fitsRarity(deal(9, 11), { rarity: 7, rarer: true })).toBe(false);
    expect(fitsRarity(deal(9, -1), { rarity: 0, rarer: true })).toBe(false);
    expect(fitsRarity(deal(9, 2.5), { rarity: 2, rarer: true })).toBe(false);
  });

  it("reads a chosen rarity that is not one of Real's eight as every rarity", () => {
    expect(fitsRarity(deal(9, 3), { rarity: 9 })).toBe(true);
  });
});

describe("the rarity filter on the deals and on the deals that went away", () => {
  it("narrows the live list along with the level, budget and sport", () => {
    expect(ids(filterDeals(DEALS, { ...PRO, rarity: 5 }, LEVELS, NOW))).toEqual([1, 2]);
    expect(ids(filterDeals(DEALS, { ...PRO, rarity: 5, sport: "nfl" }, LEVELS, NOW))).toEqual([2]);
    expect(ids(filterDeals(DEALS, { ...PRO, rarity: 5, budget: 500 }, LEVELS, NOW))).toEqual([1]);
    expect(ids(filterDeals(DEALS, { ...PRO, rarity: 4, rarer: true }, LEVELS, NOW))).toEqual([1, 2, 3, 4]);
    expect(ids(filterDeals(DEALS, PRO, LEVELS, NOW))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("narrows the gone rows the same way", () => {
    const gone = [makeGone({ now: NOW, listing_id: 20, rarity: 5 }), makeGone({ now: NOW, listing_id: 21, rarity: 2 })];
    expect(ids(filterGone(gone, { ...PRO, rarity: 5 }, LEVELS))).toEqual([20]);
    expect(ids(filterGone(gone, { ...PRO, rarity: 2, rarer: true }, LEVELS))).toEqual([20, 21]);
    expect(ids(visibleGone({ ...snap, gone }, { ...PRO, rarity: 2 }, none, none))).toEqual([21]);
  });

  it("goes through visibleDeals with the search and My players", () => {
    const follows = new Set(["nba:101"]);
    expect(ids(visibleDeals(snap, { ...PRO, rarity: 5, sport: "mine" }, follows, NOW))).toEqual([1]);
    expect(ids(visibleDeals(snap, { ...PRO, rarity: 4 }, none, NOW, "nobody"))).toEqual([]);
  });
});

describe("rarityCounts", () => {
  it("counts each rarity under the current filters, whatever rarity is chosen", () => {
    const counts = rarityCounts(snap, { ...PRO, rarity: 7 }, none, NOW);
    expect(counts.byRarity).toEqual([1, 0, 0, 0, 1, 2, 0, 1]);
    expect(counts.all).toBe(7); // the unknown two show under All and count under no rarity
  });

  it("follows the sport, the budget and the level", () => {
    expect(rarityCounts(snap, { ...PRO, sport: "nfl" }, none, NOW).byRarity).toEqual([0, 0, 0, 0, 0, 1, 0, 0]);
    expect(rarityCounts(snap, { ...PRO, budget: 500 }, none, NOW).byRarity).toEqual([1, 0, 0, 0, 1, 1, 0, 1]);
    const medium = makeSnapshot({ deals: [deal(1, 5, { confidence: "medium" }), deal(2, 5)] });
    expect(rarityCounts(medium, { ...PRO, level: "new" }, none, NOW).byRarity[5]).toBe(1);
    expect(rarityCounts(medium, PRO, none, NOW).byRarity[5]).toBe(2);
  });

  it("follows My players, the search and the rows shown elsewhere (Today's top three)", () => {
    expect(rarityCounts(snap, { ...PRO, sport: "mine" }, new Set(["nfl:102"]), NOW).byRarity[5]).toBe(1);
    const named = makeSnapshot({ deals: [deal(1, 5, { player_name: "Nikola Jokić" }), deal(2, 5)] });
    expect(rarityCounts(named, PRO, none, NOW, none, "jokic").byRarity[5]).toBe(1);
    expect(rarityCounts(snap, PRO, none, NOW, new Set(["1:target"])).byRarity[5]).toBe(1);
  });

  it("is zero for every rarity when nothing fits, with all eight still there", () => {
    const counts = rarityCounts(snap, { ...PRO, sport: "mlb" }, none, NOW);
    expect(counts.byRarity).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(counts.all).toBe(0);
  });
});

describe("Rarest first", () => {
  it("is offered at every level, after the % under, as 'Rarest first'", () => {
    for (const level of ["new", "regular", "pro"] as const) expect(sortsFor(level)).toContain("rarest");
    expect(sortLabel("rarest", "new")).toBe("Rarest first");
  });

  it("puts the rarest deals first, the best after fees first within a rarity, unknown rarities last", () => {
    const rows = [deal(1, 5, { flip_margin: 20 }), deal(2, 11), deal(3, 7), deal(4, 5, { flip_margin: 90 }), deal(5, 0)];
    expect(ids(sortDeals(rows, "rarest", none))).toEqual([3, 4, 1, 5, 2]);
  });

  it("still pins starred players first", () => {
    const rows = [deal(1, 7), deal(2, 1)];
    expect(ids(sortDeals(rows, "rarest", new Set(["nba:102"])))).toEqual([2, 1]);
  });
});
