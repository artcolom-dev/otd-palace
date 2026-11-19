import type { DealKind } from "../data/types";
import { cls } from "../lib/cls";
import { TermButton } from "./InfoTip";

/** How to buy: "to start" (bid the target price to start the countdown) or "top bid" (the bid to beat). */
export function BuyChip({ kind, inert = false, id }: { kind: DealKind; inert?: boolean; id?: string }) {
  const start = kind === "target";
  const className = cls("how-chip", start && "start");
  const label = start ? "to start" : "top bid";
  // Inside a row that is itself a link (the phone list), a chip is a plain word: the row opens the auction.
  if (inert) {
    return (
      <span className={className} id={id}>
        {label}
      </span>
    );
  }
  return (
    <TermButton term={start ? "start" : "bid"} className={className}>
      {label}
    </TermButton>
  );
}
