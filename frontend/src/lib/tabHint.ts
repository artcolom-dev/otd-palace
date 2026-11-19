// Which tab this visit opens on, known before the site's code has loaded: the entry file starts that tab's code beside
// the site's, instead of the site finding out after it runs. Kept free of imports so it adds almost nothing to the
// entry (the gate screen's file).
import type { TabKey } from "../data/prefs";

export const STORAGE_KEY = "advisor.prefs.v1";
const TABS: readonly string[] = ["today", "deals", "prices", "passes", "plan"];
const ALIASES: Record<string, TabKey> = { market: "prices", otd: "passes" };

/** The tab an old address names (#deals, and the older #market and #otd), if it names one; a broken address names none. */
export function tabFromHash(): TabKey | null {
  let name: string;
  try {
    name = decodeURIComponent(location.hash.slice(1)).toLowerCase();
  } catch {
    return null; // "#%" and the like: not a tab, and not worth a blank page
  }
  const tab = ALIASES[name] ?? name;
  return TABS.includes(tab) ? (tab as TabKey) : null;
}

/** The tab a bare address opens: the one the visitor left off on (kept on this device), else Today. */
export function rememberedTab(): TabKey {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    const tab = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>).tab : null;
    return typeof tab === "string" && TABS.includes(tab) ? (tab as TabKey) : "today";
  } catch {
    return "today";
  }
}

// Each tab's own address, served by the server as the page with that view's title and line (advisor/web.py VIEWS):
// Today is the bare address.
const PATHS: Record<TabKey, string> = { today: "/", deals: "/deals", prices: "/prices", passes: "/passes", plan: "/plan" };

/** The address of a tab. */
export const tabPath = (tab: TabKey): string => PATHS[tab];

/** The tab a path names (/deals); the bare address names none (it is the remembered tab's), nor any other path. */
export function tabFromPath(path: string = location.pathname): TabKey | null {
  if (path === "/") return null;
  const tab = path.slice(1);
  return TABS.includes(tab) && PATHS[tab as TabKey] === path ? (tab as TabKey) : null;
}

/** The tab the address names: an old #tab link wins over the path it was opened on. */
export const tabFromAddress = (): TabKey | null => tabFromHash() ?? tabFromPath();

/** The tab this visit opens on. */
export const firstTab = (): TabKey => tabFromAddress() ?? rememberedTab();
