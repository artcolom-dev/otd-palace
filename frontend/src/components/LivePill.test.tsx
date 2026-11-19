import { describe, expect, it } from "vitest";
import { bidsLast10 } from "./LivePill";

describe("bidsLast10", () => {
  it("adds up the bids heard on every live sport, and is 0 without a bid stream", () => {
    expect(bidsLast10({ bidding: { nba: { bids_10m: 131, bidders_10m: 11 }, nfl: { bids_10m: 9, bidders_10m: 3 } } })).toBe(140);
    expect(bidsLast10({ bidding: {} })).toBe(0);
    expect(bidsLast10({})).toBe(0);
  });
});
