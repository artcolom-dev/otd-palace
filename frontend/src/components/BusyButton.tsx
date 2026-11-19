// A button whose work takes a moment (unlink, check again, delete, sign out, turn on alerts, draw a picture): while it
// works it says so in its own words ("Unlinking…"), carries a thin moving line along its foot, is marked busy for
// screen readers and refuses a second tap, yet keeps the focus (a disabled button would drop it). Both words sit in the
// same place, all but the current one hidden, so the button keeps its width and nothing beside it moves. A wait of 8 s or more
// says once, politely, that it is still at it. Success or failure is the caller's to say, beside the button, as before.
import { type ButtonHTMLAttributes, type MouseEvent, type ReactNode, useEffect, useState } from "react";
import { cls } from "../lib/cls";

/** After this long at work, a button says it is still at it. */
export const LONG_WAIT_MS = 8000;

/** True once `active` has lasted `ms`; false again as soon as it ends. */
export function useLongWait(active: boolean, ms: number = LONG_WAIT_MS): boolean {
  const [long, setLong] = useState(false);
  useEffect(() => {
    setLong(false);
    if (!active) return;
    const timer = setTimeout(() => setLong(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return active && long;
}

export interface BusyButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  busy: boolean;
  /** What it says while it works: "Unlinking…". */
  busyLabel: ReactNode;
  /** What it says once the work has lasted 8 s, when a longer wait is worth a word: "Still checking…". */
  slowLabel?: ReactNode;
  children: ReactNode;
}

export function BusyButton({ busy, busyLabel, slowLabel, children, className, onClick, ...rest }: BusyButtonProps) {
  const long = useLongWait(busy);
  const shown = !busy ? "idle" : long && slowLabel ? "slow" : "busy";
  const click = (e: MouseEvent<HTMLButtonElement>) => {
    if (busy) {
      e.preventDefault(); // a second tap while it works does nothing, not even submit a form
      return;
    }
    onClick?.(e);
  };
  return (
    <>
      <button
        {...rest}
        className={cls(className, "bsy", busy && "is-busy")}
        aria-busy={busy || undefined}
        aria-disabled={busy || rest["aria-disabled"] || undefined}
        onClick={click}
      >
        <span className="bsy-in">
          <span className="bsy-l" aria-hidden={shown !== "idle" || undefined}>
            {children}
          </span>
          <span className="bsy-l" aria-hidden={shown !== "busy" || undefined}>
            {busyLabel}
          </span>
          {slowLabel && (
            <span className="bsy-l" aria-hidden={shown !== "slow" || undefined}>
              {slowLabel}
            </span>
          )}
          <span className="bsy-bar" aria-hidden="true" />
        </span>
      </button>
      {/* Only a long wait is said (a short one has said enough with its own words); no empty region meanwhile. */}
      {long && (
        <span className="sr" role="status">
          This is taking longer than usual. Still working.
        </span>
      )}
    </>
  );
}
