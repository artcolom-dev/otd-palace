import type { KeyboardEvent } from "react";
import { useApp } from "../AppContext";
import { sortLabel, sortsFor, visibleDeals } from "../data/deals";
import { passSortValue } from "../lib/dealPass";
import { onRadioKeys, radioStop, rovingIndex } from "../lib/keys";
import { Icon } from "./Icon";
import { useOverlay } from "./Overlay";

/** Up, Down, Home and End move between the menu's items; Escape (the popover's) closes it onto its button. */
function onMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitemradio]"));
  const i = rovingIndex(e.key, items.indexOf(e.target as HTMLElement), items.length, "vertical");
  if (i === null) return;
  e.preventDefault();
  items[i]?.focus();
}

/** Under the sorts: how many of the deals on screen build a pass the site tracks (what "For passes" puts first). */
function passesNote(...args: Parameters<typeof visibleDeals>): string {
  const value = passSortValue(args[0]);
  const n = visibleDeals(...args).filter((d) => value(d) !== null).length;
  if (n === 0) return "For passes: no deal here builds a pass we track right now.";
  return n === 1 ? "1 deal here builds a pass we track." : `${n} deals here build a pass we track.`;
}

/** "Sort: Best % under ▾": a menu on desktop, a sheet of choices on a phone. The sort runs in the page. */
export function SortMenu() {
  const { prefs, setPrefs, layout, follows, snap, now, query } = useApp();
  const pinned = follows.size > 0; // starred players' deals sit above the rest, whatever the sort
  const overlay = useOverlay();
  const keys = sortsFor(prefs.level);
  return (
    <button
      type="button"
      className="sortbtn"
      aria-haspopup={layout.phone ? "dialog" : "menu"}
      onClick={(e) =>
        overlay.open({
          title: "Sort deals",
          anchor: e.currentTarget,
          size: "narrow",
          body: ({ titleId, close, phone }) => (
            <div
              className={phone ? "opts" : "menu"}
              role={phone ? "radiogroup" : "menu"}
              aria-labelledby={titleId}
              onKeyDown={phone ? onRadioKeys : onMenuKeyDown}
            >
              {keys.map((key, i) => (
                <button
                  key={key}
                  type="button"
                  className={phone ? "opt" : undefined}
                  role={phone ? "radio" : "menuitemradio"}
                  aria-checked={prefs.sort === key}
                  tabIndex={phone ? radioStop(keys.indexOf(prefs.sort), i) : prefs.sort === key ? undefined : -1}
                  data-autofocus={prefs.sort === key ? "" : undefined}
                  onClick={() => {
                    setPrefs({ sort: key });
                    close();
                  }}
                >
                  {sortLabel(key, prefs.level)}
                  <Icon name="check" />
                </button>
              ))}
              <p className="sortnote">{passesNote(snap, prefs, follows, now, query)}</p>
              {pinned && <p className="sortnote">Players you star always come first.</p>}
            </div>
          ),
        })
      }
    >
      <span>Sort</span>
      <b>{sortLabel(prefs.sort, prefs.level)}</b>
      <Icon name="chev" />
    </button>
  );
}
