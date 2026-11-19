// The arithmetic of a finger: which way a touch is going, how a dragged thing gives past its end, how fast it was let
// go and where it settles. Pure, so the sheet's drag and the pull to refresh are tested without a screen.

/** How far (px) a finger moves before its direction is read: less is a tap or a tremble. */
export const DRAG_SLOP = 8;

/** How far ahead a let-go is carried, in ms of travel at the speed it had: a flick goes further than a slow release. */
export const FLICK_MS = 180;

/** A let-go faster than this (px/ms) always moves at least one stop in its direction. */
export const FLICK_SPEED = 0.45;

export type Axis = "x" | "y";

/**
 * The direction a touch has taken once it moved past `slop`: "y" when it is clearly vertical (a vertical pull must
 * beat a horizontal one by a fifth, so a diagonal swipe on a sideways list stays the list's), else "x"; null before.
 */
export function lockAxis(dx: number, dy: number, slop: number = DRAG_SLOP): Axis | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < slop && ay < slop) return null;
  return ay >= ax * 1.2 ? "y" : "x";
}

/** Past its end a dragged thing gives less and less, never more than `limit`: `over` px of finger, as px of travel. */
export function rubberBand(over: number, limit: number): number {
  if (over <= 0 || limit <= 0) return 0;
  return limit * (1 - 1 / ((over * 0.55) / limit + 1));
}

export interface Sample {
  t: number; // ms
  y: number; // px
}

/** The speed (px/ms, positive downwards) over the last `windowMs` of samples; 0 with fewer than two. */
export function velocityOf(samples: readonly Sample[], windowMs = 100): number {
  const last = samples[samples.length - 1];
  if (samples.length < 2 || !last) return 0;
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    const s = samples[i];
    if (!s || last.t - s.t > windowMs) break;
    first = s;
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.y - first.y) / dt : 0;
}

export interface Settled {
  /** The offset (px down from fully open) the sheet comes to rest at. */
  to: number;
  /** It goes: `to` is the sheet's own height. */
  dismiss: boolean;
}

/**
 * Where a sheet let go at `offset` (px down from fully open; under 0 when pulled above it) with `velocity` (px/ms,
 * positive downwards) comes to rest: the stop nearest to where the flick would carry it, among `snaps` (offsets it can
 * rest at, 0 among them) and `height` (gone). A clear flick always moves at least one stop its way.
 */
export function settleSheet(offset: number, velocity: number, snaps: readonly number[], height: number): Settled {
  const stops = [...new Set([...snaps.filter((s) => s >= 0 && s < height), 0, height])].sort((a, b) => a - b);
  const nearest = (y: number): number => stops.reduce((best, s) => (Math.abs(s - y) < Math.abs(best - y) ? s : best), 0);
  let to = nearest(offset + velocity * FLICK_MS);
  if (Math.abs(velocity) >= FLICK_SPEED) {
    const from = nearest(offset);
    if (velocity > 0 && to <= from) to = stops.find((s) => s > offset) ?? height;
    if (velocity < 0 && to >= from) to = [...stops].reverse().find((s) => s < offset) ?? 0;
  }
  return { to, dismiss: to >= height };
}

/** Pull to refresh: the most the chip comes down (px), and the travel past which letting go refreshes. */
export const PULL_MAX = 112;
export const PULL_ARM = 64;

/** How far the chip has come down for `dy` px of finger: half the finger's travel up to the arming point, then a band. */
export function pullTravel(dy: number): number {
  if (dy <= 0) return 0;
  const half = dy / 2;
  return half <= PULL_ARM ? half : PULL_ARM + rubberBand(half - PULL_ARM, PULL_MAX - PULL_ARM);
}
