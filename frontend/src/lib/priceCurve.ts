// The curve of a price move on Prices: its market's middle sale, a day at a time, then the last 24 hours.
//
// The server sends a move's finished days (advisor/price_history.py) as [days ago, middle sale, sales], oldest first:
// only UTC days it saw 3 or more sales in, at most 30 days back. A day without a figure is not sent, and is not
// drawn: the line breaks there. The last point is the move's own "today" (the last 24 hours, `median_recent`), the
// figure the row already shows, so the curve ends where the row's change does. Nothing here estimates anything.
import type { Move } from "../data/types";
import { formatRax } from "./format";
import { PRICE_CURVE_DAYS, PRICE_CURVE_MIN_POINTS, priceCurveSwitch } from "./priceCurveSwitch";

export interface CurvePoint {
  ago: number; // days before today (UTC); 0 is the last 24 hours
  price: number; // the middle sale, in Rax
  sales: number;
}

export interface PriceCurve {
  points: CurvePoint[]; // oldest first, today last
  days: number; // what the curve spans, today included: "the last N days"
  first: number;
  last: number;
  change: number; // last / first - 1
}

const whole = (v: unknown, low: number, high: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= low && v <= high;

/** The server's days as points, or null when the field is not exactly its shape (then nothing is drawn). */
function served(curve: unknown): CurvePoint[] | null {
  if (!Array.isArray(curve) || curve.length > PRICE_CURVE_DAYS) return null;
  const points: CurvePoint[] = [];
  for (const row of curve as unknown[]) {
    if (!Array.isArray(row) || row.length !== 3) return null;
    const [ago, price, sales] = row as unknown[];
    if (!whole(ago, 1, PRICE_CURVE_DAYS) || !whole(price, 1, 1e9) || !whole(sales, 1, 1e7)) return null;
    const before = points[points.length - 1];
    if (before && ago >= before.ago) return null; // oldest first, a day once
    points.push({ ago, price, sales });
  }
  return points;
}

/** A move's curve, or null when there is none to draw: the switch off, no usable days, or under 3 points in all. */
export function priceCurve(m: Pick<Move, "curve" | "median_recent" | "sales_recent">): PriceCurve | null {
  if (!priceCurveSwitch.on) return null;
  const days = served(m.curve);
  if (!days || !(Number.isFinite(m.median_recent) && m.median_recent > 0)) return null;
  const points = [...days, { ago: 0, price: m.median_recent, sales: m.sales_recent }];
  if (points.length < PRICE_CURVE_MIN_POINTS) return null;
  const first = points[0]!.price;
  return { points, days: points[0]!.ago + 1, first, last: m.median_recent, change: m.median_recent / first - 1 };
}

/** The curve for someone who cannot see it: the span it really covers, its two ends and the change between them. */
export function curveText(c: PriceCurve): string {
  const pct = Math.round(Math.abs(c.change) * 100);
  const way = pct === 0 ? "level" : `${c.change > 0 ? "up" : "down"} ${pct}%`;
  return `Typical sale over the last ${c.days} days: from ${formatRax(c.first)} to ${formatRax(c.last)} Rax, ${way}.`;
}

/** The line under the drawing: "Last 7 days: 124 → 160". */
export const curveCaption = (c: PriceCurve) => `Last ${c.days} days: ${formatRax(c.first)} → ${formatRax(c.last)}`;

const PAD = 4; // room for a dot at the box's edge

/**
 * The drawing in a `width` x `height` box: a dot a point, and a line through each run of days next to each other
 * (SVG path data). Two points with a missing day between them are not joined. Time runs left to right over the
 * curve's whole span, so a gap is as wide as the days it misses.
 */
export function curveShape(c: PriceCurve, width: number, height: number): { dots: [number, number][]; lines: string[] } {
  const oldest = c.points[0]!.ago;
  const prices = c.points.map((p) => p.price);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const round = (n: number) => Math.round(n * 10) / 10;
  const x = (ago: number) => round(PAD + ((oldest - ago) / oldest) * (width - 2 * PAD));
  const y = (price: number) =>
    high === low ? round(height / 2) : round(PAD + ((high - price) / (high - low)) * (height - 2 * PAD));
  const dots = c.points.map((p): [number, number] => [x(p.ago), y(p.price)]);
  const lines: string[] = [];
  let run: [number, number][] = [];
  c.points.forEach((p, i) => {
    const before = c.points[i - 1];
    if (before && before.ago - p.ago !== 1) {
      if (run.length > 1) lines.push(run.map(([px, py], j) => `${j ? "L" : "M"}${px} ${py}`).join(""));
      run = [];
    }
    run.push(dots[i]!);
  });
  if (run.length > 1) lines.push(run.map(([px, py], j) => `${j ? "L" : "M"}${px} ${py}`).join(""));
  return { dots, lines };
}
