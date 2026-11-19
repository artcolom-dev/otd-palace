import { useEffect, useRef, useState } from "react";
import { cls } from "../lib/cls";
import { plural } from "../lib/words";
import { Icon } from "./Icon";

const THROTTLE_MS = 2000;
const ANNOUNCE_EVERY_MS = 60_000;

/** The count shown, changed at most once every 2 s (at once when it appears or goes), so it is calm to watch. */
function useThrottledCount(count: number): number {
  const [shown, setShown] = useState(count);
  const changedAt = useRef(Date.now());
  useEffect(() => {
    if (count === shown) return;
    const apply = () => {
      changedAt.current = Date.now();
      setShown(count);
    };
    if (count === 0 || shown === 0) return apply();
    const wait = changedAt.current + THROTTLE_MS - Date.now();
    if (wait <= 0) return apply();
    const t = setTimeout(apply, wait);
    return () => clearTimeout(t);
  }, [count, shown]);
  return shown;
}

/**
 * What a screen reader hears: the first arrivals at once, then at most once a minute (the count as it stands
 * then), and silence once the pill goes. A busy market must not talk over the page.
 */
function useAnnouncement(count: number): string {
  const [said, setSaid] = useState("");
  const saidAt = useRef(0);
  const latest = useRef(count);
  latest.current = count;
  useEffect(() => {
    if (count === 0) {
      setSaid("");
      return;
    }
    const say = () => {
      saidAt.current = Date.now();
      setSaid(plural(latest.current, "new deal", "new deals"));
    };
    if (said === "") return say();
    const wait = saidAt.current + ANNOUNCE_EVERY_MS - Date.now();
    if (wait <= 0) return say();
    const t = setTimeout(say, wait);
    return () => clearTimeout(t);
  }, [count, said]);
  return said;
}

/** "3 new deals ↑": deals that arrived while the list held still. A tap puts them in. */
export function NewDealsPill({ count, onMerge, className }: { count: number; onMerge: () => void; className?: string }) {
  const shown = useThrottledCount(count);
  const said = useAnnouncement(count);
  return (
    <div className={cls("pillbox", className)}>
      <span className="sr" aria-live="polite" data-testid="new-deals-said">
        {said}
      </span>
      {count > 0 && shown > 0 && (
        <button type="button" className="pill" onClick={onMerge}>
          <Icon name="arrowup" />
          {plural(shown, "new deal", "new deals")}
        </button>
      )}
    </div>
  );
}
