// "You advise me things I already own": the advice must know what the visitor holds, at which rung, and what Real
// says each pass can still earn. Each block first reproduces the complaint, then checks the fix.
import { describe, expect, it } from "vitest";
import { defaultSeason, passList } from "../data/passList";
import type { Snapshot } from "../data/types";
import { makeDeal } from "../test/fixtures";
import { JOKIC, MACKINNON, MCDAVID, passSnapshot } from "../test/passScene";
import { NOW } from "../test/scene";
import { type NextRaxInput, nextRax } from "./nextRax";
import { dealOwned, ownIndex } from "./owned";
import { climb, dayOf, planHoldings, resolveHolding } from "./passes";

const base: NextRaxInput = {
  holdings: [], level: "regular", budget: null, passBudget: null, balance: null, now: NOW, paused: false, n: 8,
};
const run = (snap: Snapshot, over: Partial<NextRaxInput> = {}) => nextRax(snap, { ...base, ...over });
const filters = {
  level: "regular" as const, budget: null, sport: "all", season: defaultSeason("regular"), soon: false, showAll: false,
  sort: "ret" as const, query: "",
};

describe("Real's own rung, multiplier and cap win over what the rating suggests", () => {
  const snap = passSnapshot();
  const rules = snap.rules.otd;
  const markets = snap.otd.markets;

  it("reads the rung Real names, not the one the rating reaches", () => {
    // 40 rating reaches Uncommon on the player ladder; Real says the pass is Rare.
    const inferred = resolveHolding({ key: MACKINNON.key, rating: 40 }, markets, rules)!;
    const real = resolveHolding({ key: MACKINNON.key, rating: 40, rarity: "rare", mult: 4 }, markets, rules)!;
    expect(inferred.tier).toBe("uncommon");
    expect(real.tier).toBe("rare");
    expect(real.mult).toBe(4);
    expect(real.year).toBeGreaterThan(inferred.year);
  });

  it("an older answer (rating only) still infers as before", () => {
    const h = resolveHolding({ key: MACKINNON.key, rating: 90 }, markets, rules)!;
    expect(h.tier).toBe("rare");
    expect(h.cap).toBeNull();
  });

  it("a pass whose cap is 0 earns nothing more On This Day", () => {
    const capped = resolveHolding({ key: JOKIC.key, rarity: "rare", rating: 85, cap: 0 }, markets, rules)!;
    expect(capped.year).toBe(0); // a past season: nothing live is left either
    expect(capped.cap).toBe(0);
    expect(planHoldings([{ key: JOKIC.key, rarity: "rare", rating: 85, cap: 0 }], markets, rules).total).toBe(0);
    const some = resolveHolding({ key: JOKIC.key, rarity: "rare", rating: 85, cap: 300 }, markets, rules)!;
    expect(some.year).toBe(300);
  });

  it("a lift of a capped pass adds only what the higher limit leaves", () => {
    const today = dayOf(snap.otd.as_of);
    // Rare's limit is 500 x 4 = 2,000; 0 left means 2,000 earned. Epic's is 500 x 10 = 5,000: 3,000 left after a lift.
    const c = climb(JOKIC, 85, rules, today, { minted: true, used: 2000 });
    const epic = c.options.find((o) => o.tier === "epic")!;
    const fresh = climb(JOKIC, 85, rules, today, { minted: true }).options.find((o) => o.tier === "epic")!;
    expect(c.year).toBe(0);
    expect(epic.extra_year).toBeLessThanOrEqual(3000);
    expect(epic.extra_year).toBeLessThan(fresh.extra_year + fresh.year_rax); // never the whole Epic year
  });
});

describe("Your next Rax never suggests what you own", () => {
  const snap = passSnapshot();

  it("reproduced: a lift to the rung Real says the pass already has", () => {
    // The rating (40) reads as Uncommon, so the advice offered "Lift Nathan MacKinnon to Rare": he is Rare already.
    const moves = run(snap, { holdings: [{ key: MACKINNON.key, rating: 40, rarity: "rare" }] }).moves;
    expect(moves.map((m) => m.title)).not.toContain("Lift Nathan MacKinnon to Rare");
    for (const m of moves.filter((x) => x.kind === "rung")) expect(m.rung!.tier).not.toMatch(/^(general|common|uncommon|rare)$/);
  });

  it("never offers a pass held as a new slot, whatever the rung", () => {
    const moves = run(snap, { holdings: [{ key: MACKINNON.key, rarity: "common", rating: 10 }] }).moves;
    expect(moves.filter((m) => m.kind === "slot" && m.market?.key === MACKINNON.key)).toEqual([]);
  });

  it("reproduced: a deal on a pass held at that rung or higher; a lower rung keeps it", () => {
    const deal = makeDeal({ listing_id: 7, sport: "nhl", season: 2026, player_id: 3002, player_name: "Connor McDavid",
      rarity: 3, price: 100, reference: 400, flip_margin: 200, discount: 0.75, gap: 300, now: NOW });
    const withDeal = { ...snap, deals: [deal] };
    expect(run(withDeal).moves.some((m) => m.kind === "deal")).toBe(true); // nothing held: offered
    const epic = run(withDeal, { holdings: [{ key: MCDAVID.key, rarity: "epic", rating: 200 }] }).moves;
    expect(epic.some((m) => m.kind === "deal")).toBe(false);
    const common = run(withDeal, { holdings: [{ key: MCDAVID.key, rarity: "common", rating: 12 }] }).moves;
    expect(common.some((m) => m.kind === "deal")).toBe(true);
  });
});

describe("which deals and passes you own", () => {
  const snap = passSnapshot();
  const rules = snap.rules.otd;

  it("a deal is owned when the same player and season is held at its rarity or higher; another season is another pass", () => {
    const index = ownIndex([{ key: "nhl:2026:player:3002", rarity: "epic" }, { key: "nba:2025:player:1001", rating: 12 }], rules);
    const card = (over = {}) => makeDeal({ sport: "nhl", season: 2026, player_id: 3002, rarity: 3, ...over });
    expect(dealOwned(card(), index)).toBe("epic");
    expect(dealOwned(card({ rarity: 4 }), index)).toBe("epic");
    expect(dealOwned(card({ rarity: 5 }), index)).toBeNull(); // a Legendary card is more than the Epic held
    expect(dealOwned(card({ season: 2025 }), index)).toBeNull();
    expect(dealOwned(makeDeal({ sport: "nba", season: 2025, player_id: 1001, rarity: 1 }), index)).toBe("common");
  });

  it("reproduced: the pass list priced a held pass from nothing; now a lower rung shows the lift, an equal one is yours", () => {
    const open = passList(snap, filters);
    const row = open.rows.find((r) => r.market.key === MACKINNON.key)!;
    expect(row.owned).toBeUndefined();
    const below = row.rung.tier === "uncommon" ? { rarity: "common", rating: 10 } : { rarity: "general", rating: 0 };
    const lifted = passList(snap, { ...filters, owned: ownIndex([{ key: MACKINNON.key, ...below }], rules) });
    const lift = lifted.rows.find((r) => r.market.key === MACKINNON.key)!;
    expect(lift.held).toBe(below.rarity);
    expect(lift.rung.cost!).toBeLessThan(row.rung.cost!);
    expect(lifted.top?.market.key).not.toBe(MACKINNON.key);
    const same = passList(snap, { ...filters, owned: ownIndex([{ key: MACKINNON.key, rarity: row.rung.tier }], rules) });
    const mine = same.rows.find((r) => r.market.key === MACKINNON.key)!;
    expect(mine.owned).toBe(row.rung.tier);
    expect(same.top?.market.key).not.toBe(MACKINNON.key);
  });
});

describe("when Real's rung and the rating disagree, or the cap is Real's limit", () => {
  const snap = passSnapshot();
  const rules = snap.rules.otd;

  it("a rating past the rung Real names prices no lift: Real wants more than rating", () => {
    // 250 rating reaches Epic (180); Real says Rare. A lift to Epic is not "0.1 rating away".
    const holdings = [{ key: MACKINNON.key, rating: 250, rarity: "rare" }];
    const moves = run(snap, { holdings }).moves;
    expect(moves.filter((m) => m.kind === "rung" && m.market?.key === MACKINNON.key)).toEqual([]);
    const row = passList(snap, { ...filters, showAll: true, owned: ownIndex(holdings, rules) }).rows.find((r) => r.market.key === MACKINNON.key);
    if (row && !row.owned) expect(row.rung.cost).toBeNull();
  });

  // Measured on 123 accounts read twice, 9.5 hours apart (the internal research notes, 4f): of 354 claims
  // on passes with a cap, none was on a pass whose lifetime `earned` had reached it; of 392 passes of the 2025 NFL
  // season at or over their cap (a season whose On This Day had run 10 weeks: live pay had filled them) none claimed on
  // an NFL anniversary, against 75 of 1,080 under it; the 10 that claimed from over a cap had all climbed a rarity first.
  it("Real's cap counts all a past-season pass has earned, live pay included: at the cap it pays nothing more On This Day", () => {
    const over = resolveHolding({ key: JOKIC.key, rarity: "epic", rating: 190, cap: 5000, earned: 5798 }, snap.otd.markets, rules)!;
    expect([over.limit, over.year, over.used]).toEqual([0, 0, 5798]);
    expect(planHoldings([{ key: JOKIC.key, rarity: "epic", rating: 190, cap: 5000, earned: 5798 }], snap.otd.markets, rules).total).toBe(0);
    const part = resolveHolding({ key: JOKIC.key, rarity: "epic", rating: 190, cap: 5000, earned: 2000 }, snap.otd.markets, rules)!;
    expect([part.limit, part.year]).toEqual([3000, 3000]); // what is left of it
    const unknown = resolveHolding({ key: JOKIC.key, rarity: "epic", rating: 190, cap: 5000 }, snap.otd.markets, rules)!;
    expect([unknown.limit, unknown.year, unknown.used]).toEqual([5000, 5000, 0]); // Real did not say what it earned: the whole cap
    const general = resolveHolding({ key: JOKIC.key, rarity: "general", rating: 0, cap: 0 }, snap.otd.markets, rules)!;
    expect(general.year).toBe(0);
  });

  it("a lift reopens a pass that reached its cap, for what the higher rarity's limit leaves over all it earned", () => {
    const today = dayOf(snap.otd.as_of);
    const held = resolveHolding({ key: JOKIC.key, rarity: "epic", rating: 190, cap: 5000, earned: 5798 }, snap.otd.markets, rules)!;
    const legendary = climb(JOKIC, held.rating, rules, today, { minted: true, used: held.used, mult: held.mult }).options.find((o) => o.tier === "legendary")!;
    expect(legendary.extra_year).toBeGreaterThan(0);
    expect(legendary.extra_year).toBeLessThanOrEqual(12_500 - 5798);
  });

  it("a lift row's pay and payback are what the lift adds over the rung held", () => {
    const open = passList(snap, filters).rows.find((r) => r.market.key === MACKINNON.key)!;
    const below = open.rung.tier === "uncommon" ? { rarity: "common", rating: 10 } : { rarity: "general", rating: 0 };
    const lift = passList(snap, { ...filters, owned: ownIndex([{ key: MACKINNON.key, ...below }], rules) }).rows.find((r) => r.market.key === MACKINNON.key)!;
    const held = resolveHolding({ key: MACKINNON.key, ...below }, snap.otd.markets, rules)!;
    expect(lift.rung.year_rax).toBeCloseTo(open.rung.year_rax - held.year, 6);
  });
});
