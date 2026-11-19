// The sign-in of the site on a phone's home screen. Such an app does not follow a link that leaves the site: iOS opens
// discord.com in a Safari window over the app (Android, in a browser tab), Discord comes back to that window, and the
// session is made there, not in the app. So the app starts the login itself (POST /auth/handoff gives it the Discord
// address and a claim cookie), opens Discord, and keeps asking (POST /auth/handoff/claim) until the login is done: the
// server then gives it the session, and the visitor only has to close that window. See advisor/handoff.py.
import { isIos, isStandalone } from "./install";

/** The page's own moves, in one place so tests can watch them. */
export const nav = {
  assign: (url: string) => location.assign(url),
  reload: () => location.reload(),
};

/** How often the app asks while the login is open elsewhere. */
export const HANDOFF_POLL_MS = 3000;
/** The app stops asking after this long, as the server forgets the login then. */
export const HANDOFF_MAX_MS = 10 * 60 * 1000;

export type ClaimStatus = "done" | "waiting" | "gone" | "error";

/** Whether the sign-in goes through a handoff here: the site on a phone's home screen. */
export function handsOff(ua: string = navigator.userAgent, standalone: boolean = isStandalone()): boolean {
  return standalone && (isIos(ua) || /Android/.test(ua));
}

/** The `next` of a sign-in link (`/auth/discord?next=...`): the page to come back to. */
export function nextOf(href: string): string {
  try {
    return new URL(href, "https://x.invalid").searchParams.get("next") ?? "/";
  } catch {
    return "/";
  }
}

/** Starts a handoff: the Discord address to open, or null when the server did not give one. */
export async function startHandoff(next: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const r = await fetchImpl(`/auth/handoff?next=${encodeURIComponent(next)}`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!r.ok) return null;
    const body: unknown = await r.json();
    const url = typeof body === "object" && body !== null ? (body as { url?: unknown }).url : null;
    return typeof url === "string" && url.startsWith("https://discord.com/") ? url : null;
  } catch {
    return null;
  }
}

/** Asks whether the handoff's login is done ("done": this app now holds the session). */
export async function claimHandoff(fetchImpl: typeof fetch = fetch): Promise<ClaimStatus> {
  try {
    const r = await fetchImpl("/auth/handoff/claim", { method: "POST", credentials: "same-origin", cache: "no-store" });
    if (!r.ok) return "error";
    const body: unknown = await r.json();
    const status = typeof body === "object" && body !== null ? (body as { status?: unknown }).status : null;
    return status === "done" || status === "waiting" || status === "gone" ? status : "error";
  } catch {
    return "error";
  }
}

/**
 * Asks every HANDOFF_POLL_MS, and at once whenever the app comes back to the front, until the login is done (then
 * `onDone`), the server forgets it, or HANDOFF_MAX_MS pass (then `onGone`). Returns how to stop.
 */
export function waitForHandoff(
  onDone: () => void,
  onGone: () => void,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): () => void {
  const until = now() + HANDOFF_MAX_MS;
  let stopped = false;
  let asking = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onFront);
    window.removeEventListener("focus", onFront);
  };
  const ask = async () => {
    if (stopped || asking) return;
    asking = true;
    clearTimeout(timer);
    const status = await claimHandoff(fetchImpl);
    asking = false;
    if (stopped) return;
    if (status === "done") {
      stop();
      onDone();
    } else if (status === "gone" || now() >= until) {
      stop();
      onGone();
    } else {
      timer = setTimeout(() => void ask(), HANDOFF_POLL_MS);
    }
  };
  function onFront() {
    if (document.visibilityState === "visible") void ask();
  }
  document.addEventListener("visibilitychange", onFront);
  window.addEventListener("focus", onFront);
  timer = setTimeout(() => void ask(), HANDOFF_POLL_MS);
  return stop;
}
