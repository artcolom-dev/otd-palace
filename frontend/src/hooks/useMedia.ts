import { useSyncExternalStore } from "react";

function query(q: string): MediaQueryList | null {
  try {
    return typeof window.matchMedia === "function" ? window.matchMedia(q) : null;
  } catch {
    return null;
  }
}

/** Whether a media query matches now, re-rendering when it changes; false where there is no matchMedia. */
export function useMedia(q: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = query(q);
      list?.addEventListener?.("change", onChange);
      return () => list?.removeEventListener?.("change", onChange);
    },
    () => query(q)?.matches ?? false,
    () => false,
  );
}

export interface Layout {
  phone: boolean; // under 768 px: top bar, chip row, bottom tabs
  wide: boolean; // 1024 px and up: the deals as a table with Open and QR buttons; below, rows that are links
}

/** The page's layout for the current viewport. */
export function useLayout(): Layout {
  const tablet = useMedia("(min-width: 768px)");
  const wide = useMedia("(min-width: 1024px)");
  return { phone: !tablet, wide };
}
