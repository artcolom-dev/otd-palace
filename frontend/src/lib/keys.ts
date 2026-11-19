import type { KeyboardEvent } from "react";

export type Orientation = "horizontal" | "vertical" | "both";

/**
 * Where a key moves the focus in a row of `count` choices (tabs, radios, menu items) from `index`: the arrows of
 * the row's direction step and wrap, Home and End jump to the ends. Null for any other key.
 */
export function rovingIndex(key: string, index: number, count: number, orientation: Orientation = "both"): number | null {
  if (count === 0) return null;
  const across = orientation !== "vertical";
  const down = orientation !== "horizontal";
  if ((across && key === "ArrowRight") || (down && key === "ArrowDown")) return (index + 1 + count) % count;
  if ((across && key === "ArrowLeft") || (down && key === "ArrowUp")) return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/**
 * Arrow keys, Home and End in a group of radios drawn as buttons (a phone sheet's choices): the focus moves, wrapping
 * round, and the group's one tab stop moves with it. Choosing stays with a tap, Enter or Space.
 */
export function onRadioKeys(e: KeyboardEvent<HTMLElement>): void {
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'));
  const i = rovingIndex(e.key, items.indexOf(e.target as HTMLElement), items.length, "vertical");
  if (i === null) return;
  e.preventDefault();
  items.forEach((el, j) => {
    el.tabIndex = j === i ? 0 : -1;
  });
  items[i]?.focus();
}

/** The radio that holds a group's tab stop: the checked one, else the first. */
export const radioStop = (checked: number, index: number) => (index === Math.max(0, checked) ? 0 : -1);
