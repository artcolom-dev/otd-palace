// "I have Real Pro": what the visitor says about their Real account, kept on this device only (never sent anywhere).
// The account read through this site carries no Real Pro fact (advisor/importer.py reads none), so the site goes by
// this box. It matters for one thing: listing cards for sale and making offers need Real Pro
// (lib/recycle.ts). Off until ticked.
export const REAL_PRO_KEY = "advisor.realPro.v1";

const listeners = new Set<() => void>();
let current: boolean | null = null; // the answer as last read or ticked

/** Whether the visitor ticked "I have Real Pro"; false when nothing is saved or the browser refuses its storage. */
export function readRealPro(): boolean {
  try {
    return localStorage.getItem(REAL_PRO_KEY) === "1";
  } catch {
    return false;
  }
}

/** Keeps the answer (false forgets it) and tells every screen that reads it; a browser that refuses storage just forgets. */
export function saveRealPro(on: boolean): void {
  try {
    if (on) localStorage.setItem(REAL_PRO_KEY, "1");
    else localStorage.removeItem(REAL_PRO_KEY);
  } catch {
    // not remembered: the screens still follow the answer until the page closes
  }
  current = on;
  for (const listener of listeners) listener();
}

/** The answer as the screens read it: the saved one, then whatever was ticked during this visit. */
export function realProNow(): boolean {
  if (current === null) current = readRealPro();
  return current;
}

/** For useSyncExternalStore: called whenever the answer changes, here or in another tab of this site. */
export function subscribeRealPro(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== REAL_PRO_KEY && e.key !== null) return;
    current = readRealPro();
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}
