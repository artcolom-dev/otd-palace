import { describe, expect, it } from "vitest";
import { LEVELS, isoAt, makeDeal, makeGone } from "../test/fixtures";
import { filterDeals, filterGone } from "./filters";
import type { Prefs } from "./prefs";
import type { Level } from "./types";

const now = Date.parse("2026-11-12T18:00:00Z");
const past = new Date(now - 1000).toISOString();
const prefs: Prefs = { sport: "all", budget: null, level: "regular", sort: "best", tab: "today", passBudget: 5000 };
const deal = (over: Parameters<typeof makeDeal>[0] = {}) => makeDeal({ now, ...over });
const inMinutes = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

describe("filterDeals", () => {
  it("keeps a deal that fits every preference", () => {
    const d = deal();
    expect(filterDeals([d], prefs, LEVELS, now)).toEqual([d]);
  });

  it("drops deals that have ended or end right now, by the client clock", () => {
    expect(filterDeals([deal({ ends_at: past })], prefs, LEVELS, now)).toEqual([]);
    expect(filterDeals([deal({ ends_at: new Date(now).toISOString() })], prefs, LEVELS, now)).toEqual([]);
    const justAfter = deal({ ends_at: new Date(now + 1000).toISOString() });
    expect(filterDeals([justAfter], prefs, LEVELS, now)).toEqual([justAfter]);
  });

  it("drops a deal whose end time cannot be read", () => {
    expect(filterDeals([deal({ ends_at: "soon" })], prefs, LEVELS, now)).toEqual([]);
  });

  it("drops deals above the budget and keeps those at it; no budget means no limit", () => {
    expect(filterDeals([deal({ price: 300 })], { ...prefs, budget: 299 }, LEVELS, now)).toEqual([]);
    expect(filterDeals([deal({ price: 300 })], { ...prefs, budget: 300 }, LEVELS, now)).toHaveLength(1);
    expect(filterDeals([deal({ price: 9_000_000 })], { ...prefs, budget: null }, LEVELS, now)).toHaveLength(1);
  });

  it("drops deals of another sport; 'all' keeps every sport", () => {
    expect(filterDeals([deal({ sport: "nfl" })], { ...prefs, sport: "nba" }, LEVELS, now)).toEqual([]);
    expect(filterDeals([deal({ sport: "nfl" })], { ...prefs, sport: "nfl" }, LEVELS, now)).toHaveLength(1);
    expect(filterDeals([deal({ sport: "nfl" })], { ...prefs, sport: "all" }, LEVELS, now)).toHaveLength(1);
  });

  it("drops deals whose kind the level does not show", () => {
    const bid = deal({ kind: "bid", ends_at: inMinutes(10) });
    expect(filterDeals([bid], { ...prefs, level: "new" }, LEVELS, now)).toEqual([]);
    expect(filterDeals([bid], { ...prefs, level: "regular" }, LEVELS, now)).toHaveLength(1);
  });

  it("drops a bid ending further away than the level's bid window and keeps one inside it", () => {
    const regular: Prefs = { ...prefs, level: "regular" };
    expect(filterDeals([deal({ kind: "bid", ends_at: inMinutes(31) })], regular, LEVELS, now)).toEqual([]);
    expect(filterDeals([deal({ kind: "bid", ends_at: inMinutes(29) })], regular, LEVELS, now)).toHaveLength(1);
    expect(filterDeals([deal({ kind: "bid", ends_at: inMinutes(30) })], regular, LEVELS, now)).toHaveLength(1);
    // Pro waits up to two hours; a target price is never held to the bid window.
    expect(filterDeals([deal({ kind: "bid", ends_at: inMinutes(31) })], { ...prefs, level: "pro" }, LEVELS, now)).toHaveLength(1);
    expect(filterDeals([deal({ kind: "target", ends_at: inMinutes(600) })], regular, LEVELS, now)).toHaveLength(1);
  });

  it("shows no bid at all for a level whose bid window is zero, whatever its kinds say", () => {
    const levels = { ...LEVELS, new: { ...LEVELS.new!, kinds: ["target", "bid"] as Level["kinds"] } };
    const soon = deal({ kind: "bid", ends_at: new Date(now + 1000).toISOString() });
    expect(filterDeals([soon], { ...prefs, level: "new" }, levels, now)).toEqual([]);
  });

  it("drops deals whose confidence the level does not show", () => {
    const medium = deal({ confidence: "medium", discount: 0.4 });
    expect(filterDeals([medium], { ...prefs, level: "new" }, LEVELS, now)).toEqual([]);
    expect(filterDeals([medium], { ...prefs, level: "pro" }, LEVELS, now)).toEqual([medium]);
  });

  it("drops deals below the level's minimum discount and keeps those at it", () => {
    expect(filterDeals([deal({ discount: 0.249 })], { ...prefs, level: "new" }, LEVELS, now)).toEqual([]);
    expect(filterDeals([deal({ discount: 0.25 })], { ...prefs, level: "new" }, LEVELS, now)).toHaveLength(1);
    expect(filterDeals([deal({ discount: 0.199 })], { ...prefs, level: "pro" }, LEVELS, now)).toEqual([]);
    expect(filterDeals([deal({ discount: 0.2 })], { ...prefs, level: "pro" }, LEVELS, now)).toHaveLength(1);
  });

  it("shows nothing for a level the snapshot does not define", () => {
    expect(filterDeals([deal()], { ...prefs, level: "pro" }, { regular: LEVELS.regular! }, now)).toEqual([]);
  });

  it("hides a falling deal from a level that hides them (New) and shows it to one that does not (Regular)", () => {
    const falling = deal({ falling: true });
    expect(filterDeals([falling], { ...prefs, level: "new" }, LEVELS, now)).toEqual([]);
    expect(filterDeals([deal({ falling: false })], { ...prefs, level: "new" }, LEVELS, now)).toHaveLength(1);
    expect(filterDeals([falling], { ...prefs, level: "regular" }, LEVELS, now)).toEqual([falling]);
  });

  it("keeps the server's order and does not change its input", () => {
    const deals = [deal({ listing_id: 3 }), deal({ listing_id: 1, sport: "nfl" }), deal({ listing_id: 2 })];
    const copy = [...deals];
    expect(filterDeals(deals, prefs, LEVELS, now).map((d) => d.listing_id)).toEqual([3, 1, 2]);
    expect(filterDeals(deals, { ...prefs, sport: "nba" }, LEVELS, now).map((d) => d.listing_id)).toEqual([3, 2]);
    expect(deals).toEqual(copy);
  });
});

describe("filterGone", () => {
  const gone = (over: Parameters<typeof makeGone>[0] = {}) => makeGone({ now, ...over });

  it("keeps a gone deal that fits every preference, with its reason and time", () => {
    const g = gone({ reason: "countdown_started" });
    expect(filterGone([g], prefs, LEVELS)).toEqual([g]);
  });

  it("does not check the end time against the clock: a deal that ended is exactly what it shows", () => {
    const ended = gone({ ends_at: past });
    const unreadable = gone({ ends_at: "soon" });
    const farTarget = gone({ ends_at: inMinutes(600), reason: "countdown_started" });
    const endedBid = gone({ kind: "bid", ends_at: past, reason: "ended" });
    expect(filterGone([ended, unreadable, farTarget, endedBid], prefs, LEVELS)).toEqual([
      ended, unreadable, farTarget, endedBid,
    ]);
  });

  it("shows a gone bid only if it was inside the level's bid window when it went", () => {
    // Gone now: with 100 minutes left it was never on a Regular visitor's screen; with 20 minutes left it was.
    const far = gone({ kind: "bid", ends_at: inMinutes(100), reason: "outbid" });
    const near = gone({ kind: "bid", ends_at: inMinutes(20), reason: "outbid" });
    const edge = gone({ kind: "bid", ends_at: inMinutes(30), reason: "outbid" });
    expect(filterGone([far, near, edge], { ...prefs, level: "regular" }, LEVELS)).toEqual([near, edge]);
    expect(filterGone([far, near], { ...prefs, level: "pro" }, LEVELS)).toEqual([far, near]);
    // Judged by when it went, not by the visitor's clock: a bid that went an hour before it ended is hidden.
    const wentEarly = gone({ kind: "bid", ends_at: inMinutes(20), gone_at: isoAt(now - 40 * 60_000) });
    expect(filterGone([wentEarly], { ...prefs, level: "regular" }, LEVELS)).toEqual([]);
    expect(filterGone([gone({ kind: "bid", ends_at: "soon" })], { ...prefs, level: "pro" }, LEVELS)).toEqual([]);
  });

  it("hides a falling deal that went from a level that hides them (New) and shows it to Regular", () => {
    const falling = gone({ falling: true });
    expect(filterGone([falling], { ...prefs, level: "new" }, LEVELS)).toEqual([]);
    expect(filterGone([falling], { ...prefs, level: "regular" }, LEVELS)).toEqual([falling]);
  });

  it("follows the budget", () => {
    expect(filterGone([gone({ price: 300 })], { ...prefs, budget: 299 }, LEVELS)).toEqual([]);
    expect(filterGone([gone({ price: 300 })], { ...prefs, budget: 300 }, LEVELS)).toHaveLength(1);
    expect(filterGone([gone({ price: 9_000_000 })], { ...prefs, budget: null }, LEVELS)).toHaveLength(1);
  });

  it("follows the sport", () => {
    expect(filterGone([gone({ sport: "nfl" })], { ...prefs, sport: "nba" }, LEVELS)).toEqual([]);
    expect(filterGone([gone({ sport: "nfl" })], { ...prefs, sport: "nfl" }, LEVELS)).toHaveLength(1);
    expect(filterGone([gone({ sport: "nfl" })], { ...prefs, sport: "all" }, LEVELS)).toHaveLength(1);
  });

  it("follows the level's discount, confidence and kinds", () => {
    const newcomer: Prefs = { ...prefs, level: "new" };
    expect(filterGone([gone({ discount: 0.249 })], newcomer, LEVELS)).toEqual([]);
    expect(filterGone([gone({ discount: 0.25 })], newcomer, LEVELS)).toHaveLength(1);
    expect(filterGone([gone({ confidence: "medium", discount: 0.4 })], newcomer, LEVELS)).toEqual([]);
    expect(filterGone([gone({ confidence: "medium", discount: 0.4 })], { ...prefs, level: "pro" }, LEVELS)).toHaveLength(1);
    const soonBid = gone({ kind: "bid", ends_at: inMinutes(10) });
    expect(filterGone([soonBid], newcomer, LEVELS)).toEqual([]);
    expect(filterGone([soonBid], { ...prefs, level: "regular" }, LEVELS)).toHaveLength(1);
  });

  it("shows no bid for a level whose bid window is zero, whatever its kinds say", () => {
    const levels = { ...LEVELS, new: { ...LEVELS.new!, kinds: ["target", "bid"] as Level["kinds"] } };
    expect(filterGone([gone({ kind: "bid", ends_at: past })], { ...prefs, level: "new" }, levels)).toEqual([]);
    expect(filterGone([gone({ kind: "target" })], { ...prefs, level: "new" }, levels)).toHaveLength(1);
  });

  it("shows nothing for a level the snapshot does not define", () => {
    expect(filterGone([gone()], { ...prefs, level: "pro" }, { regular: LEVELS.regular! })).toEqual([]);
  });

  it("keeps the server's order (newest first) and does not change its input", () => {
    const rows = [gone({ listing_id: 3 }), gone({ listing_id: 1, sport: "nfl" }), gone({ listing_id: 2 })];
    const copy = [...rows];
    expect(filterGone(rows, { ...prefs, sport: "nba" }, LEVELS).map((g) => g.listing_id)).toEqual([3, 2]);
    expect(rows).toEqual(copy);
  });
});

describe("hurt players", () => {
  const hurt = (status: "out" | "suspended" | "doubtful" | "questionable" | "day") => ({ injury: { status, part: null, back: null } });
  const asNew: Prefs = { ...prefs, level: "new" };

  it("hides, for the level that asks for the safest deals, a player who most likely misses the next game", () => {
    for (const status of ["out", "suspended", "doubtful"] as const) {
      expect(filterDeals([deal(hurt(status))], asNew, LEVELS, now)).toEqual([]);
    }
  });

  it("keeps a player who may well play, and a player with no note, for that level", () => {
    for (const status of ["questionable", "day"] as const) {
      expect(filterDeals([deal(hurt(status))], asNew, LEVELS, now)).toHaveLength(1);
    }
    expect(filterDeals([deal()], asNew, LEVELS, now)).toHaveLength(1);
  });

  it("shows every hurt player to the levels that do not hide them, the chip says what is wrong", () => {
    for (const level of ["regular", "pro"] as const) {
      expect(filterDeals([deal(hurt("out"))], { ...prefs, level }, LEVELS, now)).toHaveLength(1);
    }
  });

  it("treats a level without the rule (an older snapshot) as showing them", () => {
    const { hide_hurt: _, ...old } = LEVELS.new as Level & { hide_hurt?: boolean };
    expect(filterDeals([deal(hurt("out"))], asNew, { ...LEVELS, new: old as Level }, now)).toHaveLength(1);
  });

  it("applies the same rule to the deals that just went away", () => {
    const gone = [makeGone({ injury: { status: "out", part: null, back: null } }), makeGone()];
    expect(filterGone(gone, asNew, LEVELS)).toHaveLength(1);
    expect(filterGone(gone, prefs, LEVELS)).toHaveLength(2);
  });
});
