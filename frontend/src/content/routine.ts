// The five things of "Your day", each with one plain sentence on what it earns. Only what Real itself says it pays:
// passes pay Rax (this season's after each game, past seasons through claims), the daily streak poll and the lineup
// (Pro) pay Rax, polls and live games earn karma. The only karma figures are Real's own, from its docs (a poll win 10,
// up to 100 wagered; 1,000 karma pays 5 Rax, as in the internal research notes). Nothing here says what
// an account makes in a day: we do not know.
import type { RoutineId } from "../lib/routine";

export interface RoutineItem {
  id: RoutineId;
  title: string;
  earns: string;
  where: "app" | "deals"; // the Real app, or this site's Deals page
}

export const ROUTINE_ITEMS: readonly RoutineItem[] = [
  { id: "claim", title: "Claim the passes you hold", earns: "Pays Rax. Passes of past seasons: 2 claims per sport a day. This season's pay after each game.", where: "app" },
  { id: "polls", title: "Answer the daily polls", earns: "Earns karma: 10 per poll win, up to 100 if wagered. 1,000 karma is 5 Rax: a slow start, not a plan. The daily streak poll pays Rax: 5 for 2 right in a row, up to 320 for 8.", where: "app" },
  { id: "game", title: "Watch one live game", earns: "Earns karma. Open the game in the app.", where: "app" },
  { id: "lineup", title: "Set your daily lineup", earns: "Pays Rax (Real Pro): 100 down to 10 for the top 10, plus 10 per exact pick.", where: "app" },
  { id: "deals", title: "Check today's best deals", earns: "Can save you Rax on cards.", where: "deals" },
];

/** Under the claim item: the trap a beginner walks into. */
export const POLL_TRAP = "A pass applied to a poll cannot be claimed until the poll ends.";
