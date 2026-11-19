import { describe, expect, it } from "vitest";
import { ACCOUNT_TYPES } from "../content/accountTypes";
import type { Snapshot } from "../data/types";
import { JOKIC, MACKINNON, MCDAVID, MURRAY, SGA, otdOf, passSnapshot } from "../test/passScene";
import { NOW } from "../test/scene";
import { planHoldings } from "./passes";
import { type PlanInput, moveWords, planOf } from "./yourPlan";

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  holdings: [],
  level: "regular",
  budget: null,
  passBudget: null,
  balance: null,
  now: NOW,
  ...over,
});
const snap: Snapshot = passSnapshot();
const plan = (over: Partial<PlanInput> = {}) => planOf(snap, snap.otd.markets, input(over));

describe("planOf: a visitor with no pass", () => {
  it("earns nothing yet, is Not earning yet, and gets first passes as moves, best per Rax first", () => {
    const p = plan();
    expect(p.year).toBe(0);
    expect(p.type.key).toBe("none");
    expect(p.progress).toMatchObject({ fraction: 0, toGo: 1 });
    expect(p.moves.length).toBeGreaterThan(0);
    expect(p.moves.length).toBeLessThanOrEqual(3);
    expect(p.moves.every((m) => m.kind !== "deal")).toBe(true);
    expect(p.moves.map((m) => m.sport)).toEqual(["nhl", "nba", "nfl"]);
  });
});

describe("planOf: a visitor with passes", () => {
  const holdings = [{ key: JOKIC.key, tier: "common" }, { key: MURRAY.key, tier: "common" }];
  it("reports the planner's yearly figure, rounded, and the type and the way to the next one", () => {
    const p = plan({ holdings });
    const direct = planHoldings(holdings, snap.otd.markets, snap.rules.otd, snap.otd.sports).total;
    expect(p.year).toBe(Math.round(direct));
    expect(p.year).toBeGreaterThan(0);
    const next = ACCOUNT_TYPES[ACCOUNT_TYPES.indexOf(p.type) + 1];
    expect(p.progress?.next).toBe(next);
    expect(p.progress!.toGo).toBe(next!.from - p.year);
    expect(p.passes).toBe(2);
  });

  it("offers at most three passes moves, never a deal, each with its cost, its gain a year and when it pays back", () => {
    const p = plan({ holdings });
    expect(p.moves.length).toBeLessThanOrEqual(3);
    for (const m of p.moves) {
      expect(m.kind).not.toBe("deal");
      expect(m.cost).toBeGreaterThan(0);
      expect(m.year).toBeGreaterThan(0);
    }
    const words = moveWords(p.moves[0]!, "2026-11-12");
    expect(words.cost).toMatch(/^[\d,]+$/);
    expect(words.year).toMatch(/^[\d,]+$/);
    expect(words.payback === null || /^pays back by end of [A-Z][a-z]+( \d{4})?$/.test(words.payback)).toBe(true);
  });

  it("never costs more than the balance typed", () => {
    for (const m of plan({ holdings, balance: 400 }).moves) expect(m.cost).toBeLessThanOrEqual(400);
  });

  it("values the passes with the markets given (a pass the site does not list is valued from its own market)", () => {
    const small: Snapshot = passSnapshot({ otd: otdOf([JOKIC]) });
    const p = planOf(small, [JOKIC, MURRAY, SGA, MACKINNON, MCDAVID], input({ holdings: [{ key: MCDAVID.key, tier: "common" }] }));
    expect(p.year).toBeGreaterThan(0);
  });

  it("puts a figure that is not a figure at 0 and never throws on a pass nobody lists", () => {
    const p = plan({ holdings: [{ key: "nba:1999:player:999999", tier: "common" }] });
    expect(Number.isFinite(p.year)).toBe(true);
    expect(p.type.key).toBe("none");
  });
});

describe("moveWords", () => {
  it("says a payback month the way the Passes tab does, and nothing when the pass never pays back", () => {
    const p = plan();
    const m = p.moves[0]!;
    const w = moveWords({ ...m, rung: { ...m.rung!, pays_back: true, payback_month: "2027-03" } }, "2026-11-12");
    expect(w.payback).toBe("pays back by end of March");
    expect(moveWords({ ...m, rung: { ...m.rung!, pays_back: false, payback_month: null } }, "2026-11-12").payback).toBeNull();
    expect(moveWords({ ...m, rung: undefined }, "2026-11-12").payback).toBeNull();
  });
  it("rounds a cost and a gain the way people say them", () => {
    const w = moveWords({ ...plan().moves[0]!, cost: 3_641, year: 10_840 }, "2026-11-12");
    expect([w.cost, w.year]).toEqual(["3,600", "10,800"]);
  });
});
