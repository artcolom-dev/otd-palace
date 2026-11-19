import { describe, expect, it } from "vitest";
import type { Deal, Snapshot } from "../data/types";
import { OTD_RULES, makeDeal } from "../test/fixtures";
import { CHASE, JOKIC, MACKINNON, MCDAVID, MURRAY, PASS_MARKETS, SGA, THUNDER, passSnapshot } from "../test/passScene";
import { NOW } from "../test/scene";
import { type Holding, planHoldings } from "./passes";
import { type RecycleInput, cardValue, quickAdvice, recycleForDeal, recyclePlan, shownLift, whyDead } from "./recycle";

const FEES = { fee: 0.1, listing_fee: 10 };

// Jokić 2024-25 at Epic, as a linked account brings it: it has earned past its 5,000 cap, so its On This Day pay stopped.
const JOKIC_FULL: Holding = { key: JOKIC.key, rarity: "epic", rating: 212, mult: 10, cap: 5000, earned: 5100, from: "real" };
// Murray at Rare with room left: not done.
const MURRAY_ROOM: Holding = { key: MURRAY.key, rarity: "rare", rating: 100, mult: 4, cap: 2000, earned: 1500, from: "real" };
// MacKinnon ticked maxed by hand.
const MACK_MAXED: Holding = { key: MACKINNON.key, tier: "rare", spent: true };
// Iconic never fills, whatever the figures say.
const SGA_ICONIC: Holding = { key: SGA.key, rarity: "iconic", rating: 3400, mult: 150, cap: 999, earned: 5000, from: "real" };
// A season being played: never done here (its cap is not Real's last word, its live pay goes on).
const CHASE_NOW: Holding = { key: CHASE.key, rarity: "epic", rating: 200, mult: 10, cap: 5000, earned: 6000, from: "real" };

function input(holdings: Holding[], over: Partial<RecycleInput> & { deals?: Deal[] } = {}): RecycleInput {
  const { deals = [], ...rest } = over;
  const snap: Snapshot = passSnapshot({ deals });
  const plan = planHoldings(holdings, PASS_MARKETS, OTD_RULES, snap.otd.sports);
  return { snap, markets: PASS_MARKETS, holdings, plan, level: "regular", pro: false, balance: null, nowMs: NOW, ...rest };
}

describe("recycle: which passes are done paying", () => {
  const all = [JOKIC_FULL, MURRAY_ROOM, MACK_MAXED, SGA_ICONIC, CHASE_NOW];

  it("a past-season pass that earned its cap, one ticked maxed; never Iconic, never this season, never one with room", () => {
    const plan = recyclePlan(input(all));
    expect(plan.dead.map((d) => [d.key, d.why])).toEqual(
      expect.arrayContaining([
        [JOKIC.key, "full"],
        [MACKINNON.key, "maxed"],
      ]),
    );
    expect(plan.dead).toHaveLength(2);
  });

  it("whyDead: a past-season pass that wins few claims is idle; a General is never done (it never paid On This Day)", () => {
    const plan = planHoldings([MURRAY_ROOM, { key: JOKIC.key, tier: "general" }], PASS_MARKETS, OTD_RULES);
    const [murray, general] = plan.held;
    expect(whyDead(murray!, new Set([MURRAY.key]))).toBe("idle");
    expect(whyDead(murray!, new Set())).toBeNull();
    expect(whyDead(general!, new Set([JOKIC.key]))).toBeNull();
  });

  it("no passes, or none done: an empty plan", () => {
    expect(recyclePlan(input([])).dead).toEqual([]);
    expect(recyclePlan(input([MURRAY_ROOM])).dead).toEqual([]);
  });
});

describe("recycle: what the cards would sell for (an estimate)", () => {
  it("rating × the typical price per point, less Real's 10 %", () => {
    const d = recyclePlan(input([JOKIC_FULL])).dead[0]!;
    // 212 rating × 10 Rax a point = 2,120; Real keeps 10 %: 1,908.
    expect(d.value).toEqual({ rating: 212, rate: 10, gross: 2120, net: 1908, fee: 0.1, listing_fee: 10, thin: false });
  });

  it("says when the price rests on few trades, and gives none without one", () => {
    const plan = planHoldings([{ key: JOKIC.key, rarity: "epic", rating: 212 }], [{ ...JOKIC, rate_sales: 3 }], OTD_RULES);
    expect(cardValue(plan.held[0]!, FEES, OTD_RULES.ignore_ask_min_sales)?.thin).toBe(true);
    const none = planHoldings([{ key: JOKIC.key, rarity: "epic", rating: 212 }], [{ ...JOKIC, rate_traded: null }], OTD_RULES);
    expect(cardValue(none.held[0]!, FEES, 5)).toBeNull();
  });

  it("values the cards at the feed's build rate when it sent one, thin when it found no cell", () => {
    const built = { ...JOKIC, rate_traded: 38.46, rate_build: 30.36, rate_build_from: { bucket: "5-7" as const, rarity: "common", sales: 11 } };
    const plan = planHoldings([{ key: JOKIC.key, rarity: "epic", rating: 212 }], [built], OTD_RULES);
    expect(cardValue(plan.held[0]!, FEES, 5)).toMatchObject({ rate: 30.36, gross: 212 * 30.36, thin: false });
    const thin = planHoldings([{ key: JOKIC.key, rarity: "epic", rating: 212 }], [{ ...JOKIC, rate_build: null }], OTD_RULES);
    expect(cardValue(thin.held[0]!, FEES, 5)).toMatchObject({ rate: 10, thin: true });
  });

  it("a pass held by its rarity alone is valued at that rarity's entry rating", () => {
    const d = recyclePlan(input([MACK_MAXED])).dead[0]!;
    expect(d.value?.rating).toBe(80); // Rare starts at 80
    expect(d.value?.net).toBe(Math.round(80 * 5.5 * 0.9));
  });

  it("adds the done passes' cards together, the most valuable first", () => {
    const plan = recyclePlan(input([MACK_MAXED, JOKIC_FULL]));
    expect(plan.dead.map((d) => d.key)).toEqual([JOKIC.key, MACKINNON.key]);
    expect(plan.value).toBe(1908 + Math.round(80 * 5.5 * 0.9));
    expect(plan.sellable).toBe(2);
  });
});

describe("recycle: Quick Sell (Real's own price, no Real Pro needed)", () => {
  // Jokić full with no rarity left that reopens it: no lift, so Quick Sell is the way to turn it into Rax without Pro.
  const JOKIC_SPENT: Holding = { ...JOKIC_FULL, earned: 50000 };

  it("about 1 Rax a rating point for the cards the site knows, next to what listing them would bring", () => {
    const d = recyclePlan(input([JOKIC_SPENT])).dead[0]!;
    // 212 rating × 1 Rax a point = 212; listed (Real Pro): 212 × 10 less Real's 10 % = 1,908.
    expect(d.quick).toEqual({ rating: 212, per_point: 1, rax: 212, listed: 1908, advice: "sell" });
  });

  it("rests on the rating alone: a pass with no trades still has one; a team pass has none", () => {
    const holdings = [{ key: JOKIC.key, rarity: "epic", rating: 212, mult: 10, cap: 5000, earned: 50000, from: "real" as const }];
    const inp = input(holdings);
    const markets = [{ ...JOKIC, rate_traded: null }, ...PASS_MARKETS.filter((m) => m.key !== JOKIC.key)];
    const plan = planHoldings(holdings, markets, OTD_RULES, inp.snap.otd.sports);
    const d = recyclePlan({ ...inp, markets, plan }).dead[0]!;
    expect(d.value).toBeNull();
    expect(d.quick).toMatchObject({ rax: 212, listed: null });
    const team = recyclePlan(input([{ key: THUNDER.key, rarity: "rare", rating: 100, mult: 4, cap: 2000, earned: 2100, from: "real" }]));
    expect(team.dead[0]!.quick).toBeNull();
  });

  it("a pass held by its rarity alone counts that rarity's entry rating", () => {
    const d = recyclePlan(input([{ ...MACK_MAXED }])).dead[0]!;
    expect(d.quick?.rating).toBe(80);
    expect(d.quick?.rax).toBe(80);
  });

  it("is never the advice while a lift reopens the pass, even one the typed balance does not cover", () => {
    expect(recyclePlan(input([JOKIC_FULL])).dead[0]!.quick?.advice).toBe("lift");
    expect(recyclePlan(input([JOKIC_FULL], { balance: 1000 })).dead[0]!.quick?.advice).toBe("lift");
  });

  it("quickAdvice: lift first; keep an idle pass that still wins at least its Quick Sell in a year; else sell", () => {
    const lift = recyclePlan(input([JOKIC_FULL])).dead[0]!.lift;
    expect(quickAdvice("full", lift, 0, 212)).toBe("lift");
    expect(quickAdvice("full", null, 0, 212)).toBe("sell");
    expect(quickAdvice("maxed", null, 0, 80)).toBe("sell");
    expect(quickAdvice("idle", null, 300, 212)).toBe("keep");
    expect(quickAdvice("idle", null, 212, 212)).toBe("keep");
    expect(quickAdvice("idle", null, 100, 212)).toBe("sell");
  });

  it("adds up the passes it is the advice for, and what listing those would bring", () => {
    const plan = recyclePlan(input([JOKIC_SPENT, MACK_MAXED]));
    // MacKinnon maxed has a lift (to Epic): not counted.
    expect(plan.quick).toEqual({ passes: 1, rax: 212, listed: 1908 });
    expect(recyclePlan(input([JOKIC_FULL])).quick).toEqual({ passes: 0, rax: 0, listed: 0 });
  });

  it("says no listing total when one of those passes has no price", () => {
    const holdings = [JOKIC_SPENT];
    const inp = input(holdings);
    const markets = [{ ...JOKIC, rate_traded: null }, ...PASS_MARKETS.filter((m) => m.key !== JOKIC.key)];
    const plan = planHoldings(holdings, markets, OTD_RULES, inp.snap.otd.sports);
    expect(recyclePlan({ ...inp, markets, plan }).quick).toEqual({ passes: 1, rax: 212, listed: null });
  });

  it("an older server without the rule: no Quick Sell at all", () => {
    const inp = input([JOKIC_SPENT]);
    const { quicksell_per_point: _drop, ...rules } = inp.snap.rules;
    const plan = recyclePlan({ ...inp, snap: { ...inp.snap, rules } });
    expect(plan.dead[0]!.quick).toBeNull();
    expect(plan.quick).toEqual({ passes: 0, rax: 0, listed: 0 });
  });
});

describe("recycle: the lift that reopens a full pass (no Real Pro needed)", () => {
  it("the next rarity, priced at the typical price; it reopens the new limit less all the pass earned", () => {
    const lift = recyclePlan(input([JOKIC_FULL])).dead[0]!.lift!;
    expect(lift.tier).toBe("legendary");
    expect(lift.rating_to_add).toBe(168); // 380 − 212
    expect(lift.cost).toBe(1680); // 168 × 10
    expect(lift.limit).toBe(12500); // 500 × 25
    expect(lift.reopens).toBe(12500 - 5100);
    expect(lift.extra_year).toBeGreaterThan(0);
    expect(lift.affordable).toBeNull(); // no balance typed
  });

  it("prices it from the cards listed now when they hold enough rating", () => {
    const listed = { ...JOKIC, shelf: [[100, 900], [80, 760]] as [number, number][], shelf_count: 2 };
    const holdings = [JOKIC_FULL];
    const inp = input(holdings);
    const markets = [listed, ...PASS_MARKETS.filter((m) => m.key !== JOKIC.key)];
    const plan = planHoldings(holdings, markets, OTD_RULES, inp.snap.otd.sports);
    const lift = recyclePlan({ ...inp, markets, plan }).dead[0]!.lift!;
    expect(lift.shelf).toBe(1660); // 180 rating listed for 1,660, enough for the 168 needed
    expect(lift.best).toBe(1660);
  });

  it("with the live auctions, prices it from the shelf only when every pay is firm: a sum of openings is no price", () => {
    const holdings = [JOKIC_FULL];
    const inp = input(holdings);
    const liftWith = (auctions: [number, number, 0 | 1][]) => {
      const markets = [{ ...JOKIC, auctions }, ...PASS_MARKETS.filter((m) => m.key !== JOKIC.key)];
      const plan = planHoldings(holdings, markets, OTD_RULES, inp.snap.otd.sports);
      return recyclePlan({ ...inp, markets, plan }).dead[0]!.lift!;
    };
    expect(liftWith([[100, 900, 1], [80, 760, 1]]).shelf).toBe(1660);
    expect(liftWith([[100, 900, 1], [80, 760, 0]]).shelf).toBeNull();
  });

  it("names a deal of the same player-season that gets there alone for less, and says whether the balance covers it", () => {
    const deal = makeDeal({ now: NOW, listing_id: 7, sport: "nba", season: 2025, player_id: 1001, rating: 170, price: 900 });
    const pricey = makeDeal({ now: NOW, listing_id: 8, sport: "nba", season: 2025, player_id: 1001, rating: 170, price: 2000 });
    const short = makeDeal({ now: NOW, listing_id: 9, sport: "nba", season: 2025, player_id: 1001, rating: 100, price: 100 });
    const lift = recyclePlan(input([JOKIC_FULL], { deals: [pricey, short, deal], balance: 1000 })).dead[0]!.lift!;
    expect(lift.deal?.listing_id).toBe(7);
    expect(lift.best).toBe(900);
    expect(lift.affordable).toBe(true);
    expect(recyclePlan(input([JOKIC_FULL], { balance: 1000 })).dead[0]!.lift!.affordable).toBe(false);
  });

  it("a pass ticked maxed by hand counts at least its limit as earned", () => {
    const lift = recyclePlan(input([MACK_MAXED])).dead[0]!.lift!;
    expect(lift.tier).toBe("epic");
    expect(lift.reopens).toBe(500 * 10 - 500 * 4); // Epic's limit less Rare's, all taken as earned
  });

  it("no lift when it does not pay back, when Real's rung hides the price, or for an idle pass", () => {
    const dead = recyclePlan(input([{ ...JOKIC_FULL, earned: 50000 }])).dead[0]!;
    expect(dead.why).toBe("full");
    expect(dead.lift).toBeNull(); // earned is past Legendary's and Mystic's limits: no next rarity reopens it
    const hidden = recyclePlan(input([{ ...JOKIC_FULL, rating: 400 }])).dead[0]!; // Real says Epic, the rating says Legendary
    expect(hidden.lift).toBeNull();
  });
});

describe("recycle: where the Rax from selling could go (Real Pro)", () => {
  const holdings = [JOKIC_FULL, MURRAY_ROOM, SGA_ICONIC];

  it("without Real Pro: no selling route at all", () => {
    const plan = recyclePlan(input(holdings));
    expect(plan.dead[0]!.target).toBeNull();
    expect(plan.route).toBeNull();
  });

  it("with Real Pro: each done pass's cards point at the best pass they build alone, in a sport with a claim free", () => {
    const plan = recyclePlan(input(holdings, { pro: true }));
    const target = plan.dead[0]!.target!;
    // NBA's two daily claims are taken by Murray and the Iconic: the pass goes elsewhere (NHL here).
    expect(target.market.sport).not.toBe("nba");
    expect(target.rung.cost).toBeLessThanOrEqual(1908);
    expect([MACKINNON.key, MCDAVID.key]).toContain(target.market.key);
  });

  it("with Real Pro: all the done passes' cards together build the budget answer's passes", () => {
    const plan = recyclePlan(input(holdings, { pro: true }));
    expect(plan.route?.picks.length).toBeGreaterThan(0);
    expect(plan.route!.spent).toBeLessThanOrEqual(plan.value);
    expect(plan.route!.picks.every((p) => p.market.key !== JOKIC.key)).toBe(true);
  });

  it("a sold pass frees its sport's claim: its teammates' passes can be the target", () => {
    const plan = recyclePlan(input([JOKIC_FULL, MURRAY_ROOM], { pro: true }));
    // NBA had Murray live and Jokić done: one claim free, so one NBA pass at most may be offered.
    expect(plan.route?.picks.length).toBeGreaterThan(0);
    expect(plan.route!.picks.filter((p) => p.market.sport === "nba").length).toBeLessThanOrEqual(1);
  });
});

describe("recycleForDeal: the line a deal row can show", () => {
  const plan = recyclePlan(input([JOKIC_FULL, MURRAY_ROOM]));

  it("a card of the same player-season that lifts the full pass a rarity reopens it", () => {
    const deal = makeDeal({ sport: "nba", season: 2025, player_id: 1001, rating: 200 });
    expect(recycleForDeal(deal, plan)).toEqual({ key: JOKIC.key, title: "Nikola Jokić 2024-25", tier: "legendary", reopens: 12500 - 5100 });
  });

  it("nothing for a card too small to lift it, another season, a pass with room, or no plan", () => {
    expect(recycleForDeal(makeDeal({ sport: "nba", season: 2025, player_id: 1001, rating: 100 }), plan)).toBeNull();
    expect(recycleForDeal(makeDeal({ sport: "nba", season: 2026, player_id: 1001, rating: 300 }), plan)).toBeNull();
    expect(recycleForDeal(makeDeal({ sport: "nba", season: 2025, player_id: 1002, rating: 300 }), plan)).toBeNull();
    expect(recycleForDeal(makeDeal({ sport: "nba", season: 2025, player_id: 1001, rating: 300 }), null)).toBeNull();
  });

  it("nothing when even the higher rarity's limit is already earned", () => {
    const spent = recyclePlan(input([{ ...JOKIC_FULL, earned: 13000 }]));
    expect(recycleForDeal(makeDeal({ sport: "nba", season: 2025, player_id: 1001, rating: 200 }), spent)).toBeNull();
  });

  it("never for a team pass: it carries its team's id, which a player's card could share", () => {
    const team = recyclePlan(input([{ key: THUNDER.key, rarity: "rare", rating: 100, mult: 4, cap: 2000, earned: 2100, from: "real" }]));
    expect(team.dead.map((d) => d.key)).toEqual([THUNDER.key]);
    expect(recycleForDeal(makeDeal({ sport: "nba", season: 2025, player_id: THUNDER.player_id, rating: 300 }), team)).toBeNull();
  });
});

describe("shownLift: the lift a done pass's line shows", () => {
  it("with Real Pro always; without, only one the typed balance covers, or any when none was typed", () => {
    const short = recyclePlan(input([JOKIC_FULL], { balance: 1000 })).dead[0]!;
    expect(short.lift!.affordable).toBe(false);
    expect(shownLift(short, true)).toBe(short.lift);
    expect(shownLift(short, false)).toBeNull();
    const none = recyclePlan(input([JOKIC_FULL])).dead[0]!;
    expect(shownLift(none, false)).toBe(none.lift);
  });
});
