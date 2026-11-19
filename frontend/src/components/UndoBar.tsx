// "Removed X · Undo": the one-line bar a phone app shows after an action that removed or moved something, floating above
// the tab bar (bottom centre on desktop) for a few seconds: a pass removed with a row's ×, a star that pinned a player's
// deals to the top (the row leaves the finger). Undo puts things back as they were; unanswered, it goes on its own
// and the action stands. One bar for the whole site (AppContext.notify), the newest offer winning. The live region is
// always there, empty between offers, so each offer is read out as it comes.
import { useEffect, useLayoutEffect, useRef } from "react";
import { DUR, EASE_OUT, play } from "../lib/motion";

/** How long the offer stays: long enough to notice a slip, short enough not to sit over the list. */
export const UNDO_MS = 6000;

export interface UndoOffer {
  text: string;
  seq: number; // a new offer (a second action) starts the count again
  undo: () => void; // the bar goes once it has run
}

export function UndoBar({ offer, onGone }: { offer: UndoOffer | null; onGone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const gone = useRef(onGone);
  gone.current = onGone;
  const seq = offer?.seq ?? null;
  useEffect(() => {
    if (seq === null) return;
    const timer = setTimeout(() => gone.current(), UNDO_MS);
    return () => clearTimeout(timer);
  }, [seq]);
  useLayoutEffect(() => {
    if (seq === null) return;
    play(ref.current, [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], {
      duration: DUR.base,
      easing: EASE_OUT,
    });
  }, [seq]);
  return (
    <div className="undobar" aria-live="polite">
      {offer && (
        <div ref={ref} className="undo-in">
          <span className="undo-tx">{offer.text}</span>
          <button
            type="button"
            className="undo-go"
            onClick={() => {
              offer.undo();
              gone.current();
            }}
          >
            Undo
          </button>
        </div>
      )}
    </div>
  );
}
