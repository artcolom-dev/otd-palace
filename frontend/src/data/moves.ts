// Today's price moves (advisor/moves.py): the players whose cards sold for much more or much less in the last 24 hours
// than in the 7 days before, by the middle sale of each. The server sends the biggest risers and fallers, in order;
// the page only filters them by the visitor's sport tab.
import { playerKey, type SportCounts } from "./deals";
import type { Move, Snapshot } from "./types";

export type MoveDir = "risers" | "fallers";
export const MOVE_DIRS: readonly MoveDir[] = ["risers", "fallers"];

/** One market of one player: sport, season, player and the rating band the sales were in. */
export const moveKey = (m: Pick<Move, "sport" | "season" | "player_id" | "bucket">) =>
  `${m.sport}:${m.season}:${m.player_id}:${m.bucket}`;

/** The moves of one side for a sport tab: "all", "mine" (the players followed) or one sport; the server's order. */
export function visibleMoves(snap: Snapshot, dir: MoveDir, sport: string, follows: ReadonlySet<string>): Move[] {
  return snap.moves[dir].filter((m) =>
    sport === "all" ? true : sport === "mine" ? follows.has(playerKey(m)) : m.sport === sport,
  );
}

/** How many moves of one side each sport tab would show. */
export function moveCounts(snap: Snapshot, dir: MoveDir, follows: ReadonlySet<string>): SportCounts {
  const moves = snap.moves[dir];
  const bySport: Record<string, number> = {};
  for (const m of moves) bySport[m.sport] = (bySport[m.sport] ?? 0) + 1;
  return { all: moves.length, mine: moves.filter((m) => follows.has(playerKey(m))).length, bySport };
}

/** The sports with moves, in the deals' order, then any other by name. */
export function moveSports(snap: Snapshot): string[] {
  const all = new Set([...snap.moves.risers, ...snap.moves.fallers].map((m) => m.sport));
  return [...snap.sports.filter((s) => all.has(s)), ...[...all].filter((s) => !snap.sports.includes(s)).sort()];
}

/** "+31%", "−22%" (a real minus), "0%"; rounded half away from zero. */
export function changeText(change: number): string {
  const pct = Math.round(Math.abs(change) * 100);
  if (pct === 0) return "0%";
  return `${change > 0 ? "+" : "−"}${pct}%`;
}

/** The rating band a move was measured in: "3–5 rating", "9+ rating", "rating under 1.5". */
export function bandText(bucket: string): string {
  const [lo, hi] = bucket.split("-");
  if (lo === "0" && hi) return `rating under ${hi}`;
  if (hi) return `${lo}–${hi} rating`;
  return `${bucket} rating`;
}
