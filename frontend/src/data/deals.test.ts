import { describe, expect, it } from "vitest";
import { makeDeal, makeSnapshot } from "../test/fixtures";
import { NOW, sceneDeals, sceneSnapshot } from "../test/scene";
import {
  budgetNudge,
  dealKey,
  goneReasonText,
  hurtHidden,
  isHeroMaterial,
  playerKey,
  sortDeals,
  sortLabel,
  sortsFor,
  sportCounts,
  visibleDeals,
} from "./deals";
import type { Prefs } from "./prefs";

const names = (deals: { player_name: string }[]) => deals.map((d) => d.player_name);
const prefs = (over: Partial<Prefs> = {}): Prefs => ({
  level: "regular", budget: 1000, sport: "all", sort: "best", tab: "today", passBudget: 5000, ...over,
});
const none = new Set<string>();

describe("keys", () => {
  it("names a deal by listing and kind, and a player by sport and id", () => {
    expect(dealKey(makeDeal({ listing_id: 7, kind: "bid" }))).toBe("7:bid");
    expect(playerKey(makeDeal({ sport: "nba", player_id: 100 }))).toBe("nba:100");
  });
});

describe("sorts", () => {
  it("offers the same sorts to every level, the best after fees first, and says % cheaper to New", () => {
    for (const level of ["new", "regular", "pro"] as const) {
      expect(sortsFor(level)).toEqual(["best", "ending", "newest", "cheapest", "under", "rarest", "passes"]);
      expect(sortLabel("best", level)).toBe("Best after fees");
    }
    expect(sortLabel("under", "regular")).toBe("Biggest % under");
    expect(sortLabel("under", "new")).toBe("Biggest % cheaper");
    expect(["ending", "newest", "cheapest"].map((k) => sortLabel(k as never, "pro"))).toEqual(["Ending soon", "Newest", "Cheapest"]);
  });

  it("orders by each key; the default is what reselling at the usual price leaves after fees, not the % under", () => {
    const deals = sceneDeals();
    expect(names(sortDeals(deals, "best", none)).slice(0, 3)).toEqual(["Josh Allen", "Nikola Jokić", "Ja'Marr Chase"]);
    // The deals that lose after fees stay, last.
    expect(names(sortDeals(deals, "best", none)).slice(-2)).toEqual(["Macklin Celebrini", "Mohamed Salah"]);
    expect(names(sortDeals(deals, "under", none)).slice(0, 3)).toEqual(["Connor McDavid", "Nikola Jokić", "Ja'Marr Chase"]);
    expect(names(sortDeals(deals, "cheapest", none))[0]).toBe("Macklin Celebrini");
    expect(names(sortDeals(deals, "ending", none)).slice(0, 2)).toEqual(["Macklin Celebrini", "Connor McDavid"]);
    expect(names(sortDeals(deals, "newest", none))[0]).toBe("Ja'Marr Chase");
  });

  it("ranks deals by what they return through their pass, the deals that build no tracked pass last", () => {
    expect(sortLabel("passes", "regular")).toBe("For passes");
    const a = makeDeal({ listing_id: 1, player_name: "A" });
    const b = makeDeal({ listing_id: 2, player_name: "B" });
    const c = makeDeal({ listing_id: 3, player_name: "C", flip_margin: 500 });
    const d = makeDeal({ listing_id: 4, player_name: "D", flip_margin: 10 });
    const value = new Map<number, number>([[1, 0.5], [2, 2]]);
    const sorted = sortDeals([a, b, c, d], "passes", none, (deal) => value.get(deal.listing_id) ?? null);
    // B returns the most a year per Rax; C and D build no pass, so they follow, best after fees first.
    expect(names(sorted)).toEqual(["B", "A", "C", "D"]);
  });

  it("without pass figures, the For passes sort falls back to the best after fees", () => {
    const deals = sceneDeals();
    expect(names(sortDeals(deals, "passes", none))).toEqual(names(sortDeals(deals, "best", none)));
  });

  it("pins followed players' deals above the rest, each group in the chosen order", () => {
    const sorted = sortDeals(sceneDeals(), "best", new Set(["nba:44", "soccer:77"]));
    expect(names(sorted).slice(0, 3)).toEqual(["Anthony Edwards", "Mohamed Salah", "Josh Allen"]);
  });
});

describe("visibleDeals", () => {
  it("applies level, budget and sport, then sorts", () => {
    const snap = sceneSnapshot();
    expect(names(visibleDeals(snap, prefs({ level: "new", budget: 200 }), none, NOW))).toEqual([
      "Ja'Marr Chase", "Anthony Edwards",
    ]);
    expect(names(visibleDeals(snap, prefs({ sport: "nhl" }), none, NOW))).toEqual(["Connor McDavid", "Macklin Celebrini"]);
  });

  it("shows only followed players on the mine tab, and only the searched player with a query", () => {
    const snap = sceneSnapshot();
    expect(names(visibleDeals(snap, prefs({ sport: "mine" }), new Set(["nba:22"]), NOW))).toEqual(["Nikola Jokić"]);
    expect(names(visibleDeals(snap, prefs(), none, NOW, "jokic"))).toEqual(["Nikola Jokić"]);
  });
});

describe("sportCounts", () => {
  it("counts the visible deals per sport tab, with the mine tab and the rows shown elsewhere left out", () => {
    const counts = sportCounts(sceneSnapshot(), prefs(), new Set(["nba:22", "nba:44"]), NOW, new Set(["101:target"]));
    expect(counts.all).toBe(6);
    expect(counts.mine).toBe(2);
    expect(counts.bySport).toEqual({ nfl: 1, nba: 2, nhl: 2, soccer: 1 });
    const tops = sportCounts(sceneSnapshot(), prefs(), new Set(), NOW, new Set(["101:target", "105:target", "107:target"]));
    expect(tops.bySport).toEqual({ nba: 2, nhl: 2 });
    expect(tops).not.toHaveProperty("present"); // a sport whose deals all sit in the tiles gets no tab
  });
});

describe("budgetNudge", () => {
  it("names the cheapest deal over the budget and the smallest preset that reaches it", () => {
    const snap = sceneSnapshot({ deals: sceneDeals().filter((d) => d.price > 60) });
    expect(budgetNudge(snap, prefs({ level: "new", budget: 50 }), none, NOW)).toEqual({ cheapest: 70, next: 200 });
  });

  it("offers any price when no preset reaches the cheapest deal, and nothing without a budget", () => {
    const snap = sceneSnapshot({ deals: [makeDeal({ now: NOW, price: 1500, reference: 2500, discount: 0.4 })] });
    expect(budgetNudge(snap, prefs({ budget: 1000 }), none, NOW)).toEqual({ cheapest: 1500, next: null });
    expect(budgetNudge(snap, prefs({ budget: null }), none, NOW)).toBeNull();
  });

  it("can look only at the deals that would make a hero", () => {
    const snap = sceneSnapshot({ deals: sceneDeals().filter((d) => d.listing_id !== 104) });
    // McDavid (64, a bid) is the cheapest over 50, but the cheapest safe deal is Chase at 160
    expect(budgetNudge(snap, prefs({ budget: 50 }), none, NOW)).toEqual({ cheapest: 64, next: 200 });
    expect(budgetNudge(snap, prefs({ budget: 50 }), none, NOW, isHeroMaterial)).toEqual({ cheapest: 160, next: 200 });
    const unsafe = sceneSnapshot({ deals: sceneDeals().filter((d) => d.listing_id === 103) });
    expect(budgetNudge(unsafe, prefs({ budget: 50 }), none, NOW, isHeroMaterial)).toBeNull();
  });
});

describe("goneReasonText", () => {
  it("says why in plain words", () => {
    expect(goneReasonText("countdown_started")).toBe("Someone started the countdown");
    expect(goneReasonText("outbid")).toBe("Outbid");
    expect(goneReasonText("ended")).toBe("Ended");
    expect(goneReasonText("price_moved")).toBe("Price changed");
    expect(goneReasonText("no_longer_a_deal")).toBe("No longer a deal");
  });
});

describe("hurtHidden", () => {
  const out = { injury: { status: "out" as const, part: null, back: null } };
  const snapOf = (...deals: ReturnType<typeof makeDeal>[]) => makeSnapshot({ deals });
  const deal = (over: Parameters<typeof makeDeal>[0] = {}) => makeDeal({ now: NOW, ...over });
  const none = new Set<string>();

  it("counts what the visitor's level hides only because the player is hurt, as the list itself counts: budget, sport", () => {
    const snap = snapOf(deal(out), deal({ ...out, listing_id: 2 }), deal({ listing_id: 3 }), deal({ ...out, listing_id: 4, price: 900 }), deal({ ...out, listing_id: 5, sport: "nfl" }));
    expect(hurtHidden(snap, prefs({ level: "new", budget: 500, sport: "nba" }), none, NOW)).toBe(2);
  });

  it("counts the deals of the followed players on the My players tab, which the list shows as 'all' and then narrows", () => {
    const snap = snapOf(deal({ ...out, player_id: 7 }), deal({ ...out, listing_id: 2, player_id: 8 }));
    expect(hurtHidden(snap, prefs({ level: "new", sport: "mine" }), new Set(["nba:7"]), NOW)).toBe(1);
  });

  it("counts only the deals a search matches, and lets the caller narrow further (a pass's cards)", () => {
    const snap = snapOf(deal({ ...out, player_name: "Aaron Able" }), deal({ ...out, listing_id: 2, player_name: "Ben Baker" }));
    expect(hurtHidden(snap, prefs({ level: "new" }), none, NOW, "baker")).toBe(1);
    expect(hurtHidden(snap, prefs({ level: "new" }), none, NOW, "", (d) => d.player_name === "Aaron Able")).toBe(1);
  });

  it("is 0 for a level that hides none, and when nothing is hurt", () => {
    expect(hurtHidden(snapOf(deal(out)), prefs(), none, NOW)).toBe(0);
    expect(hurtHidden(snapOf(deal()), prefs({ level: "new" }), none, NOW)).toBe(0);
  });
});
