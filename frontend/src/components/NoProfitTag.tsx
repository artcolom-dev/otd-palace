import { NO_PROFIT_TEXT } from "../lib/words";
import { TermButton } from "./InfoTip";

/**
 * The tag on a deal that is under its usual price but leaves nothing after Real's fees if resold there (its after-fees
 * margin is 0 or less). The deal stays listed: a buyer may want the card itself. A tap explains it.
 */
export function NoProfitTag({ inert = false }: { inert?: boolean }) {
  if (inert) return <span className="noprofit" title={NO_PROFIT_TEXT}>no profit after fees</span>;
  return (
    <TermButton term="noProfit" className="noprofit">
      no profit after fees
    </TermButton>
  );
}
