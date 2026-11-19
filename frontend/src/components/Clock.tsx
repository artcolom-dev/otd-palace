import { useEffect, useRef, useState } from "react";
import type { Deal } from "../data/types";
import { cls } from "../lib/cls";
import { clockText, clockTone, seenText } from "../lib/words";

const PLUS_MS = 2400;
const EXTENDED_MS = 30_000; // an end that moves at least this much later is a soft-close extension

/**
 * A deal's clock off the shared second: "listed 3 m ago" or "ends in 22 m", orange in a bid's last minute, and a
 * "+1 min" flash when a late bid pushes the end back.
 */
export function Clock({ deal, now, sentence = false }: { deal: Deal; now: number; sentence?: boolean }) {
  const lastEnd = useRef(deal.ends_at);
  const [plus, setPlus] = useState(0);

  useEffect(() => {
    const before = Date.parse(lastEnd.current);
    const after = Date.parse(deal.ends_at);
    lastEnd.current = deal.ends_at;
    if (deal.kind === "bid" && after - before >= EXTENDED_MS) setPlus((n) => n + 1);
  }, [deal.ends_at, deal.kind]);

  useEffect(() => {
    if (!plus) return;
    const t = setTimeout(() => setPlus(0), PLUS_MS);
    return () => clearTimeout(t);
  }, [plus]);

  return (
    <span className="clockbox">
      <span className={cls("clock", clockTone(deal, now))} data-testid="clock">
        {clockText(deal, now, sentence)}
      </span>
      {seenText(deal, now) && (
        <span className="seen" data-testid="seen">
          {seenText(deal, now)}
        </span>
      )}
      {plus > 0 && (
        <span key={plus} className="plus" aria-hidden="true">
          +1 min
        </span>
      )}
    </span>
  );
}
