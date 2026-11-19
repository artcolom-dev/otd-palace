import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ALERTS, local } from "../data/local";
import { type AlertRules, forgetSubscription } from "../lib/push";
import { SYNC_DEBOUNCE_MS, useAlertRules, useAlertSync } from "./useAlerts";

// The real lib/push.ts against a browser that holds a subscription, with a spy for the server: what is sent when.

const KEY = "AQIDBA";
const RULES: AlertRules = {
  level: "new", budget: 200, follows: [], opened: [],
  categories: { deals: false, last_call: true, moves: false, digest: false, routine: false },
  digest_hour: 9, quiet: [23, 7], utc_offset_min: 60,
};

let fetchSpy: ReturnType<typeof vi.fn>;
let subscribedWith: number[];

function browserWithSubscription() {
  const sub = {
    endpoint: "https://fcm.googleapis.com/fcm/send/device-1",
    get options() {
      return { applicationServerKey: new Uint8Array(subscribedWith).buffer };
    },
    toJSON: () => ({ endpoint: sub.endpoint, keys: { p256dh: "P256", auth: "AUTH" } }),
    unsubscribe: vi.fn(async () => true),
  };
  const registration = { pushManager: { getSubscription: vi.fn(async () => sub), subscribe: vi.fn() } };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register: vi.fn(), ready: Promise.resolve(registration), getRegistration: vi.fn(async () => registration) },
  });
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
  fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchSpy);
}

const puts = () =>
  fetchSpy.mock.calls
    .filter(([, init]) => (init as RequestInit).method === "PUT")
    .map(([, init]) => ({ keepalive: (init as RequestInit).keepalive, rules: JSON.parse(String((init as RequestInit).body)).rules }));

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function hidePage() {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  act(() => void document.dispatchEvent(new Event("visibilitychange")));
}

describe("useAlertSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    local.reload();
    local.setAlerts({ on: true, lastCall: true });
    subscribedWith = [1, 2, 3, 4];
    forgetSubscription();
    browserWithSubscription();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const mount = (rules = RULES) =>
    renderHook(({ r }) => useAlertSync(true, local.get().alerts.on, r, KEY), { initialProps: { r: rules } });

  it("a deal just opened reaches the server at once, with keepalive, for its last call", async () => {
    const { rerender } = mount();
    await flush(SYNC_DEBOUNCE_MS + 10); // the sync on load
    fetchSpy.mockClear();
    rerender({ r: { ...RULES, opened: [102] } });
    await flush(0);
    expect(puts()).toEqual([{ keepalive: true, rules: { ...RULES, opened: [102] } }]);
    await flush(SYNC_DEBOUNCE_MS + 10);
    expect(puts()).toHaveLength(1); // nothing left waiting
  });

  it("other changes wait for the debounce", async () => {
    const { rerender } = mount();
    await flush(SYNC_DEBOUNCE_MS + 10);
    fetchSpy.mockClear();
    rerender({ r: { ...RULES, level: "pro" } });
    await flush(SYNC_DEBOUNCE_MS - 100);
    expect(puts()).toEqual([]);
    await flush(200);
    expect(puts()).toEqual([{ keepalive: false, rules: { ...RULES, level: "pro" } }]);
  });

  it("a change still waiting is sent when the page is hidden", async () => {
    const { rerender } = mount();
    await flush(SYNC_DEBOUNCE_MS + 10);
    fetchSpy.mockClear();
    rerender({ r: { ...RULES, level: "pro" } });
    hidePage();
    await flush(0);
    expect(puts()).toEqual([{ keepalive: true, rules: { ...RULES, level: "pro" } }]);
    await flush(SYNC_DEBOUNCE_MS + 10);
    expect(puts()).toHaveLength(1);
  });

  it("a change still waiting is sent when the page is closed", async () => {
    const { rerender } = mount();
    await flush(SYNC_DEBOUNCE_MS + 10);
    fetchSpy.mockClear();
    rerender({ r: { ...RULES, budget: 1000 } });
    act(() => void window.dispatchEvent(new Event("pagehide")));
    await flush(0);
    expect(puts()).toEqual([{ keepalive: true, rules: { ...RULES, budget: 1000 } }]);
  });

  it("on pagehide the request is made in the same tick, not after the browser hands over the subscription", async () => {
    const { rerender } = mount();
    await flush(SYNC_DEBOUNCE_MS + 10); // the sync on load reads the subscription, and it is kept
    fetchSpy.mockClear();
    rerender({ r: { ...RULES, budget: 1000 } });
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(puts()).toEqual([{ keepalive: true, rules: { ...RULES, budget: 1000 } }]); // no await in between
  });

  it("nothing waiting, nothing sent on hide", async () => {
    mount();
    await flush(SYNC_DEBOUNCE_MS + 10);
    fetchSpy.mockClear();
    hidePage();
    await flush(0);
    expect(puts()).toEqual([]);
  });

  it("a subscription made for an older server key turns alerts off and asks to turn them on again", async () => {
    subscribedWith = [9, 9, 9, 9];
    mount();
    await flush(0);
    expect(local.get().alerts).toEqual({ ...DEFAULT_ALERTS, lastCall: true, on: false, renew: true });
  });
});

describe("useAlertRules offset", () => {
  it("re-reads the UTC offset when the page becomes visible again (DST, travel)", () => {
    const spy = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(300);
    const { result } = renderHook(() => useAlertRules(DEFAULT_ALERTS, "L", null, [], []));
    expect(result.current.utc_offset_min).toBe(-300);
    spy.mockReturnValue(240);
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current.utc_offset_min).toBe(-240);
    spy.mockRestore();
  });
});
