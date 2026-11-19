import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDeal } from "../test/fixtures";
import { passSnapshot } from "../test/passScene";
import { DEFAULT_ALERTS, local, useLocal } from "./local";

const KEY = "advisor.local.v1";
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "null");

const EMPTY = {
  follows: [], opened: [], welcomeDismissed: false, passes: [], heldMarkets: [], lastVisitAt: null, visits: 0, saved: 0, got: [],
  openedDismissedAt: 0, installDismissed: false, balance: null, dailyRax: null,
  routine: { show: null, day: "", ticks: [], done: [] },
  alerts: {
    on: false, deals: false, lastCall: false, moves: false, digest: false, routine: false, digestHour: 9, quiet: [23, 7],
    renew: false,
  },
  link: null,
};

describe("local: what this device remembers, and nothing about who uses it", () => {
  beforeEach(() => {
    localStorage.clear();
    local.reload();
  });
  afterEach(() => vi.restoreAllMocks());

  it("starts empty", () => {
    expect(local.get()).toEqual(EMPTY);
  });

  it("keeps the alert settings under the same key, never a second store: all off until chosen", () => {
    expect(local.get().alerts).toEqual(DEFAULT_ALERTS);
    expect(DEFAULT_ALERTS).toEqual(EMPTY.alerts);
    local.setAlerts({ on: true, deals: true, digestHour: 7, quiet: null });
    expect(stored().alerts).toEqual({
      on: true, deals: true, lastCall: false, moves: false, digest: false, routine: false, digestHour: 7, quiet: null,
      renew: false,
    });
    expect(Object.keys(localStorage)).toEqual([KEY]);
    local.resetAlerts();
    expect(local.get().alerts).toEqual(DEFAULT_ALERTS);
    expect(stored().follows).toEqual([]);
  });

  it("reads alert settings it cannot trust as the defaults, field by field", () => {
    localStorage.setItem(KEY, JSON.stringify({ alerts: { on: "yes", deals: true, digestHour: 25, quiet: [23, 99] } }));
    local.reload();
    expect(local.get().alerts).toEqual({ ...DEFAULT_ALERTS, deals: true });
    localStorage.setItem(KEY, JSON.stringify({ alerts: { lastCall: true, digestHour: 6, quiet: [22, 6] } }));
    local.reload();
    expect(local.get().alerts).toEqual({ ...DEFAULT_ALERTS, lastCall: true, digestHour: 6, quiet: [22, 6] });
  });

  it("keeps the passes this device holds under the same key: by rarity or exact rating, maxed or not", () => {
    expect(local.addPass({ key: "nba:2025:player:1", tier: "epic" })).toBe(false);
    expect(local.addPass({ key: "nhl:2026:player:2", rating: 212, spent: true })).toBe(false);
    expect(stored().passes).toEqual([
      { key: "nba:2025:player:1", tier: "epic" },
      { key: "nhl:2026:player:2", rating: 212, spent: true },
    ]);
    // The same pass again replaces it, in place, and says it was an update.
    expect(local.addPass({ key: "nba:2025:player:1", rating: 400 })).toBe(true);
    expect(local.get().passes[0]).toEqual({ key: "nba:2025:player:1", rating: 400 });
    local.removePass("nhl:2026:player:2");
    local.reload();
    expect(local.get().passes).toEqual([{ key: "nba:2025:player:1", rating: 400 }]);
    expect(stored().follows).toEqual([]); // the rest of the device's state is untouched
  });

  it("puts a removed pass back where it was, with its valuation, once (Undo)", () => {
    local.addPass({ key: "nba:2025:player:1", tier: "epic" });
    local.addPass({ key: "nba:2019:player:777", tier: "rare" });
    local.addPass({ key: "nhl:2026:player:2", rating: 212 });
    local.keepMarkets([{ ...passSnapshot().otd.markets[0]!, key: "nba:2019:player:777", season: 2019, player_id: 777 }]);
    const removed = local.removePass("nba:2019:player:777");
    expect(local.get().passes.map((p) => p.key)).toEqual(["nba:2025:player:1", "nhl:2026:player:2"]);
    expect(local.get().heldMarkets).toEqual([]);
    expect(removed).not.toBeNull();
    local.restorePass(removed!);
    local.reload();
    expect(local.get().passes).toEqual([
      { key: "nba:2025:player:1", tier: "epic" },
      { key: "nba:2019:player:777", tier: "rare" },
      { key: "nhl:2026:player:2", rating: 212 },
    ]);
    expect(local.get().heldMarkets.map((m) => m.key)).toEqual(["nba:2019:player:777"]);
    local.restorePass(removed!); // twice: still one of it
    expect(local.get().passes).toHaveLength(3);
    expect(local.removePass("nba:1999:player:5")).toBeNull(); // not held: nothing to put back
  });

  it("drops stored passes it cannot read", () => {
    localStorage.setItem(KEY, JSON.stringify({
      passes: [{ key: "a", tier: "rare" }, { key: 3 }, { tier: "rare" }, { key: "b", rating: -4 }, { key: "c" }, "x",
        { key: "d", rating: 30, tier: "uncommon", spent: "yes" }],
    }));
    local.reload();
    expect(local.get().passes).toEqual([{ key: "a", tier: "rare" }, { key: "d", rating: 30, tier: "uncommon" }]);
  });

  it("keeps a held pass's rarity only when it is a tier of the ladder", () => {
    localStorage.setItem(KEY, JSON.stringify({
      passes: [
        { key: "a", tier: "<img src=x onerror=alert(1)>" },
        { key: "b", tier: "General" },
        { key: "c", tier: "legendary" },
        { key: "d", tier: "mythic", rating: 120 },
        { key: "e", tier: "iconic", spent: true },
      ],
    }));
    local.reload();
    expect(local.get().passes).toEqual([
      { key: "c", tier: "legendary" },
      { key: "d", rating: 120 },
      { key: "e", tier: "iconic", spent: true },
    ]);
    expect(local.addPass({ key: "f", tier: "gold" })).toBe(false);
    expect(local.get().passes.map((p) => p.key)).not.toContain("f");
  });

  it("follows and unfollows a player by sport and id, and remembers it", () => {
    expect(local.toggleFollow("nba:22")).toBe(true);
    expect(stored().follows).toEqual(["nba:22"]);
    local.reload();
    expect(local.get().follows).toEqual(["nba:22"]);
    expect(local.toggleFollow("nba:22")).toBe(false);
    expect(local.get().follows).toEqual([]);
  });

  it("remembers the deals opened, newest first, once each, as a few card facts", () => {
    const deal = makeDeal({ listing_id: 9, player_name: "Nikola Jokić", price: 150, reference: 228 });
    local.markOpened(deal, 1000);
    local.markOpened(deal, 2000);
    expect(local.get().opened).toEqual([
      {
        key: "9:target", listing_id: 9, kind: "target", sport: "nba", player_id: 100, player_name: "Nikola Jokić",
        price: 150, reference: 228, rarity: 3, season: 2026, rating: 4.2, at: 2000,
      },
    ]);
    expect(local.isOpened(9)).toBe(true);
    expect(local.isOpened(10)).toBe(false);
  });

  it("keeps at most 30 opened deals", () => {
    for (let i = 0; i < 40; i++) local.markOpened(makeDeal({ listing_id: i }), i);
    expect(local.get().opened).toHaveLength(30);
    expect(local.get().opened[0]?.listing_id).toBe(39);
  });

  it("remembers that the welcome strip was dismissed", () => {
    local.dismissWelcome();
    local.reload();
    expect(local.get().welcomeDismissed).toBe(true);
  });

  it("ignores stored values it does not accept", () => {
    localStorage.setItem(KEY, JSON.stringify({ follows: [1, "nba:2"], opened: "x", welcomeDismissed: "yes", passes: 4 }));
    local.reload();
    expect(local.get()).toEqual({ ...EMPTY, follows: ["nba:2"] });
  });

  it("counts visits: a return within 30 minutes of leaving is the same visit", () => {
    local.startVisit(0);
    expect(local.get().visits).toBe(1);
    local.leave(60_000);
    expect(stored().lastVisitAt).toBe(60_000);
    local.startVisit(60_000 + 29 * 60_000); // back after 29 min: the same visit
    expect(local.get().visits).toBe(1);
    local.leave(2 * 3_600_000);
    local.startVisit(2 * 3_600_000 + 31 * 60_000);
    local.reload();
    expect(local.get()).toMatchObject({ visits: 2, lastVisitAt: 2 * 3_600_000 });
  });

  it("adds what a deal marked got saved to the tally, never counting a listing twice, never below 0", () => {
    local.markOpened(makeDeal({ listing_id: 5, price: 150, reference: 228 }), 1000);
    local.markOpened(makeDeal({ listing_id: 6, kind: "bid", price: 70, reference: 60 }), 2000);
    const [bid, target] = local.get().opened;
    expect(local.markGot(target!)).toBe(78);
    expect(local.markGot(target!)).toBeNull(); // the same listing again: not counted twice
    expect(local.markGot({ ...target!, key: "5:bid", kind: "bid" })).toBeNull(); // nor as another kind of deal
    expect(local.markGot(bid!)).toBe(0); // paid more than its usual price: nothing saved, nothing lost
    local.reload();
    expect(local.get()).toMatchObject({ saved: 78, got: [6, 5] });
  });

  it("remembers \"Not this time\" for the deals opened until then, and a dismissed install card", () => {
    local.dismissOpened(5000);
    local.dismissInstall();
    local.reload();
    expect(local.get()).toMatchObject({ openedDismissedAt: 5000, installDismissed: true });
  });

  it("reads a tally and visit it can trust, and nothing else", () => {
    localStorage.setItem(KEY, JSON.stringify({ lastVisitAt: "x", visits: -2, saved: -5, got: [1, "2", 3], openedDismissedAt: null }));
    local.reload();
    expect(local.get()).toEqual({ ...EMPTY, got: [1, 3] });
    localStorage.setItem(KEY, JSON.stringify({ lastVisitAt: 10, visits: 3, saved: 120.4, installDismissed: true }));
    local.reload();
    expect(local.get()).toMatchObject({ lastVisitAt: 10, visits: 3, saved: 120, installDismissed: true });
  });

  it("survives a storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    local.reload();
    expect(() => local.toggleFollow("nfl:1")).not.toThrow();
    expect(local.get().follows).toEqual(["nfl:1"]);
  });

  it("remembers the last balance typed into 'What can I do with…', as a whole number of Rax, and forgets it on null", () => {
    local.setBalance(840);
    expect(stored().balance).toBe(840);
    local.setBalance(null);
    expect(stored().balance).toBeNull();
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      local.setBalance(bad);
      expect(local.get().balance).toBeNull();
    }
    local.setBalance(840.6);
    expect(local.get().balance).toBe(841);
    localStorage.setItem(KEY, JSON.stringify({ balance: "840" }));
    local.reload();
    expect(local.get().balance).toBeNull();
    localStorage.setItem(KEY, JSON.stringify({ balance: 1250 }));
    local.reload();
    expect(local.get().balance).toBe(1250);
  });

  it("remembers an opened deal's season and rating, so a twin can be found when it ends, and still reads older records", () => {
    local.markOpened(makeDeal({ listing_id: 7, season: 2025, rating: 5.5 }), 1000);
    expect(local.get().opened[0]).toMatchObject({ listing_id: 7, season: 2025, rating: 5.5 });
    const { season, rating, ...old } = local.get().opened[0]!;
    localStorage.setItem(KEY, JSON.stringify({ opened: [old] }));
    local.reload();
    expect(local.get().opened[0]?.listing_id).toBe(7);
    expect(local.get().opened[0]?.season).toBeUndefined();
  });

  it("re-renders whoever reads it when it changes", () => {
    const { result } = renderHook(() => useLocal());
    expect(result.current.follows).toEqual([]);
    act(() => {
      local.toggleFollow("nhl:3");
    });
    expect(result.current.follows).toEqual(["nhl:3"]);
  });
  it("remembers the Rax the visitor says they make on a typical day: a whole positive number, else forgotten", () => {
    local.setDailyRax(35);
    expect(stored().dailyRax).toBe(35);
    local.setDailyRax(35.6);
    expect(local.get().dailyRax).toBe(36);
    for (const bad of [0, -4, Number.NaN, Number.POSITIVE_INFINITY, null]) {
      local.setDailyRax(bad);
      expect(local.get().dailyRax).toBeNull();
    }
    localStorage.setItem(KEY, JSON.stringify({ dailyRax: "35" }));
    local.reload();
    expect(local.get().dailyRax).toBeNull();
    localStorage.setItem(KEY, JSON.stringify({ dailyRax: 20 }));
    local.reload();
    expect(local.get().dailyRax).toBe(20);
  });

  describe("the daily routine, under the same key", () => {
    it("ticks and unticks an item of the day, and records the day once 3 are ticked", () => {
      local.tickRoutine("claim", true, "2026-11-13");
      local.tickRoutine("polls", true, "2026-11-13");
      expect(stored().routine).toEqual({ show: null, day: "2026-11-13", ticks: ["claim", "polls"], done: [] });
      local.tickRoutine("game", true, "2026-11-13");
      expect(stored().routine.done).toEqual(["2026-11-13"]);
      local.tickRoutine("game", false, "2026-11-13");
      expect(local.get().routine.done).toEqual([]);
    });

    it("a new local day starts from nothing and keeps the days that counted", () => {
      for (const id of ["claim", "polls", "game"] as const) local.tickRoutine(id, true, "2026-11-13");
      local.tickRoutine("lineup", true, "2026-11-14");
      expect(local.get().routine).toEqual({ show: null, day: "2026-11-14", ticks: ["lineup"], done: ["2026-11-13"] });
    });

    it("remembers a choice to show or hide the card, and forgets it on null", () => {
      local.showRoutine(true);
      expect(stored().routine.show).toBe(true);
      local.showRoutine(false);
      expect(local.get().routine.show).toBe(false);
      local.showRoutine(null);
      expect(local.get().routine.show).toBeNull();
    });

    it("reads a corrupt routine as an empty one and keeps the rest of the device", () => {
      localStorage.setItem(KEY, JSON.stringify({ visits: 4, routine: { show: 7, day: "yesterday", ticks: "all", done: [1, "x"] } }));
      local.reload();
      expect(local.get().routine).toEqual(EMPTY.routine);
      expect(local.get().visits).toBe(4);
      localStorage.setItem(KEY, JSON.stringify({ visits: 4, routine: [] }));
      local.reload();
      expect(local.get().routine).toEqual(EMPTY.routine);
    });

    it("the reminder is one more alert category, off until chosen, read as a flag", () => {
      expect(DEFAULT_ALERTS.routine).toBe(false);
      local.setAlerts({ routine: true });
      expect(stored().alerts.routine).toBe(true);
      localStorage.setItem(KEY, JSON.stringify({ alerts: { routine: "yes" } }));
      local.reload();
      expect(local.get().alerts.routine).toBe(false);
    });
  });
});

describe("local: an analysed account's valuations of the passes kept from it", () => {
  beforeEach(() => {
    localStorage.clear();
    local.reload();
  });
  const theirs = (key: string, over: Record<string, unknown> = {}) => ({
    ...passSnapshot().otd.markets[0]!, key, season: 2019, player_id: Number(key.split(":")[3]), player_name: "Lone Wolf", ...over,
  });

  it("keeps one per held pass, drops it with the pass, and survives a reload", () => {
    local.addPass({ key: "nba:2019:player:777", tier: "rare" });
    local.keepMarkets([theirs("nba:2019:player:777"), theirs("nba:2019:player:888")]);   // 888 is not held
    expect(local.get().heldMarkets.map((m) => m.key)).toEqual(["nba:2019:player:777"]);
    local.keepMarkets([theirs("nba:2019:player:777", { base_1x: 999 })]);                 // the newer one replaces it
    local.reload();
    expect(local.get().heldMarkets).toHaveLength(1);
    expect(local.get().heldMarkets[0]!.base_1x).toBe(999);
    local.removePass("nba:2019:player:777");
    expect(local.get().heldMarkets).toEqual([]);
  });

  it("never keeps a valuation the planner could not trust", () => {
    local.addPass({ key: "nba:2019:player:777", tier: "rare" });
    for (const bad of [{ base_1x: -1 }, { season_progress: 0 }, { month_share: [1] }, { shelf: null }, { game_days: "x" }, { season_state: "soon" }, { mintable: "yes" }, { rate_traded: -2 }]) {
      local.keepMarkets([theirs("nba:2019:player:777", bad)]);
      expect(local.get().heldMarkets, JSON.stringify(bad)).toEqual([]);
    }
  });

  it("keep the feed's build rate and offers only when they fit, and never the live auctions", () => {
    local.addPass({ key: "nba:2019:player:777", tier: "rare" });
    const build = { rate_bucket: "5-7", rate_build: 30.36, rate_build_from: { bucket: "5-7", rarity: "common", sales: 11 }, offers: [["5-7", "common", 8.93, 23, 30.36]] };
    local.keepMarkets([theirs("nba:2019:player:777", { ...build, auctions: [[5.2, 200, 1]] })]);
    local.reload();
    const [kept] = local.get().heldMarkets;
    expect(kept).toMatchObject(build);
    expect(kept).not.toHaveProperty("auctions");
    local.keepMarkets([theirs("nba:2019:player:777", { rate_build: "30", rate_build_from: { bucket: "9+" }, offers: "x", rate_bucket: 4 })]);
    local.reload();
    const [cleaned] = local.get().heldMarkets;
    for (const k of ["rate_build", "rate_build_from", "offers", "rate_bucket"]) expect(cleaned).not.toHaveProperty(k);
  });

  it("are kept without what is derived from them, under a key of their own written only when they change", () => {
    local.addPass({ key: "nba:2019:player:777", tier: "rare" });
    local.keepMarkets([theirs("nba:2019:player:777")]);
    const held = JSON.parse(localStorage.getItem("advisor.held.v1")!) as Record<string, unknown>[];
    expect(held.map((m) => m.key)).toEqual(["nba:2019:player:777"]);
    for (const k of ["rungs", "best", "weak", "on_sale", "month_share_estimated"]) expect(held[0]).not.toHaveProperty(k);
    expect(stored()).not.toHaveProperty("heldMarkets");
    localStorage.setItem("advisor.held.v1", "[]"); // a click elsewhere does not write them again
    local.toggleFollow("nba:1");
    expect(localStorage.getItem("advisor.held.v1")).toBe("[]");
  });

  it("an older device's, kept in the main key with their rungs, are read and moved to their own key", () => {
    localStorage.setItem(KEY, JSON.stringify({ passes: [{ key: "nba:2019:player:777", tier: "rare" }], heldMarkets: [theirs("nba:2019:player:777")] }));
    local.reload();
    expect(local.get().heldMarkets.map((m) => m.key)).toEqual(["nba:2019:player:777"]);
    expect(local.get().heldMarkets[0]).not.toHaveProperty("rungs");
    local.toggleFollow("nba:1");
    expect(JSON.parse(localStorage.getItem("advisor.held.v1")!)).toHaveLength(1);
    expect(stored()).not.toHaveProperty("heldMarkets");
  });

  it("keeps many passes in one write, each as one would be kept, and says how many were new", () => {
    local.addPass({ key: "nba:2019:player:1", tier: "rare" });
    let writes = 0;
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) {
      if (k === KEY) writes++;
      return set.call(this, k, v);
    };
    try {
      const added = local.addPasses([
        { key: "nba:2019:player:1", tier: "epic" }, // the same pass again: replaced in place
        { key: "nba:2019:player:2", rating: 50 },
        { key: "", tier: "rare" }, // unreadable: left out
        { key: "nba:2019:player:3", tier: "nope" }, // a rarity no ladder has: left out
      ]);
      expect(added).toBe(1);
    } finally {
      Storage.prototype.setItem = set;
    }
    expect(writes).toBe(1);
    expect(local.get().passes).toEqual([{ key: "nba:2019:player:1", tier: "epic" }, { key: "nba:2019:player:2", rating: 50 }]);
  });

  it("a storage too full for the valuations still saves the passes, and tries the valuations again later", () => {
    local.addPass({ key: "nba:2019:player:777", tier: "rare" });
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) {
      if (k === "advisor.held.v1") throw new DOMException("full", "QuotaExceededError");
      return set.call(this, k, v);
    };
    try {
      local.keepMarkets([theirs("nba:2019:player:777")]);
      local.addPass({ key: "nba:2019:player:778", tier: "rare" });
    } finally {
      Storage.prototype.setItem = set;
    }
    expect(stored().passes.map((p: { key: string }) => p.key)).toEqual(["nba:2019:player:777", "nba:2019:player:778"]);
    expect(localStorage.getItem("advisor.held.v1")).toBeNull();
    expect(stored().heldMarkets).toHaveLength(1); // kept in the main key meanwhile
    local.reload();
    expect(local.get().heldMarkets.map((m) => m.key)).toEqual(["nba:2019:player:777"]);
    local.toggleFollow("nba:1"); // room again: the next write moves them to their own key
    expect(JSON.parse(localStorage.getItem("advisor.held.v1")!)).toHaveLength(1);
    expect(stored()).not.toHaveProperty("heldMarkets");
  });

  it("the passes are written before the valuations, so valuations that fill the storage never cost a pass", () => {
    local.addPass({ key: "nba:2019:player:777", tier: "rare" });
    const order: string[] = [];
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) {
      order.push(k);
      return set.call(this, k, v);
    };
    try {
      local.keepMarkets([theirs("nba:2019:player:777")]);
    } finally {
      Storage.prototype.setItem = set;
    }
    expect(order).toEqual([KEY, "advisor.held.v1"]);
  });

  it("a valuations key that cannot be read costs the valuations, never the passes", () => {
    local.addPass({ key: "nba:2019:player:777", tier: "rare" });
    local.keepMarkets([theirs("nba:2019:player:777")]);
    localStorage.setItem("advisor.held.v1", "{not json");
    local.reload();
    expect(local.get().passes).toEqual([{ key: "nba:2019:player:777", tier: "rare" }]);
    expect(local.get().heldMarkets).toEqual([]);
  });

  it("keeps no shelf with a valuation: what was on sale then is not on sale now", () => {
    local.addPass({ key: "nba:2019:player:777", tier: "rare" });
    local.keepMarkets([theirs("nba:2019:player:777", { shelf: [[10, 80], [5, 60]], shelf_count: 2 })]);
    expect(local.get().heldMarkets[0]).toMatchObject({ shelf: [], shelf_count: 2 });
  });

  it("a 2,149-pass account fits whole, its valuations included, far inside the storage a browser gives a site", () => {
    const keys = Array.from({ length: 2149 }, (_, i) => `nba:2019:player:${10_000 + i}`);
    expect(local.addPasses(keys.map((key) => ({ key, rating: 120 })))).toBe(2149);
    local.keepMarkets(keys.map((key) => theirs(key)));
    local.reload();
    expect(local.get().passes).toHaveLength(2149);
    expect(local.get().heldMarkets).toHaveLength(2149);
    const bytes = (localStorage.getItem(KEY)?.length ?? 0) + (localStorage.getItem("advisor.held.v1")?.length ?? 0);
    expect(bytes).toBeLessThan(2_500_000); // browsers give a site about 5 MB
  });
});


describe("local: a linked Real account", () => {
  beforeEach(() => {
    localStorage.clear();
    local.reload();
  });
  const site = new Set(passSnapshot().otd.markets.map((m) => m.key));

  it("an older device's data reads as before, with nothing linked and its passes kept as added by hand", () => {
    localStorage.setItem(KEY, JSON.stringify({ follows: ["nba:1"], passes: [{ key: "nba:2025:player:1001", rating: 12 }], visits: 4 }));
    local.reload();
    expect(local.get().link).toBeNull();
    expect(local.get().passes).toEqual([{ key: "nba:2025:player:1001", rating: 12 }]);
    expect(local.get().visits).toBe(4);
  });

  it("linking makes the account's passes this device's at once, with what Real says about each", () => {
    local.link("Shaedon", [
      { key: "nba:2025:player:1001", rating: 85, rarity: "rare", mult: 4, cap: 0, earned: 2000, label: "Rare 1", level: 1 },
      { key: "nhl:2026:player:3001", rating: 12 },
    ], [], site, 1000);
    expect(local.get().link).toEqual({ username: "Shaedon", at: 1000, count: 2 });
    expect(local.get().passes).toEqual([
      { key: "nba:2025:player:1001", rating: 85, rarity: "rare", mult: 4, cap: 0, earned: 2000, label: "Rare 1", level: 1, from: "real" },
      { key: "nhl:2026:player:3001", rating: 12, from: "real" },
    ]);
    local.reload(); // and it is saved
    expect(local.get().passes).toHaveLength(2);
    expect(local.get().link?.username).toBe("Shaedon");
  });

  it("linking again replaces the link's passes, keeps the ones added by hand, and unlinking takes only the link's", () => {
    local.addPass({ key: "nfl:2026:player:2001", tier: "common" });
    local.link("Shaedon", [{ key: "nba:2025:player:1001", rating: 85 }, { key: "nhl:2026:player:3001", rating: 12 }], [], site, 1);
    local.link("Shaedon", [{ key: "nba:2025:player:1001", rating: 190 }], [], site, 2);
    expect(local.get().passes).toEqual([
      { key: "nba:2025:player:1001", rating: 190, from: "real" },
      { key: "nfl:2026:player:2001", tier: "common" },
    ]);
    local.unlink();
    expect(local.get().passes).toEqual([{ key: "nfl:2026:player:2001", tier: "common" }]);
    expect(local.get().link).toBeNull();
  });

  it("a pass the account holds and the visitor added by hand becomes the account's", () => {
    local.addPass({ key: "nba:2025:player:1001", tier: "common" });
    local.link("Shaedon", [{ key: "nba:2025:player:1001", rarity: "epic" }], [], site, 1);
    expect(local.get().passes).toEqual([{ key: "nba:2025:player:1001", rarity: "epic", from: "real" }]);
  });

  it("a value Real sends that does not fit is left out, the pass kept", () => {
    local.link("Shaedon", [{ key: "nba:2025:player:1001", rating: 5, rarity: "shiny", mult: -1, cap: -3, label: "x".repeat(99) } as never], [], site, 1);
    expect(local.get().passes).toEqual([{ key: "nba:2025:player:1001", rating: 5, from: "real" }]);
  });
});
