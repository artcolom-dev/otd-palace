// A figure that counts to its value: from 0 the first time it is drawn (500 ms), and from the old value to the new one
// when it changes (400 ms). A refresh that brings the same value does nothing. The text is written straight to one
// text node through a ref (React never owns it, so a re-render cannot fight the count), the final value is written
// first and last, and a browser without the Web Animations API (the tests' jsdom) or a visitor who asks for less
// motion just gets the value. A hidden ghost of the final text, drawn by the style sheet from `data-final`, holds the
// width, so the words beside the figure never move while it counts.
import { useLayoutEffect, useRef } from "react";
import { cls } from "../lib/cls";
import { formatRax } from "../lib/format";
import { DUR, prefersReducedMotion } from "../lib/motion";

const easeOutCubic = (k: number) => 1 - (1 - k) ** 3;

export function CountUp({
  value,
  format = formatRax,
  className,
}: {
  value: number;
  format?: (n: number) => string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = shown.current ?? 0;
    const first = shown.current === null;
    shown.current = value;
    const canMove =
      typeof el.animate === "function" &&
      !prefersReducedMotion() &&
      !document.documentElement.hasAttribute("data-tab-hidden") &&
      Math.abs(value - from) >= 1 &&
      (!first || value >= 1);
    if (!canMove) {
      el.textContent = format(value);
      return;
    }
    const ms = first ? DUR.enter : DUR.glide;
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      el.textContent = format(k >= 1 ? value : Math.round(from + (value - from) * easeOutCubic(k)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    el.textContent = format(from);
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      el.textContent = format(value);
    };
  }, [value, format]);
  return (
    <span className={cls("cu", className)} data-final={format(value)}>
      <span ref={ref} />
    </span>
  );
}
