import { act, render } from "@testing-library/react";
import { vi } from "vitest";
import { App } from "../App";
import { resetPhotos } from "../components/PlayerAvatar";
import { type LocalState, local } from "../data/local";
import type { Snapshot } from "../data/types";
import { resetInstall } from "../lib/install";
import { resetPassUi } from "../views/passState";
import { NOW, sceneSnapshot } from "./scene";

export type Viewport = "phone" | "desktop";

export interface MediaOptions {
  reducedMotion?: boolean; // the visitor asks for less motion
  standalone?: boolean; // the site runs from the home screen
}

/** A matchMedia that answers like a 390 px phone or a 1440 px desktop, by default without reduced motion, in a tab. */
export function setViewport(viewport: Viewport, { reducedMotion = false, standalone = false }: MediaOptions = {}) {
  const width = viewport === "phone" ? 390 : 1440;
  const matches = (query: string) => {
    if (/prefers-reduced-motion:\s*reduce/.test(query)) return reducedMotion;
    if (/display-mode:\s*standalone/.test(query)) return standalone;
    const min = /min-width:\s*(\d+(?:\.\d+)?)px/.exec(query);
    const max = /max-width:\s*(\d+(?:\.\d+)?)px/.exec(query);
    if (min) return width >= Number(min[1]);
    if (max) return width <= Number(max[1]);
    return false;
  };
  window.matchMedia = ((query: string) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** Records every WAAPI call; jsdom has no Web Animations of its own. */
export const animate = vi.fn(function (this: Element) {
  return { finished: Promise.resolve(), cancel: () => undefined, finish: () => undefined, onfinish: null };
});

const ok = (snap: Snapshot) =>
  new Response(JSON.stringify(snap), { status: 200, headers: { ETag: `"${snap.version}"` } });

export interface AppOptions extends MediaOptions {
  snap?: Snapshot | null;
  viewport?: Viewport;
  path?: string; // "/deals": the view's own address ("/" by default, Today or the remembered tab)
  hash?: string; // "deals": an old link to a tab, or a sheet's address ("how/fees", "account/<name>", "join")
  search?: string; // "?open=104": the address a notification opens
  /** How the server answers a poll with nothing pushed: a 304 by default. */
  respond?: () => Response | Promise<Response>;
  /** The Discord gate's mark the server puts in the page (`<script id="me">`), as its JSON text; none by default. */
  me?: string;
  /** How the server answers the gate's own requests (/api/me, /api/teaser, /auth/logout); nothing by default. */
  gateFetch?: typeof fetch;
}

/**
 * The whole site on a snapshot inlined in the page, at `NOW` on fake timers. `push` serves a new snapshot to the
 * next poll and lets the poll happen; `advance` moves the clock.
 */
export function renderApp({
  snap = sceneSnapshot(),
  viewport = "phone",
  path = "/",
  hash = "",
  search = "",
  respond = () => new Response(null, { status: 304 }),
  me,
  gateFetch,
  ...media
}: AppOptions = {}) {
  vi.setSystemTime(NOW);
  setViewport(viewport, media);
  Element.prototype.animate = animate as unknown as Element["animate"];
  history.replaceState(null, "", `${path}${search}${hash ? `#${hash}` : ""}`);
  document.getElementById("snapshot")?.remove();
  document.getElementById("me")?.remove();
  if (me !== undefined) {
    const el = document.createElement("script");
    el.id = "me";
    el.type = "application/json";
    el.textContent = me;
    document.body.append(el);
  }
  if (snap) {
    const el = document.createElement("script");
    el.id = "snapshot";
    el.type = "application/json";
    el.textContent = JSON.stringify(snap);
    document.body.append(el);
  }
  let next: Snapshot | null = null;
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    const reply = next ? ok(next) : respond();
    next = null;
    return reply;
  });
  const gateOptions = gateFetch ? { fetchImpl: gateFetch } : undefined;
  const view = render(
    <App snapshotOptions={{ fetchImpl, now: () => Date.now(), wallNow: () => Date.now() }} gateOptions={gateOptions} />,
  );
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const push = async (snapshot: Snapshot) => {
    next = snapshot;
    await advance((snap?.rules.poll_s ?? 5) * 1000);
  };
  return { ...view, fetchImpl, advance, push };
}

/** A clean device: no saved choices, no follows, nothing opened, the welcome strip not yet dismissed, no passes,
 * the Passes tab's choices of an earlier visit forgotten, and no photo known to have failed. */
export function freshDevice() {
  localStorage.clear();
  local.reload();
  resetPassUi();
  resetInstall();
  resetPhotos();
  setVisibility("visible", false);
}

/** A device that remembers this much from earlier visits (the rest as on a clean device). */
export function seedDevice(state: Partial<LocalState>) {
  localStorage.setItem("advisor.local.v1", JSON.stringify(state));
  local.reload();
}

/** The page goes to the background (another app, another tab) or comes back; `notify` fires visibilitychange. */
export function setVisibility(state: "visible" | "hidden", notify = true) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  if (notify) act(() => void document.dispatchEvent(new Event("visibilitychange")));
}

/** Puts back jsdom's own `document.visibilityState`, after a test that set it. */
export function restoreVisibility() {
  Reflect.deleteProperty(document, "visibilityState");
}
