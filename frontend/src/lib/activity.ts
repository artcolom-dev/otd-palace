// What the page is used for, event by event, for the site's private admin panel (advisor/activity.py, shown at /admin).
//
// Each event goes under this browser's visit id (lib/visit.ts) and, once signed in with Discord, under the member's
// Discord account (the server reads that from the session cookie; the privacy notice says so). Events wait in a small
// queue and leave together: when the page is hidden (a beacon, so nothing waits on it), every FLUSH_MS while it is on
// screen, or when the queue is full. A session starts when the page opens and when it comes back after SESSION_GAP_MS
// out of sight; the seconds on screen are reported when it is hidden. Nothing is sent while the browser asks not to
// be tracked (Global Privacy Control, Do Not Track) and nobody is signed in, nor without usable storage. Fire and
// forget: it never throws, never waits and never touches the page's own work.
import { deviceClass, deviceId, mayCount } from "./visit";
import { isStandalone } from "./install";

export type ActivityKind =
  | "session"
  | "time"
  | "lookup"
  | "link"
  | "unlink"
  | "share"
  | "filter"
  | "sort"
  | "sport"
  | "deal"
  | "out"
  | "push"
  | "pings"
  | "install"
  | "refresh"
  | "sheet"
  | "year";

type Item = [ActivityKind] | [ActivityKind, string | null] | [ActivityKind, string | null, number];

const EVENTS_URL = "/api/events";
export const BATCH_MAX = 40; // advisor/rules.py ACTIVITY_BATCH_MAX
export const FLUSH_MS = 20_000;
export const SESSION_GAP_MS = 30 * 60_000; // advisor/rules.py ACTIVITY_SESSION_GAP_S
const TIME_MAX_S = 4 * 3600; // advisor/rules.py ACTIVITY_TIME_MAX_S
const QUEUE_MAX = 200; // a page that cannot send keeps no more than this
const USERNAME = /^[A-Za-z0-9_.-]{1,31}$/;
const LISTING = /^\d{1,18}$/;

const ARGS: Record<ActivityKind, "none" | "word" | "user" | "id"> = {
  session: "none",
  time: "none",
  lookup: "user",
  link: "user",
  unlink: "none",
  share: "word",
  filter: "word",
  sort: "word",
  sport: "word",
  deal: "id",
  out: "word",
  push: "word",
  pings: "word",
  install: "word",
  refresh: "none",
  sheet: "word",
  year: "user",
};

let queue: Item[] = [];

/** A plain word the server takes (`[a-z0-9][a-z0-9_.-]{0,31}`), made from any text: lower case, anything else a dash. */
export function word(text: string): string | null {
  const made = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return made ? made : null;
}

function argFor(kind: ActivityKind, arg: string | number | null | undefined): string | null | undefined {
  const rule = ARGS[kind];
  if (rule === "none") return null;
  if (arg === null || arg === undefined) return undefined;
  const text = String(arg).trim();
  if (rule === "word") return word(text) ?? undefined;
  if (rule === "id") return LISTING.test(text) ? text : undefined;
  const name = text.replace(/^@/, "");
  return USERNAME.test(name) ? name : undefined;
}

/** Notes one event (see the file's note): `arg` is checked here as the server checks it, `n` is for "time" (seconds)
 * and "year" (an account's yearly figure). An event the server would refuse is dropped here instead. */
export function track(kind: ActivityKind, arg?: string | number | null, n?: number): void {
  try {
    const a = argFor(kind, arg);
    if (a === undefined) return;
    let item: Item;
    if (kind === "time" || kind === "year") {
      if (typeof n !== "number" || !Number.isFinite(n)) return;
      const whole = Math.round(n);
      if (kind === "time" && (whole < 1 || whole > TIME_MAX_S)) return;
      if (kind === "year" && (whole < 0 || whole > 50_000_000)) return;
      item = [kind, a, whole];
    } else {
      item = a === null ? [kind] : [kind, a];
    }
    if (queue.length >= QUEUE_MAX) return;
    queue.push(item);
    if (queue.length >= BATCH_MAX) flushActivity();
  } catch {
    // Counting is never worth breaking the page over.
  }
}

/** Sends what waits, in one report: a beacon (it outlives the page), else a keepalive POST. */
export function flushActivity(): void {
  try {
    if (!queue.length) return;
    if (!mayCount()) {
      queue = [];
      return;
    }
    const d = deviceId();
    if (!d) {
      queue = [];
      return;
    }
    const items = queue.slice(0, BATCH_MAX);
    queue = queue.slice(BATCH_MAX);
    const json = JSON.stringify({ d, k: deviceClass(), a: isStandalone(), e: items });
    const sent =
      typeof navigator.sendBeacon === "function" &&
      navigator.sendBeacon(EVENTS_URL, new Blob([json], { type: "application/json" }));
    if (!sent) {
      fetch(EVENTS_URL, {
        method: "POST",
        body: json,
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        credentials: "same-origin",
      }).catch(() => undefined);
    }
    if (queue.length) flushActivity();
  } catch {
    // as above
  }
}

/** Sessions, time on screen and the regular sends (see the file's note). Returns the undo. */
export function startActivity(root: Document = document, now: () => number = Date.now): () => void {
  let shownAt: number | null = root.visibilityState === "hidden" ? null : now();
  let hiddenAt: number | null = shownAt === null ? now() : null;
  if (shownAt !== null) track("session");
  const report = () => {
    if (shownAt === null) return;
    const seconds = Math.min(TIME_MAX_S, Math.round((now() - shownAt) / 1000));
    shownAt = null;
    hiddenAt = now();
    if (seconds >= 1) track("time", null, seconds);
    flushActivity();
  };
  const onVisibility = () => {
    if (root.visibilityState === "hidden") return report();
    if (shownAt !== null) return;
    if (hiddenAt === null || now() - hiddenAt >= SESSION_GAP_MS) track("session");
    shownAt = now();
    hiddenAt = null;
  };
  const onHide = () => report();
  root.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onHide);
  const timer = window.setInterval(() => {
    if (root.visibilityState !== "hidden") flushActivity();
  }, FLUSH_MS);
  return () => {
    root.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onHide);
    window.clearInterval(timer);
  };
}

/** Forgets what waits ("Delete my data"). */
export function dropActivity(): void {
  queue = [];
}

/** Tests only: what waits, and a fresh page life. */
export function pendingForTests(): Item[] {
  return queue;
}
export function resetActivityForTests(): void {
  queue = [];
}
