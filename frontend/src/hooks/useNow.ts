import { useSyncExternalStore } from "react";

// One clock for the whole page: every countdown and "listed 3 m ago" reads the same second, from one interval
// that runs only while something reads it and only while the tab is visible.

const TICK_MS = 1000;
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

function tick() {
  now = Date.now();
  for (const listener of listeners) listener();
}

function start() {
  if (timer === undefined && listeners.size > 0 && visible()) timer = setInterval(tick, TICK_MS);
}

function stop() {
  clearInterval(timer);
  timer = undefined;
}

function onVisibilityChange() {
  if (visible()) {
    tick(); // catch up at once on what happened while hidden
    start();
  } else {
    stop();
  }
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    document.addEventListener("visibilitychange", onVisibilityChange);
    now = Date.now();
  }
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}

// With no reader the clock is not running, so a first render reads the time itself, to the second (a value that
// changes between two reads of one render would make React render again).
const getSnapshot = () => (listeners.size === 0 ? Math.floor(Date.now() / TICK_MS) * TICK_MS : now);

/** The current time in ms, updated once a second while the tab is visible. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
