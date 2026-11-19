import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AlertRules,
  forgetSubscription,
  keyBytes,
  permission,
  sendTest,
  subscribe,
  subscriptionState,
  supported,
  syncRules,
  unsubscribe,
} from "./push";

const KEY = "AQIDBA"; // the server's public key, base64url: bytes 1 2 3 4
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/device-1";
const RULES: AlertRules = {
  level: "new", budget: 200, follows: ["nba:22"], opened: [102],
  categories: { deals: true, last_call: false, moves: false, digest: false, routine: false },
  digest_hour: 9, quiet: [23, 7], utc_offset_min: 60,
};

class FakeSubscription {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  unsubscribe = vi.fn(async () => true);
  constructor(endpoint: string, key: Uint8Array) {
    this.endpoint = endpoint;
    this.options = { applicationServerKey: key.slice().buffer };
  }
  toJSON() {
    return { endpoint: this.endpoint, expirationTime: null, keys: { p256dh: "P256", auth: "AUTH" } };
  }
}

interface Env {
  notification: { permission: NotificationPermission; requestPermission: ReturnType<typeof vi.fn> };
  register: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  current: FakeSubscription | null;
}

/** A browser that has push, with the visitor's answer to the permission prompt and the server's answers. */
function browser({ answer = "granted" as NotificationPermission, statuses = [204] as number[] } = {}): Env {
  const env = {} as Env;
  env.current = null;
  env.notification = { permission: "default", requestPermission: vi.fn(async () => answer) };
  env.subscribe = vi.fn(async (options: { applicationServerKey: Uint8Array }) => {
    env.current = new FakeSubscription(ENDPOINT, options.applicationServerKey);
    return env.current;
  });
  const registration = { pushManager: { getSubscription: vi.fn(async () => env.current), subscribe: env.subscribe } };
  env.register = vi.fn(async () => registration);
  const queue = [...statuses];
  env.fetch = vi.fn(async () => new Response(null, { status: queue.length > 1 ? queue.shift()! : queue[0]! }));
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register: env.register, ready: Promise.resolve(registration), getRegistration: vi.fn(async () => registration) },
  });
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", env.notification);
  vi.stubGlobal("fetch", env.fetch);
  return env;
}

const sent = (env: Env, i = 0) => {
  const [url, init] = env.fetch.mock.calls[i] as [string, RequestInit];
  return { url, method: init.method, body: JSON.parse(String(init.body)), init };
};

describe("push: alerts on this device", () => {
  beforeEach(() => {
    forgetSubscription();
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: undefined });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads a base64url key into bytes", () => {
    expect([...keyBytes(KEY)]).toEqual([1, 2, 3, 4]);
    expect([...keyBytes("_-8")]).toEqual([255, 239]);
  });

  it("unsupported: says so, never asks, never throws", async () => {
    expect(supported()).toBe(false);
    expect(permission()).toBe("unsupported");
    expect(await subscribe(RULES, KEY)).toBe("unsupported");
    expect(await syncRules(RULES)).toBe("off");
    expect(await sendTest(RULES)).toBe("off");
    expect(await unsubscribe()).toBe("none");
    expect(await subscriptionState(KEY)).toBe("none");
  });

  it("denied: says so, and registers nothing", async () => {
    const env = browser({ answer: "denied" });
    env.notification.permission = "denied";
    expect(permission()).toBe("denied");
    expect(await subscribe(RULES, KEY)).toBe("denied");
    expect(env.register).not.toHaveBeenCalled();
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it("a prompt put away without an answer changes nothing", async () => {
    const env = browser({ answer: "default" });
    expect(await subscribe(RULES, KEY)).toBe("dismissed");
    expect(env.register).not.toHaveBeenCalled();
  });

  it("asks nothing until subscribe() is called", () => {
    const env = browser();
    expect(supported()).toBe(true);
    expect(permission()).toBe("default");
    expect(env.notification.requestPermission).not.toHaveBeenCalled();
  });

  it("granted: registers the worker at the root, subscribes with the server's key and hands the server the rules", async () => {
    const env = browser();
    expect(await subscribe(RULES, KEY)).toBe("on");
    expect(env.notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(env.register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    const options = env.subscribe.mock.calls[0]![0] as { userVisibleOnly: boolean; applicationServerKey: Uint8Array };
    expect(options.userVisibleOnly).toBe(true);
    expect([...options.applicationServerKey]).toEqual([1, 2, 3, 4]);
    const put = sent(env);
    expect([put.url, put.method]).toEqual(["/api/push/subscription", "PUT"]);
    expect(put.body).toEqual({ subscription: { endpoint: ENDPOINT, keys: { p256dh: "P256", auth: "AUTH" } }, rules: RULES });
    expect(put.init.credentials).toBe("same-origin"); // the Discord gate reads its session cookie
    expect(new Headers(put.init.headers).get("Content-Type")).toBe("application/json");
    expect(await subscriptionState(KEY)).toBe("current");
    expect(await subscriptionState("CQkJCQ")).toBe("stale"); // the server's key changed since
  });

  it("a subscription made for an older key is replaced", async () => {
    const env = browser();
    const old = new FakeSubscription("https://fcm.googleapis.com/fcm/send/old", new Uint8Array([9, 9]));
    env.current = old;
    expect(await subscribe(RULES, KEY)).toBe("on");
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(sent(env).body.subscription.endpoint).toBe(ENDPOINT);
  });

  it("an endpoint the server says is gone is swapped for a fresh one once", async () => {
    const env = browser({ statuses: [410, 204] });
    expect(await subscribe(RULES, KEY)).toBe("on");
    expect(env.subscribe).toHaveBeenCalledTimes(2);
    expect(env.fetch).toHaveBeenCalledTimes(2);
  });

  it("syncs the rules of a subscribed device; a 410 means it was unsubscribed", async () => {
    const env = browser({ statuses: [204, 204, 410] });
    expect(await syncRules(RULES)).toBe("off"); // nothing subscribed yet: nothing sent
    expect(env.fetch).not.toHaveBeenCalled();
    await subscribe(RULES, KEY);
    expect(await syncRules({ ...RULES, level: "pro" })).toBe("ok");
    expect(sent(env, 1).body.rules.level).toBe("pro");
    const sub = env.current!;
    expect(await syncRules(RULES)).toBe("off");
    expect(sub.unsubscribe).toHaveBeenCalled();
  });

  it("turning off deletes the subscription on the server, then here, and says whether the server took it", async () => {
    const env = browser();
    await subscribe(RULES, KEY);
    const sub = env.current!;
    expect(await unsubscribe()).toBe("deleted");
    const del = sent(env, 1);
    expect([del.url, del.method, del.body]).toEqual(["/api/push/subscription", "DELETE", { endpoint: ENDPOINT }]);
    expect(sub.unsubscribe).toHaveBeenCalled();
  });

  it("a server it cannot reach still turns alerts off here, and says only here", async () => {
    const env = browser({ statuses: [204, 500] });
    await subscribe(RULES, KEY);
    const sub = env.current!;
    expect(await unsubscribe()).toBe("device");
    expect(sub.unsubscribe).toHaveBeenCalled();
    env.current = new FakeSubscription(ENDPOINT, keyBytes(KEY));
    env.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await unsubscribe()).toBe("device");
  });

  it("syncs with keepalive when asked, so it outlives a page being left", async () => {
    const env = browser();
    await subscribe(RULES, KEY);
    expect(await syncRules(RULES, { keepalive: true })).toBe("ok");
    expect((env.fetch.mock.calls[1]![1] as RequestInit).keepalive).toBe(true);
    expect(await syncRules(RULES)).toBe("ok");
    expect((env.fetch.mock.calls[2]![1] as RequestInit).keepalive).toBe(false);
  });

  it("a keepalive sync starts its request in the same tick, from the subscription kept after subscribe", async () => {
    const env = browser();
    await subscribe(RULES, KEY);
    env.fetch.mockClear();
    const pending = syncRules({ ...RULES, level: "pro" }, { keepalive: true });
    expect(env.fetch).toHaveBeenCalledTimes(1); // nothing awaited first: a page being left cannot wait
    const { body, init } = sent(env);
    expect([init.method, init.keepalive, body.rules.level, body.subscription]).toEqual([
      "PUT", true, "pro", { endpoint: ENDPOINT, keys: { p256dh: "P256", auth: "AUTH" } },
    ]);
    expect(await pending).toBe("ok");
  });

  it("the subscription is kept after a read of the browser's too, and forgotten when there is none", async () => {
    const env = browser();
    env.current = new FakeSubscription(ENDPOINT, keyBytes(KEY));
    expect(await subscriptionState(KEY)).toBe("current");
    const pending = syncRules(RULES, { keepalive: true });
    expect(env.fetch).toHaveBeenCalledTimes(1);
    await pending;
    env.current = null;
    expect(await subscriptionState(KEY)).toBe("none");
    expect(await syncRules(RULES, { keepalive: true })).toBe("off"); // nothing kept, nothing sent
    expect(env.fetch).toHaveBeenCalledTimes(1);
  });

  it("an older key's subscription, a deleted one and a gone one are not kept for a keepalive sync", async () => {
    const env = browser();
    env.current = new FakeSubscription(ENDPOINT, new Uint8Array([9, 9, 9, 9]));
    expect(await subscriptionState(KEY)).toBe("stale");
    env.current = null;
    expect(await syncRules(RULES, { keepalive: true })).toBe("off");
    await subscribe(RULES, KEY);
    expect(await unsubscribe()).toBe("deleted");
    env.current = null; // the browser let go of it
    env.fetch.mockClear();
    expect(await syncRules(RULES, { keepalive: true })).toBe("off");
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it("a keepalive sync the server answers 410 for lets go of the subscription", async () => {
    const env = browser({ statuses: [204, 410] });
    await subscribe(RULES, KEY);
    const sub = env.current!;
    expect(await syncRules(RULES, { keepalive: true })).toBe("off");
    expect(sub.unsubscribe).toHaveBeenCalled();
    env.current = null;
    expect(await syncRules(RULES, { keepalive: true })).toBe("off");
  });

  it("a server that answers 404 or 429 leaves the subscription alone", async () => {
    const env = browser({ statuses: [204, 404, 429] });
    await subscribe(RULES, KEY);
    expect(await syncRules(RULES)).toBe("error");
    expect(await syncRules(RULES)).toBe("error");
    expect(env.current!.unsubscribe).not.toHaveBeenCalled();
  });

  it("a test the server still does not know after the rules is an error, not an unsubscribe", async () => {
    const env = browser({ statuses: [204, 404, 204, 404] });
    await subscribe(RULES, KEY);
    expect(await sendTest(RULES)).toBe("error");
    expect(env.current!.unsubscribe).not.toHaveBeenCalled();
  });

  it("sends a test, three an hour", async () => {
    const env = browser({ statuses: [204, 204, 429] });
    await subscribe(RULES, KEY);
    expect(await sendTest(RULES)).toBe("sent");
    expect([sent(env, 1).url, sent(env, 1).method, sent(env, 1).body]).toEqual(["/api/push/test", "POST", { endpoint: ENDPOINT }]);
    expect(await sendTest(RULES)).toBe("limited");
  });

  it("a test the server does not know re-sends the rules first, then tries again", async () => {
    const env = browser({ statuses: [204, 404, 204, 204] });
    await subscribe(RULES, KEY);
    expect(await sendTest(RULES)).toBe("sent");
    expect(env.fetch.mock.calls.map(([url, init]) => `${(init as RequestInit).method} ${url}`)).toEqual([
      "PUT /api/push/subscription", "POST /api/push/test", "PUT /api/push/subscription", "POST /api/push/test",
    ]);
  });

  it("never throws: a worker that will not register, or a network down, is an error", async () => {
    const env = browser();
    env.register.mockRejectedValueOnce(new Error("SecurityError"));
    expect(await subscribe(RULES, KEY)).toBe("error");
    env.fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await subscribe(RULES, KEY)).toBe("error");
    expect(await syncRules(RULES)).toBe("error");
    expect(await sendTest(RULES)).toBe("error");
  });
});
