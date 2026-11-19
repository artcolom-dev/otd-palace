import { renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";
import type { Deal, GoneDeal } from "../data/types";
import { makeDeal, makeGone } from "../test/fixtures";
import type { StableRow } from "./useStableList";
import { TAKEN_MS, fallingLast, useTopTiles } from "./useTopTiles";

type Item = Deal | GoneDeal;
const T0 = Date.parse("2026-11-12T18:00:00Z");
// one player per listing (makeDeal's default player would make them all one player)
const live = (id: number): StableRow<Item> => ({
  key: `${id}:target`,
  item: makeDeal({ listing_id: id, player_id: id, now: T0 }),
  isNew: false,
  held: false,
});
const gone = (id: number): StableRow<Item> => ({
  key: `${id}:target`,
  item: makeGone({ ...makeDeal({ listing_id: id, player_id: id, now: T0 }), reason: "countdown_started", now: T0 }),
  isNew: false,
  held: false,
});
const held = (id: number): StableRow<Item> => ({ ...live(id), held: true });


function setup(rows: StableRow<Item>[], frozen = false, now = T0) {
  return renderHook(({ rows, frozen, now }) => useTopTiles(rows, frozen, now), { initialProps: { rows, frozen, now } });
}
const tileIds = (r: ReturnType<typeof useTopTiles>) => r.tiles.map((t) => [t.rank, t.row.item.listing_id, t.away]);
const restIds = (r: ReturnType<typeof useTopTiles>) => r.rest.map((row) => row.item.listing_id);

describe("useTopTiles: the visitor's top three, then the rest from rank 4", () => {
  it("makes the first three deals the tiles, ranked 1 to 3, and leaves the rest to the list", () => {
    const { result } = setup([live(1), live(2), live(3), live(4), live(5)]);
    expect(tileIds(result.current)).toEqual([[1, 1, null], [2, 2, null], [3, 3, null]]);
    expect(restIds(result.current)).toEqual([4, 5]);
  });

  it("shows only the tiles there are", () => {
    expect(tileIds(setup([live(1), live(2)]).result.current)).toEqual([[1, 1, null], [2, 2, null]]);
    expect(setup([]).result.current).toEqual({ tiles: [], rest: [] });
  });

  it("keeps a tile whose deal went away for a moment, dimmed with why, then moves the next deals up", () => {
    const { result, rerender } = setup([live(1), live(2), live(3), live(4)]);
    rerender({ rows: [gone(1), live(2), live(3), live(4)], frozen: false, now: T0 + 1000 });
    expect(tileIds(result.current)).toEqual([[1, 1, "Someone started the countdown"], [2, 2, null], [3, 3, null]]);
    expect(restIds(result.current)).toEqual([4]);
    rerender({ rows: [gone(1), live(2), live(3), live(4)], frozen: false, now: T0 + 1000 + TAKEN_MS - 1 });
    expect(result.current.tiles[0]!.away).not.toBeNull();
    rerender({ rows: [gone(1), live(2), live(3), live(4)], frozen: false, now: T0 + 1000 + TAKEN_MS });
    expect(tileIds(result.current)).toEqual([[1, 2, null], [2, 3, null], [3, 4, null]]);
    expect(restIds(result.current)).toEqual([]);
  });

  it("moves nothing up while the visitor is busy with the deals, and does it once they let go", () => {
    const { result, rerender } = setup([live(1), live(2), live(3), live(4)], true);
    rerender({ rows: [live(1), gone(2), live(3), live(4)], frozen: true, now: T0 + 1000 });
    rerender({ rows: [live(1), gone(2), live(3), live(4)], frozen: true, now: T0 + 60_000 });
    expect(tileIds(result.current)).toEqual([[1, 1, null], [2, 2, "Someone started the countdown"], [3, 3, null]]);
    rerender({ rows: [live(1), gone(2), live(3), live(4)], frozen: false, now: T0 + 60_000 });
    expect(tileIds(result.current)).toEqual([[1, 1, null], [2, 3, null], [3, 4, null]]);
  });

  it("dims a tile held still while frozen, with what its clock says", () => {
    const { result, rerender } = setup([live(1), live(2), live(3)], true);
    rerender({ rows: [live(1), held(2), live(3)], frozen: true, now: T0 });
    expect(result.current.tiles[1]!.away).toBe("No longer a deal");
  });

  it("never lets a gone row of the list climb into the tiles", () => {
    const { result, rerender } = setup([live(1), live(2), live(3), gone(4), live(5)]);
    expect(restIds(result.current)).toEqual([4, 5]); // a gone row stays in its place in the list
    rerender({ rows: [live(1), live(2), gone(4), live(5)], frozen: false, now: T0 + 1000 }); // 3 left with no trace
    expect(tileIds(result.current)).toEqual([[1, 1, null], [2, 2, null], [3, 5, null]]);
    expect(restIds(result.current)).toEqual([]);
  });

  it("takes back a deal that comes back live under the same key", () => {
    const { result, rerender } = setup([live(1), live(2), live(3)]);
    rerender({ rows: [gone(1), live(2), live(3)], frozen: false, now: T0 + 1000 });
    rerender({ rows: [gone(1), live(2), live(3)], frozen: false, now: T0 + 1000 + TAKEN_MS });
    rerender({ rows: [live(1), live(2), live(3)], frozen: false, now: T0 + 9000 });
    expect(tileIds(result.current)).toEqual([[1, 1, null], [2, 2, null], [3, 3, null]]);
  });

  it("gives one player one tile: a second listing of that player goes on in the list, in its place", () => {
    const twin: StableRow<Item> = { ...live(9), item: makeDeal({ listing_id: 9, player_id: 1, now: T0 }) };
    const { result } = setup([live(1), twin, live(2), live(3), live(4)]);
    expect(tileIds(result.current)).toEqual([[1, 1, null], [2, 2, null], [3, 3, null]]);
    expect(restIds(result.current)).toEqual([9, 4]);
  });

  it("holds the same moments when React draws twice (Strict Mode): nothing is written while drawing", () => {
    const { result, rerender } = renderHook(({ rows, frozen, now }) => useTopTiles(rows, frozen, now), {
      initialProps: { rows: [live(1), live(2), live(3), live(4)], frozen: false, now: T0 },
      wrapper: StrictMode,
    });
    rerender({ rows: [gone(1), live(2), live(3), live(4)], frozen: false, now: T0 + 1000 });
    expect(tileIds(result.current)[0]).toEqual([1, 1, "Someone started the countdown"]);
    rerender({ rows: [gone(1), live(2), live(3), live(4)], frozen: false, now: T0 + 1000 + TAKEN_MS });
    expect(tileIds(result.current)).toEqual([[1, 2, null], [2, 3, null], [3, 4, null]]);
  });
});

describe("fallingLast: under the default sort, a deal that is not falling comes before every falling one", () => {
  const deal = (id: number, falling = false) => makeDeal({ listing_id: id, player_id: id, falling, now: T0 });
  it("moves the falling deals after the others, each group in its own order", () => {
    const out = fallingLast([deal(1, true), deal(2), deal(3, true), deal(4)]);
    expect(out.map((d) => d.listing_id)).toEqual([2, 4, 1, 3]);
  });

  it("leaves a list with no falling deal, or only falling ones, as it is", () => {
    expect(fallingLast([deal(1), deal(2)]).map((d) => d.listing_id)).toEqual([1, 2]);
    expect(fallingLast([deal(1, true), deal(2, true)]).map((d) => d.listing_id)).toEqual([1, 2]);
  });
});
