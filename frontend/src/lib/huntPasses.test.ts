// Bugs found hunting the passes domain: each test failed before its fix.
import { describe, expect, it } from "vitest";
import type { PassMarket, PassSport } from "../data/types";
import { OTD_RULES } from "../test/fixtures";
import { TODAY, served } from "../test/passScene";
import { type Holding, planHoldings } from "./passes";

const FLAT = Array.from({ length: 12 }, (_, i) => ([10, 11, 12, 1, 2, 3, 4, 5, 6].includes(i + 1) ? 1 / 9 : 0));
const market = (id: number, base: number, over: Partial<PassMarket> = {}): PassMarket =>
  served({
    key: `nba:2024:player:${id}`, sport: "nba", season: 2024, season_label: "2024", season_state: "past", player_id: id,
    player_name: `P${id}`, team_id: null, position: null, kind: "player", base_1x: base, season_progress: 1, game_days: 1,
    game_days_measured: true, month_share: FLAT, rate_traded: 5, rate_sales: 9, shelf: [], shelf_count: 0, mint_cost: 200,
    mintable: true, ...over,
  }, TODAY);
const ONE_DAY: Record<string, PassSport> = { nba: { claim_days: 1, months: [10] } as PassSport };

describe("a day's claims go to the passes that pay most that day", () => {
  it("a pass nearly at its cap, which pays a little that day, does not displace a full claim: adding a pass never lowers the total", () => {
    const markets = [market(1, 100), market(2, 100), market(3, 100), market(4, 1000)];
    const mine: Holding[] = [{ key: markets[0]!.key, tier: "rare" }, { key: markets[1]!.key, tier: "rare" }, { key: markets[2]!.key, tier: "rare" }];
    const before = planHoldings(mine, markets, OTD_RULES, ONE_DAY).total;
    const nearCap: Holding = { key: markets[3]!.key, tier: "rare", cap: 10, earned: 0 };
    const after = planHoldings([...mine, nearCap], markets, OTD_RULES, ONE_DAY).total;
    expect(after).toBeGreaterThanOrEqual(before - 1e-9);
  });
});

describe("a lift in the Passes list counts what the pass has earned, as the plan does", () => {
  it("a past pass nearly at its cap lifts for what the higher rung's limit leaves", async () => {
    const { passSnapshot, otdOf } = await import("../test/passScene");
    const { passList } = await import("../data/passList");
    const { ownIndex } = await import("./owned");
    const { climb, dayOf } = await import("./passes");
    const m = market(1, 60);
    const snap = { ...passSnapshot(), otd: otdOf([m]) };
    const rules = snap.rules.otd;
    const held: Holding = { key: m.key, rarity: "rare", cap: 2000, earned: 1900, from: "real" };
    const owned = ownIndex([held], rules);
    const f = { level: "regular" as const, budget: null, sport: "all", season: "all" as const, soon: false, showAll: true, sort: "soon" as const, query: "" };
    const row = passList(snap, { ...f, owned }).rows.find((r) => r.market.key === m.key)!;
    expect(row.held).toBe("rare");
    const want = climb(m, owned.get(m.key)!.rating, rules, dayOf(snap.otd.as_of), { minted: true, used: 1900, mult: owned.get(m.key)!.mult, all: true }).options.find((o) => o.tier === row.rung.tier)!;
    expect(row.rung.year_rax).toBeCloseTo(want.extra_year, 6);
  });
});
