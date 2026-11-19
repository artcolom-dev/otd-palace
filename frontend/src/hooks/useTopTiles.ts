import { useLayoutEffect, useRef } from "react";
import { dimReason } from "../components/DealTable";
import { isGone, playerKey } from "../data/deals";
import type { Deal, GoneDeal } from "../data/types";
import type { StableRow } from "./useStableList";

// Today's ranking split in two: the first three deals are the tiles at the top (ranks 1 to 3), the rest is the list
// under them (from rank 4). The rows come from the stable list, so the order only changes on a merge or a filter;
// what this adds is the tiles' own moment when a deal goes away: the tile stays, dimmed with why, then the next deals
// move up. Nothing moves up while the visitor is busy with the deals (`frozen`). One player gets one tile: a second
// listing of a tiled player stays in the list, in its place.

type Row = StableRow<Deal | GoneDeal>;

export const TOP = 3;
export const TAKEN_MS = 1600; // how long a tile whose deal went away stays, dimmed with its reason

export interface Tile {
  row: Row;
  rank: number; // 1, 2 or 3
  away: string | null; // why its deal went away, while the tile stays dimmed
}

/**
 * Under the default sort ("best"), tile 1 is never a falling deal while one that is not falling exists: the deals
 * that are not falling come first, each group in its own order. Falling deals keep their grey pill and tag wherever
 * they land.
 */
export function fallingLast<T extends Deal>(deals: readonly T[]): T[] {
  return [...deals.filter((d) => !d.falling), ...deals.filter((d) => d.falling)];
}

/** What the tiles remember between draws: when a tile's deal went away, the gone rows done with, the live tiles. */
interface Memory {
  wentAt: ReadonlyMap<string, number>;
  dropped: ReadonlySet<string>;
  shown: ReadonlySet<string>;
}

const EMPTY: Memory = { wentAt: new Map(), dropped: new Set(), shown: new Set() };

/** The tiles and the rest from the rows and what the last committed draw remembered; nothing is written here. */
function split(rows: readonly Row[], frozen: boolean, now: number, memory: Memory) {
  const wentAt = new Map(memory.wentAt);
  const dropped = new Set<string>();
  const tiles: Tile[] = [];
  const rest: Row[] = [];
  const players = new Set<string>();
  for (const row of rows) {
    const away = isGone(row.item) || row.held ? dimReason(row, now) : null;
    if (away === null) {
      // A deal live again under the same key (its price moved back) is a deal like any other.
      wentAt.delete(row.key);
    } else if (memory.dropped.has(row.key)) {
      dropped.add(row.key); // still in the rows: remembered; gone from them: forgotten
      continue;
    }
    const player = playerKey(row.item);
    if (tiles.length >= TOP || players.has(player)) {
      rest.push(row);
      continue;
    }
    if (away === null) {
      tiles.push({ row, rank: tiles.length + 1, away: null });
      players.add(player);
      continue;
    }
    let since = wentAt.get(row.key);
    if (since === undefined && memory.shown.has(row.key)) {
      since = now;
      wentAt.set(row.key, now);
    }
    if (since !== undefined && (frozen || now - since < TAKEN_MS)) {
      tiles.push({ row, rank: tiles.length + 1, away });
      players.add(player);
      continue;
    }
    // Its moment is over, or it is a gone row of the list that would climb into the tiles: it goes.
    dropped.add(row.key);
    wentAt.delete(row.key);
  }
  const keys = new Set(rows.map((r) => r.key));
  for (const key of wentAt.keys()) if (!keys.has(key)) wentAt.delete(key);
  const shown = new Set(tiles.filter((t) => t.away === null).map((t) => t.row.key));
  return { tiles, rest, memory: { wentAt, dropped, shown } satisfies Memory };
}

export function useTopTiles(rows: readonly Row[], frozen: boolean, now: number): { tiles: Tile[]; rest: Row[] } {
  const memory = useRef<Memory>(EMPTY);
  const { tiles, rest, memory: next } = split(rows, frozen, now, memory.current);
  // What this draw learnt is kept once it is on screen, so a draw React throws away leaves nothing behind.
  useLayoutEffect(() => {
    memory.current = next;
  });
  return { tiles, rest };
}
