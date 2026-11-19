import { describe, expect, it } from "vitest";
import { makeDeal } from "../test/fixtures";
import { findTwins } from "./twins";

const RULES = { price_band: 0.25, max: 3 };
const d = (listing_id: number, over = {}) => makeDeal({ listing_id, ...over });
const ids = (rows: { listing_id: number }[]) => rows.map((r) => r.listing_id);
const subject = { listing_id: 1, sport: "nba", player_id: 100, season: 2026, price: 100, rating: 5 };

describe("findTwins", () => {
  it("puts the same player-season first, then the same sport at a close price and at least the rating", () => {
    const pool = [
      d(2, { player_id: 9, price: 110, rating: 5, discount: 0.4 }),
      d(3, { price: 300, rating: 4, discount: 0.26 }), // the same player-season, whatever its price and rating
      d(4, { player_id: 8, price: 120, rating: 6, discount: 0.3 }),
      d(5, { player_id: 7, sport: "nfl", price: 100, rating: 5 }), // another sport
      d(6, { player_id: 6, price: 126, rating: 5 }), // past the band: 25% of 100 is 25
      d(7, { player_id: 5, price: 100, rating: 4.9 }), // under the rating
      d(8, { season: 2025, price: 100, rating: 5, discount: 0.28 }), // another season: a similar deal, not a twin of the season
    ];
    expect(ids(findTwins(subject, pool, RULES))).toEqual([3, 2, 4]);
  });

  it("takes the edge of the band, orders by discount and breaks a tie by the nearer price", () => {
    const pool = [
      d(2, { player_id: 2, price: 125, rating: 5, discount: 0.26 }),
      d(3, { player_id: 3, price: 75, rating: 5, discount: 0.31 }),
      d(4, { player_id: 4, price: 100, rating: 5, discount: 0.31 }),
    ];
    expect(ids(findTwins(subject, pool, RULES))).toEqual([4, 3, 2]);
  });

  it("never suggests the same listing, whatever its kind, and shows a listing once, as its better kind", () => {
    const pool = [
      d(1, { kind: "bid", price: 90 }),
      d(2, { kind: "target", price: 95, discount: 0.3 }),
      d(2, { kind: "bid", price: 90, discount: 0.4 }),
    ];
    const out = findTwins(subject, pool, RULES);
    expect(ids(out)).toEqual([2]);
    expect(out[0]?.kind).toBe("bid");
  });

  it("stops at the rules' maximum, or at a smaller limit", () => {
    const pool = Array.from({ length: 10 }, (_, i) => d(i + 2, { price: 100, rating: 9 }));
    expect(findTwins(subject, pool, RULES)).toHaveLength(3);
    expect(findTwins(subject, pool, RULES, 2)).toHaveLength(2);
    expect(findTwins(subject, [], RULES)).toEqual([]);
  });

  it("works from what an opened deal remembers: no season and no rating", () => {
    const opened = { listing_id: 1, sport: "nba", player_id: 100, price: 100 };
    const pool = [
      d(2, { player_id: 9, price: 110, rating: 1, discount: 0.4 }), // any rating will do
      d(3, { season: 2025, price: 300, discount: 0.26 }), // the same player, any season
      d(4, { player_id: 9, price: 500 }), // too dear
    ];
    expect(ids(findTwins(opened, pool, RULES))).toEqual([3, 2]);
  });

  it("does not change the pool it was given", () => {
    const pool = [d(2, { price: 100 }), d(3, { price: 100, discount: 0.9 })];
    const before = ids(pool);
    findTwins(subject, pool, RULES);
    expect(ids(pool)).toEqual(before);
  });
});
