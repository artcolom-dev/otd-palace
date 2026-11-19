import type { ReactNode } from "react";
import { useApp } from "../AppContext";
import { budgetNudge, hiddenByLevel } from "../data/deals";
import { formatRax } from "../lib/format";
import { isRarity, rarityName } from "../content/real";
import { sportLabel } from "../lib/words";
import { PARTIAL_LISTINGS, useListingsPartial } from "./CoverageNote";

export interface EmptyAction {
  label: string;
  run: () => void;
}

/** A dashed box that says why there is nothing here, and offers the one change that would show something. */
export function EmptyState({ message, actions }: { message: ReactNode; actions: EmptyAction[] }) {
  return (
    <div className="empty" data-empty="">
      <p>{message}</p>
      {actions.length > 0 && (
        <div className="eacts">
          {actions.map((a) => (
            <button key={a.label} type="button" className="lnk box" onClick={a.run}>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Why the visitor sees no deal, most specific reason first, with its nudge. `more` when the hero is still up. */
export function useEmptyReason(more = false): { message: ReactNode; actions: EmptyAction[] } {
  const { snap, prefs, setPrefs, setLevel, follows, now, query, setQuery } = useApp();
  const none = more ? "No more deals" : "No deals";
  const partial = useListingsPartial();
  const missing = partial ? <> {PARTIAL_LISTINGS}</> : null;

  if (query) {
    return {
      message: (
        <>
          <b>No open deals on {query} right now.</b> Star a player in any row and their next deal is pinned at the top.
        </>
      ),
      actions: [{ label: "Clear search", run: () => setQuery("") }],
    };
  }
  if (prefs.sport === "mine") {
    return {
      message: (
        <>
          <b>None of your players has a deal right now.</b> Star a player in any row to pin their deals here.
        </>
      ),
      actions: [{ label: "Show all deals", run: () => setPrefs({ sport: "all" }) }],
    };
  }
  if (isRarity(prefs.rarity)) {
    const which = prefs.rarer && prefs.rarity < 7 ? `${rarityName(prefs.rarity)} or rarer` : rarityName(prefs.rarity);
    return {
      message: (
        <>
          <b>
            {none === "No deals" ? `No ${which} deals` : `No more ${which} deals`} right now.
          </b>{" "}
          New deals show up here as soon as we find them.{missing}
        </>
      ),
      actions: [{ label: "Show all rarities", run: () => setPrefs({ rarity: null }) }],
    };
  }
  const nudge = budgetNudge(snap, prefs, follows, now);
  if (nudge && prefs.budget !== null) {
    const to = nudge.next === null ? "any price" : formatRax(nudge.next);
    return {
      message: (
        <>
          <b>
            {none} under {formatRax(prefs.budget)} right now
          </b>{" "}
          — the cheapest is {formatRax(nudge.cheapest)}. Show up to {to}?
        </>
      ),
      actions: [
        {
          label: nudge.next === null ? "Show any price" : `Show up to ${to}`,
          run: () => setPrefs({ budget: nudge.next }),
        },
      ],
    };
  }
  const hidden = hiddenByLevel(snap, prefs, follows, now);
  if (hidden > 0) {
    return {
      message: (
        <>
          <b>
            {hidden === 1 ? "1 deal is" : `${formatRax(hidden)} deals are`} hidden at New:
          </b>{" "}
          live auctions, prices falling today, a hurt player or fewer recent sales. Show {hidden === 1 ? "it" : "them"} in Regular?
        </>
      ),
      actions: [{ label: "Switch to Regular", run: () => setLevel("regular") }],
    };
  }
  if (prefs.sport !== "all") {
    return {
      message: (
        <>
          <b>
            {none} in {sportLabel(prefs.sport)} right now.
          </b>
          {missing}
        </>
      ),
      actions: [{ label: "Show all sports", run: () => setPrefs({ sport: "all" }) }],
    };
  }
  return {
    message: (
      <>
        <b>{none} right now.</b> New deals show up here as soon as we find them.{missing}
      </>
    ),
    actions: [],
  };
}
