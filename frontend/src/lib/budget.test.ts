import { describe, expect, it } from "vitest";
import type { Deal, PassMarket, PassRung } from "../data/types";
import { CHASE, JOKIC, JUDGE, MACKINNON, MCDAVID, MURRAY, PASS_MARKETS, SGA, TODAY, otdOf, passSnapshot } from "../test/passScene";
import { NOW, sceneSnapshot } from "../test/scene";
import { OTD_RULES, makeDeal } from "../test/fixtures";
import { type BuddyPlan, type PassRoute, bestBasket, bestPassStep, bestPassSteps, buddyPlan, buddySentence, laterLine, offerRouteLine, passRoute, saveUpLine, startLine } from "./budget";
import { planHoldings } from "./passes";

const group = (d: Deal) => `${d.sport}:${d.season}:${d.player_id}`;

/** A small deterministic generator: the same seed, the same deals. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The most saving any set of deals with one deal per player-season and a total within the balance can make. */
function brute(deals: Deal[], balance: number): number {
  let best = 0;
  const go = (i: number, spent: number, saved: number, used: Set<string>) => {
    best = Math.max(best, saved);
    for (let j = i; j < deals.length; j++) {
      const d = deals[j]!;
      if (spent + d.price > balance || used.has(group(d))) continue;
      used.add(group(d));
      go(j + 1, spent + d.price, saved + d.reference - d.price, used);
      used.delete(group(d));
    }
  };
  go(0, 0, 0, new Set());
  return best;
}

describe("bestBasket", () => {
  it("finds the same saving as trying every set, on random small inputs", () => {
    const random = rng(7);
    for (let run = 0; run < 250; run++) {
      const n = 1 + Math.floor(random() * 9);
      const deals = Array.from({ length: n }, (_, i) => {
        const price = 1 + Math.floor(random() * 60);
        const gap = 1 + Math.floor(random() * 40);
        return makeDeal({
          listing_id: i + 1, player_id: 1 + Math.floor(random() * 5), season: 2025 + Math.floor(random() * 2),
          price, reference: price + gap, kind: random() < 0.3 ? "bid" : "target",
        });
      });
      const balance = 1 + Math.floor(random() * 150);
      const basket = bestBasket(deals, balance);
      expect(basket.saved, `run ${run}`).toBe(brute(deals, balance));
      expect(basket.spent).toBeLessThanOrEqual(balance);
      expect(new Set(basket.deals.map(group)).size).toBe(basket.deals.length);
      expect(basket.spent).toBe(basket.deals.reduce((s, d) => s + d.price, 0));
      expect(basket.usual).toBe(basket.deals.reduce((s, d) => s + d.reference, 0));
      expect(basket.saved).toBe(basket.usual - basket.spent);
      expect(basket.left).toBe(balance - basket.spent);
    }
  });

  it("never puts two deals of one player-season in the basket, a listing's two kinds included", () => {
    const deals = [
      makeDeal({ listing_id: 1, kind: "target", price: 50, reference: 100 }),
      makeDeal({ listing_id: 1, kind: "bid", price: 40, reference: 100 }),
      makeDeal({ listing_id: 2, player_id: 2, price: 50, reference: 80 }),
    ];
    const basket = bestBasket(deals, 500);
    expect(basket.deals.map((d) => d.listing_id).sort()).toEqual([1, 2]);
    expect(basket.deals.find((d) => d.listing_id === 1)?.kind).toBe("bid"); // the bigger saving of the two
  });

  it("is empty when nothing fits, or there is no balance", () => {
    const deals = [makeDeal({ price: 300 })];
    expect(bestBasket(deals, 299).deals).toEqual([]);
    expect(bestBasket(deals, 0)).toMatchObject({ deals: [], spent: 0, usual: 0, saved: 0, left: 0 });
    expect(bestBasket([], 500).deals).toEqual([]);
  });

  it("lists the biggest saving first", () => {
    const deals = [
      makeDeal({ listing_id: 1, player_id: 1, price: 10, reference: 20 }),
      makeDeal({ listing_id: 2, player_id: 2, price: 10, reference: 60 }),
      makeDeal({ listing_id: 3, player_id: 3, price: 10, reference: 40 }),
    ];
    expect(bestBasket(deals, 100).deals.map((d) => d.listing_id)).toEqual([2, 3, 1]);
  });

  it("stays inside a big balance and close to the best, quickly", () => {
    const random = rng(11);
    const deals = Array.from({ length: 180 }, (_, i) => {
      const price = 40 + Math.floor(random() * 900);
      return makeDeal({ listing_id: i + 1, player_id: i + 1, price, reference: Math.round(price * (1.25 + random() * 0.6)) });
    });
    const balance = 25_000;
    const started = Date.now();
    const basket = bestBasket(deals, balance);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(basket.spent).toBeLessThanOrEqual(balance);
    // at least as good as taking the biggest saving per Rax first
    let spent = 0;
    let greedy = 0;
    for (const d of [...deals].sort((a, b) => (b.reference - b.price) / b.price - (a.reference - a.price) / a.price)) {
      if (spent + d.price <= balance) {
        spent += d.price;
        greedy += d.reference - d.price;
      }
    }
    expect(basket.saved).toBeGreaterThanOrEqual(greedy * 0.99);
  });
});

describe("buddyPlan", () => {
  const snap = sceneSnapshot();

  it("uses what the level shows: New has no auction, Regular has", () => {
    const fresh = buddyPlan(snap, "new", 1000, NOW).basket.deals.map((d) => d.player_name);
    expect(fresh).toEqual(expect.arrayContaining(["Ja'Marr Chase", "Anthony Edwards"]));
    expect(fresh).not.toContain("Connor McDavid"); // a bid
    expect(fresh).not.toContain("Josh Allen"); // medium confidence
    const regular = buddyPlan(snap, "regular", 1000, NOW).basket.deals.map((d) => d.player_name);
    expect(regular).toContain("Connor McDavid");
    expect(regular).toContain("Josh Allen");
  });

  it("leaves falling deals out at every level, since their usual price may be above what they sell for now", () => {
    for (const level of ["new", "regular", "pro"] as const) {
      expect(buddyPlan(snap, level, 5000, NOW).basket.deals.map((d) => d.player_name)).not.toContain("Nikola Jokić");
    }
  });

  it("ignores the visitor's budget and sport, since the balance is the budget", () => {
    const plan = buddyPlan(snap, "regular", 5000, NOW);
    expect(new Set(plan.basket.deals.map((d) => d.sport)).size).toBeGreaterThan(1);
  });

  it("keeps to the sport the visitor chose, and to every sport when none is chosen (or 'mine')", () => {
    const sports = (sport?: string) => [...new Set(buddyPlan(snap, "regular", 5000, NOW, sport).basket.deals.map((d) => d.sport))].sort();
    expect(sports()).toEqual(["nba", "nfl", "nhl", "soccer"]);
    expect(sports("all")).toEqual(["nba", "nfl", "nhl", "soccer"]);
    expect(sports("mine")).toEqual(["nba", "nfl", "nhl", "soccer"]); // followed players are not a sport
    expect(sports("nhl")).toEqual(["nhl"]);
    expect(sports("nfl")).toEqual(["nfl"]);
    expect(buddyPlan(snap, "regular", 5000, NOW, "golf").basket.deals).toEqual([]);
  });

  it("keeps the balance as the budget when a sport is chosen, and the passes to that sport", () => {
    const p = passSnapshot();
    const nhl = buddyPlan({ ...p, deals: sceneSnapshot().deals }, "regular", 400, NOW, "nhl");
    expect(nhl.basket.spent).toBeLessThanOrEqual(400);
    expect(nhl.route.picks.map((x) => x.market.sport)).toEqual(["nhl"]);
    expect(buddyPlan(p, "regular", 400, NOW, "ufc").route.picks).toEqual([]); // no pass of that sport pays back
    expect(buddyPlan(p, "regular", 5000, NOW).route.picks.length).toBeGreaterThan(0);
  });

  it("leaves out a deal whose auction has ended by the clock", () => {
    const old = { ...snap, deals: snap.deals.map((d) => ({ ...d, ends_at: new Date(NOW - 1000).toISOString() })) };
    expect(buddyPlan(old, "regular", 5000, NOW).basket.deals).toEqual([]);
  });
});

const rung = (over: Partial<PassRung>): PassRung => ({
  tier: "rare", rating: 80, mult: 4, limit: 2000, limit_estimated: false, rating_to_add: 0, cost: 500, route: "cards",
  year_rax: 120, year_capped: false, projected: false, per_game_day: 1, years_to_limit: 6, year_per_rax: 0.24,
  lifetime_per_rax: 4, pays_back: true, payback_months: 50, payback_month: "2030-12", ...over,
});
const market = (key: string, rungs: PassRung[], name = key): PassMarket =>
  ({ key, sport: "nba", season: 2025, season_label: "2024-25", season_state: "past", player_id: 1, player_name: name,
     team_id: null, position: null, kind: "player", base_1x: 1, season_progress: 1, game_days: 80,
     game_days_measured: true, month_share: [], month_share_estimated: true, rate_traded: 1, rate_sales: 9, shelf: [],
     shelf_count: 0, mint_cost: 200, mintable: true, rungs, best: null, weak: [], on_sale: null }) as PassMarket;

describe("bestPassStep", () => {
  it("picks the rung that pays the most a year among those the balance reaches and that pay back", () => {
    const markets = [
      market("a", [rung({ tier: "common", cost: 100, year_rax: 40 }), rung({ tier: "rare", cost: 800, year_rax: 150 })], "Ann"),
      market("b", [rung({ tier: "epic", cost: 700, year_rax: 300, pays_back: false })], "Bob"), // never pays back
      market("c", [rung({ tier: "epic", cost: 600, year_rax: 220 }), rung({ tier: "legendary", cost: 9000, year_rax: 900 })], "Cy"),
      market("d", [rung({ tier: "rare", cost: null as unknown as number, year_rax: 999 })], "Di"), // cannot be priced
    ];
    const step = bestPassStep(markets, 850);
    expect([step?.market.player_name, step?.rung.tier]).toEqual(["Cy", "epic"]);
    expect(bestPassStep(markets, 90)).toBeNull();
    expect(bestPassStep(markets, 0)).toBeNull();
    expect(bestPassStep([], 5000)).toBeNull();
  });

  it("breaks a tie by the better return per Rax, then the lower cost", () => {
    const markets = [
      market("a", [rung({ cost: 500, year_rax: 100, year_per_rax: 0.2 })], "Ann"),
      market("b", [rung({ cost: 400, year_rax: 100, year_per_rax: 0.25 })], "Bob"),
    ];
    expect(bestPassStep(markets, 1000)?.market.player_name).toBe("Bob");
  });
});

describe("bestPassSteps", () => {
  const markets = [
    market("a", [rung({ tier: "common", cost: 100, year_rax: 40 }), rung({ tier: "rare", cost: 800, year_rax: 150 })], "Ann"),
    market("b", [rung({ tier: "epic", cost: 700, year_rax: 300, pays_back: false })], "Bob"), // never pays back
    market("c", [rung({ tier: "epic", cost: 600, year_rax: 220 }), rung({ tier: "legendary", cost: 9000, year_rax: 900 })], "Cy"),
    market("e", [rung({ tier: "rare", cost: 300, year_rax: 90 })], "Ed"),
  ];

  it("lists the passes the balance can build, one rung each (the best it reaches), most Rax a year first", () => {
    const steps = bestPassSteps(markets, 850, 5);
    expect(steps.map((s) => [s.market.player_name, s.rung.tier])).toEqual([
      ["Cy", "epic"], ["Ann", "rare"], ["Ed", "rare"],
    ]);
  });

  it("stops at the number asked, and agrees with the single best step", () => {
    expect(bestPassSteps(markets, 850, 2).map((s) => s.market.player_name)).toEqual(["Cy", "Ann"]);
    expect(bestPassSteps(markets, 850, 1)[0]).toEqual(bestPassStep(markets, 850));
    expect(bestPassSteps(markets, 50, 5)).toEqual([]);
  });

});

describe("buddySentence", () => {
  const plan = (deals: Deal[]): BuddyPlan => ({ basket: bestBasket(deals, 840), route: EMPTY_ROUTE, dealNet: 0, lead: deals.length ? "deals" : "none" });
  it("says the best you can do right now, in plain words", () => {
    const deals = [
      makeDeal({ listing_id: 1, player_id: 1, price: 300, reference: 420 }),
      makeDeal({ listing_id: 2, player_id: 2, price: 400, reference: 500 }),
    ];
    expect(buddySentence(840, plan(deals), false)).toBe(
      "With 840 Rax, the best you can do right now is 2 deals: 700 Rax for cards usually worth 920, so you save about 220.",
    );
    expect(buddySentence(840, plan([deals[0]!]), false)).toContain("is 1 deal: 300 Rax for a card usually worth 420, so you save about 120.");
  });
  it("says so when no deal fits, and offers the pass when there is one", () => {
    expect(buddySentence(20, plan([]), false)).toBe("With 20 Rax, no deal fits right now.");
  });
  it("names the sport when one is chosen", () => {
    const deals = [makeDeal({ listing_id: 1, player_id: 1, price: 300, reference: 420 })];
    expect(buddySentence(840, plan(deals), false, "nhl")).toBe(
      "With 840 Rax, the best you can do right now in NHL is 1 deal: 300 Rax for a card usually worth 420, so you save about 120.",
    );
    expect(buddySentence(20, plan([]), false, "nhl")).toBe("With 20 Rax, no NHL deal fits right now.");
    expect(buddySentence(20, plan([]), false, "all")).toBe("With 20 Rax, no deal fits right now.");
    expect(buddySentence(20, plan([]), false, "mine")).toBe("With 20 Rax, no deal fits right now.");
  });
  it("does not say what to do while the data is paused", () => {
    const text = buddySentence(840, plan([makeDeal()]), true);
    expect(text).toBe("Prices are paused right now, so we cannot say what 840 Rax can do. Try again when the live dot is back.");
    expect(text).not.toContain("best you can do");
  });
});

const EMPTY_ROUTE: PassRoute = {
  picks: [], spent: 0, year: 0, payback_months: null, payback_month: null, first_pay: null, offer_spent: null, cheapest: null,
  later: null,
};

/** A pass of `sport` with these rungs; its months are the sport's (an estimate), so it pays in November. */
const pass = (key: string, sport: string, ladder: Partial<PassRung>[]): PassMarket =>
  ({ ...market(key, ladder.map((r) => rung(r)), key), sport, player_id: key.length * 7 + key.charCodeAt(0) }) as PassMarket;

/** The most Rax a year any set of rungs (one per pass, at most `per` passes of a sport, within the balance) pays. */
function bruteRoute(markets: PassMarket[], balance: number, per: number): number {
  let best = 0;
  const go = (i: number, spent: number, year: number, count: Record<string, number>) => {
    best = Math.max(best, year);
    for (let j = i; j < markets.length; j++) {
      const m = markets[j]!;
      if ((count[m.sport] ?? 0) >= per) continue;
      for (const r of m.rungs) {
        if (!r.pays_back || r.cost === null || r.cost <= 0 || spent + r.cost > balance || !(r.year_rax > 0)) continue;
        if (r.lifetime_per_rax !== null && r.lifetime_per_rax <= 1) continue;
        count[m.sport] = (count[m.sport] ?? 0) + 1;
        go(j + 1, spent + r.cost, year + r.year_rax, count);
        count[m.sport]! -= 1;
      }
    }
  };
  go(0, 0, 0, {});
  return best;
}

describe("passRoute", () => {
  const otd = otdOf(PASS_MARKETS);
  const route = (balance: number, over: Partial<Parameters<typeof passRoute>[3]> = {}, markets = PASS_MARKETS) =>
    passRoute({ ...otdOf(markets) }, OTD_RULES, balance, { level: "regular", ...over });

  it("builds the passes that pay the most in the next 12 months within the balance, at most 2 a sport", () => {
    const random = rng(7);
    for (let round = 0; round < 40; round++) {
      const markets: PassMarket[] = [];
      for (let i = 0; i < 7; i++) {
        const sport = ["nba", "nhl", "nfl"][Math.floor(random() * 3)]!;
        const ladder = [1, 2, 3].map(() => {
          const cost = 50 + Math.floor(random() * 900);
          return { tier: "common", cost, year_rax: Math.floor(random() * 2 * cost), pays_back: random() > 0.15, lifetime_per_rax: 3 };
        });
        markets.push(pass(`p${round}x${i}`, sport, ladder));
      }
      const balance = 200 + Math.floor(random() * 2500);
      const got = passRoute({ markets, as_of: `${TODAY}T00:00:00Z`, sports: {} }, OTD_RULES, balance, { level: "regular" });
      expect(got.year).toBeCloseTo(bruteRoute(markets, balance, 2));
      expect(got.spent).toBeLessThanOrEqual(balance);
      const per: Record<string, number> = {};
      for (const p of got.picks) per[p.market.sport] = (per[p.market.sport] ?? 0) + 1;
      expect(Math.max(0, ...Object.values(per))).toBeLessThanOrEqual(2);
    }
  });

  it("adds up passes that each win their claims: the planner replays them to the same total", () => {
    const got = route(12000);
    expect(got.picks.length).toBeGreaterThan(2);
    const plan = planHoldings(got.picks.map((p) => ({ key: p.market.key, tier: p.rung.tier })), otd.markets, OTD_RULES, otd.sports);
    expect(plan.total).toBeCloseTo(got.year, 0);
    expect(got.picks.map((p) => p.rung.year_rax)).toEqual([...got.picks.map((p) => p.rung.year_rax)].sort((a, b) => b - a));
  });

  it("never offers a team pass nor one that never pays back", () => {
    const keys = route(100000).picks.map((p) => p.market.key);
    expect(keys.some((k) => k.includes(":team:"))).toBe(false);
    expect(keys).not.toContain("ufc:2025:fighter:5001");
  });

  it("pays back when its one pass does, and says when it starts paying", () => {
    const got = route(300, {}, [MACKINNON]); // Common, 255
    expect(got.picks.map((p) => p.rung.tier)).toEqual(["common"]);
    const r = MACKINNON.rungs.find((x) => x.tier === "common")!;
    expect(got.payback_months).toBeCloseTo(r.payback_months!);
    expect(got.payback_month).toBe(r.payback_month);
    expect(got.first_pay).toBe(0); // NHL pays in November
  });

  it("leaves a pass that pays only months from now for later, and names when to buy it", () => {
    const got = route(5000, {}, [...PASS_MARKETS, JUDGE]);
    expect(got.picks.map((p) => p.market.key)).not.toContain(JUDGE.key);
    expect(got.later?.market.key).toBe(JUDGE.key);
    expect([got.later?.from, got.later?.buy]).toEqual([3, 2]);
    expect(route(5000, {}, PASS_MARKETS).later).toBeNull();
  });

  it("keeps New to passes paid back within a year that are not projections", () => {
    for (const p of route(100000, { level: "new" }).picks) {
      expect(p.rung.projected).toBe(false);
      expect(p.rung.payback_months!).toBeLessThanOrEqual(12);
    }
    expect(route(100000, { level: "new" }).picks.map((p) => p.market.key)).not.toContain(CHASE.key); // half played: projected
  });

  it("fills only the claims a holder's passes leave, and never a pass already held", () => {
    const holdings = [{ key: JOKIC.key, tier: "common" }, { key: SGA.key, tier: "common" }];
    const got = route(20000, { holdings, held: otd.markets, sports: otd.sports });
    expect(got.picks.some((p) => p.market.sport === "nba")).toBe(false); // two NBA passes held: both claims taken
    const one = route(20000, { holdings: [{ key: JOKIC.key, tier: "common" }], held: otd.markets, sports: otd.sports });
    expect(one.picks.filter((p) => p.market.sport === "nba").map((p) => p.market.key)).not.toContain(JOKIC.key);
    expect(one.picks.filter((p) => p.market.sport === "nba").length).toBeLessThanOrEqual(1);
  });

  it("keeps to one sport when asked", () => {
    expect(new Set(route(20000, { sport: "nhl" }).picks.map((p) => p.market.sport))).toEqual(new Set(["nhl"]));
  });

  it("says what the cards would cost by offers, and the cheapest pass when none fits", () => {
    const got = route(5000);
    expect(got.offer_spent).not.toBeNull();
    expect(got.offer_spent!).toBeLessThan(got.spent);
    const none = route(100);
    expect(none.picks).toEqual([]);
    expect(none.cheapest).toBe(Math.min(...[MACKINNON, MCDAVID, JOKIC, MURRAY, CHASE].flatMap((m) =>
      m.rungs.filter((r) => r.pays_back && r.cost !== null && r.lifetime_per_rax! > 1).map((r) => r.cost!)))); // the NFL General, 200
  });
});

describe("buddyPlan, passes first", () => {
  const snap = { ...passSnapshot(), deals: sceneSnapshot().deals };

  it("leads with passes when they pay back more in a year than the deals leave after fees", () => {
    const plan = buddyPlan(snap, "regular", 5000, NOW);
    expect(plan.lead).toBe("passes");
    expect(plan.route.year).toBeGreaterThan(plan.dealNet);
    expect(plan.dealNet).toBeCloseTo(plan.basket.deals.reduce((s, d) => s + d.flip_margin, 0));
  });

  it("leads with deals when no pass that pays back fits the balance", () => {
    const plan = buddyPlan(snap, "regular", 150, NOW);
    expect(plan.route.picks).toEqual([]);
    expect(plan.lead).toBe(plan.basket.deals.length ? "deals" : "none");
  });
});

describe("buddySentence, passes first", () => {
  const snap = { ...passSnapshot(), deals: sceneSnapshot().deals };
  it("says the passes, what they pay in a year and when they pay back, then what the deals would leave", () => {
    const plan = buddyPlan(snap, "regular", 5000, NOW);
    const text = buddySentence(5000, plan, false, "all", TODAY);
    expect(text).toMatch(/^With 5,000 Rax, passes pay you most: \d passes? for about [\d,]+ Rax should pay about [\d,]+ Rax over the next 12 months, paid back in about \d+ months? \(by [A-Z][a-z]+\)\./);
  });
  it("says one pass in the singular", () => {
    const plan = buddyPlan({ ...snap, otd: otdOf([MACKINNON]) }, "regular", 300, NOW);
    expect(buddySentence(300, plan, false, "all", TODAY)).toMatch(/^With 300 Rax, passes pay you most: 1 pass for about 260 Rax should pay about /);
  });
});

describe("the route's other lines", () => {
  const base: PassRoute = { ...EMPTY_ROUTE, picks: [{ market: MACKINNON, rung: { ...MACKINNON.rungs[0]!, cost: 255 }, offer: null }], spent: 255, year: 1000 };
  it("says when the passes start paying", () => {
    expect(startLine({ ...base, first_pay: 0 }, TODAY)).toBe("Starts paying this month.");
    expect(startLine({ ...base, first_pay: 1 }, TODAY)).toBe("Starts paying in December.");
    expect(startLine({ ...base, first_pay: null }, TODAY)).toBeNull();
    expect(startLine(EMPTY_ROUTE, TODAY)).toBeNull();
  });
  it("says what offers could bring the passes to, as an expectation", () => {
    expect(offerRouteLine({ ...base, offer_spent: 210 })).toBe(
      "Cheaper with offers: offer about 20% under the usual price on many of its cards. Most offers are refused (about 1 in 6 is accepted in what we measured), so send many: if enough are accepted, this pass costs about 210 Rax instead of 260.",
    );
    const two = { ...base, picks: [...base.picks, ...base.picks], spent: 510, offer_spent: 420 };
    expect(offerRouteLine(two)).toContain("on many of their cards.");
    expect(offerRouteLine(two)).toContain("these passes cost about 420 Rax instead of 510.");
    expect(offerRouteLine({ ...base, offer_spent: null })).toBeNull();
  });
  it("says how far a balance is from the cheapest pass, and that offers get there for less", () => {
    expect(saveUpLine(100, { ...EMPTY_ROUTE, cheapest: 255 })).toBe(
      "No pass that pays back fits 100 Rax yet: the cheapest costs about 260, so about 160 to go. Offers under the usual price can build it for less.",
    );
    expect(saveUpLine(100, base)).toBeNull();
    expect(saveUpLine(100, EMPTY_ROUTE)).toBeNull();
  });
  it("names a pass whose sport pays later, with the month to buy it in", () => {
    const later = { market: JUDGE, rung: { ...JUDGE.rungs[0]!, cost: 250 }, from: 3, buy: 2 };
    expect(laterLine({ ...base, later })).toBe("Later: MLB pays from March — better bought in February, not sooner (Aaron Judge 2026).");
    expect(laterLine(base)).toBeNull();
  });
});
