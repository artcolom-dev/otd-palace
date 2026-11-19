import { AlertNotice } from "../components/AlertNotice";
import { DealsSection } from "./DealsSection";
import { PassDeals } from "../components/PassDeals";

/** Deals: every deal for this visitor, without the hero; a notification's deal is lit up, or explained when it left. */
export function DealsView() {
  return (
    <div className="page deals-page">
      <AlertNotice />
      <PassDeals />
      <DealsSection title="All deals" heading="h1" />
    </div>
  );
}
