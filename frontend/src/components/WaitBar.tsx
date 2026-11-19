// A thin bar beside the words of a wait, inside the page or a sheet. Two kinds, never mixed up: with a real measure
// (`value` of `max`: an account's passes counted so far, as the server reports them) it is a progress bar that fills
// to that point and says how far in the page's own words; without one it only moves, a short band crossing it, and
// claims nothing (screen readers get the words beside it, not the bar).
import { useLayoutEffect, useRef } from "react";

export function WaitBar({ value, max = 1, label, valueText }: { value?: number; max?: number; label?: string; valueText?: string }) {
  const line = useRef<HTMLElement>(null);
  const known = typeof value === "number" && max > 0;
  const now = known ? Math.min(max, Math.max(0, value)) : 0;
  // Set from script, as the CSP allows no inline style: a transform, so the compositor draws it.
  useLayoutEffect(() => {
    if (known && line.current) line.current.style.transform = `scaleX(${(now / max).toFixed(3)})`;
  }, [known, now, max]);
  if (!known) {
    return (
      <span className="wbar" data-kind="busy" aria-hidden="true">
        <i />
      </span>
    );
  }
  return (
    <span
      className="wbar"
      data-kind="known"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={now}
      aria-valuetext={valueText}
    >
      <i ref={line} />
    </span>
  );
}
