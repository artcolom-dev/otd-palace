// This season's passes (season_state "current"): the feed sends one for each player with a deal, and the server serves
// them apart, in otd.current_markets (advisor/snapshot.py _otd_json). They feed Deals (a deal's pass line, "Pass deals",
// the "For passes" sort) and the valuing of a pass the visitor holds; they are never a suggestion on the Passes tab.
import { describe, expect, it } from "vitest";
import { passList, starterPick } from "../data/passList";
import type { PassMarket, Snapshot } from "../data/types";
import { OTD_RULES, makeDeal, makeSnapshot } from "../test/fixtures";
import { CHASE, JOKIC, PASS_MARKETS, TODAY, WEMBANYAMA, served, servedOtd } from "../test/passScene";
import { heldSiteMarkets } from "../hooks/useHeldMarkets";
import { passRoute } from "./budget";
import { dealPass, dealPassMarket, passMarketIndex, passSortValue, servedMarkets } from "./dealPass";
import { firstGoalPick } from "./firstGoal";
import { nextRax } from "./nextRax";
import { passDeals } from "./passDeals";
import { toBasis } from "./passes";

// Chase's season being played, with cards on sale under its usual 12 a point.
const CHASE_CHEAP: PassMarket = served({ ...toBasis(CHASE), shelf: [[6, 30], [5, 25]], shelf_count: 2 });
const snapOf = (markets: PassMarket[]): Snapshot => makeSnapshot({ sports: ["nba", "nhl", "nfl"], otd: servedOtd(markets) });
const SNAP = snapOf([...PASS_MARKETS.filter((m) => m !== CHASE), CHASE_CHEAP, WEMBANYAMA]);
const CURRENT = new Set([CHASE.key, WEMBANYAMA.key]);
const chaseCard = makeDeal({ sport: "nfl", season: 2026, player_id: 2001, player_name: "Ja'Marr Chase", rating: 6, price: 30, per_point: 5 });

describe("the served otd", () => {
  it("holds this season's passes apart from the past seasons", () => {
    expect(SNAP.otd.markets.some((m) => CURRENT.has(m.key))).toBe(false);
    expect(SNAP.otd.current_markets!.map((m) => m.key).sort()).toEqual([...CURRENT].sort());
    expect(servedMarkets(SNAP.otd).map((m) => m.key)).toEqual([...SNAP.otd.markets, ...SNAP.otd.current_markets!].map((m) => m.key));
    expect(servedMarkets({ markets: [JOKIC] }).map((m) => m.key)).toEqual([JOKIC.key]); // the free site, an older server
  });
});

describe("Deals reads them", () => {
  it("a deal's pass line finds the card's pass of this season", () => {
    const market = dealPassMarket(chaseCard, passMarketIndex(servedMarkets(SNAP.otd)));
    expect(market?.key).toBe(CHASE.key);
    expect(dealPass(chaseCard, market!, OTD_RULES, TODAY)).not.toBeNull();
  });

  it("the For passes sort values a deal on this season's pass", () => {
    const value = passSortValue(SNAP)(chaseCard);
    expect(value).not.toBeNull();
    expect(value).toBeCloseTo(dealPass(chaseCard, CHASE_CHEAP, OTD_RULES, TODAY)!.year_per_rax!);
  });

  it("Pass deals lists this season's pass when its cards on sale build it for less", () => {
    const list = passDeals(SNAP.otd, OTD_RULES, { level: "pro", sport: "all", budget: null, held: new Set() });
    expect(list.map((d) => d.market.key)).toContain(CHASE.key);
  });
});

describe("a pass the visitor holds is valued with it", () => {
  it("this season's pass held comes with the site's markets; one not held does not", () => {
    const holdings = [{ key: CHASE.key, tier: "common" }];
    const held = heldSiteMarkets(SNAP.otd, holdings);
    expect(held.map((m) => m.key)).toContain(CHASE.key);
    expect(held.map((m) => m.key)).not.toContain(WEMBANYAMA.key);
    expect(heldSiteMarkets(SNAP.otd, holdings)).toBe(held); // the same array for the same inputs
    expect(heldSiteMarkets(SNAP.otd, [])).toBe(SNAP.otd.markets);
  });
});

describe("the Passes tab never suggests them", () => {
  it("not in the list, the starter or the first goal", () => {
    const list = passList(SNAP, { level: "pro", sport: "all", season: "all", budget: null, query: "", soon: false, showAll: true, sort: "soon" });
    expect([...list.rows, ...list.never, ...list.teams].some((r) => CURRENT.has(r.market.key))).toBe(false);
    expect(CURRENT.has(starterPick(SNAP, new Set())?.market.key ?? "")).toBe(false);
    expect(CURRENT.has(firstGoalPick(SNAP)?.market.key ?? "")).toBe(false);
  });

  it("not in the budget buddy's route nor in Today's moves", () => {
    const route = passRoute(SNAP.otd, OTD_RULES, 100_000, { level: "pro" });
    expect(route.picks.length).toBeGreaterThan(0);
    expect(route.picks.some((p) => CURRENT.has(p.market.key))).toBe(false);
    const input = { holdings: [], level: "pro" as const, budget: null, passBudget: null, balance: 100_000, now: Date.parse(SNAP.generated_at), paused: false, n: 50 };
    const moves = nextRax(SNAP, input).moves;
    expect(moves.some((m) => m.kind === "slot")).toBe(true);
    expect(moves.some((m) => [...CURRENT].some((key) => m.key.includes(key)))).toBe(false);
  });
});
