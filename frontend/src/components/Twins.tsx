// "Similar deals": a deal that went away is never a dead end. The same player-season first, then the same sport at a
// close price and at least the same rating, three rows at most (lib/twins.ts). Drawn on a dimmed gone row, in the
// "You opened…" strip and on the notice a notification's address (?open=) opens when its deal is no longer there.
import { useId } from "react";
import { useApp } from "../AppContext";
import { sortDeals, visibleDeals } from "../data/deals";
import { findTwins, type TwinSubject } from "../lib/twins";
import { DealLink } from "./DealLink";
import { PausedDescription, usePaused } from "./Paused";

/**
 * The twins of `subject` among the deals this visitor sees. With no subject (a deal the page has no record of) it
 * offers the best deals for them instead, under `fallbackTitle`. Draws nothing when there is none to offer.
 */
export function Twins({ subject, fallbackTitle = "Deals for you instead" }: { subject: TwinSubject | null; fallbackTitle?: string }) {
  const { snap, prefs, follows, now } = useApp();
  const paused = usePaused();
  const id = useId();
  const rules = snap.rules.twins;
  if (!rules) return null;
  const shown = visibleDeals(snap, prefs, follows, now);
  const rows = subject ? findTwins(subject, shown, rules) : sortDeals(shown, "best", follows).slice(0, rules.max);
  if (rows.length === 0) return null;
  const title = subject ? "Similar deals" : fallbackTitle;
  return (
    <div className="twins">
      <PausedDescription {...paused} />
      <p className="twh" id={id}>
        {title}
      </p>
      <ul aria-labelledby={id}>
        {rows.map((deal, i) => (
          <li key={`${deal.listing_id}:${deal.kind}`}>
            <DealLink deal={deal} pos={i} paused={paused} />
          </li>
        ))}
      </ul>
    </div>
  );
}
