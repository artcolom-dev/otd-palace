// Prices and Passes load after the page: their code (the pass planner above all) is not needed to paint Today or
// Deals. Their code is fetched once the page is idle, so moving to either tab stays instant.
import { lazyView } from "../lib/lazyView";

const prices = lazyView(() => import("./PricesView").then((m) => m.PricesView));
const passes = lazyView(() => import("./PassesView").then((m) => m.PassesView));
const plan = lazyView(() => import("./PlanView").then((m) => m.PlanView));

export const PricesView = prices.View;
export const PassesView = passes.View;
export const PlanView = plan.View;

/** After a failed load, the next visit to the view (the crash card's Try again) imports its code anew. */
export function resetFailedViews(): void {
  prices.reset();
  passes.reset();
  plan.reset();
}

/** Fetches the views' code. A failure is left for the visit to the tab to show, with its Try again. */
export function preloadViews(): Promise<void> {
  return Promise.all([prices.preload(), passes.preload(), plan.preload()]).then(
    () => undefined,
    () => undefined,
  );
}
