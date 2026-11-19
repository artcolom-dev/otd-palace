import { describe, expect, it } from "vitest";
import type { Snapshot } from "../data/types";
import { isoAt, makeDeal } from "../test/fixtures";
import { JOKIC, JUDGE, MACKINNON, MCDAVID, MURRAY, OLIVEIRA, PASS_MARKETS, SGA, THUNDER, otdOf, passSnapshot } from "../test/passScene";
import { NOW } from "../test/scene";
import { FREE_ORDER, type NextRaxInput, nextRax, resellText } from "./nextRax";
import { replaySport, resolveHolding } from "./passes";

const base: NextRaxInput = {
  holdings: [],
  level: "regular",
  budget: null,
  passBudget: null,
  balance: null,
  now: NOW,
  paused: false,
  n: 5,
};
const run = (snap: Snapshot, over: Partial<NextRaxInput> = {}) => nextRax(snap, { ...base, ...over });

describe("nextRax: a free player (no pass held)", () => {
  const snap = passSnapshot();

  it("says it is the free-player case and offers the first pass of each sport, best return per Rax first", () => {
    const r = run(snap, { balance: 400 });
    expect(r.free).toBe(true);
    expect(FREE_ORDER).toHaveLength(3);
    const slots = r.moves.filter((m) => m.kind === "slot");
    expect(slots.map((m) => m.sport)).toEqual(["nhl", "nba", "nfl"]); // best a year per Rax first; a season being played has its live games filling its limit (B9)
    expect(new Set(slots.map((m) => m.sport)).size).toBe(slots.length); // one per sport
    expect(slots[0]).toMatchObject({ cost: 365, year: 1500, title: "Add a pass in NHL: a daily claim is free" });
    expect(slots[0]!.what).toBe("Nathan MacKinnon 2025-26 · Uncommon");
    expect(slots[0]!.returns).toBe("about 1,500 a year (estimate)");
  });

  it("never costs more than the balance typed, and is empty when nothing fits", () => {
    for (const m of run(snap, { balance: 400 }).moves) expect(m.cost).toBeLessThanOrEqual(400);
    expect(run(snap, { balance: 150 }).moves).toEqual([]);
  });

  it("respects the most the visitor spends on one pass", () => {
    for (const m of run(snap, { passBudget: 330 }).moves) expect(m.cost).toBeLessThanOrEqual(330);
  });

  it("leaves a season in progress and a slow payback out at New, keeps them at Regular", () => {
    const keys = (level: "new" | "regular") => run(snap, { level, balance: 1000 }).moves.map((m) => m.market?.key);
    expect(keys("regular")).toContain(PASS_MARKETS.find((m) => m.sport === "nfl")!.key);
    expect(keys("new")).not.toContain(PASS_MARKETS.find((m) => m.sport === "nfl")!.key);
  });
});

describe("nextRax: the season's clock", () => {
  it("does not offer now a pass whose pay is months away (a past MLB season in November), held or not", () => {
    const snap = passSnapshot({ otd: otdOf([...PASS_MARKETS, JUDGE]) });
    expect(JUDGE.rungs.find((r) => r.tier === JUDGE.best)!.year_per_rax).toBeGreaterThan(4); // the best a Rax ...
    expect(run(snap).moves.map((m) => m.market?.key)).not.toContain(JUDGE.key); // ... but nothing until March
    const held = run(snap, { holdings: [{ key: JUDGE.key, tier: "common" }] });
    expect(held.moves.map((m) => m.market?.key)).not.toContain(JUDGE.key);
  });
});

describe("nextRax: empty slots and teammates", () => {
  it("a sport already holding two passes on one team still has room: the third adds less than it pays alone", () => {
    const snap = passSnapshot({ otd: otdOf([JOKIC, MURRAY, SGA]) });
    const r = run(snap, { holdings: [{ key: JOKIC.key, tier: "common" }, { key: MURRAY.key, tier: "common" }] });
    const nba = r.moves.find((m) => m.sport === "nba" && m.kind === "slot");
    expect(nba?.market?.key).toBe(SGA.key);
    expect(nba!.year!).toBeGreaterThan(0);
    expect(nba!.year!).toBeLessThanOrEqual(nba!.rung!.year_rax + 1e-9);
  });

  it("a pass alone in its sport adds exactly what the pass pays: nothing is competing for its days", () => {
    const snap = passSnapshot({ otd: otdOf([JOKIC, MACKINNON, MCDAVID]) });
    const nhl = run(snap, { holdings: [{ key: JOKIC.key, tier: "common" }] }).moves.find((m) => m.sport === "nhl")!;
    expect(nhl.year).toBe(nhl.rung!.year_rax);
    expect(nhl.cost).toBe(nhl.rung!.cost);
  });

  it("says when the pass plays on the same days as one held", () => {
    const snap = passSnapshot({ otd: otdOf([JOKIC, MURRAY]) });
    const r = run(snap, { holdings: [{ key: JOKIC.key, tier: "common" }] });
    const move = r.moves.find((m) => m.market?.key === MURRAY.key)!;
    expect(move.note).toBe("Plays on the same days as Nikola Jokić.");
    const other = passSnapshot({ otd: otdOf([JOKIC, SGA]) });
    expect(run(other, { holdings: [{ key: JOKIC.key, tier: "common" }] }).moves.find((m) => m.market?.key === SGA.key)!.note).toBeNull();
  });

  it("does not offer a pass already held, a team pass, an unpriced pass or one that never pays back", () => {
    const snap = passSnapshot({ otd: otdOf([JOKIC, THUNDER, OLIVEIRA]) });
    const keys = run(snap, { holdings: [{ key: JOKIC.key, tier: "common" }] }).moves.filter((m) => m.kind === "slot").map((m) => m.market?.key);
    expect(keys).not.toContain(JOKIC.key);
    expect(keys).not.toContain(THUNDER.key); // a team pass: its cards cannot be priced
    expect(keys).not.toContain(OLIVEIRA.key); // never pays back
  });

  it("a held pass the app says is maxed leaves its slot empty, and no lift is offered for it", () => {
    const snap = passSnapshot({ otd: otdOf([JOKIC, SGA]) });
    const r = run(snap, { holdings: [{ key: JOKIC.key, tier: "common", spent: true }] });
    expect(r.moves.some((m) => m.kind === "rung")).toBe(false);
    expect(r.moves.some((m) => m.market?.key === SGA.key)).toBe(true);
  });
});

describe("nextRax: rating that crosses a rung", () => {
  const snap = passSnapshot({ otd: otdOf([MACKINNON]) });

  it("from Uncommon, takes the lift that returns the most per Rax, which crosses to Epic (4x to 10x)", () => {
    const r = run(snap, { holdings: [{ key: MACKINNON.key, tier: "uncommon" }] });
    const lift = r.moves.find((m) => m.kind === "rung")!;
    expect(lift.title).toBe("Lift Nathan MacKinnon to Epic");
    expect(lift.cost).toBe(825); // 150 more rating at 5.5 a point
    expect(lift.year).toBe(3500); // Epic's 5,000 a year over Uncommon's 1,500
    expect(lift.returns).toBe("adds about 3,500 a year (estimate)");
    expect(lift.per).toBeCloseTo(3500 / 825, 9);
    expect(lift.what).toBe("Nathan MacKinnon 2025-26 · about 150 more rating");
    expect(lift.resell).toBe("yes");
  });

  it("a General held pays nothing On This Day: its next move is its cards to Common, without the mint", () => {
    const r = run(snap, { holdings: [{ key: MACKINNON.key, tier: "general" }] });
    const lift = r.moves.find((m) => m.kind === "rung")!;
    expect(lift.title).toBe("Lift Nathan MacKinnon to Common");
    expect(lift.cost).toBe(55); // 10 rating at 5.5 a point: the pass is minted already
    expect(lift.year).toBe(1000); // Common's 1,000 a year over General's nothing
    expect(lift.rung!.route).toBe("cards");
  });

  it("with an exact rating just under a rung, the lift costs only the few points that cross it", () => {
    const r = run(snap, { holdings: [{ key: MACKINNON.key, rating: 170 }] });
    const lift = r.moves.find((m) => m.kind === "rung")!;
    expect(lift.title).toBe("Lift Nathan MacKinnon to Epic");
    expect(lift.cost).toBeCloseTo(55, 6); // 10 points at 5.5
    expect(lift.year).toBe(3000); // Epic 5,000 over Rare 2,000
    expect(r.moves[0]).toBe(lift); // by far the best use of a Rax here
  });

  it("takes the nearer rung when the far one costs more than the balance or the pass budget, and none when both do", () => {
    const holdings = [{ key: MACKINNON.key, tier: "uncommon" }];
    const near = run(snap, { holdings, balance: 500 }).moves.find((m) => m.kind === "rung")!;
    expect(near.title).toBe("Lift Nathan MacKinnon to Rare");
    expect(near.cost).toBe(275);
    expect(run(snap, { holdings, passBudget: 500 }).moves.find((m) => m.kind === "rung")!.title).toBe("Lift Nathan MacKinnon to Rare");
    expect(run(snap, { holdings, balance: 250 }).moves.some((m) => m.kind === "rung")).toBe(false);
    expect(run(snap, { holdings, passBudget: 250 }).moves.some((m) => m.kind === "rung")).toBe(false);
  });

  it("in a sport whose claims are contested, a lift adds what it adds to the sport, never more than it pays alone", () => {
    const snap = passSnapshot({ otd: otdOf([JOKIC, MURRAY, SGA]) });
    const holdings = [{ key: JOKIC.key, tier: "legendary" }, { key: MURRAY.key, tier: "legendary" }, { key: SGA.key, tier: "uncommon" }];
    const rules = snap.rules.otd;
    const lifts = run(snap, { holdings, n: 8 }).moves.filter((m) => m.kind === "rung");
    expect(lifts.length).toBeGreaterThan(0);
    const held = holdings.map((h) => resolveHolding(h, snap.otd.markets, rules)!);
    const before = replaySport("nba", held, rules, snap.otd.sports).total;
    for (const lift of lifts) {
      const i = held.findIndex((h) => h.market.key === lift.market!.key);
      const lifted = resolveHolding({ key: lift.market!.key, rating: held[i]!.rating + lift.rung!.rating_to_add }, snap.otd.markets, rules)!;
      const after = replaySport("nba", held.map((h, j) => (j === i ? lifted : h)), rules, snap.otd.sports).total;
      expect(lift.year).toBeCloseTo(after - before, 6);
      expect(lift.year!).toBeLessThanOrEqual((lift.rung as unknown as { extra_year: number }).extra_year + 1e-9);
      expect(lift.per).toBeCloseTo(lift.year! / lift.cost, 9);
    }
  });

  it("a lift that never gets into its sport's two claims (two stronger teammates, the same days) is not offered", () => {
    // MacKinnon moved onto McDavid's team, beside a second Oiler: three passes on the same days, two claims a day.
    const oiler = { ...MCDAVID, key: "nhl:2026:player:778", player_id: 778, player_name: "Second Oiler" };
    const mate = { ...MACKINNON, team_id: MCDAVID.team_id, game_days: MCDAVID.game_days };
    const holdings = [{ key: MCDAVID.key, tier: "legendary" }, { key: oiler.key, tier: "legendary" }, { key: mate.key, tier: "uncommon" }];
    const alone = run(passSnapshot({ otd: otdOf([mate]) }), { holdings: [{ key: mate.key, tier: "uncommon" }], n: 8 });
    expect(alone.moves.some((m) => m.kind === "rung")).toBe(true); // on its own, lifting it pays
    const r = run(passSnapshot({ otd: otdOf([MCDAVID, oiler, mate]) }), { holdings, n: 8 });
    expect(r.moves.some((m) => m.kind === "rung" && m.market?.key === mate.key)).toBe(false);
  });

  it("is not offered for a pass whose market is no longer served", () => {
    const gone = run(passSnapshot({ otd: otdOf([JOKIC]) }), { holdings: [{ key: MACKINNON.key, tier: "uncommon" }] });
    expect(gone.moves.some((m) => m.kind === "rung")).toBe(false);
  });
});

describe("nextRax: deals", () => {
  const good = makeDeal({ listing_id: 11, player_id: 501, player_name: "Good Deal", price: 47, reference: 330, flip_margin: 232, discount: 0.86, now: NOW });
  const snapWith = (...deals: ReturnType<typeof makeDeal>[]) => passSnapshot({ otd: otdOf([]), deals });

  it("offers a deal with a positive margin after fees, as '+N after fees'", () => {
    const r = run(snapWith(good), { level: "regular" });
    expect(r.moves).toHaveLength(1);
    expect(r.moves[0]).toMatchObject({ kind: "deal", cost: 47, net: 232, returns: "+232 after fees", title: "Deal: Good Deal", resell: "yes" });
    expect(r.moves[0]!.per).toBeCloseTo(232 / 47, 9);
  });

  it("leaves out thin deals (a usual price under the fees' reach), falling markets, losses and what the budget cannot pay", () => {
    const thin = makeDeal({ listing_id: 12, player_id: 502, price: 40, reference: 120, flip_margin: 62, discount: 0.66, now: NOW });
    const falling = makeDeal({ listing_id: 13, player_id: 503, price: 200, reference: 400, flip_margin: 150, falling: true, discount: 0.5, now: NOW });
    const loss = makeDeal({ listing_id: 14, player_id: 504, price: 390, reference: 410, flip_margin: -20, discount: 0.3, now: NOW });
    const dear = makeDeal({ listing_id: 15, player_id: 505, price: 900, reference: 1300, flip_margin: 290, discount: 0.3, now: NOW });
    const snap = snapWith(thin, falling, loss, dear, good);
    expect(run(snap, { level: "regular", budget: 500 }).moves.map((m) => m.deal?.listing_id)).toEqual([11]);
    expect(run(snap, { level: "regular", balance: 100 }).moves.map((m) => m.deal?.listing_id)).toEqual([11]);
  });

  it("follows the level: New shows no bid, a deal under its discount is hidden", () => {
    const bid = makeDeal({ listing_id: 16, player_id: 506, kind: "bid", ends_at: isoAt(NOW + 10 * 60_000), price: 300, reference: 500, flip_margin: 140, discount: 0.4, now: NOW });
    const mild = makeDeal({ listing_id: 17, player_id: 507, price: 300, reference: 380, flip_margin: 28, discount: 0.21, now: NOW });
    const snap = snapWith(bid, mild);
    expect(run(snap, { level: "new" }).moves).toEqual([]);
    expect(run(snap, { level: "regular", budget: null }).moves.map((m) => m.deal?.listing_id).sort()).toEqual([16, 17]);
  });

  it("keeps one deal per player-season", () => {
    const a = makeDeal({ listing_id: 21, player_id: 600, price: 100, reference: 400, flip_margin: 250, discount: 0.75, now: NOW });
    const b = makeDeal({ listing_id: 22, player_id: 600, price: 150, reference: 400, flip_margin: 200, discount: 0.6, now: NOW });
    expect(run(snapWith(a, b)).moves.map((m) => m.deal?.listing_id)).toEqual([21]);
  });

  it("paused: no deal is offered, the passes still are, and it says so", () => {
    const snap = passSnapshot({ deals: [good] });
    const r = run(snap, { paused: true, balance: 400 });
    expect(r.paused).toBe(true);
    expect(r.moves.some((m) => m.kind === "deal")).toBe(false);
    expect(r.moves.some((m) => m.kind === "slot")).toBe(true);
  });
});

describe("nextRax: the ranking", () => {
  it("ranks by return per Rax, a pass's year against a deal's margin, and cuts to n", () => {
    const deal = makeDeal({ listing_id: 11, player_id: 501, price: 47, reference: 330, flip_margin: 232, discount: 0.86, now: NOW });
    const snap = passSnapshot({ deals: [deal] });
    const all = run(snap, { n: 20, balance: 5000 });
    const pers = all.moves.map((m) => m.per);
    expect(pers).toEqual([...pers].sort((a, b) => b - a));
    expect(all.moves.map((m) => m.kind)).toContain("deal");
    expect(run(snap, { n: 2, balance: 5000 }).moves).toHaveLength(2);
    expect(run(snap, { balance: 5000 }).moves).toHaveLength(4); // three sports' slots and the deal: fewer than 5
    expect(run(snap, { n: undefined, balance: 5000 }).moves).toHaveLength(3);
  });

  it("is deterministic and never offers a pack", () => {
    const snap = passSnapshot();
    const a = run(snap, { n: 20, balance: 5000 });
    expect(run(snap, { n: 20, balance: 5000 })).toEqual(a);
    for (const m of a.moves) expect(["slot", "rung", "deal"]).toContain(m.kind);
    expect(JSON.stringify(a.moves.map((m) => [m.title, m.what, m.returns]))).not.toMatch(/pack/i);
  });

  it("invents nothing: each pass move's cost and pay are a served rung's, each deal's margin the deal's own", () => {
    const deal = makeDeal({ listing_id: 11, player_id: 501, price: 47, reference: 330, flip_margin: 232, discount: 0.86, now: NOW });
    const snap = passSnapshot({ deals: [deal] });
    for (const m of run(snap, { n: 20, balance: 9000, holdings: [{ key: MACKINNON.key, tier: "uncommon" }] }).moves) {
      if (m.kind === "slot") {
        expect(m.cost).toBe(m.rung!.cost);
        expect(m.year!).toBeLessThanOrEqual(m.rung!.year_rax + 1e-9);
      }
      if (m.kind === "deal") expect(m.net).toBe(m.deal!.flip_margin);
      expect(m.returns).toMatch(/estimate\)$|after fees$/);
    }
  });
});

describe("resellText", () => {
  it("claims only what is known", () => {
    expect(resellText("yes")).toBe("Resellable: market cards trade");
    expect(resellText("partly")).toBe("The cards resell; the mint may not");
    expect(resellText("unknown")).toBe("Resale not known");
  });
});
