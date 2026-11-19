import { useId } from "react";
import { useApp } from "../AppContext";
import type { Challenge } from "../data/types";
import { cls } from "../lib/cls";
import { endsText } from "../lib/words";

/** The challenges still running at `nowMs`, at most `max`. */
export function liveChallenges(challenges: readonly Challenge[] | undefined, nowMs: number, max = 3): Challenge[] {
  return (challenges ?? []).filter((c) => !c.ends_at || Date.parse(c.ends_at) > nowMs).slice(0, max);
}

/**
 * A key per challenge: what it says, and for one that reads the same as one before it (the snapshot does not carry
 * the feed's own key, and two of Real's challenges can share a title, a reward and an end), how many came before.
 */
export function challengeKeys(challenges: readonly Challenge[]): string[] {
  const seen = new Map<string, number>();
  return challenges.map((c) => {
    const base = `${c.title}|${c.reward ?? ""}|${c.ends_at ?? ""}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}|${n}`;
  });
}

/**
 * "Free Rax right now": what Real pays Rax or packs for at this moment (watch a game's plays, fill a profile...),
 * from the live feed. Nothing at all while no challenge runs, which is most of the time.
 */
export function FreeRax() {
  const { snap, now, layout } = useApp();
  const id = useId();
  const live = liveChallenges(snap.challenges, now);
  if (live.length === 0) return null;
  const keys = challengeKeys(live);
  return (
    <section className={cls(layout.phone ? "pnl" : "panel", "freerax")} aria-labelledby={`${id}h`}>
      <div className="ph">
        <h2 id={`${id}h`}>Free Rax right now</h2>
      </div>
      <p className="pnote">Real pays these in the app, no card needed.</p>
      <ul className="frl">
        {live.map((c, i) => (
          <li key={keys[i]}>
            <b>{c.title}</b>
            {c.reward && <span className="frr">{c.reward}</span>}
            {c.ends_at && <span className="frt">{endsText(Date.parse(c.ends_at) - now)}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
