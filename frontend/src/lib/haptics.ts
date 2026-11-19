// A short buzz under the finger, for the few moments that deserve one: a tab changed, a deal opened in Real, a player
// starred, a switch flipped, an account linked (or not), a pull that refreshes, a sheet that snaps. Never on scroll,
// never twice in a blink, never for a visitor who asks for less motion or turned it off.
//
// Two ways to buzz, whichever the device has:
// - the Vibration API (Android browsers): a pattern of milliseconds;
// - iOS 18 and later, which has no Vibration API but gives the system's own light tick when a switch control
//   (`<input type="checkbox" switch>`) flips: a hidden switch's label is clicked. It only answers inside a tap (the
//   browser's user activation), so on an iPhone every pattern is one tick and a buzz after a wait (a link answered) is
//   silent. Older iPhones and desktops: nothing, and nothing is drawn.
// Everything the module reads from the browser can be handed in (`createHaptics`), so it is tested without one.
import { useSyncExternalStore } from "react";

export type HapticPattern = "tap" | "select" | "success" | "warning";

/** Each pattern in milliseconds (on, off, on...): light and short, as a phone's own keyboard and switches are. */
export const PATTERNS: Readonly<Record<HapticPattern, number | readonly number[]>> = {
  tap: 8, // a tab, a deal opened, a sheet that snaps or goes
  select: 12, // a switch, a star, a pull that will refresh
  success: [12, 70, 18], // an account linked, a refresh that brought news
  warning: [26, 60, 26], // a link or an unlink that failed
};

/** Two buzzes never come closer than this: a burst of taps or events is one buzz, not a rattle. */
export const MIN_GAP_MS = 80;

/** Where this device keeps "off" (a visitor's choice, this device only). */
export const STORAGE_KEY = "advisor.haptics.v1";

export type HapticEngine = "vibrate" | "ios-switch" | "none";

interface NavLike {
  vibrate?: (pattern: number | number[]) => boolean;
  userAgent?: string;
  maxTouchPoints?: number;
}

type StoreLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface HapticsEnv {
  /** The browser's navigator (vibrate, userAgent, maxTouchPoints). */
  nav?: NavLike | null;
  /** The document the iOS switch lives in; null: none. */
  doc?: Document | null;
  /** Whether that document's inputs know the `switch` attribute (iOS 17.4+ Safari). */
  hasSwitch?: () => boolean;
  now?: () => number;
  reducedMotion?: () => boolean;
  /** Whether the page is on screen: a hidden page never buzzes. */
  visible?: () => boolean;
  storage?: StoreLike | null;
}

export interface Haptics {
  /** How this device buzzes, decided on first use. */
  engine: () => HapticEngine;
  /** Buzzes `pattern` when it may; says whether it did. */
  fire: (pattern: HapticPattern) => boolean;
  /** The visitor's choice (on unless turned off on this device). */
  enabled: () => boolean;
  setEnabled: (on: boolean) => void;
  /** Whether this device can buzz at all: the switch is shown only then. */
  available: () => boolean;
  /** The device asks for less motion: nothing buzzes, whatever the switch says. */
  stilled: () => boolean;
  subscribe: (listener: () => void) => () => void;
}

/** An iPhone, iPod or iPad (an iPad that reports itself as a Mac still has a touch screen). */
export function isIosLike(ua: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && maxTouchPoints > 1;
}

/** How a device with this navigator buzzes. iOS first: its browsers have no vibrate, but a WebView might lie. */
export function detectEngine(nav: NavLike | null | undefined, hasSwitch: boolean): HapticEngine {
  if (!nav) return "none";
  const touch = (nav.maxTouchPoints ?? 0) > 0;
  if (isIosLike(nav.userAgent ?? "", nav.maxTouchPoints ?? 0)) return hasSwitch ? "ios-switch" : "none";
  // A desktop browser has vibrate() too, with nothing to shake: only a touch device is worth it.
  if (touch && typeof nav.vibrate === "function") return "vibrate";
  return "none";
}

function browserEnv(): Required<HapticsEnv> {
  const w = typeof window === "undefined" ? null : window;
  return {
    nav: typeof navigator === "undefined" ? null : (navigator as NavLike),
    doc: typeof document === "undefined" ? null : document,
    hasSwitch: () => {
      try {
        return w !== null && "switch" in w.HTMLInputElement.prototype;
      } catch {
        return false;
      }
    },
    now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
    reducedMotion: () => {
      try {
        return w !== null && typeof w.matchMedia === "function" && w.matchMedia("(prefers-reduced-motion: reduce)").matches;
      } catch {
        return false;
      }
    },
    visible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
    storage: (() => {
      try {
        return w ? w.localStorage : null;
      } catch {
        return null; // storage blocked: the choice lasts this visit
      }
    })(),
  };
}

export function createHaptics(given: HapticsEnv = {}): Haptics {
  // Read on first use, not at import: the page's own instance is made before anything runs.
  let env: Required<HapticsEnv> | null = null;
  const read = (): Required<HapticsEnv> => {
    if (!env) {
      const handed = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined));
      env = { ...browserEnv(), ...handed } as Required<HapticsEnv>;
    }
    return env;
  };

  let engine: HapticEngine | null = null;
  const engineOf = (): HapticEngine => (engine ??= detectEngine(read().nav, read().hasSwitch()));

  let memory: boolean | null = null; // the choice when storage cannot keep it
  const enabled = (): boolean => {
    if (memory !== null) return memory;
    try {
      return read().storage?.getItem(STORAGE_KEY) !== "off";
    } catch {
      return true;
    }
  };

  const listeners = new Set<() => void>();
  let last = -Infinity;
  let label: HTMLLabelElement | null = null;

  /** The hidden switch, inside the open modal sheet when there is one (the page under a modal is inert). */
  const tick = (doc: Document): boolean => {
    if (!label || label.ownerDocument !== doc) {
      label = doc.createElement("label");
      label.hidden = true;
      label.setAttribute("aria-hidden", "true");
      label.className = "haptic";
      const input = doc.createElement("input");
      input.type = "checkbox";
      input.setAttribute("switch", "");
      input.tabIndex = -1;
      label.append(input);
    }
    const host = doc.querySelector("dialog[open]") ?? doc.body;
    if (!host) return false;
    if (label.parentNode !== host) host.append(label);
    label.click();
    return true;
  };

  return {
    engine: engineOf,
    available: () => engineOf() !== "none",
    stilled: () => read().reducedMotion(),
    enabled,
    setEnabled(on) {
      memory = null;
      try {
        const store = read().storage;
        if (!store) memory = on;
        else if (on) store.removeItem(STORAGE_KEY);
        else store.setItem(STORAGE_KEY, "off");
      } catch {
        memory = on;
      }
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fire(pattern) {
      const e = read();
      const how = engineOf();
      if (how === "none" || !enabled() || e.reducedMotion() || !e.visible()) return false;
      const t = e.now();
      if (t - last < MIN_GAP_MS) return false;
      try {
        if (how === "vibrate") {
          const p = PATTERNS[pattern];
          const ok = e.nav?.vibrate?.(typeof p === "number" ? p : [...p]) ?? false;
          if (!ok) return false;
        } else if (!e.doc || !tick(e.doc)) {
          return false;
        }
      } catch {
        return false;
      }
      last = t;
      return true;
    },
  };
}

/** The page's own haptics. */
export const haptics: Haptics = createHaptics();

/** Buzzes `pattern` on this device when it may (see the top of this file). */
export const haptic = (pattern: HapticPattern): boolean => haptics.fire(pattern);

/** The visitor's choice, re-rendering when it changes. */
export function useHapticsOn(h: Haptics = haptics): boolean {
  return useSyncExternalStore(h.subscribe, h.enabled, h.enabled);
}
