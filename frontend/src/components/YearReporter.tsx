// Tells the server a linked member's yearly figure (see lib/reportYear): headless, always mounted next to LinkSync.
// The figure is the planner's, on the passes read from the linked Real account (not ones added by hand, which another
// device may not hold: two devices would take turns overwriting the server's figure). Only a member whose link the server keeps is
// asked about, after a pause and only when the figure moved by 5 % or more from what the server holds. Cosmetic: it
// sets the member's account-type role in our Discord, nothing else, and the server trusts it for nothing more.
import { useContext, useEffect, useMemo } from "react";
import { useApp } from "../AppContext";
import { useLocal } from "../data/local";
import { useHeldMarkets } from "../hooks/useHeldMarkets";
import { track } from "../lib/activity";
import { saveLinkSettings, useMemberLink } from "../lib/link";
import { planHoldings } from "../lib/passes";
import { REPORT_AFTER_MS, worthReporting } from "../lib/reportYear";
import { MemberContext } from "./MemberLine";

const reported = new Map<string, number>();

export function YearReporter() {
  const { snap } = useApp();
  const member = useContext(MemberContext);
  const server = useMemberLink();
  const { passes, link } = useLocal();
  const markets = useHeldMarkets();
  const kept = server?.link ? server.link.year : undefined; // undefined: the server keeps no link for this member
  const real = useMemo(() => passes.filter((p) => p.from === "real"), [passes]);
  const counted = Boolean(link && real.length > 0 && markets.length > 0);
  const on = Boolean(member && counted && kept !== undefined);
  // The figure of the account linked on this device: told to the server for a member (below), and, once per figure
  // per page life, to the admin panel's Accounts tab (lib/activity.ts), for anyone.
  const figure = useMemo(
    () => (counted ? Math.round(planHoldings(real, markets, snap.rules.otd, snap.otd.sports).total) : null),
    [counted, real, markets, snap.rules.otd, snap.otd.sports],
  );
  const year = on ? figure : null;
  const username = link?.username;
  useEffect(() => {
    if (figure === null || !username || reported.get(username) === figure) return;
    reported.set(username, figure);
    track("year", username, figure);
  }, [figure, username]);
  useEffect(() => {
    if (!member || year === null || kept === undefined || !worthReporting(kept, year)) return;
    const timer = setTimeout(() => void saveLinkSettings(member, { year }), REPORT_AFTER_MS);
    return () => clearTimeout(timer);
  }, [member, year, kept]);
  return null;
}
