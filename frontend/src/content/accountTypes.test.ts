import { describe, expect, it } from "vitest";
import tokens from "../styles/tokens.css?raw";
import { ACCOUNT_TYPES, nextType, progressToNext, typeOf, UP_TO_NOTE } from "./accountTypes";
import { RARITIES } from "./real";

const words = (s: string) => s.trim().split(/\s+/).length;

describe("the account types", () => {
  it("are a ladder of yearly On This Day value that starts at 0, has no gap and no overlap, and is open at the top", () => {
    expect(ACCOUNT_TYPES[0]!.from).toBe(0);
    ACCOUNT_TYPES.forEach((t, i) => {
      const after = ACCOUNT_TYPES[i + 1];
      expect(t.to).toBe(after ? after.from : null);
      if (after) expect(after.from).toBeGreaterThan(t.from);
    });
  });

  it("are the six of the research, by yearly value only", () => {
    expect(ACCOUNT_TYPES.map((t) => [t.name, t.from])).toEqual([
      ["Not earning yet", 0],
      ["Starter", 1],
      ["Steady", 10_000],
      ["Strong", 100_000],
      ["Big", 500_000],
      ["Giant", 2_000_000],
    ]);
  });

  it("read as a ladder: each one's colour is a higher rarity than the one before, and a real one", () => {
    const colors = ACCOUNT_TYPES.map((t) => t.color);
    expect(colors).toEqual([...colors].sort((a, b) => a - b));
    expect(new Set(colors).size).toBe(colors.length);
    for (const c of colors) expect(RARITIES[c]).toBeDefined();
    expect(tokens).toMatch(/--rarity-7:/);
  });

  it("say what they are, what to do, what to skip and what to watch, in 25 words a line at most, in plain English", () => {
    for (const t of ACCOUNT_TYPES) {
      for (const line of [t.meaning, t.do, t.skip, t.watch]) {
        expect(words(line), `${t.name}: ${line}`).toBeLessThanOrEqual(25);
        expect(line.length).toBeGreaterThan(20);
      }
    }
  });

  it("say how a pass really stops paying: its limit counts all it has earned, live pay included, and a lift reopens it", () => {
    for (const t of ACCOUNT_TYPES) {
      for (const line of [t.meaning, t.do, t.skip, t.watch]) expect(line, line).not.toMatch(/spent pass|sell them/i);
    }
    const watch = (key: string) => ACCOUNT_TYPES.find((t) => t.key === key)!.watch;
    for (const key of ["steady", "big"]) expect(watch(key)).toMatch(/limit.*live pay included/);
    expect(watch("big")).toMatch(/reopens/);
  });

  it("never say the accounts read fail to collect: measured, they claim, and a claim pays what the planner expects", () => {
    for (const t of ACCOUNT_TYPES) {
      for (const line of [t.meaning, t.do, t.skip, t.watch]) expect(line, line).not.toMatch(/never collected|make sure you collect/i);
    }
    expect(ACCOUNT_TYPES.find((t) => t.key === "giant")!.do).toMatch(/3,380/);
    expect(UP_TO_NOTE).toMatch(/every claim day/);
    expect(UP_TO_NOTE).not.toMatch(/collection is lower/i);
  });

  it("never define a type by claims, passes held or the Rax balance", () => {
    for (const t of ACCOUNT_TYPES) expect(t.meaning).not.toMatch(/\bclaims?\b|balance/i);
  });
});

describe("typeOf", () => {
  it("puts a figure in the bracket whose edge it has reached", () => {
    const at = (y: number) => typeOf(y).name;
    expect([0, 0.4].map(at)).toEqual(["Not earning yet", "Not earning yet"]);
    expect([1, 2_900, 9_999].map(at)).toEqual(["Starter", "Starter", "Starter"]);
    expect([10_000, 48_000, 99_999].map(at)).toEqual(["Steady", "Steady", "Steady"]);
    expect([100_000, 499_999].map(at)).toEqual(["Strong", "Strong"]);
    expect([500_000, 1_999_999].map(at)).toEqual(["Big", "Big"]);
    expect([2_000_000, 6_200_000, 5e9].map(at)).toEqual(["Giant", "Giant", "Giant"]);
  });
  it("reads a figure that is not a figure as nothing", () => {
    expect([NaN, -5, Infinity * -1].map((y) => typeOf(y).key)).toEqual(["none", "none", "none"]);
  });
  it("rounds half a rax a year to a whole one", () => {
    expect(typeOf(0.6).key).toBe("starter");
  });
});

describe("nextType and progressToNext", () => {
  it("name the type above, and nothing above the top", () => {
    expect(nextType(2_900)?.name).toBe("Steady");
    expect(nextType(0)?.name).toBe("Starter");
    expect(nextType(2_000_000)).toBeNull();
    expect(progressToNext(9e6)).toBeNull();
  });
  it("count the way to the next edge: 2,900 of 10,000 is 29 % and 7,100 to go", () => {
    const p = progressToNext(2_900)!;
    expect(p.next.name).toBe("Steady");
    expect([p.year, p.target, p.toGo]).toEqual([2_900, 10_000, 7_100]);
    expect(p.fraction).toBeCloseTo(0.29, 5);
  });
  it("hold a nothing at the start of the bar and a figure just under the edge near its end", () => {
    expect(progressToNext(0)).toMatchObject({ fraction: 0, toGo: 1, target: 1 });
    expect(progressToNext(499_999)!.fraction).toBeLessThan(1);
    expect(progressToNext(499_999)!.toGo).toBe(1);
  });
});
