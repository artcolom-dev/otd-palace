// The anonymous visit count behind the site's private admin panel (advisor/visits.py, shown at /admin).
//
// The browser picks one random id and keeps it in its own storage: not a cookie, never sent anywhere but to our own
// /api/visit, and it names nobody. The page reports that it opened (with its tab, a coarse device class, whether it
// runs from the home screen, the referring site's host name and a campaign tag from its address), that a tab opened,
// or that a "Continue with Discord" link was pressed. Fire and forget: a beacon, else a keepalive POST; it never
// throws and never waits. Without usable storage nothing is sent (a new id at each load would count one person many
// times), and neither when the browser sends Global Privacy Control or Do Not Track while nobody is signed in (a
// signed-in member's activity is recorded with their Discord account: see lib/activity.ts). "Delete my data" forgets the id
// (see lib/privacy.ts), so the next visit starts a new one.
import type { TabKey } from "../data/prefs";
import { isStandalone } from "./install";

export const VISIT_KEY = "advisor.visit.v1";
const VISIT_URL = "/api/visit";
const ID = /^[A-Za-z0-9_-]{22}$/;
const TAG = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
const SIGN_IN = "/auth/discord";

export type VisitEvent = "load" | "view" | "signin";
export type DeviceClass = "phone" | "tablet" | "desktop";

function newId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** This browser's visit id, made on first use; null when its storage cannot be read or written. */
export function deviceId(): string | null {
  try {
    const kept = localStorage.getItem(VISIT_KEY);
    if (kept && ID.test(kept)) return kept;
    const made = newId();
    localStorage.setItem(VISIT_KEY, made);
    return localStorage.getItem(VISIT_KEY) === made ? made : null;
  } catch {
    return null;
  }
}

/** This browser's visit id if it has one already (none is made); null otherwise. */
export function peekDevice(): string | null {
  try {
    const kept = localStorage.getItem(VISIT_KEY);
    return kept && ID.test(kept) ? kept : null;
  } catch {
    return null;
  }
}

let erased = false; // "Delete my data" signed this page out: the page's own mark still says who it was

/** Drops this browser's visit id ("Delete my data"); the one it held, once, or null. */
export function forgetDevice(): string | null {
  erased = true;
  try {
    const kept = localStorage.getItem(VISIT_KEY);
    localStorage.removeItem(VISIT_KEY);
    return kept && ID.test(kept) ? kept : null;
  } catch {
    return null;
  }
}

/** The host name of the site that sent the visitor here, never our own and never more than the name. */
export function referrerHost(referrer: string = document.referrer, own: string = location.hostname): string | undefined {
  if (!referrer) return undefined;
  try {
    const host = new URL(referrer).hostname.toLowerCase();
    const bare = (name: string) => name.replace(/^www\./, "");
    return host && bare(host) !== bare(own.toLowerCase()) ? host : undefined;
  } catch {
    return undefined;
  }
}

/** A campaign tag from the address (`?ref=` first, else `utm_source`), lower case, short and plain; else nothing. */
export function campaignTag(search: string = location.search): string | undefined {
  try {
    const params = new URLSearchParams(search);
    const tag = (params.get("ref") ?? params.get("utm_source") ?? "").trim().toLowerCase();
    return TAG.test(tag) ? tag : undefined;
  } catch {
    return undefined;
  }
}

/** A coarse class from the pointer and the screen's short side: nothing finer is ever sent. */
export function deviceClass(): DeviceClass {
  try {
    const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    const short = Math.min(screen.width, screen.height);
    if (coarse && short < 600) return "phone";
    if (coarse && short < 1100) return "tablet";
    return "desktop";
  } catch {
    return "desktop";
  }
}

interface Where {
  referrer?: string;
  search?: string;
}

/** Whether the browser asks sites not to track it (Global Privacy Control, or Do Not Track): then nothing is sent
 * and no id is made. */
export function optedOut(): boolean {
  try {
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
    return nav.globalPrivacyControl === true || nav.doNotTrack === "1";
  } catch {
    return false;
  }
}

/** Whether the page may count this visit: always for someone signed in with Discord (their activity is recorded with
 * their account, as the privacy notice says), else only while the browser does not ask not to be tracked. */
export function mayCount(): boolean {
  try {
    if (!optedOut()) return true;
    if (erased) return false;
    // The gate's mark the server put in the page (lib/gate.ts reads the same), read here alone to stay light.
    const mark = JSON.parse(document.getElementById("me")?.textContent || "null") as { state?: unknown } | null;
    return mark?.state === "in" || mark?.state === "out" || mark?.state === "banned";
  } catch {
    return false;
  }
}

/** Reports one visit event, fire and forget. A page load also says where the visit came from. */
export function sendVisit(event: VisitEvent, tab?: TabKey, where: Where = {}): void {
  try {
    if (!mayCount()) return;
    const d = deviceId();
    if (!d) return;
    const body: Record<string, unknown> = { d, e: event };
    if (tab) body.t = tab;
    body.k = deviceClass();
    body.a = isStandalone();
    if (event === "load") {
      const r = referrerHost(where.referrer ?? document.referrer);
      const s = campaignTag(where.search ?? location.search);
      if (r) body.r = r;
      if (s) body.s = s;
    }
    const json = JSON.stringify(body);
    const sent =
      typeof navigator.sendBeacon === "function" &&
      navigator.sendBeacon(VISIT_URL, new Blob([json], { type: "application/json" }));
    if (sent) return;
    fetch(VISIT_URL, {
      method: "POST",
      body: json,
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => undefined);
  } catch {
    // Counting is never worth breaking the page over.
  }
}

/** Reports each press on a "Continue with Discord" link anywhere on the page (every such link starts the login at
 * /auth/discord). Listens in the capture phase, so a link that handles its own click is seen too. Returns the undo. */
export function watchSignIn(root: Document = document): () => void {
  const onClick = (e: Event) => {
    const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
    const href = link?.getAttribute("href") ?? "";
    if (href === SIGN_IN || href.startsWith(`${SIGN_IN}?`)) sendVisit("signin");
  };
  root.addEventListener("click", onClick, true);
  return () => root.removeEventListener("click", onClick, true);
}

let loaded = false;
let lastTab: TabKey | null = null;
let lastDay = "";

const utcDay = () => new Date().toISOString().slice(0, 10);

/** The tab on screen: the first call of a page's life reports the load (with its tab), each later change of tab a
 * view. The same tab again, or a component drawn twice, reports nothing more. */
export function noteTab(tab: TabKey, where: Where = {}): void {
  if (!loaded) {
    loaded = true;
    lastTab = tab;
    lastDay = utcDay();
    sendVisit("load", tab, where);
    return;
  }
  if (tab === lastTab) return;
  lastTab = tab;
  lastDay = utcDay();
  sendVisit("view", tab);
}

/** A page left open (a home-screen app is resumed, not reloaded) shown again on a new UTC day reports its tab, so
 * the day counts as one it was used. Returns the undo. */
export function watchReturn(root: Document = document): () => void {
  const onShow = () => {
    if (root.visibilityState === "hidden" || !loaded || !lastTab) return;
    const today = utcDay();
    if (today === lastDay) return;
    lastDay = today;
    sendVisit("view", lastTab);
  };
  root.addEventListener("visibilitychange", onShow);
  return () => root.removeEventListener("visibilitychange", onShow);
}

/** Tests only: a fresh page life. */
export function resetVisitForTests(): void {
  erased = false;
  loaded = false;
  lastTab = null;
  lastDay = "";
}
