import { useCallback, useEffect, useRef, useState } from "react";
import type { Deal, GoneDeal } from "../data/types";

// A list that stays still under the thumb. The order on screen is the order of the last merge: deals that arrive
// after it wait in `queued` (behind the "new deals" pill), deals already shown update in place (a deal that changed
// kind, the same listing, too), and a deal that went away either becomes its gone row in the same place or, if it has
// none, leaves; while the visitor is touching, hovering or scrolling the list (`frozen`), even that waits, so nothing
// moves under their finger.

type Row = Deal | GoneDeal;

export interface StableRow<T> {
  key: string;
  item: T;
  isNew: boolean; // arrived with the last tap on the pill
  held: boolean; // left the input, kept in place while the list is frozen
}

export interface StableListOptions<T> {
  frozen: boolean;
  /** Any change of this (a filter, the sort, the level) merges at once. */
  resetKey?: string;
  keyOf?: (item: T) => string;
  /** A row that only stands in for a row already shown (a gone deal): never queued, never added by a merge. */
  isGhost?: (item: T) => boolean;
  /** What a row is about whatever its key (a deal: its listing). A row that left gives its place to an arrival about
   * the same thing (a target whose countdown started, now the auction's bid to beat) instead of queueing it as new. */
  slotOf?: (item: T) => string;
}

export interface StableListState<T> {
  order: string[];
  newKeys: ReadonlySet<string>;
  resetKey: string | undefined;
  loaded: boolean;
  held: Map<string, T>; // the last item of each row on screen, to hold one that leaves while frozen
}

const defaultKey = (row: Row) => `${row.listing_id}:${row.kind}`;
const defaultGhost = (row: Row) => "reason" in row;
const defaultSlot = (row: Row) => String(row.listing_id);
const NONE: ReadonlySet<string> = new Set();

function merged<T>(
  items: readonly T[],
  keyOf: (t: T) => string,
  isGhost: (t: T) => boolean,
  shown: ReadonlySet<string>,
): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key) || (isGhost(item) && !shown.has(key))) continue;
    seen.add(key);
    order.push(key);
  }
  return order;
}

/**
 * A tap on the pill: the input order, the arrivals marked new, and only the held rows the new order keeps (a row
 * the merge drops is forgotten, not held for ever).
 */
export function mergeList<T>(
  prev: StableListState<T>,
  items: readonly T[],
  keyOf: (t: T) => string,
  isGhost: (t: T) => boolean,
): StableListState<T> {
  const before = new Set(prev.order);
  const order = merged(items, keyOf, isGhost, before);
  const kept = new Set(order);
  return {
    ...prev,
    order,
    newKeys: new Set(order.filter((key) => !before.has(key))),
    loaded: prev.loaded || order.length > 0,
    held: new Map([...prev.held].filter(([key]) => kept.has(key))),
  };
}

export function useStableList<T = Row>(
  items: readonly T[],
  { frozen, resetKey, keyOf: keyOfOpt, isGhost: isGhostOpt, slotOf: slotOfOpt }: StableListOptions<T>,
): { rows: StableRow<T>[]; queued: T[]; merge: () => void } {
  const keyOf = (keyOfOpt ?? (defaultKey as unknown as (t: T) => string));
  const isGhost = (isGhostOpt ?? (defaultGhost as unknown as (t: T) => boolean));
  const slotOf = (slotOfOpt ?? (defaultSlot as unknown as (t: T) => string));

  const [state, setState] = useState<StableListState<T>>(() => ({
    order: merged(items, keyOf, isGhost, NONE),
    newKeys: NONE,
    resetKey,
    loaded: items.length > 0,
    held: new Map(),
  }));

  // The newest item per key: the first one wins, as the input lists each key once (live before gone).
  const byKey = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    if (!byKey.has(key)) byKey.set(key, item);
  }

  // A filter change, a first list worth showing, or arrivals while nothing is on screen merge during this render
  // (React re-renders at once): there is nothing under the visitor's finger to keep still.
  let current = state;
  const nothingShown = (!state.loaded || state.order.length === 0) && items.some((item) => !isGhost(item));
  if (state.resetKey !== resetKey || nothingShown) {
    current = {
      order: merged(items, keyOf, isGhost, NONE),
      newKeys: NONE,
      resetKey,
      loaded: items.length > 0,
      held: new Map(),
    };
    setState(current);
  }

  // A row that left while an arrival is about the same thing (its deal changed kind: the same card) hands it its place,
  // during this render as above: the same row on screen, not one gone and a "new deal" behind the pill.
  if (current.order.some((key) => !byKey.has(key))) {
    const inOrder = new Set(current.order);
    const arrivals = new Map<string, string>(); // slot -> the key of the first arrival about it
    for (const item of items) {
      const key = keyOf(item);
      if (inOrder.has(key) || isGhost(item)) continue;
      const slot = slotOf(item);
      if (!arrivals.has(slot)) arrivals.set(slot, key);
    }
    let renamed = false;
    const order = current.order.map((key) => {
      const last = byKey.has(key) ? undefined : current.held.get(key);
      const slot = last === undefined ? undefined : slotOf(last);
      const to = slot === undefined ? undefined : arrivals.get(slot);
      if (slot === undefined || to === undefined) return key;
      arrivals.delete(slot);
      renamed = true;
      return to;
    });
    if (renamed) {
      current = { ...current, order };
      setState(current);
    }
  }

  const shown = new Set(current.order);
  const rows: StableRow<T>[] = [];
  for (const key of current.order) {
    const item = byKey.get(key);
    if (item !== undefined) rows.push({ key, item, isNew: current.newKeys.has(key), held: false });
    else if (frozen) {
      const last = current.held.get(key);
      if (last !== undefined) rows.push({ key, item: last, isNew: current.newKeys.has(key), held: true });
    }
  }
  const queued = items.filter((item) => !shown.has(keyOf(item)) && !isGhost(item));

  // Remember the last item of every row on screen, so a frozen list can hold one that leaves.
  const latest = useRef(current);
  latest.current = current;
  useEffect(() => {
    const s = latest.current;
    for (const key of s.order) {
      const item = byKey.get(key);
      if (item !== undefined) s.held.set(key, item);
    }
    if (!frozen) {
      const gone = s.order.filter((key) => !byKey.has(key));
      if (gone.length > 0) {
        for (const key of gone) s.held.delete(key);
        setState((prev) => ({ ...prev, order: prev.order.filter((key) => !gone.includes(key)) }));
      }
    }
  });

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const merge = useCallback(() => {
    setState((prev) => mergeList(prev, itemsRef.current, keyOf, isGhost));
    // The key and ghost functions are fixed for a list's life; only the items change, and they are read via a ref.
  }, []);

  return { rows, queued, merge };
}
