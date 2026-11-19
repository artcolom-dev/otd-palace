import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { noteBuild } from "../lib/freshBuild";
import { noteDiscordRequired } from "../lib/gate";
import { type Thrift, deviceThrift } from "../lib/thrift";
import type { Snapshot } from "./types";

export type SnapshotStatus = "loading" | "live" | "stale";

/** Why the last poll brought nothing: no usable answer from the server, or an answer the page cannot read. */
export type SnapshotError = "unreachable" | "unreadable";

export interface SnapshotState {
  snap: Snapshot | null;
  status: SnapshotStatus;
  /** Whole seconds the data has been standing still: the older of its two ages (see `useSnapshot`); null while there is none. */
  updatedAgoS: number | null;
  /** Why the last poll failed; null once one answers (a 304 included). */
  lastError: SnapshotError | null;
  /** Polls that failed in a row. */
  failures: number;
  /** The phone knows it has no network: nothing is asked until it is back, and the data reads as stale meanwhile. */
  offline: boolean;
}

export interface SnapshotHandle extends SnapshotState {
  /** Polls now instead of waiting for the next turn. */
  retry: () => void;
  /** Polls now (a pull to refresh); resolves once that poll is over: true when the server answered. */
  refresh: () => Promise<boolean>;
}

export interface UseSnapshotOptions {
  fetchImpl?: typeof fetch;
  /** A monotonic clock in milliseconds; `performance.now` by default. */
  now?: () => number;
  /** The wall clock in milliseconds since the epoch; `Date.now` by default. */
  wallNow?: () => number;
  /** What the phone says about saving data or battery, and being offline; the browser's own by default. */
  thrift?: Thrift;
}

const SNAPSHOT_URL = "/api/snapshot";
const FALLBACK_POLL_S = 5; // until a snapshot says how often to poll
const TICK_MS = 1000; // how often the age shown on screen is recomputed
const FETCH_TIMEOUT_POLLS = 2; // a request gets this many poll intervals before it counts as failed
// The wall-clock age of a snapshot may exceed stale_after_s by this much before it counts as stale: the visitor's
// clock is not the server's, and being a little off must not make fresh data look stale.
const CLOCK_SKEW_ALLOWANCE_S = 30;
// This many failed polls in a row (about 10 s) and the data is stale whatever its age: the server is not answering.
const STALE_AFTER_FAILURES = 2;
// Coming back to the page within this long of the last answer waits for the usual turn instead of polling at once.
const WAKE_FRESH_MS = 2000;
// While the phone saves data or battery, it polls this many times less often (every 20 s for the usual 5), but never
// past half of stale_after_s: slower data, never data shown as paused because of it.
const SAVING_POLL_FACTOR = 4;

const LOADING: SnapshotState = {
  snap: null,
  status: "loading",
  updatedAgoS: null,
  lastError: null,
  failures: 0,
  offline: false,
};

const defaultFetch: typeof fetch = (input, init) => fetch(input, init);
const defaultNow = () => performance.now();
const defaultWallNow = () => Date.now();
const pageHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * A shallow check that the pieces the site reads are there; the server is trusted for what is inside them. Returns
 * the name of the first field that is missing or of the wrong kind ("levels.pro.bid_max_left_min"), or null when
 * the snapshot can be used. Each level must carry its bid window: without it the bid filter would compare against
 * NaN and hide every bid. It must also say, true or false, whether it hides falling deals.
 */
export function snapshotProblem(value: unknown): string | null {
  if (!isRecord(value)) return "the snapshot itself";
  const { version, generated_at, sports, deals, moves, otd, levels, rules, pulse, gone, taken_10m, links } = value;
  if (!isNumber(version)) return "version";
  if (typeof generated_at !== "string") return "generated_at";
  if (!Array.isArray(sports)) return "sports";
  if (!Array.isArray(deals)) return "deals";
  if (!isRecord(moves)) return "moves";
  if (!Array.isArray(moves.risers)) return "moves.risers";
  if (!Array.isArray(moves.fallers)) return "moves.fallers";
  if (!isRecord(otd)) return "otd";
  if (!Array.isArray(otd.markets)) return "otd.markets";
  if (otd.current_markets !== undefined && !Array.isArray(otd.current_markets)) return "otd.current_markets";
  if (!isRecord(otd.picks)) return "otd.picks";
  if (!isRecord(levels)) return "levels";
  for (const [name, level] of Object.entries(levels)) {
    if (!isRecord(level)) return `levels.${name}`;
    if (!isNumber(level.bid_max_left_min)) return `levels.${name}.bid_max_left_min`;
    if (typeof level.hide_falling !== "boolean") return `levels.${name}.hide_falling`;
  }
  if (!isRecord(rules)) return "rules";
  if (!isNumber(rules.stale_after_s)) return "rules.stale_after_s";
  if (!isNumber(rules.poll_s)) return "rules.poll_s";
  if (!isRecord(rules.otd)) return "rules.otd";
  if (!isRecord(pulse)) return "pulse";
  if (!isNumber(pulse.window_min)) return "pulse.window_min";
  if (!Array.isArray(pulse.sales)) return "pulse.sales";
  if (!Array.isArray(gone)) return "gone";
  if (!isNumber(taken_10m)) return "taken_10m";
  if (!isRecord(links)) return "links";
  if (!(links.community === null || typeof links.community === "string")) return "links.community";
  return null;
}

const isSnapshot = (value: unknown): value is Snapshot => snapshotProblem(value) === null;

/** The snapshot the server put in the page, if there is one and it can be read. */
function readInlined(): Snapshot | null {
  try {
    const text = document.getElementById("snapshot")?.textContent;
    const parsed: unknown = text ? JSON.parse(text) : null;
    return isSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * An answer to `?otd=` leaves the passes out while they stand: they are the ones held, under the same `otd_version`.
 * An answer without them that names other passes is left as it came, and fails the check.
 */
function withHeldPasses(body: unknown, held: Snapshot | null, heldOtd: string | null): unknown {
  if (!isRecord(body) || "otd" in body || !held || !heldOtd) return body;
  return body.otd_version === heldOtd ? { ...body, otd: held.otd } : body;
}

/**
 * The new answer with the previous one's pass rules when they did not change: the plans worked out from them (a big
 * account's take tens of milliseconds) are then kept from one poll to the next instead of being redone at each.
 */
export function keepPassRules(next: Snapshot, prev: Snapshot | null): Snapshot {
  if (!prev || prev.rules.otd === next.rules.otd) return next;
  return JSON.stringify(prev.rules.otd) === JSON.stringify(next.rules.otd) ? { ...next, rules: { ...next.rules, otd: prev.rules.otd } } : next;
}

const urlFor = (heldOtd: string | null) =>
  heldOtd ? `${SNAPSHOT_URL}?otd=${encodeURIComponent(heldOtd)}` : SNAPSHOT_URL;

/**
 * A signal that aborts after `ms`: AbortSignal.timeout where the browser has it, else a controller and a timer, so
 * an older browser still gives up on a request that hangs. `clear` drops the timer once the request is over.
 */
function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  if (typeof AbortSignal.timeout === "function") {
    try {
      return { signal: AbortSignal.timeout(ms), clear: () => undefined };
    } catch {
      // fall through to the timer
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("The request took too long", "TimeoutError")), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

// The server's ETag for a snapshot is its version in quotes.
const etagOf = (snap: Snapshot) => `"${snap.version}"`;

/**
 * Where the data stands: stale after STALE_AFTER_FAILURES failed polls in a row, when it has not changed for longer
 * than `stale_after_s` on the monotonic clock, when it was generated longer ago than that (plus the skew allowance)
 * on the wall clock, or when its `generated_at` cannot be read. The wall-clock age is what catches a page that slept
 * or was restored from cache.
 */
function stateAt(
  snap: Snapshot | null,
  changedAt: number,
  nowMs: number,
  wallMs: number,
  failures: number,
  lastError: SnapshotError | null,
  offline = false,
): SnapshotState {
  if (!snap) return failures === 0 && !offline ? LOADING : { ...LOADING, failures, lastError, offline };
  const limitMs = snap.rules.stale_after_s * 1000;
  const sinceChangeMs = Math.max(0, nowMs - changedAt);
  const generatedMs = Date.parse(snap.generated_at);
  const sinceGeneratedMs = Number.isNaN(generatedMs) ? null : Math.max(0, wallMs - generatedMs);
  const stale =
    failures >= STALE_AFTER_FAILURES ||
    sinceChangeMs > limitMs ||
    sinceGeneratedMs === null ||
    sinceGeneratedMs > limitMs + CLOCK_SKEW_ALLOWANCE_S * 1000;
  return {
    snap,
    status: stale ? "stale" : "live",
    updatedAgoS: Math.floor(Math.max(sinceChangeMs, sinceGeneratedMs ?? 0) / 1000),
    lastError,
    failures,
    offline,
  };
}

const sameState = (a: SnapshotState, b: SnapshotState) =>
  a.snap === b.snap &&
  a.status === b.status &&
  a.updatedAgoS === b.updatedAgoS &&
  a.lastError === b.lastError &&
  a.failures === b.failures &&
  a.offline === b.offline;

/**
 * The market snapshot: the one inlined in the page, kept current by polling `/api/snapshot`.
 *
 * Data is "live" only while both of its ages are within bounds: the monotonic age since a new version last
 * arrived (at most `rules.stale_after_s`) and the wall-clock age since the server generated it (at most that
 * plus a skew allowance; this device's clock is corrected by the last answer's Date header), and while the server answers: two failed polls in a row (no answer, a hung request, a
 * 5xx or any other error status, or an answer that cannot be read) make it "stale" whatever its age. A 304 is an
 * answer. Each poll names the passes it holds (`?otd=<otd_version>`) so the server can leave them out while they
 * stand; after refusing an answer that left out other passes than the held ones, the next poll names none and gets
 * them all. Polling and the age ticker stop while the page is hidden; the age is re-checked and a poll goes out as
 * soon as the page becomes visible, is restored from the back/forward cache or the network comes back, unless the
 * last answer is under 2 s old (a quick flip of tabs). `retry` polls now, dropping a request still on its way. The
 * options are read once, when the hook first runs.
 *
 * On a phone: while it saves data or battery (`Thrift.saving`) it polls 4 times less often, never past half of
 * `stale_after_s`; while it knows it is offline it asks nothing, the data reads as stale at once (`offline` says why),
 * and the first poll goes out the moment the network is back.
 */
export function useSnapshot(options: UseSnapshotOptions = {}): SnapshotHandle {
  const [{ fetchImpl, now, wallNow, thrift, initial }] = useState(() => {
    const now = options.now ?? defaultNow;
    const wallNow = options.wallNow ?? defaultWallNow;
    const thrift = options.thrift ?? deviceThrift();
    const offline = thrift.offline();
    return {
      fetchImpl: options.fetchImpl ?? defaultFetch,
      now,
      wallNow,
      thrift,
      initial: { snap: readInlined(), at: now(), wallAt: wallNow(), offline },
    };
  });
  const [state, setState] = useState<SnapshotState>(() =>
    initial.offline
      ? stateAt(initial.snap, initial.at, initial.at, initial.wallAt, STALE_AFTER_FAILURES, "unreachable", true)
      : stateAt(initial.snap, initial.at, initial.at, initial.wallAt, 0, null),
  );
  const pollNow = useRef<() => void>(() => undefined);
  const refreshNow = useRef<() => Promise<boolean>>(() => Promise.resolve(false));

  useEffect(() => {
    let snap = initial.snap;
    let heldOtd: string | null = snap?.otd_version ?? null; // the passes this poll names; none after a mix-up
    let changedAt = initial.at;
    let etag = snap ? etagOf(snap) : null;
    let failures = initial.offline ? STALE_AFTER_FAILURES : 0;
    let lastError: SnapshotError | null = initial.offline ? "unreachable" : null;
    let lastPollAt = initial.at; // when the last poll ended (or the page opened): the next one is due a delay after it
    let answeredAt: { mono: number; wall: number } | null = null; // the last poll that brought an answer
    // The server's clock minus this device's, from the last answer's Date header; 0 until one says. A device whose
    // clock is set minutes wrong must not read every fresh snapshot as old (or an old one as fresh).
    let skewMs = 0;
    let stopped = false;
    let polling = false;
    let again = false; // Retry came during a request: that one is dropped and another goes out at once
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let ticker: ReturnType<typeof setInterval> | undefined;
    let inFlight: AbortController | undefined;
    let clearTimeoutSignal: () => void = () => undefined;
    const warned = new Set<string>(); // one warning per kind of unreadable answer, not one per poll
    const waiters: ((answered: boolean) => void)[] = []; // refreshes waiting for the poll under way to end
    const settle = (answered: boolean) => {
      for (const resolve of waiters.splice(0)) resolve(answered);
    };

    const warnOnce = (message: string) => {
      if (warned.has(message)) return;
      warned.add(message);
      console.warn(message);
    };

    const refresh = () => {
      const next = stateAt(snap, changedAt, now(), wallNow() + skewMs, failures, lastError, thrift.offline());
      setState((previous) => (sameState(previous, next) ? previous : next));
    };

    const pollDelayMs = () => {
      const usual = Math.max(1, snap?.rules.poll_s ?? FALLBACK_POLL_S) * 1000;
      if (!thrift.saving()) return usual;
      const halfStale = ((snap?.rules.stale_after_s ?? 0) * 1000) / 2;
      return Math.max(usual, Math.min(usual * SAVING_POLL_FACTOR, halfStale));
    };

    // Nothing runs on its own while the page is hidden: coming back polls at once.
    const schedule = (delayMs: number) => {
      clearTimeout(pollTimer);
      pollTimer = pageHidden() ? undefined : setTimeout(poll, delayMs);
    };
    const startTicker = () => {
      if (ticker === undefined && !pageHidden()) ticker = setInterval(refresh, TICK_MS);
    };
    const stopTicker = () => {
      clearInterval(ticker);
      ticker = undefined;
    };

    /** One request: null when it brought an answer (new or not), else why it failed. */
    const ask = async (signal: AbortSignal): Promise<SnapshotError | null> => {
      let text: string;
      let tag: string | null;
      try {
        const headers: Record<string, string> = etag ? { "If-None-Match": etag } : {};
        const response = await fetchImpl(urlFor(heldOtd), { headers, signal });
        if (response.status === 200 || response.status === 304) {
          noteBuild(response.headers?.get?.("X-Build") ?? null);
          const serverMs = Date.parse(response.headers?.get?.("Date") ?? "");
          if (Number.isFinite(serverMs)) skewMs = serverMs - wallNow();
        }
        if (response.status === 304) return null;
        // The Discord gate wants a member (one who left our server, or whose session ran out): the page shows the gate.
        if (response.status === 401) noteDiscordRequired();
        if (response.status !== 200) return "unreachable";
        tag = response.headers.get("ETag");
        text = await response.text();
      } catch {
        return "unreachable"; // no answer, a refused connection, or a request that took too long
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        warnOnce("OTD Palace: ignored a snapshot that is not JSON");
        return "unreadable";
      }
      const merged = withHeldPasses(body, snap, heldOtd);
      const problem = snapshotProblem(merged);
      if (problem !== null) {
        // Most likely the page and the server are of different versions: say which field, so it can be found.
        warnOnce(`OTD Palace: ignored a snapshot with a missing or unreadable "${problem}"`);
        // An answer that left out other passes than the held ones: the next poll asks for all of them.
        if (isRecord(body) && !("otd" in body)) heldOtd = null;
        return "unreadable";
      }
      const next = keepPassRules(merged as Snapshot, snap);
      if (next.version !== snap?.version) {
        snap = next;
        changedAt = now();
        etag = tag ?? etagOf(next);
      }
      heldOtd = snap?.otd_version ?? null;
      return null;
    };

    const poll = async () => {
      if (stopped) return;
      if (polling) {
        if (again) inFlight?.abort(new DOMException("Asked again", "AbortError"));
        return;
      }
      clearTimeout(pollTimer);
      if (thrift.offline()) {
        // No network, and the phone knows it: nothing to ask. Look again later, and at once on "online".
        again = false;
        failures = Math.max(failures, STALE_AFTER_FAILURES);
        lastError = "unreachable";
        lastPollAt = now();
        refresh();
        schedule(pollDelayMs());
        settle(false);
        return;
      }
      polling = true;
      let error: SnapshotError | null = "unreachable";
      try {
        const controller = new AbortController();
        inFlight = controller;
        const timeout = timeoutSignal(FETCH_TIMEOUT_POLLS * pollDelayMs());
        clearTimeoutSignal = timeout.clear;
        const onTimeout = () => controller.abort(timeout.signal.reason);
        timeout.signal.addEventListener("abort", onTimeout, { once: true });
        try {
          error = await ask(controller.signal);
        } finally {
          timeout.signal.removeEventListener("abort", onTimeout);
          timeout.clear();
        }
      } finally {
        polling = false;
      }
      if (stopped) return;
      if (again) {
        // Dropped for a Retry: not a failure, and the new request goes out now.
        again = false;
        void poll();
        return;
      }
      failures = error === null ? 0 : failures + 1;
      lastError = error;
      lastPollAt = now();
      if (error === null) answeredAt = { mono: now(), wall: wallNow() };
      refresh();
      schedule(pollDelayMs());
      settle(error === null);
    };
    pollNow.current = () => {
      if (polling) again = true;
      void poll();
    };
    refreshNow.current = () =>
      new Promise<boolean>((resolve) => {
        if (stopped) return resolve(false);
        waiters.push(resolve);
        pollNow.current();
      });

    // Back on the page: show the true age without waiting for the next tick, and fetch without waiting for the next
    // poll, unless the last answer is under 2 s old (a quick flip of tabs): then the usual turn comes.
    const wake = () => {
      if (stopped) return;
      startTicker();
      refresh();
      const fresh =
        answeredAt !== null &&
        now() - answeredAt.mono < WAKE_FRESH_MS &&
        Math.abs(wallNow() - answeredAt.wall) < WAKE_FRESH_MS;
      if (fresh && answeredAt !== null && !polling) schedule(Math.max(0, answeredAt.mono + pollDelayMs() - now()));
      else void poll();
    };
    // Gone offline: say so now, without the two failed polls it would take otherwise; "online" polls again (wake).
    const onOffline = () => {
      if (stopped || !thrift.offline()) return;
      failures = Math.max(failures, STALE_AFTER_FAILURES);
      lastError = "unreachable";
      refresh();
    };
    // Saving started or stopped: the next poll comes the new delay after the last one (at once if that is past).
    const onThriftChange = () => {
      if (stopped || polling || pageHidden()) return;
      schedule(Math.max(0, lastPollAt + pollDelayMs() - now()));
    };
    const onVisibilityChange = () => {
      if (pageHidden()) {
        clearTimeout(pollTimer);
        stopTicker();
      } else {
        wake();
      }
    };

    // With nothing to show yet, ask at once instead of waiting a whole poll interval.
    schedule(snap ? pollDelayMs() : 0);
    startTicker();
    const stopWatching = thrift.watch(onThriftChange);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", wake);
    window.addEventListener("online", wake);
    window.addEventListener("offline", onOffline);

    return () => {
      stopped = true;
      pollNow.current = () => undefined;
      refreshNow.current = () => Promise.resolve(false);
      settle(false);
      clearTimeout(pollTimer);
      clearTimeoutSignal();
      stopTicker();
      stopWatching();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", onOffline);
      inFlight?.abort();
    };
  }, [fetchImpl, now, wallNow, thrift, initial]);

  const retry = useCallback(() => pollNow.current(), []);
  const refresh = useCallback(() => refreshNow.current(), []);
  return useMemo(() => ({ ...state, retry, refresh }), [state, retry, refresh]);
}
