// Motion through the Web Animations API only: no inline style strings, so the page keeps a strict CSP. Every effect
// has a reduced-motion path of opacity or colour alone, and nothing here loops.

/** The motion tokens of styles/tokens.css, in ms: the same durations (Real's 200 to 500 ms) and easings in CSS and in script. */
export const DUR = { fast: 120, base: 200, slow: 300, glide: 400, enter: 500, hold: 1200 } as const;
/** Staggers: one beat between siblings, and the most a list may wait in all (nobody waits for a long list to deal). */
export const STAGGER = { beat: 40, max: 240 } as const;
export const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
export const EASE_IN = "cubic-bezier(0.5, 0, 0.75, 0)";
/** A sheet let go by the finger: leaves fast, lands soft, no bounce (a spring with its overshoot damped away). */
export const EASE_SPRING = "cubic-bezier(0.32, 0.72, 0, 1)";

/** The delay of the `i`-th sibling of an entering list, capped so a long list is dealt in `STAGGER.max` ms at most. */
export const stagger = (i: number, beat: number = STAGGER.beat): number => Math.min(i * beat, STAGGER.max);

export function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Plays `frames` on `el` (or `reduced`, opacity and colour only, when the visitor asks for less motion). Returns
 * null where there is nothing to animate: no element, or a browser without the Web Animations API.
 */
export function play(
  el: Element | null | undefined,
  frames: Keyframe[],
  options: KeyframeAnimationOptions,
  reduced: Keyframe[] | null = [{ opacity: 0 }, { opacity: 1 }],
): Animation | null {
  if (!el || typeof el.animate !== "function") return null;
  const rm = prefersReducedMotion();
  if (rm && reduced === null) return null;
  try {
    return el.animate(rm ? (reduced ?? frames) : frames, rm ? { ...options, easing: "ease-out" } : options);
  } catch {
    return null;
  }
}

/** Slides each element from where it was (`before`, top edges by key) to where it is now: a FLIP move. */
export function flipFrom(before: Map<string, number>, els: Iterable<HTMLElement>, keyOf: (el: HTMLElement) => string) {
  for (const el of els) {
    const was = before.get(keyOf(el));
    if (was === undefined) continue;
    const dy = was - el.getBoundingClientRect().top;
    if (Math.abs(dy) > 1) {
      play(el, [{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: DUR.glide, easing: EASE_OUT }, [
        { opacity: 0.45 },
        { opacity: 1 },
      ]);
    }
  }
}

/** The top edge of each element, by key, to FLIP from after the next change. */
export function measureTops(els: Iterable<HTMLElement>, keyOf: (el: HTMLElement) => string): Map<string, number> {
  const tops = new Map<string, number>();
  for (const el of els) tops.set(keyOf(el), el.getBoundingClientRect().top);
  return tops;
}
