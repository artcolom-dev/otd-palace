// The one meter. Every "how far" on the site (toward your first pass, the share of a sport's claims your passes
// win, how often a card sells at a price) is drawn by this, so they share a size, a track and a way of moving.
// `Pips` is its stepped twin for a short list of things done (today's checklist).
// The value reaches the style sheet as a custom property set through the CSSOM (never a style attribute, so the page
// keeps a strict CSP); `styles/meter.css` draws and animates it.
import { cls } from "../lib/cls";
import { useCssVar } from "../hooks/useCssVar";
/** A real share is never drawn thinner than this, so a small but real value still reads as a bar and not as a flaw. */
const SLIVER = 0.03;
interface MeterProps {
  /** 0 to 1. Anything else (a NaN, a negative, more than 1) is held to that range. */
  value: number;
  /** What it measures, said to a screen reader ("Toward your first pass"). Leave it out for a bar that repeats a line beside it. */
  label?: string;
  /** `accent`: progress toward something the visitor does. `quiet`: a share in a list, so ten of them do not all shout. */
  tone?: "accent" | "quiet";
  /** `m` (8 px) stands alone; `s` (6 px) sits in a list or a row. */
  size?: "m" | "s";
  className?: string;
}
export function Meter({ value, label, tone = "accent", size = "m", className }: MeterProps) {
  const share = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const ref = useCssVar<HTMLSpanElement>("--fill", (share > 0 ? Math.max(share, SLIVER) : 0).toFixed(4));
  const named = label !== undefined;
  return (
    <span
      ref={ref}
      className={cls("meter", className)}
      data-tone={tone}
      data-size={size}
      role={named ? "progressbar" : undefined}
      aria-label={label}
      aria-valuemin={named ? 0 : undefined}
      aria-valuemax={named ? 100 : undefined}
      aria-valuenow={named ? Math.round(share * 100) : undefined}
      aria-hidden={named ? undefined : true}
    >
      <i />
    </span>
  );
}
interface PipsProps {
  done: number;
  total: number;
  /** What the whole row says to a screen reader ("2 of 5 done today"). */
  label: string;
  className?: string;
}
/** `total` short pills, the first `done` lit: a count a glance can read, one pill for each thing to do. */
export function Pips({ done, total, label, className }: PipsProps) {
  const lit = Math.min(total, Math.max(0, Math.floor(Number.isFinite(done) ? done : 0)));
  return (
    <span className={cls("pips", className)} role="img" aria-label={label}>
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={i < lit ? "lit" : undefined} />
      ))}
    </span>
  );
}
