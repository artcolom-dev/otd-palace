// What fills the places Today and the shell leave around the deals. Each wrapper collapses while its part is empty.
import { useApp } from "../AppContext";
import { BudgetCard } from "../components/BudgetBuddy";
import { CommunityCta } from "../components/CommunityCta";
import { EarnCard } from "../components/EarnCard";
import { FirstGoalCard } from "../components/FirstGoal";
import { FreeRax } from "../components/FreeRax";
import { MovesPanel } from "../components/MovesPanel";
import { NextRaxCard } from "../components/NextRax";
import { OpenedStrip } from "../components/OpenedStrip";
import { PassPickPanel } from "../components/PassPickPanel";
import { PlanCard } from "../components/YourPlan";
import { ProfileCard } from "../components/ProfileCard";
import { SavedTotal } from "../components/SavedTotal";
import { SinceLastVisit } from "../components/SinceLastVisit";
import { RightNowCard } from "../components/RightNow";
import { RoutineBack, YourDay } from "../components/YourDay";

/** First on Today for a small account (or a visitor holding nothing): the best moves for this moment. A bigger account has it in the day slot, put away. */
export function CoachSlot() {
  return <RightNowCard place="top" />;
}

/** Above the hero: "Since your last visit: 4 new deals on your players · Jokić −22% today". */
export function SinceSlot() {
  return <SinceLastVisit />;
}

/** Top of the right rail (desktop) or with the account card (phone): "Your passes can pay up to X Rax a year". */
export function PlanSlot() {
  return <PlanCard />;
}

/** Top of the right rail (desktop) or above the hero (phone): "You opened 2 deals — got one?". */
export function OpenedSlot() {
  return <OpenedStrip />;
}

/**
 * What to do today: the daily checklist, for a visitor with no pass the first one to aim at, and this month's season
 * move with the way into "Earn more Rax".
 */
export function DaySlot() {
  return (
    <>
      <RightNowCard place="day" />
      <YourDay />
      <FirstGoalCard />
      <EarnCard />
    </>
  );
}

/** Under the top three (desktop): the best next uses of the visitor's Rax. A phone has it in the panels, after the buddy. */
export function NextSlot() {
  return <NextRaxCard variant="today" />;
}

/**
 * The right rail under it (desktop) or after the deals (phone): what the visitor's balance can buy, (phone) the best
 * next uses of it, prices moving today, then the pass worth getting, then (desktop; a phone's shell has it at the foot
 * of every page) the community, and the way back to the daily checklist when it is put away.
 */
export function PanelsSlot() {
  const { layout } = useApp();
  return (
    <>
      <FreeRax />
      <BudgetCard />
      {layout.phone && <NextRaxCard variant="today" />}
      <MovesPanel />
      <PassPickPanel />
      <ProfileCard />
      {!layout.phone && <CommunityCta />}
      <RoutineBack />
    </>
  );
}

/** The sidebar, under the budget: the running "Saved … Rax" total. */
export function SavedSlot() {
  return <SavedTotal variant="side" />;
}
