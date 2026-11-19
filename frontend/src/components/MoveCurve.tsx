// The curve in a price move's row on Prices: a small drawing of its market's middle sale, a dot a day with sales, the
// last dot the last 24 hours, with the span it really covers and its two ends written under it (lib/priceCurve.ts).
// It is a picture of figures the row and the caption already say in words, so it sits under the row's link and takes
// no tap of its own; a screen reader gets one sentence instead. Nothing moves: it is drawn at once. A faint line under
// the drawing is its floor, so a day standing alone (the days around it had too few sales) still reads as a point.
import { type PriceCurve, curveCaption, curveShape, curveText } from "../lib/priceCurve";
import { cls } from "../lib/cls";

const WIDTH = 96;
const HEIGHT = 24;

export function MoveCurve({ curve }: { curve: PriceCurve }) {
  const { dots, lines } = curveShape(curve, WIDTH, HEIGHT);
  const way = curve.change > 0 ? "up" : curve.change < 0 ? "down" : null;
  return (
    <span className={cls("mvc", way)} data-testid="move-curve">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width={WIDTH} height={HEIGHT} aria-hidden="true" focusable="false">
        <line className="axis" x1={0} x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} />
        {lines.map((d) => (
          <path key={d} d={d} />
        ))}
        {dots.map(([x, y], i) => (
          <circle key={`${x}:${y}`} cx={x} cy={y} r={i === dots.length - 1 ? 2.75 : 2} className={i === dots.length - 1 ? "now" : undefined} />
        ))}
      </svg>
      <span className="mvcl" aria-hidden="true">
        {curveCaption(curve)}
      </span>
      <span className="sr">{curveText(curve)}</span>
    </span>
  );
}
