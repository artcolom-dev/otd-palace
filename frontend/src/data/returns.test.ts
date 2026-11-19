import { describe, expect, it } from "vitest";
import { makeDeal } from "../test/fixtures";
import { NOW, sceneSnapshot } from "../test/scene";
import type { OpenedDeal } from "./local";
import type { Prefs } from "./prefs";
import { OPENED_WINDOW_MS, recentOpens, sinceLastVisit, sinceText } from "./returns";

const REGULAR: Prefs = { level: "regular", budget: 1000, sport: "all", sort: "best", tab: "today", passBudget: 5000 };
const min = (n: number) => n * 60_000;

describe("since your last visit", () => {
  const snap = sceneSnapshot();
  const follows = new Set(["nba:22", "nba:44", "nfl:11"]);

  it("counts the followed players' deals listed since then, and their biggest move of 20% or more", () => {
    // Jokić (5 m ago) and Edwards (9 m ago) were listed after a visit 12 minutes ago; Chase (4 m ago) too.
    const since = sinceLastVisit(snap, REGULAR, follows, NOW, NOW - min(12));
    expect(since).toEqual({ deals: 3, move: snap.moves.risers[0] });
    expect(sinceText(since!)).toBe("3 new deals on your players · Chase +41% today");
    // Jokić falls 22%: the biggest move among those followed when Chase is not.
    const noChase = sinceLastVisit(snap, REGULAR, new Set(["nba:22"]), NOW, NOW - min(12));
    expect(sinceText(noChase!)).toBe("1 new deal on your players · Jokić −22% today");
  });

  it("follows the level and budget: a deal the visitor would not see is not news", () => {
    const newcomer = { ...REGULAR, level: "new" as const, budget: 200 };
    expect(sinceLastVisit(snap, newcomer, follows, NOW, NOW - min(12))?.deals).toBe(2); // Chase and Edwards
  });

  it("is nothing on a first visit, within 10 minutes of the last, or when nothing changed for those followed", () => {
    expect(sinceLastVisit(snap, REGULAR, follows, NOW, null)).toBeNull();
    expect(sinceLastVisit(snap, REGULAR, follows, NOW, NOW - min(9))).toBeNull();
    expect(sinceLastVisit(snap, REGULAR, new Set(), NOW, NOW - min(60))).toBeNull();
    // Salah moved 25% but nothing was listed for him since: the move alone is news.
    expect(sinceText(sinceLastVisit(snap, REGULAR, new Set(["soccer:77"]), NOW, NOW - min(12))!)).toBe("Salah +25% today");
  });

  it("leaves out moves under 20%", () => {
    const small = sceneSnapshot({
      moves: { risers: [{ ...snap.moves.risers[0]!, change: 0.19 }], fallers: [] },
      deals: [],
    });
    expect(sinceLastVisit(small, REGULAR, new Set(["nfl:11"]), NOW, NOW - min(30))).toBeNull();
  });
});

describe("the deals opened, to ask about", () => {
  const open = (listing_id: number, at: number): OpenedDeal => {
    const d = makeDeal({ listing_id });
    return {
      key: `${listing_id}:target`, listing_id, kind: "target", sport: d.sport, player_id: d.player_id,
      player_name: d.player_name, price: d.price, reference: d.reference, rarity: d.rarity, at,
    };
  };

  it("are those opened in the last 30 minutes, before the page came back, not got and not dismissed", () => {
    const opened = [open(4, NOW - min(1)), open(3, NOW - min(5)), open(2, NOW - min(10)), open(1, NOW - min(31))];
    const returnedAt = NOW - min(2); // the page came back 2 minutes ago: 4 was opened after, so not yet
    expect(recentOpens(opened, NOW, returnedAt, 0, []).map((o) => o.listing_id)).toEqual([3, 2]);
    expect(recentOpens(opened, NOW, returnedAt, 0, [3]).map((o) => o.listing_id)).toEqual([2]);
    expect(recentOpens(opened, NOW, returnedAt, NOW - min(8), []).map((o) => o.listing_id)).toEqual([3]);
    expect(OPENED_WINDOW_MS).toBe(min(30));
  });
});
