import { type KeyboardEvent, useId, useLayoutEffect, useRef } from "react";
import { useApp } from "../AppContext";
import { PASS_LEVEL_MEANING } from "../content/passWords";
import { LEVEL_KEYS, type LevelKey } from "../data/prefs";
import { rovingIndex } from "../lib/keys";
import { DUR, play } from "../lib/motion";

export const LEVEL_MEANING: Record<LevelKey, string> = {
  new: "Safest deals, plain words.",
  regular: "More deals, auctions ending soon.",
  pro: "Everything, with resale profit. Free here, not Real Pro.",
};

const FALLBACK_LABEL: Record<LevelKey, string> = { new: "New", regular: "Regular", pro: "Pro" };

/** New / Regular / Pro as one radio group; the arrows, Home and End move between them. */
export function LevelControl({ variant }: { variant: "side" | "phone" }) {
  const { snap, prefs, setLevel } = useApp();
  const labelId = useId();
  const groupRef = useRef<HTMLDivElement>(null);

  const choose = (level: LevelKey) => {
    if (level !== prefs.level) setLevel(level);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = rovingIndex(e.key, LEVEL_KEYS.indexOf(prefs.level), LEVEL_KEYS.length);
    if (i === null) return;
    e.preventDefault();
    const next = LEVEL_KEYS[i]!;
    choose(next);
    groupRef.current?.querySelector<HTMLElement>(`[data-level="${next}"]`)?.focus();
  };

  const radios = (
    <div
      ref={groupRef}
      className={variant === "side" ? "seg" : "lvl"}
      role="radiogroup"
      aria-label={variant === "phone" ? "Level" : undefined}
      aria-labelledby={variant === "side" ? labelId : undefined}
      onKeyDown={onKeyDown}
    >
      {LEVEL_KEYS.map((level) => {
        const on = prefs.level === level;
        return (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            data-level={level}
            onClick={() => choose(level)}
          >
            <span>{snap.levels[level]?.label ?? FALLBACK_LABEL[level]}</span>
          </button>
        );
      })}
    </div>
  );

  if (variant === "phone") return radios;
  return (
    <>
      <span className="lbl" id={labelId}>
        Level
      </span>
      {radios}
      <LevelMeaning />
    </>
  );
}

/** The level's one-line meaning (on the Passes tab, what it means there); it fades in when the level changes. */
export function LevelMeaning() {
  const { prefs, tab } = useApp();
  const ref = useRef<HTMLParagraphElement>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    play(ref.current, [{ opacity: 0 }, { opacity: 1 }], { duration: DUR.slow }, null);
  }, [prefs.level]);
  return (
    <p ref={ref} className="lvlmean" aria-live="polite">
      {(tab === "passes" ? PASS_LEVEL_MEANING : LEVEL_MEANING)[prefs.level]}
    </p>
  );
}
