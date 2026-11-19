// "Your plan": what the passes held can pay a year, the account type that figure makes, the way to the next type and the
// best next passes to get. Pure: the same planner the Passes tab and "Your next Rax" use (lib/passes.ts planHoldings,
// lib/nextRax.ts passMoves), read as a plan. The yearly figure is a ceiling (what the passes CAN pay when every claim
// day is claimed); the words around it say "up to".
import { type AccountType, type Progress, progressToNext, typeOf } from "../content/accountTypes";
import { about, paybackWord } from "../content/passWords";
import type { LevelKey } from "../data/prefs";
import type { PassMarket, Snapshot } from "../data/types";
import { type NextMove, passMoves, rankMoves } from "./nextRax";
import { type Holding, dayOf, planHoldings } from "./passes";

export interface PlanInput {
  holdings: readonly Holding[];
  level: LevelKey;
  budget: number | null;
  passBudget: number | null;
  balance: number | null; // what the visitor typed as theirs: no move costs more than this
  now: number;
}

/** A pass move of the plan: a pass to add or to lift, always with what it adds a year. */
export type PlanMove = NextMove & { year: number };

export interface YourPlan {
  year: number; // rax a year the passes can pay, rounded: the figure that makes the type
  type: AccountType;
  progress: Progress | null; // null at the top type
  moves: PlanMove[]; // at most 3, the best first: the first is THE ONE MOVE
  passes: number; // passes read
}

export const PLAN_MOVES = 3;

/**
 * The plan of `holdings`, valued with `markets` (the site's, then the valuations kept for held passes the site does
 * not list). The moves are the passes' alone: a deal is the visitor's of the moment, not the account's.
 */
export function planOf(snap: Pick<Snapshot, "otd" | "rules">, markets: readonly PassMarket[], input: PlanInput): YourPlan {
  const year = Math.round(planHoldings(input.holdings, markets, snap.rules.otd, snap.otd.sports).total);
  const valued = { otd: { ...snap.otd, markets: markets as PassMarket[] }, rules: snap.rules };
  const found = passMoves(valued, {
    holdings: input.holdings,
    level: input.level,
    budget: input.budget,
    passBudget: input.passBudget,
    balance: input.balance,
    now: input.now,
    paused: true,
    n: 8,
  }).filter((m) => m.kind !== "deal" && m.year !== null && m.year > 0);
  const moves = rankMoves(found, { holdings: input.holdings, n: PLAN_MOVES, paused: true }).moves as PlanMove[];
  return { year, type: typeOf(year), progress: progressToNext(year), moves, passes: input.holdings.length };
}

/** A move in words, for a row: the cost and the gain rounded as people say them, and the payback as the Passes tab says it. */
export function moveWords(move: PlanMove, today: string): { cost: string; year: string; payback: string | null } {
  const month = move.rung ? paybackWord(move.rung, today) : null;
  return { cost: about(move.cost), year: about(move.year), payback: month ? `pays back by end of ${month}` : null };
}

/** The snapshot's day, for a payback month. */
export const todayOf = (snap: Pick<Snapshot, "otd">): string => dayOf(snap.otd.as_of);
