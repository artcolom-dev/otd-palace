// The top progress bar's timing, apart from any drawing: one bar for every page-level wait of the site (a view's code
// on its way, the first market, a page the browser is leaving for). Waits are counted, so two at once are one bar that
// ends with the last. The bar shows only once a wait passes `delayMs`, so a fast answer never flashes it; once shown it
// stays `minShowMs` at least, then runs to the end and fades. What it shows in between is a trickle (it moves on its
// own, slower and slower, and never reaches the end by itself): it says "working", never how far, because nothing it
// covers knows how far it is. Where real progress is known (an account's seasons being read), the page draws its own
// bar beside the words that count it (components/Busy).
import { prefersReducedMotion } from "./motion";

export type ProgressPhase = "idle" | "running" | "done";

export interface ProgressView {
  /** idle: nothing shown; running: the bar trickles; done: the bar is full and fading out. */
  phase: ProgressPhase;
  /** How much of the bar is drawn, 0 to 1. A trickle, not a measure, while running. */
  value: number;
  /** The wait has lasted `longMs` or more: worth a reassuring word. */
  long: boolean;
}

export interface ProgressOptions {
  delayMs?: number;
  minShowMs?: number;
  doneMs?: number;
  longMs?: number;
  trickleMs?: number;
  reducedMotion?: () => boolean;
}

export interface Progress {
  /** Holds one wait; the function it returns lets it go (calling it again does nothing). */
  start: () => () => void;
  /** A page that just arrived after a wait the bar could not see (the code loading before the page could run): the
   * bar shows full and fades, unless a wait is under way. */
  finish: () => void;
  get: () => ProgressView;
  subscribe: (listener: () => void) => () => void;
  reset: () => void;
}

/** Where the trickle starts, and the end it creeps towards without reaching. */
const FIRST = 0.08;
const CEILING = 0.92;
/** The share of what is left that each step of the trickle covers. */
const STEP = 0.07;

const IDLE: ProgressView = { phase: "idle", value: 0, long: false };

export function createProgress({
  delayMs = 180,
  minShowMs = 400,
  doneMs = 500, // the full bar is seen, then fades (styles/loading.css: 150 ms, then 300 ms)
  longMs = 8000,
  trickleMs = 250,
  reducedMotion = prefersReducedMotion,
}: ProgressOptions = {}): Progress {
  let view: ProgressView = IDLE;
  let holds = 0;
  let shownAt = 0;
  let lastRun = FIRST; // where the trickle was when the bar last completed
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let longTimer: ReturnType<typeof setTimeout> | undefined;
  let trickle: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();

  const set = (next: Partial<ProgressView>) => {
    view = { ...view, ...next };
    for (const listener of [...listeners]) listener();
  };
  const stopTimers = () => {
    clearTimeout(showTimer);
    clearTimeout(finishTimer);
    clearTimeout(hideTimer);
    clearTimeout(longTimer);
    clearInterval(trickle);
    showTimer = finishTimer = hideTimer = longTimer = trickle = undefined;
  };

  const show = (from: number) => {
    showTimer = undefined;
    shownAt = Date.now();
    set({ phase: "running", value: from });
    clearInterval(trickle);
    trickle = undefined;
    if (!reducedMotion()) {
      trickle = setInterval(() => set({ value: view.value + (CEILING - view.value) * STEP }), trickleMs);
    }
  };

  const complete = () => {
    finishTimer = undefined;
    clearInterval(trickle);
    clearTimeout(longTimer);
    trickle = longTimer = undefined;
    lastRun = view.phase === "running" ? view.value : 0.5;
    set({ phase: "done", value: 1, long: false });
    hideTimer = setTimeout(() => {
      hideTimer = undefined;
      set(IDLE);
    }, doneMs);
  };

  const release = () => {
    holds -= 1;
    if (holds > 0) return;
    if (showTimer !== undefined) {
      // Over before the bar showed: nothing was drawn, nothing to undo.
      stopTimers();
      if (view !== IDLE) set(IDLE);
      return;
    }
    if (view.phase !== "running") return;
    const left = minShowMs - (Date.now() - shownAt);
    if (left > 0) finishTimer = setTimeout(complete, left);
    else complete();
  };

  const start = () => {
    holds += 1;
    if (holds === 1) {
      clearTimeout(finishTimer);
      finishTimer = undefined;
      if (view.phase === "done") {
        // Still on screen, fading: pick it up again where the trickle left off.
        clearTimeout(hideTimer);
        hideTimer = undefined;
        show(lastRun);
      } else if (view.phase === "idle" && showTimer === undefined) {
        showTimer = setTimeout(() => show(FIRST), delayMs);
      }
      if (longTimer === undefined) {
        longTimer = setTimeout(() => {
          longTimer = undefined;
          if (holds > 0) set({ long: true });
        }, longMs);
      }
    }
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      release();
    };
  };

  return {
    start,
    finish: () => {
      if (holds > 0) return;
      stopTimers();
      complete();
    },
    get: () => view,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset: () => {
      holds = 0;
      stopTimers();
      if (view !== IDLE) set(IDLE);
    },
  };
}

/** The site's one bar. */
export const progress = createProgress();
