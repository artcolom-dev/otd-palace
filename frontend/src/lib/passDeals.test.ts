import { describe, expect, it } from "vitest";
import type { PassMarket } from "../data/types";
import { OTD_RULES } from "../test/fixtures";
import { JOKIC, MACKINNON, MCDAVID, MURRAY, SGA, THUNDER, TODAY, otdOf, served } from "../test/passScene";
import { liveBySport } from "./budget";
import { OFFER_LEVEL } from "./offers";
import { passDealWords, passDeals } from "./passDeals";
import { onSale, paybackAtCost, toBasis } from "./passes";

// A market with other cards on sale: the engine's figures recomputed, as the server would serve them.
const withShelf = (m: PassMarket, shelf: [number, number][], over: Partial<PassMarket> = {}) =>
  served({ ...toBasis(m), shelf, shelf_count: shelf.length, ...over });

// Jokić trades at 10 a point; these two cards sell at 8 and 9 a point: Common (10 rating + the 200 mint) for 293.
const JOKIC_CHEAP = withShelf(JOKIC, [[6, 48], [5, 45]]);
// Murray trades at 9 a point and his cards sit at 12 a point: nothing cheaper on the shelf.
const MURRAY_DEAR = withShelf(MURRAY, [[10, 120], [20, 240]]);

const options = { level: "regular" as const, sport: "all", budget: null, held: new Set<string>() };
const otd = (markets: PassMarket[]) => otdOf(markets);

describe("passDeals", () => {
  it("lists a pass whose cards on sale reach a paying rarity for less than at the usual rate", () => {
    const [deal] = passDeals(otd([JOKIC_CHEAP]), OTD_RULES, options);
    expect(deal!.market.key).toBe(JOKIC.key);
    const sale = onSale(JOKIC_CHEAP, deal!.rung.rating_to_add, OTD_RULES);
    expect(deal!.rating).toBe(sale.on_sale_rating);
    expect(deal!.cards).toBe(sale.on_sale_cost);
    const mint = deal!.rung.route === "mint+cards" ? 200 : 0;
    expect(deal!.cost).toBe(mint + sale.on_sale_cost);
    expect(deal!.cost).toBeLessThan(deal!.rung.cost!);
    expect(deal!.per_point).toBeCloseTo(sale.on_sale_cost / sale.on_sale_rating);
    expect(deal!.usual_rate).toBe(10);
    expect(deal!.year_per_rax).toBeCloseTo(deal!.rung.year_rax / deal!.cost);
    const back = paybackAtCost(toBasis(JOKIC_CHEAP), deal!.rung, deal!.cost, OTD_RULES, TODAY);
    expect(deal!.payback_months).toBeCloseTo(back.months!);
  });

  it("leaves out a pass whose cards on sale cost the usual rate or more, a team pass, and a pass the visitor holds", () => {
    expect(passDeals(otd([MURRAY_DEAR, THUNDER]), OTD_RULES, options)).toEqual([]);
    expect(passDeals(otd([JOKIC_CHEAP]), OTD_RULES, { ...options, held: new Set([JOKIC.key]) })).toEqual([]);
  });

  it("leaves out a pass whose usual rate rests on too few trades to call anything cheaper (advisor/pass_deals.py too)", () => {
    const thin = withShelf(JOKIC, [[6, 48], [5, 45]], { rate_sales: OTD_RULES.ignore_ask_min_sales - 1 });
    expect(passDeals(otd([thin]), OTD_RULES, options)).toEqual([]);
    const enough = withShelf(JOKIC, [[6, 48], [5, 45]], { rate_sales: OTD_RULES.ignore_ask_min_sales });
    expect(passDeals(otd([enough]), OTD_RULES, options)).toHaveLength(1);
  });

  it("leaves out a rarity the shelf cannot reach", () => {
    // Two cards, 11 rating: Common only; Uncommon (30) is out of reach.
    for (const d of passDeals(otd([JOKIC_CHEAP]), OTD_RULES, options)) expect(d.rung.rating_to_add).toBeLessThanOrEqual(11);
  });

  it("ranks by the next 12 months' pay per Rax at the cost on sale, at most 2 passes per sport", () => {
    const a = withShelf(JOKIC, [[10, 50]]); // 5 a point
    const b = withShelf(SGA, [[10, 300]]); // 30 a point, usual 40
    const c = withShelf(MURRAY, [[10, 40]]); // 4 a point, usual 9
    const list = passDeals(otd([a, b, c]), OTD_RULES, options);
    expect(list.filter((d) => d.market.sport === "nba")).toHaveLength(2);
    for (let i = 1; i < list.length; i++) expect(list[i - 1]!.year_per_rax).toBeGreaterThanOrEqual(list[i]!.year_per_rax);
  });

  it("counts the live passes the visitor holds in a sport against its 2 claims a day, as the budget buddy's route", () => {
    const a = withShelf(JOKIC, [[10, 50]]);
    const b = withShelf(SGA, [[10, 300]]);
    const c = withShelf(MURRAY, [[10, 40]]);
    const nhl = withShelf(MACKINNON, [[10, 40]]);
    const all = otd([a, b, c, nhl]);
    const nba = (live: Record<string, number>) => passDeals(all, OTD_RULES, { ...options, live }).filter((d) => d.market.sport === "nba");
    expect(nba({})).toHaveLength(2);
    expect(nba({ nba: 1 })).toHaveLength(1);
    expect(nba({ nba: 2 })).toHaveLength(0);
    expect(passDeals(all, OTD_RULES, { ...options, live: { nba: 2 } }).map((d) => d.market.sport)).toContain("nhl");
  });

  it("liveBySport counts each sport's live passes held, a spent one not", () => {
    const markets = [JOKIC, SGA, MACKINNON];
    expect(liveBySport([{ key: JOKIC.key, tier: "common" }, { key: SGA.key, tier: "common" }], markets, OTD_RULES)).toEqual({ nba: 2 });
    expect(liveBySport([{ key: JOKIC.key, tier: "common", spent: true }], markets, OTD_RULES)).toEqual({});
    expect(liveBySport([], markets, OTD_RULES)).toEqual({});
  });

  it("keeps to the visitor's sport tab and pass budget", () => {
    const nhl = withShelf(MACKINNON, [[10, 40]]);
    const nba = withShelf(JOKIC, [[10, 50]]);
    expect(passDeals(otd([nhl, nba]), OTD_RULES, { ...options, sport: "nhl" }).map((d) => d.market.sport)).toEqual(["nhl"]);
    const tight = passDeals(otd([nhl, nba]), OTD_RULES, { ...options, budget: 240 });
    for (const d of tight) expect(d.cost).toBeLessThanOrEqual(240);
  });

  it("New gets only passes that pay back within a year and are no projection, as the budget buddy's route", () => {
    for (const d of passDeals(otd([JOKIC_CHEAP, withShelf(MCDAVID, [[12, 100]])]), OTD_RULES, { ...options, level: "new" })) {
      expect(d.rung.projected).toBe(false);
      expect(d.rung.payback_months!).toBeLessThanOrEqual(12);
    }
  });

  it("adds the offer hint when offers would build it for less than the cards on sale", () => {
    const [deal] = passDeals(otd([JOKIC_CHEAP]), OTD_RULES, options);
    expect(deal!.offer).not.toBeNull();
    expect(deal!.offer!.rate).toBeCloseTo(10 * OFFER_LEVEL);
    const [cheap] = passDeals(otd([withShelf(JOKIC, [[10, 50]])]), OTD_RULES, options); // 5 a point: under the offer line
    expect(cheap!.offer).toBeNull();
  });
});

describe("passDealWords", () => {
  const [deal] = passDeals(otd([JOKIC_CHEAP]), OTD_RULES, options);

  it("says the rating on sale, its price, its price a point and the usual, what the rarity pays and when it is back", () => {
    for (const level of ["new", "regular", "pro"] as const) {
      const w = passDealWords(deal!, level);
      expect(w.title).toBe("Nikola Jokić 2024-25");
      expect(w.sale).toMatch(/11 rating on sale for 93|11 rating for 93/);
      expect(w.sale).toMatch(/8\.5/);
      expect(w.sale).toMatch(/10\.0/);
      expect(w.pay).toMatch(/Common/);
    }
  });

  it("spells it out for New: the cards add the rating, the mint's price, Rax a rating point", () => {
    const w = passDealWords(deal!, "new");
    const mint = deal!.cost - deal!.cards;
    expect(mint).toBeGreaterThan(0);
    expect(w.sale).toBe(`Cards on sale add 11 rating for 93 Rax, plus ${mint} Rax to mint the pass: 8.5 Rax a rating point (usual 10.0).`);
    expect(w.sale).not.toBe(passDealWords(deal!, "regular").sale);
    expect(w.offer).toMatch(/most offers are refused/);
  });

  it("says the offer with the measured odds and that offers need Real Pro", () => {
    for (const level of ["new", "regular", "pro"] as const) {
      const offer = passDealWords(deal!, level).offer!;
      expect(offer).toMatch(/1 in 6/);
      expect(offer).toMatch(/Offers need Real Pro/);
      expect(offer).not.toMatch(/both sides|seller's/);
      expect(offer).not.toMatch(/measured/i);
    }
  });
});
