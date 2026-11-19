// A figure that was just seen to change: a price that moved, a count that grew. It takes a calm accent wash that fades
// over 1.2 s (opacity only, drawn by styles/motion.css). Nothing happens on the first paint or when a refresh brings
// the same value, so the page stays still unless something really changed. Under reduced motion the wash is a short
// colour-only fade (the token is 0 ms there, so it is simply not drawn).
import { useEffect, useRef, useState } from "react";
import { cls } from "../lib/cls";
import { formatRax } from "../lib/format";
import { DUR } from "../lib/motion";

/** True for 1.2 s after `value` changes; never on the first render. */
export function useChanged(value: unknown): boolean {
  const last = useRef(value);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (Object.is(last.current, value)) return;
    last.current = value;
    setOn(true);
    const t = window.setTimeout(() => setOn(false), DUR.hold);
    return () => window.clearTimeout(t);
  }, [value]);
  return on;
}

/** A bold number that washes when it changes. */
export function Chg({ value, id, className }: { value: number; id?: string; className?: string }) {
  const on = useChanged(value);
  return (
    <b id={id} className={cls(className, on && "chg")}>
      {formatRax(value)}
    </b>
  );
}
