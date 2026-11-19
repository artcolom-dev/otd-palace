import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Deal, GoneDeal } from "../data/types";
import { makeDeal, makeGone } from "../test/fixtures";
import { type StableListState, mergeList, useStableList } from "./useStableList";

type Item = Deal | GoneDeal;
const deal = (listing_id: number, over: Partial<Deal> = {}) => makeDeal({ listing_id, ...over });
const ids = (rows: { item: Item }[]) => rows.map((r) => r.item.listing_id);

function setup(initial: Item[], frozen = false, resetKey = "a") {
  return renderHook(({ items, frozen, resetKey }) => useStableList(items, { frozen, resetKey }), {
    initialProps: { items: initial, frozen, resetKey },
  });
}

describe("useStableList: a list that stays still", () => {
  it("shows the first load as it comes", () => {
    const { result } = setup([deal(1), deal(2)]);
    expect(ids(result.current.rows)).toEqual([1, 2]);
    expect(result.current.queued).toEqual([]);
  });

  it("treats the first non-empty list as the first load", () => {
    const { result, rerender } = setup([]);
    rerender({ items: [deal(1), deal(2)], frozen: false, resetKey: "a" });
    expect(ids(result.current.rows)).toEqual([1, 2]);
  });

  it("shows arrivals at once when nothing is left on screen", () => {
    const { result, rerender } = setup([deal(1)]);
    rerender({ items: [], frozen: false, resetKey: "a" });
    expect(result.current.rows).toEqual([]);
    rerender({ items: [deal(2)], frozen: false, resetKey: "a" });
    expect(ids(result.current.rows)).toEqual([2]);
    expect(result.current.queued).toEqual([]);
  });

  it("queues new ids and keeps the order of the last merge", () => {
    const { result, rerender } = setup([deal(1), deal(2)]);
    rerender({ items: [deal(3), deal(2), deal(1)], frozen: false, resetKey: "a" });
    expect(ids(result.current.rows)).toEqual([1, 2]);
    expect(result.current.queued.map((d) => d.listing_id)).toEqual([3]);
  });

  it("applies updates to rows already shown in place", () => {
    const { result, rerender } = setup([deal(1, { price: 300 }), deal(2)]);
    rerender({ items: [deal(2), deal(1, { price: 280 })], frozen: false, resetKey: "a" });
    expect(ids(result.current.rows)).toEqual([1, 2]);
    expect(result.current.rows[0]?.item.price).toBe(280);
  });

  it("merges on demand: the input order, the queue emptied, the arrivals marked new", () => {
    const { result, rerender } = setup([deal(1), deal(2)]);
    rerender({ items: [deal(3), deal(2), deal(1)], frozen: false, resetKey: "a" });
    act(() => result.current.merge());
    expect(ids(result.current.rows)).toEqual([3, 2, 1]);
    expect(result.current.queued).toEqual([]);
    expect(result.current.rows.map((r) => r.isNew)).toEqual([true, false, false]);
  });

  it("merges at once when the filter changes, with nothing marked new", () => {
    const { result, rerender } = setup([deal(1), deal(2)]);
    rerender({ items: [deal(4), deal(2)], frozen: false, resetKey: "b" });
    expect(ids(result.current.rows)).toEqual([4, 2]);
    expect(result.current.rows.some((r) => r.isNew)).toBe(false);
  });

  it("drops a row that left, unless the list is frozen: then it holds its place until it thaws", () => {
    const { result, rerender } = setup([deal(1), deal(2), deal(3)]);
    rerender({ items: [deal(1), deal(3)], frozen: true, resetKey: "a" });
    expect(ids(result.current.rows)).toEqual([1, 2, 3]);
    expect(result.current.rows[1]?.held).toBe(true);
    rerender({ items: [deal(1), deal(3)], frozen: false, resetKey: "a" });
    expect(ids(result.current.rows)).toEqual([1, 3]);
    rerender({ items: [deal(1), deal(3)], frozen: true, resetKey: "a" });
    expect(ids(result.current.rows)).toEqual([1, 3]);
  });

  it("lets a merge while frozen drop the rows it was holding, and forget them", () => {
    const { result, rerender } = setup([deal(1), deal(2)]);
    rerender({ items: [deal(1), deal(3)], frozen: true, resetKey: "a" });
    expect(ids(result.current.rows)).toEqual([1, 2]);
    act(() => result.current.merge());
    expect(ids(result.current.rows)).toEqual([1, 3]);
    expect(result.current.rows.map((r) => r.held)).toEqual([false, false]);
  });

  it("prunes what it holds to the rows a merge keeps", () => {
    const key = (d: Item) => `${d.listing_id}:${d.kind}`;
    const ghost = (d: Item) => "reason" in d;
    const prev: StableListState<Item> = {
      order: ["1:target", "2:target"],
      newKeys: new Set(),
      resetKey: "a",
      loaded: true,
      held: new Map<string, Item>([["1:target", deal(1)], ["2:target", deal(2)]]),
    };
    const next = mergeList(prev, [deal(1), deal(3)], key, ghost);
    expect(next.order).toEqual(["1:target", "3:target"]);
    expect([...next.newKeys]).toEqual(["3:target"]);
    expect([...next.held.keys()]).toEqual(["1:target"]);
    expect([...prev.held.keys()]).toEqual(["1:target", "2:target"]); // the old state is left as it was
  });

  it("lets a gone row take the place of the deal it was, and never shows one that was not on screen", () => {
    const { result, rerender } = setup([deal(1), deal(2)]);
    const gone2 = makeGone({ listing_id: 2, reason: "countdown_started" });
    const gone9 = makeGone({ listing_id: 9 });
    rerender({ items: [deal(1), gone2, gone9], frozen: false, resetKey: "a" });
    expect(ids(result.current.rows)).toEqual([1, 2]);
    expect(result.current.rows[1]?.item).toHaveProperty("reason", "countdown_started");
    expect(result.current.queued).toEqual([]);
    act(() => result.current.merge());
    expect(ids(result.current.rows)).toEqual([1, 2]);
  });

  it("lets a deal that changed kind keep its place: the same card, never a new deal behind the pill", () => {
    // Someone bid the target of 5: the server serves the same listing as the auction's bid to beat, with no gone row
    // (advisor/gone.py: a listing is never both a deal and a gone row; the deal changed kind in place).
    const { result, rerender } = setup([deal(1), deal(5, { kind: "target" }), deal(2)]);
    rerender({ items: [deal(1), deal(2), deal(5, { kind: "bid" })], frozen: false, resetKey: "a" });
    expect(result.current.rows.map((r) => r.key)).toEqual(["1:target", "5:bid", "2:target"]);
    expect(result.current.rows.map((r) => r.isNew)).toEqual([false, false, false]);
    expect(result.current.queued).toEqual([]);
    // Frozen under the finger, it is the same: the live row in its place, not a dimmed "No longer a deal".
    rerender({ items: [deal(1), deal(2), deal(5, { kind: "target" })], frozen: true, resetKey: "a" });
    expect(result.current.rows.map((r) => [r.key, r.held])).toEqual([["1:target", false], ["5:target", false], ["2:target", false]]);
  });

  it("keeps a live bid row and a gone target row of the same listing apart", () => {
    const { result, rerender } = setup([deal(5, { kind: "target" })]);
    rerender({
      items: [deal(5, { kind: "bid" }), makeGone({ listing_id: 5, kind: "target", reason: "countdown_started" })],
      frozen: false,
      resetKey: "a",
    });
    expect(result.current.rows.map((r) => r.key)).toEqual(["5:target"]);
    expect(result.current.queued.map((d) => `${d.listing_id}:${d.kind}`)).toEqual(["5:bid"]);
  });
});
