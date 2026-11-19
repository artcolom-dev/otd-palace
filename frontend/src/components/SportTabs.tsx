import { type KeyboardEvent, useRef } from "react";
import { useApp } from "../AppContext";
import { type SportCounts, sportCounts } from "../data/deals";
import { cls } from "../lib/cls";
import { formatRax } from "../lib/format";
import { rovingIndex } from "../lib/keys";
import { sportLabel } from "../lib/words";
import { Icon } from "./Icon";

/**
 * "★ My players" (once someone is followed), "All", then each served sport in the served order, each with how many
 * deals it holds at this level and budget, leaving out the rows in `exclude` (Today's top three), or, given `counts`
 * and `sports`, what those count, such as moves. A sport that counts 0 (its deals all in the top three, or none at
 * all) is left out unless it is the one chosen. One tab stop: the arrows, Home and End move along the tabs and
 * choose as they go.
 */
export function SportTabs({
  exclude,
  counts: given,
  sports,
}: {
  exclude?: ReadonlySet<string>;
  counts?: SportCounts;
  sports?: readonly string[];
}) {
  const { snap, prefs, setPrefs, follows, now, query } = useApp();
  const listRef = useRef<HTMLDivElement>(null);
  const counts = given ?? sportCounts(snap, prefs, follows, now, exclude, query);
  const tabs: { key: string; label: string; n: number; star?: boolean }[] = [];
  if (follows.size > 0) tabs.push({ key: "mine", label: "My players", n: counts.mine, star: true });
  tabs.push({ key: "all", label: "All", n: counts.all });
  for (const sport of sports ?? snap.sports) {
    const n = counts.bySport[sport] ?? 0;
    if (n > 0 || prefs.sport === sport) tabs.push({ key: sport, label: sportLabel(sport), n });
  }
  const current = Math.max(0, tabs.findIndex((t) => t.key === prefs.sport));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = tabs.findIndex((t) => t.key === (e.target as HTMLElement).dataset.sport);
    const i = rovingIndex(e.key, from < 0 ? current : from, tabs.length, "horizontal");
    if (i === null) return;
    e.preventDefault();
    const next = tabs[i]!.key;
    setPrefs({ sport: next });
    listRef.current?.querySelector<HTMLElement>(`[data-sport="${next}"]`)?.focus();
  };

  return (
    <div ref={listRef} className="tabs" role="tablist" aria-label="Filter by player or sport" onKeyDown={onKeyDown}>
      {tabs.map((tab, i) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          data-sport={tab.key}
          aria-selected={prefs.sport === tab.key}
          tabIndex={i === current ? 0 : -1}
          className={cls(tab.star && "mine")}
          onClick={() => setPrefs({ sport: tab.key })}
        >
          {tab.star && <Icon name="star" />}
          {tab.label}
          <span>{formatRax(tab.n)}</span>
        </button>
      ))}
    </div>
  );
}
