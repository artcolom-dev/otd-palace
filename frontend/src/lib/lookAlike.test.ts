import { describe, expect, it } from "vitest";
import { lookAlikes } from "./lookAlike";

type Row = Parameters<typeof lookAlikes>[0][number];
const row = (listing_id: number, over: Partial<Row> = {}): Row => ({
  listing_id, player_id: 7, sport: "nba", season: 2027, rarity: 3, rating: 1.6, price: 50, mint: listing_id, ...over,
});

describe("lookAlikes", () => {
  it("marks every row that reads the same as another one: player, season, rarity, rating and price", () => {
    const out = lookAlikes([row(1), row(2), row(3, { price: 60 }), row(4, { rating: 1.7 })]);
    expect([...out].sort()).toEqual([1, 2]);
  });

  it("tells sports, seasons and rarities apart", () => {
    expect(lookAlikes([row(1), row(2, { sport: "nfl" })]).size).toBe(0);
    expect(lookAlikes([row(1), row(2, { season: 2026 })]).size).toBe(0);
    expect(lookAlikes([row(1), row(2, { rarity: 4 })]).size).toBe(0);
  });

  it("leaves out a row with no mint number, since there is nothing to show it apart", () => {
    expect([...lookAlikes([row(1), row(2), row(3, { mint: null })])].sort()).toEqual([1, 2]);
    expect(lookAlikes([row(1), row(2, { mint: null })]).size).toBe(0);
  });

  it("is empty for no rows or one", () => {
    expect(lookAlikes([]).size).toBe(0);
    expect(lookAlikes([row(1)]).size).toBe(0);
  });
});
