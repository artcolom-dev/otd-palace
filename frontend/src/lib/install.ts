// Adding the site to a phone's home screen. Chromium on Android offers it through the `beforeinstallprompt` event,
// which fires once, soon after the page loads: it is caught here from the start and kept until the card uses it.
// iOS has no such event; there the card says how to do it by hand (Share, then Add to Home Screen).
import { useSyncExternalStore } from "react";

/** The event Chromium fires when the site can be installed; not in the DOM typings. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<unknown>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform?: string }>;
}

let deferred: InstallPromptEvent | null = null;
let listening = false;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

function onPrompt(e: Event) {
  e.preventDefault(); // our own card asks, from the second visit on, instead of the browser's banner
  deferred = e as InstallPromptEvent;
  notify();
}

function onInstalled() {
  deferred = null;
  notify();
}

/** Starts catching the install offer; called once at start-up (and again harmlessly). */
export function listenForInstall(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("beforeinstallprompt", onPrompt);
  window.addEventListener("appinstalled", onInstalled);
}

/** Forgets the offer and stops listening (tests start afresh). */
export function resetInstall(): void {
  if (typeof window !== "undefined") {
    window.removeEventListener("beforeinstallprompt", onPrompt);
    window.removeEventListener("appinstalled", onInstalled);
  }
  listening = false;
  deferred = null;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const offered = () => deferred !== null;

/** Whether the browser has offered to install the site (Android/Chromium). */
export function useInstallOffer(): boolean {
  return useSyncExternalStore(subscribe, offered, offered);
}

/** Shows the browser's own install dialog; resolves once the visitor answered it. Says whether they accepted. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  deferred = null; // the event can be used once
  notify();
  try {
    await event.prompt();
    const choice = await event.userChoice;
    return choice.outcome === "accepted";
  } catch {
    return false;
  }
}

/** Whether the site already runs from the home screen. */
export function isStandalone(): boolean {
  try {
    if (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches) return true;
  } catch {
    // an old browser without display-mode queries
  }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** An iPhone, iPod or iPad (an iPad that reports itself as a Mac still has a touch screen). */
export function isIos(ua: string = navigator.userAgent): boolean {
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1;
}

/**
 * An app's own browser on iOS (Instagram, Facebook, many chat apps): a web view that cannot add anything to the home
 * screen. Safari, and Chrome, Firefox or Edge on iOS (which can, from their share menu), all say Safari/ in their
 * user agent; a web view does not.
 */
export function isIosInApp(ua: string = navigator.userAgent): boolean {
  return isIos(ua) && !/Safari\//.test(ua);
}
