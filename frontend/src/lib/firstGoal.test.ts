import { describe, expect, it } from "vitest";
import type { PassMarket } from "../data/types";
import { CHASE, JOKIC, OLIVEIRA, THUNDER, otdOf, passSnapshot } from "../test/passScene";
import { firstGoal, firstGoalPick } from "./firstGoal";

const snap = passSnapshot();

describe("firstGoalPick", () => {
  it("is the cheapest sensible starter: a past season, a starter rarity, paying back within a year", () => {
    const pick = firstGoalPick(snap)!;
    // Starters are Jokić (NBA) and MacKinnon (NHL); Common 300 for Jokić, Common 255 for MacKinnon.
    expect(pick.market.player_name).toBe("Nathan MacKinnon");
    expect(pick.rung.tier).toBe("common");
    expect(pick.rung.cost).toBe(255);
    expect(pick.market.season_state).toBe("past");
  });

  it("ignores a season in progress even when it is a sport's starter", () => {
    const only = passSnapshot({ otd: { ...otdOf([CHASE]), starters: { nfl: CHASE.key } } });
    expect(firstGoalPick(only)).toBeNull();
  });

  it("falls back to the cheapest that pays back when none pays back within a year", () => {
    const slow: PassMarket = {
      ...JOKIC,
      rungs: JOKIC.rungs.map((r) => ({ ...r, payback_months: 20 })),
    };
    const pick = firstGoalPick(passSnapshot({ otd: { ...otdOf([slow]), starters: { nba: slow.key } } }))!;
    expect(pick.market.key).toBe(slow.key);
    expect(pick.rung.tier).toBe("common");
  });

  it("is null with no starter, or one that never pays back or cannot be priced", () => {
    expect(firstGoalPick(passSnapshot({ otd: otdOf([]) }))).toBeNull();
    const unpriced = { ...otdOf([THUNDER]), starters: { nba: THUNDER.key } };
    expect(firstGoalPick(passSnapshot({ otd: unpriced }))).toBeNull(); // a team pass: its cards cannot be priced
    expect(firstGoalPick(passSnapshot({ otd: { ...otdOf([OLIVEIRA]), starters: { ufc: OLIVEIRA.key } } }))).toBeNull();
  });

  it("ties on cost go to the better return per Rax", () => {
    const a: PassMarket = { ...JOKIC, key: "nba:2025:player:9001", rungs: JOKIC.rungs.map((r) => ({ ...r, cost: 250, year_per_rax: 3 })) };
    const b: PassMarket = { ...JOKIC, key: "nba:2025:player:9002", rungs: JOKIC.rungs.map((r) => ({ ...r, cost: 250, year_per_rax: 4 })) };
    const pick = firstGoalPick(passSnapshot({ otd: { ...otdOf([a, b]), starters: { x: a.key, y: b.key } } }))!;
    expect(pick.market.key).toBe(b.key);
  });
});

describe("firstGoal: the visitor's own numbers", () => {
  it("shows the cost, the yearly pay, and nothing of time when no daily Rax is given", () => {
    const g = firstGoal(snap, null, null)!;
    expect(g).toMatchObject({ cost: 255, year: 1000, have: 0, need: 255, fill: 0, days: null });
  });

  it("fills the bar from the balance typed and says what is still missing", () => {
    const g = firstGoal(snap, 100, null)!;
    expect(g.have).toBe(100);
    expect(g.need).toBe(155);
    expect(g.fill).toBeCloseTo(100 / 255, 9);
    expect(g.days).toBeNull();
  });

  it("works out the days only from a daily Rax the visitor gave: whole days, rounded up", () => {
    expect(firstGoal(snap, 100, 20)!.days).toBe(8); // 155 / 20 = 7.75
    expect(firstGoal(snap, null, 51)!.days).toBe(5); // 255 / 51
    expect(firstGoal(snap, 100, 155)!.days).toBe(1);
  });

  it("a balance that reaches it: nothing missing, a full bar, no days", () => {
    const g = firstGoal(snap, 300, 10)!;
    expect(g).toMatchObject({ need: 0, fill: 1, days: null });
  });

  it("an unreadable daily Rax or balance is not used", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY * 0]) expect(firstGoal(snap, null, bad)!.days).toBeNull();
    expect(firstGoal(snap, Number.NaN, null)!.have).toBe(0);
    expect(firstGoal(snap, -10, null)!.need).toBe(255);
  });

  it("is null when there is no goal to show", () => {
    expect(firstGoal(passSnapshot({ otd: otdOf([]) }), 100, 10)).toBeNull();
  });
});

describe("firstGoal with offers", () => {
  it("says what the first pass could cost by offers, and what would then be missing", () => {
    const goal = firstGoal(snap, 150, null)!; // MacKinnon Common: 255, of which 55 of cards at 5.5 a point
    expect(goal.offer).toBeCloseTo(255 - 10 * 5.5 * 0.2);
    expect(goal.offerNeed).toBeCloseTo(goal.offer! - 150);
    expect(firstGoal(snap, 300, null)!.offerNeed).toBe(0);
  });
});
