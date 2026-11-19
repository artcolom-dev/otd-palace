// "Saved 1,240 Rax with OTD Palace": the Rax saved on the deals this device marked as got.
import { useEffect, useRef, useState } from "react";
import { useLocal } from "../data/local";
import { cls } from "../lib/cls";
import { formatRax } from "../lib/format";
import { prefersReducedMotion } from "../lib/motion";
import { plural } from "../lib/words";
import { Icon } from "./Icon";
import { InfoTip } from "./InfoTip";

const COUNT_MS = 600; // the total counts up this long

/** A number that counts up (or down) to `value` over 600 ms when it changes; at once for less motion. */
function useCountUp(value: number): [number, boolean] {
  const [shown, setShown] = useState(value);
  const [hot, setHot] = useState(false);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    from.current = value;
    if (start === value) return;
    if (prefersReducedMotion()) {
      setShown(value);
      return;
    }
    const t0 = Date.now();
    let timer = 0;
    const step = () => {
      const k = Math.min(1, (Date.now() - t0) / COUNT_MS);
      setShown(Math.round(start + (value - start) * (1 - (1 - k) ** 3)));
      if (k < 1) timer = window.setTimeout(step, 16);
    };
    setHot(true);
    timer = window.setTimeout(step, 16);
    const cool = window.setTimeout(() => setHot(false), 1100);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(cool);
      setShown(value);
    };
  }, [value]);
  return [shown, hot];
}

/**
 * "Saved 1,240 Rax with OTD Palace": the device's total from the deals marked got, once above 0. In the sidebar
 * on desktop, under the hero on a phone; its ⓘ says it is counted on this device.
 */
export function SavedTotal({ variant }: { variant: "side" | "phone" }) {
  const { saved, got } = useLocal();
  const [shown, hot] = useCountUp(saved);
  if (saved <= 0) return null;
  const figure = <strong className={cls(hot && "hot")}>{formatRax(shown)}</strong>;
  if (variant === "phone") {
    return (
      <p className="savings phone" data-testid="saved-total">
        <Icon name="check" />
        <span>
          Saved {figure} Rax with OTD Palace
        </span>
        <InfoTip term="saved" />
      </p>
    );
  }
  return (
    <section className="savings" data-testid="saved-total" aria-label="Saved with OTD Palace">
      <p>
        Saved {figure} Rax
        <InfoTip term="saved" />
      </p>
      <small>with OTD Palace · {plural(got.length, "deal", "deals")} you got</small>
    </section>
  );
}
