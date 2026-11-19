import { describe, expect, it } from "vitest";
import type { PassMarket } from "../data/types";
import { buildRate, cleanBuildFields, offerCell, passBucket, rarityName } from "./passRates";

type Basis = Pick<PassMarket, "rate_traded" | "rate_sales" | "rate_build" | "rate_build_from" | "rate_bucket" | "offers">;

const WEMBY: Basis = {
  rate_traded: 38.46,
  rate_sales: 100,
  rate_bucket: "5-7",
  rate_build: 30.36,
  rate_build_from: { bucket: "5-7", rarity: "common", sales: 11 },
  offers: [
    ["3-5", null, 9.38, 50, 40.54],
    ["5-7", null, 9.18, 50, 38.46],
    ["5-7", "common", 8.93, 23, 30.36],
    ["5-7", "uncommon", 8.96, 13, 36.84],
  ],
};

describe("buildRate: what a rating point costs to build", () => {
  it("is the feed's build cell when it found one", () => {
    expect(buildRate(WEMBY)).toEqual({ rate: 30.36, thin: false, bucket: "5-7", rarity: "common", sales: 11 });
  });

  it("is the traded rate, flagged thin, when the feed measured the pass but no cell had enough sales", () => {
    expect(buildRate({ rate_traded: 22, rate_sales: 6, rate_bucket: "3-5", rate_build: null })).toEqual({
      rate: 22,
      thin: true,
      bucket: "3-5",
      rarity: null,
      sales: 6,
    });
  });

  it("is the traded rate, never thin, for a pass served without the new fields", () => {
    expect(buildRate({ rate_traded: 10, rate_sales: 20 })).toEqual({ rate: 10, thin: false, bucket: null, rarity: null, sales: 20 });
    expect(buildRate({ rate_traded: null, rate_sales: 0 }).rate).toBeNull();
  });
});

describe("buckets and rarities", () => {
  it("follow the feed's buckets", () => {
    expect([0.5, 3, 3.01, 5, 7, 7.1, 9.5, -5.5].map(passBucket)).toEqual(["0-3", "0-3", "3-5", "3-5", "5-7", "7+", "7+", "5-7"]);
    expect(passBucket(0)).toBeNull();
  });

  it("names a card's rarity by its number", () => {
    expect([0, 1, 5, 7].map(rarityName)).toEqual(["general", "common", "legendary", "iconic"]);
    expect(rarityName(8)).toBeNull();
  });
});

describe("offerCell: the accepted offers measured for a cell", () => {
  it("takes the rarity's cell, else the whole bucket's, else nothing", () => {
    expect(offerCell(WEMBY, "5-7", "common")).toEqual({ rate: 8.93, offers: 23, listing: 30.36 });
    expect(offerCell(WEMBY, "5-7", "legendary")).toEqual({ rate: 9.18, offers: 50, listing: 38.46 });
    expect(offerCell(WEMBY, "3-5", null)).toEqual({ rate: 9.38, offers: 50, listing: 40.54 });
    expect(offerCell(WEMBY, "7+", "common")).toBeNull();
    expect(offerCell({}, "5-7", "common")).toBeNull();
  });
});

describe("cleanBuildFields: a stored market's new fields, trusted only when they fit", () => {
  it("keeps what fits and drops what does not, the live auctions always (they are not the cards on sale now)", () => {
    const kept = cleanBuildFields({ ...WEMBY, auctions: [[5.2, 200, 1]] } as never);
    expect(kept).toEqual(WEMBY);
    const bad = cleanBuildFields({
      rate_traded: 10,
      rate_sales: 20,
      rate_bucket: "9+",
      rate_build: "30" as never,
      rate_build_from: { bucket: "5-7" } as never,
      offers: [["5-7", "common", -1, 5, null]] as never,
    } as never);
    expect(bad).toEqual({ rate_traded: 10, rate_sales: 20 });
    expect(cleanBuildFields({ rate_traded: 10, rate_sales: 20, rate_build: null } as never)).toEqual({
      rate_traded: 10,
      rate_sales: 20,
      rate_build: null,
    });
  });
});
