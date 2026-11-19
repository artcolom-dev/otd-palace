// "Right now", on Today: the one to three best moves for a small account at this moment, from the clock (Real's day turns
// over about 08:15 New York time), the month (which sports pay now) and what the account holds. A tiny account ("Not
// earning yet", "Starter", or a visitor holding nothing) sees it first; a bigger one has it put away behind one button.
// The words come from lib/rightNow.ts (pure, clock injected); this file only draws them.
import { useId, useMemo, useState } from "react";
import { TermTip } from "./InfoTip";
import { useApp } from "../AppContext";
import { useLocal } from "../data/local";
import { useCoachPlan } from "../hooks/useYourPlan";
import { cls } from "../lib/cls";
import type { TermKey } from "../content/glossary";
import { offerHint } from "../lib/offers";
import { dayOf } from "../lib/passes";
import { type Buy, type CoachMove, type MoveKind, isTiny, rightNow } from "../lib/rightNow";
import { localDay, streakOf } from "../lib/routine";

const sportOfKey = (key: string) => key.split(":")[0] ?? "";

/** The coach for this moment, worked out once a minute; null before the season months are known. */
export function useCoach() {
  const { snap, now } = useApp();
  const { passes, balance, routine } = useLocal();
  const plan = useCoachPlan();
  const minute = Math.floor(now / 60_000);
  return useMemo(() => {
    const months = snap.rules.otd?.sport_months;
    if (!months) return null;
    const buys: Buy[] = plan.moves
      .filter((m) => m.rung && m.kind !== "deal")
      .map((m) => {
        const offer = m.market ? offerHint(m.market, m.rung!, snap.rules.otd, dayOf(snap.otd.as_of)) : null;
        return {
          sport: m.sport, title: m.title, tier: m.rung!.tier, mult: m.rung!.mult, cost: m.cost, year: m.year,
          offerCost: offer?.cost ?? null, offerMeasured: offer?.measured != null,
        };
      });
    const tiny = isTiny(plan.type.key);
    const today = localDay(minute * 60_000);
    const streak = streakOf(routine.done, today);
    return {
      tiny,
      type: plan.type.name,
      view: rightNow({
        now: minute * 60_000, tiny, heldSports: passes.map((p) => sportOfKey(p.key)), sportMonths: months, buys, balance,
        streak: { count: streak.count, doneToday: streak.doneToday },
      }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the clock is read by the minute
  }, [snap.rules.otd, snap.otd.as_of, plan, passes, balance, routine.done, minute]);
}

/** The Real word each move rests on, explained by its ⓘ (none at Pro). */
const MOVE_TERM: Partial<Record<MoveKind, TermKey>> = { claim: "claim", free: "general", pass: "rarity", soon: "otd" };

function Move({ move, pos }: { move: CoachMove; pos: number }) {
  const term = MOVE_TERM[move.kind];
  return (
    <li className="rn-move" data-kind={move.kind}>
      <span className="rn-n" aria-hidden="true">
        {pos}
      </span>
      <span className="rn-body">
        <b>
          {move.title}
          {term && <TermTip term={term} />}
        </b>
        <span className="rn-why">{move.why}</span>
        {move.worth && <small className="rn-worth">{move.worth}</small>}
        {move.tip && (
          <span className="rn-tip">
            {move.tip}
            <TermTip term="offer" />
          </span>
        )}
      </span>
    </li>
  );
}

export function RightNowCard({ place }: { place: "top" | "day" }) {
  const { layout } = useApp();
  const coach = useCoach();
  const id = useId();
  const [open, setOpen] = useState(false);
  if (!coach) return null;
  const { tiny, view } = coach;
  if (tiny !== (place === "top")) return null; // a tiny account has it first; a bigger one, with its day
  const shown = tiny || open;
  const body = (
    <>
      <p className="rn-clock">{view.headline}</p>
      <ol className="rn-moves" aria-label="Your best moves, in order">
        {view.moves.map((m, i) => (
          <Move key={`${m.kind}-${m.title}`} move={m} pos={i + 1} />
        ))}
      </ol>
      {view.idle && <p className="pnote rn-idle">{view.idle}</p>}
      {view.coming && (
        <p className="pnote rn-coming">
          <b>{view.coming.days === 0 ? "Today" : view.coming.days === 1 ? "Tomorrow" : `In ${view.coming.days} days`}:</b>{" "}
          {view.coming.event.title}. {view.coming.event.line}
        </p>
      )}
      {view.streak && <p className="pnote rn-streak">{view.streak}</p>}
      <p className="pnote rn-gloss">
        On This Day: a pass pays Rax again on the anniversaries of its player's games. Rax is Real's coin.
      </p>
    </>
  );
  return (
    <section className={cls(layout.phone ? "pnl" : "panel", "rn")} aria-labelledby={`${id}h`} data-tiny={tiny ? "1" : "0"}>
      <div className="ph">
        <h2 id={`${id}h`}>Right now</h2>
        {!tiny && (
          <button
            type="button"
            className="lnk rn-toggle"
            aria-expanded={open}
            aria-controls={`${id}b`}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide" : "Show"}
          </button>
        )}
      </div>
      {!tiny && !open && <p className="pnote rn-sum">{view.headline}</p>}
      <div id={`${id}b`} hidden={!shown}>
        {shown && body}
      </div>
    </section>
  );
}
