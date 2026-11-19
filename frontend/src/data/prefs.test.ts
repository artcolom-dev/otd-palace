import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEVELS } from "../test/fixtures";
import { type Prefs, loadPrefs, parseBudget, savePrefs } from "./prefs";

const KEY = "advisor.prefs.v1";
// A first visit: the New level at its own default budget (200 in the fixture levels), every sport, the best deals
// first, on the Today tab; at most New's 1,000 on one daily-pay pass; every rarity.
const DEFAULTS: Prefs = {
  sport: "all", budget: 200, level: "new", sort: "best", tab: "today", passBudget: 1000, rarity: null, rarer: false,
  buildTo: null,
};

describe("parseBudget", () => {
  it.each([
    ["", null],
    ["abc", null],
    ["1,500", 1500],
    ["-5", null],
    ["0", null],
    [" 250 ", 250],
    ["1 500", 1500],
    ["1\u00a0500", 1500], // no-break space
    ["1\u202f500", 1500], // narrow no-break space
    ["12,345,678", 12345678],
    ["1.5", null],
    ["2e3", null],
    ["+7", null],
    ["12abc", null],
    ["99999999999999999999", null],
  ])("parseBudget(%j) = %j", (input, out) => expect(parseBudget(input)).toBe(out));
});

describe("loadPrefs / savePrefs", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("defaults to New at its own budget, every sport, best first, on Today", () => {
    expect(loadPrefs(LEVELS)).toEqual(DEFAULTS);
  });

  it("has no budget to default to before the levels are known", () => {
    expect(loadPrefs()).toEqual({ ...DEFAULTS, budget: null, passBudget: null });
  });

  it("round-trips what was saved, a budget of any price included", () => {
    const prefs: Prefs = {
      sport: "nba", budget: 2500, level: "pro", sort: "under", tab: "deals", passBudget: 20000, rarity: 5, rarer: true,
      buildTo: 7,
    };
    savePrefs(prefs);
    expect(loadPrefs(LEVELS)).toEqual(prefs);
    savePrefs({ ...prefs, budget: null, passBudget: null });
    expect(loadPrefs(LEVELS)).toMatchObject({ budget: null, passBudget: null });
  });

  it("keeps the For passes sort", () => {
    savePrefs({ sport: "all", budget: null, level: "pro", sort: "passes", tab: "deals", passBudget: null });
    expect(loadPrefs(LEVELS).sort).toBe("passes");
  });

  it("reads a Profit sort saved before as the best after fees, which it now is", () => {
    localStorage.setItem("advisor.prefs.v1", JSON.stringify({ sport: "all", budget: null, level: "pro", sort: "profit", tab: "deals", passBudget: null }));
    expect(loadPrefs(LEVELS).sort).toBe("best");
  });

  it("stores only the preference fields under the versioned key", () => {
    savePrefs({ sport: "nfl", budget: null, level: "new", sort: "best", tab: "today", passBudget: 5000, extra: "nope" } as Prefs);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual({
      sport: "nfl", budget: null, level: "new", sort: "best", tab: "today", passBudget: 5000, rarity: null, rarer: false,
      buildTo: null,
    });
  });

  it("falls back to the defaults on stored text that is not JSON", () => {
    localStorage.setItem(KEY, "{not json");
    expect(loadPrefs(LEVELS)).toEqual(DEFAULTS);
  });

  it("falls back field by field on stored values it does not accept, the budget to the level's own", () => {
    localStorage.setItem(KEY, JSON.stringify({
      sport: 7, budget: -3, level: "admin", sort: "luck", tab: "casino", passBudget: "lots", rarity: "legendary", rarer: "yes",
      buildTo: "legendary",
    }));
    expect(loadPrefs(LEVELS)).toEqual(DEFAULTS);
    localStorage.setItem(KEY, JSON.stringify({ sport: "mlb", budget: 1.5, level: "regular", sort: "newest", tab: "passes", passBudget: -1 }));
    expect(loadPrefs(LEVELS)).toEqual({
      sport: "mlb", budget: 1000, level: "regular", sort: "newest", tab: "passes", passBudget: 5000, rarity: null,
      rarer: false, buildTo: null,
    });
    // Saved before passes had a budget: the saved level's own.
    localStorage.setItem(KEY, JSON.stringify({ sport: "all", budget: 50, level: "pro", sort: "best", tab: "today" }));
    expect(loadPrefs(LEVELS).passBudget).toBeNull();
  });

  it("falls back to the defaults when the stored value is not an object", () => {
    for (const stored of ["null", "42", '"nba"', "[1,2]"]) {
      localStorage.setItem(KEY, stored);
      expect(loadPrefs(LEVELS)).toEqual(DEFAULTS);
    }
  });

  it("survives a storage that throws, on read and on write", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(loadPrefs(LEVELS)).toEqual(DEFAULTS);
    expect(() => savePrefs(DEFAULTS)).not.toThrow();
  });

  it("keeps the Rarest first sort", () => {
    savePrefs({ ...DEFAULTS, sort: "rarest" });
    expect(loadPrefs(LEVELS).sort).toBe("rarest");
  });

  it("round-trips each of Real's eight rarities and the 'and rarer' switch, and All as null", () => {
    for (let rarity = 0; rarity < 8; rarity++) {
      savePrefs({ ...DEFAULTS, rarity, rarer: rarity % 2 === 0 });
      expect(loadPrefs(LEVELS)).toMatchObject({ rarity, rarer: rarity % 2 === 0 });
    }
    savePrefs({ ...DEFAULTS, rarity: null, rarer: true });
    expect(loadPrefs(LEVELS)).toMatchObject({ rarity: null, rarer: true });
  });

  it("reads prefs saved before the rarity strip as every rarity, the other choices kept", () => {
    localStorage.setItem(KEY, JSON.stringify({ sport: "nba", budget: 50, level: "pro", sort: "under", tab: "deals", passBudget: null }));
    expect(loadPrefs(LEVELS)).toEqual({
      sport: "nba", budget: 50, level: "pro", sort: "under", tab: "deals", passBudget: null, rarity: null, rarer: false,
      buildTo: null,
    });
  });

  it("reads a stored rarity that is not one of Real's eight as every rarity", () => {
    for (const rarity of [8, -1, 2.5, "5", true, null]) {
      localStorage.setItem(KEY, JSON.stringify({ ...DEFAULTS, rarity }));
      expect(loadPrefs(LEVELS).rarity).toBeNull();
    }
  });

  it("saves a missing rarity (a Prefs made in code) as every rarity", () => {
    const { rarity: _r, rarer: _x, ...older } = DEFAULTS;
    savePrefs(older);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toMatchObject({ rarity: null, rarer: false });
  });

  it("round-trips the Passes tab's Build to rarity, Common (1) to Iconic (7), and Best for each as null", () => {
    for (let buildTo = 1; buildTo < 8; buildTo++) {
      savePrefs({ ...DEFAULTS, buildTo });
      expect(loadPrefs(LEVELS)).toEqual({ ...DEFAULTS, buildTo });
    }
    savePrefs({ ...DEFAULTS, buildTo: null });
    expect(loadPrefs(LEVELS).buildTo).toBeNull();
  });

  it("reads prefs saved before Build to as Best for each, every other choice kept", () => {
    const before = { sport: "nba", budget: 50, level: "pro", sort: "under", tab: "passes", passBudget: null, rarity: 3, rarer: true };
    localStorage.setItem(KEY, JSON.stringify(before));
    expect(loadPrefs(LEVELS)).toEqual({ ...before, buildTo: null });
  });

  it("reads a stored Build to that is not Common to Iconic as Best for each: General pays nothing On This Day", () => {
    for (const buildTo of [0, 8, -1, 2.5, "5", "legendary", true, null]) {
      localStorage.setItem(KEY, JSON.stringify({ ...DEFAULTS, buildTo }));
      expect(loadPrefs(LEVELS).buildTo).toBeNull();
    }
  });

  it("saves a missing Build to (a Prefs made in code) as Best for each", () => {
    const { buildTo: _b, ...older } = DEFAULTS;
    savePrefs(older);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toMatchObject({ buildTo: null });
  });
});
