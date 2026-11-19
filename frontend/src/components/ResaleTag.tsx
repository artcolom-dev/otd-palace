import type { Resale } from "../data/types";
import { resaleWords } from "../lib/resale";
import { TermButton } from "./InfoTip";

/**
 * The tag on a deal whose player's cards sold (or did not) when listed again: "Resells well" or "Slow to resell",
 * with the counts behind it for a screen reader and, on desktop, behind a tap that explains where they come from. On
 * a phone it is a word, as the falling and hurt tags are. Nothing for the middle, where a tag would be noise.
 */
export function ResaleTag({ resale, inert = false }: { resale: Resale | undefined; inert?: boolean }) {
  const words = resaleWords(resale);
  if (words === null) return null;
  const { label, line, tone } = words;
  if (inert) {
    return (
      <span className="resold" data-tone={tone}>
        {label}
        <span className="sr"> · {line}</span>
      </span>
    );
  }
  return (
    <TermButton term="resale" className="resold" tone={tone} label={`${label} · ${line}`}>
      {label}
    </TermButton>
  );
}
