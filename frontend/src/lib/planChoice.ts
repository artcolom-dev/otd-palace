// "Where are you with Real?": the choice a visitor with no linked account made on Your plan, kept on this device only
// (never sent anywhere). "start": not started yet. "new": just started. Linking replaces it with the real plan.
export type PlanChoice = "start" | "new";
export const PLAN_CHOICE_KEY = "advisor.planChoice.v1";

/** The saved choice, or null: nothing saved, a value this site does not know, or a browser that refuses its storage. */
export function readPlanChoice(): PlanChoice | null {
  try {
    const v = localStorage.getItem(PLAN_CHOICE_KEY);
    return v === "start" || v === "new" ? v : null;
  } catch {
    return null;
  }
}

/** Keeps the choice (null forgets it); a browser that refuses its storage just does not remember. */
export function savePlanChoice(choice: PlanChoice | null): void {
  try {
    if (choice === null) localStorage.removeItem(PLAN_CHOICE_KEY);
    else localStorage.setItem(PLAN_CHOICE_KEY, choice);
  } catch {
    // not remembered: the plan still shows this visit
  }
}
