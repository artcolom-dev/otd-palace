// "Your day": up to five things a player does each day, ticked by the visitor themselves, a row of pills that light, and a
// calm streak (a day counts from 3 ticks; one missed day a week is forgiven). Kept on this device; it starts afresh at
// the device's own midnight. Shown to New by default, to Regular and Pro when they turn it on.
import { useId } from "react";
import { useApp } from "../AppContext";
import { POLL_TRAP, ROUTINE_ITEMS, type RoutineItem } from "../content/routine";
import { local, useLocal } from "../data/local";
import { cls } from "../lib/cls";
import { REAL_HOME, toOpenUrl } from "../lib/openLink";
import { ROUTINE_IDS, STREAK_MIN, localDay, showRoutine, streakOf, ticksFor } from "../lib/routine";
import { trackOut } from "../lib/track";
import { Icon } from "./Icon";
import { Pips } from "./Meter";

const userAgent = () => (typeof navigator === "undefined" ? "" : navigator.userAgent);

/** The weekday of a "YYYY-MM-DD" day, in short English ("Tue"). */
function weekday(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

/** How many of today's things are done: the count, and one pill for each thing, lit as it is ticked. */
function Progress({ done, total }: { done: number; total: number }) {
  return (
    <span className="rtn-prog">
      <b aria-hidden="true">
        {done}
        <small>/{total}</small>
      </b>
      <Pips done={done} total={total} label={`${done} of ${total} done today`} />
    </span>
  );
}

function Row({ item, on, today, pos }: { item: RoutineItem; on: boolean; today: string; pos: number }) {
  const { prefs, navigate } = useApp();
  return (
    <li className={cls("rtn-item", on && "on")}>
      <label className="rtn-row">
        <input type="checkbox" name={`routine-${item.id}`} checked={on} onChange={(e) => local.tickRoutine(item.id, e.target.checked, today)} />
        <span className="rtn-box" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M6 12.5l4 4 8-9" />
          </svg>
        </span>
        <span className="rtn-txt">
          <b>{item.title}</b>
          <small>{item.earns}</small>
        </span>
      </label>
      {item.where === "app" ? (
        <a
          className="rtn-go"
          href={toOpenUrl(REAL_HOME, userAgent())}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open Real: ${item.title}`}
          onClick={() => trackOut({ panel: "routine", target: "app", level: prefs.level, sport: prefs.sport, pos })}
        >
          <Icon name="ext" />
        </a>
      ) : (
        <button type="button" className="rtn-go" aria-label="See today's deals" onClick={() => navigate("deals")}>
          <Icon name="arrow" />
        </button>
      )}
      {item.id === "claim" && <p className="rtn-trap">{POLL_TRAP}</p>}
    </li>
  );
}

/** The streak and its grace token, in calm words. */
function streakLine(count: number, graceDay: string | null, graceReady: boolean) {
  if (count === 0) return { text: `Tick ${STREAK_MIN} things to start a streak.`, grace: null };
  const text = `Streak: ${count} ${count === 1 ? "day" : "days"}`;
  if (graceDay !== null) return { text, grace: { state: "used", label: `Grace day used (${weekday(graceDay)})` } };
  return { text, grace: graceReady ? { state: "ready", label: "1 grace day ready" } : null };
}

export function YourDay() {
  const { prefs, now, layout } = useApp();
  const { routine } = useLocal();
  const id = useId();
  if (!showRoutine(routine, prefs.level)) return null;
  const today = localDay(now);
  const ticks = ticksFor(routine, today);
  const streak = streakOf(routine.done, today);
  const line = streakLine(streak.count, streak.graceDay, streak.graceReady);
  return (
    <section className={cls(layout.phone ? "pnl" : "panel", "rtn")} aria-labelledby={`${id}h`}>
      <div className="ph">
        <h2 id={`${id}h`}>Your day</h2>
        <Progress done={ticks.length} total={ROUTINE_IDS.length} />
      </div>
      <p className="rtn-streak">
        <span>{line.text}</span>
        {line.grace && (
          <span className="rtn-grace" data-state={line.grace.state}>
            {line.grace.label}
          </span>
        )}
      </p>
      <ul className="rtn-list" aria-label="Today's checklist">
        {ROUTINE_ITEMS.map((item, i) => (
          <Row key={item.id} item={item} on={ticks.includes(item.id)} today={today} pos={i} />
        ))}
      </ul>
      <p className="sr" role="status">
        {ticks.length} of {ROUTINE_IDS.length} done today
      </p>
      <div className="rtn-foot">
        <small>
          A day counts from {STREAK_MIN} ticks. One missed day a week is forgiven. It starts again at midnight on this
          device.
        </small>
        <button type="button" className="lnk" onClick={() => local.showRoutine(false)}>
          Hide
        </button>
      </div>
    </section>
  );
}

/** Where the card was put away (or never turned on): one button to bring it back. */
export function RoutineBack() {
  const { prefs } = useApp();
  const { routine } = useLocal();
  if (showRoutine(routine, prefs.level)) return null;
  return (
    <button type="button" className="lnk box rtn-back" onClick={() => local.showRoutine(true)}>
      <Icon name="check" />
      Show your daily checklist
    </button>
  );
}
