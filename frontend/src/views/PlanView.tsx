// Your plan: what the visitor's passes can pay a year, the account type it makes, and the next moves. For a visitor with
// no account linked, it starts from "Where are you with Real?" (components/YourPlan).
import { PlanBody } from "../components/YourPlan";
import { PLAN_TITLE } from "../content/yourPlan";
import { LockedPlan, useLocked } from "../components/Access";

export function PlanView() {
  const locked = useLocked(); // the free site: the plan comes with Discord, with the account it reads
  return (
    <div className="page plan-page">
      <h1>{PLAN_TITLE}</h1>
      <p className="plan-lead">Real pays you Rax every day your passes' players played on that date. Here is what yours can pay, and what to do next.</p>
      {locked ? <LockedPlan /> : <PlanBody />}
    </div>
  );
}
