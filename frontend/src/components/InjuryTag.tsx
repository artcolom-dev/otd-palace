import type { Injury } from "../data/types";
import { injuryWords } from "../lib/injury";
import { TermButton } from "./InfoTip";

/**
 * The tag on a deal whose player ESPN lists as hurt: one word on the screen ("Out", "Day-to-day"), the whole line
 * ("Out · knee · back about Nov 18") for a screen reader and, on desktop, behind a tap that explains what it means.
 * On a phone it is a word, not a button too small to tap beside the ⓘ (the falling tag does the same). Its shape
 * (a filled dot for a player who most likely misses the game, a ring for one who may play) says it without colour.
 */
export function InjuryTag({ injury, inert = false }: { injury: Injury; inert?: boolean }) {
  const words = injuryWords(injury);
  if (words === null) return null; // a note we cannot read: no tag, never an error
  const { label, line, tone } = words;
  if (inert) {
    return (
      <span className="inj" data-tone={tone}>
        {label}
        <span className="sr">{line.slice(label.length)}</span>
      </span>
    );
  }
  return (
    <TermButton term="hurt" className="inj" tone={tone} label={line}>
      {label}
    </TermButton>
  );
}
