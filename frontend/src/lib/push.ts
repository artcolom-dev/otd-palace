// Alerts on this device by web push: the browser's permission, the service worker, the push subscription, and the
// rules the server matches deals against. Nothing here ever throws: every call answers how it went.
//
// The permission prompt only ever comes from subscribe(), which the page calls on a tap on "Turn on alerts", never on
// load. The worker is registered there too, and only in a production build (and in the tests).

import { track } from "./activity";
import { noteDiscordRequired } from "./gate";

export type Permission = "unsupported" | "default" | "denied" | "granted";
export type SubscribeResult = "on" | "denied" | "dismissed" | "unsupported" | "error";
export type SyncResult = "ok" | "off" | "error";
export type TestResult = "sent" | "limited" | "off" | "error";
/** "deleted": on our server and here; "device": here only (our server could not be reached or refused); "none": there
 * was no subscription here to delete; "error": the browser would not let go of it. */
export type UnsubscribeResult = "deleted" | "device" | "none" | "error";
/** "current": subscribed with the server's key; "stale": subscribed with an older key (the server's changed since);
 * "none": not subscribed. */
export type SubscriptionState = "current" | "stale" | "none";

/** What the server matches for this device; it carries nothing about who uses it. */
export interface AlertRules {
  level: string;
  budget: number | null;
  follows: string[]; // "sport:player_id", the newest MAX_FOLLOWS
  opened: number[]; // listing ids opened in Real from here, newest first, for "last call"
  categories: { deals: boolean; last_call: boolean; moves: boolean; digest: boolean; routine: boolean };
  digest_hour: number; // 0-23 on this device's clock
  quiet: [number, number] | null; // no alert from the first hour to the second, on this device's clock
  utc_offset_min: number; // this device's clock ahead of UTC, in minutes
}

/** The most the server takes: the rules are cut to these before they are sent. */
export const MAX_FOLLOWS = 100;
export const MAX_OPENED = 30;

const SW_URL = "/sw.js";
const SUBSCRIPTION_URL = "/api/push/subscription";
const TEST_URL = "/api/push/test";
const READY_MS = 10_000;
const ENABLED = import.meta.env.PROD || import.meta.env.MODE === "test";

interface PushGlobals {
  Notification?: { permission: NotificationPermission; requestPermission: () => Promise<NotificationPermission> };
  PushManager?: unknown;
}
const env = () => globalThis as unknown as PushGlobals;

/** Whether this browser can get alerts from a page: a service worker, the Push API and notifications. On iOS that is
 * only OTD Palace installed on the home screen. */
export function supported(): boolean {
  try {
    return (
      ENABLED &&
      typeof navigator !== "undefined" &&
      Boolean(navigator.serviceWorker) &&
      env().PushManager !== undefined &&
      env().Notification !== undefined
    );
  } catch {
    return false;
  }
}

/** The visitor's answer so far for this site, read without asking anything. */
export function permission(): Permission {
  if (!supported()) return "unsupported";
  try {
    return env().Notification?.permission ?? "unsupported";
  } catch {
    return "unsupported";
  }
}

/** A base64url key (the server's public key) as bytes. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function sameKey(current: ArrayBuffer | null | undefined, wanted: Uint8Array): boolean {
  if (!current) return false;
  const have = new Uint8Array(current);
  return have.length === wanted.length && have.every((byte, i) => byte === wanted[i]);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Sends JSON to the server, with this site's cookies only (the Discord gate's session, when it is on); answers the
 * HTTP status. With `keepalive` the request outlives the page (it is being hidden or closed). A 401 is the gate
 * wanting a member: the page is told, and shows the gate. */
async function send(url: string, method: string, body: unknown, keepalive = false): Promise<number> {
  const response = await fetch(url, {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    keepalive,
  });
  if (response.status === 401) noteDiscordRequired();
  return response.status;
}

/** Only what the server needs of a subscription: its endpoint and its two keys. */
function wire(sub: PushSubscription) {
  const { endpoint, keys } = sub.toJSON() as { endpoint: string; keys: Record<string, string> };
  return { endpoint, keys: { p256dh: keys?.p256dh, auth: keys?.auth } };
}
type Wire = ReturnType<typeof wire>;

// This device's subscription as the server wants it, kept from the last time it was read or made. A page being left
// (pagehide) cannot wait for the browser to hand the subscription over, which is asynchronous: with this the last
// sync starts its keepalive fetch in the same tick.
let known: Wire | null = null;

/** Forget the kept subscription (for tests). */
export function forgetSubscription() {
  known = null;
}

const putWire = (subscription: Wire, rules: AlertRules, keepalive = false) =>
  send(SUBSCRIPTION_URL, "PUT", { subscription, rules }, keepalive);
const putRules = (sub: PushSubscription, rules: AlertRules, keepalive = false) => putWire(wire(sub), rules, keepalive);

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!supported()) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  const sub = registration ? await registration.pushManager.getSubscription() : null;
  known = sub ? wire(sub) : null;
  return sub;
}

/**
 * Asks for permission (the one place that does), registers the worker, subscribes with the server's key and hands
 * the server the rules. A subscription made for an older key is replaced; an endpoint the server says is gone is
 * swapped for a fresh one, once.
 */
export async function subscribe(rules: AlertRules, publicKey: string): Promise<SubscribeResult> {
  if (!supported()) return "unsupported";
  try {
    const answer = await env().Notification!.requestPermission();
    if (answer === "denied") return "denied";
    if (answer !== "granted") return "dismissed";
    await navigator.serviceWorker.register(SW_URL, { scope: "/" });
    const registration = await withTimeout(navigator.serviceWorker.ready, READY_MS);
    const key = keyBytes(publicKey);
    const fresh = () => registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    let sub = await registration.pushManager.getSubscription();
    if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await fresh();
    known = wire(sub);
    let status = await putRules(sub, rules);
    if (status === 410) {
      await sub.unsubscribe();
      sub = await fresh();
      known = wire(sub);
      status = await putRules(sub, rules);
    }
    if (status === 204) track("push", "on");
    return status === 204 ? "on" : "error";
  } catch {
    return "error";
  }
}

/**
 * Hands the server this device's rules again; "off" when the device is not subscribed, or the server says it no
 * longer is (410). `keepalive` lets the request finish after the page is left (a deal just opened in Real).
 */
export async function syncRules(rules: AlertRules, { keepalive = false }: { keepalive?: boolean } = {}): Promise<SyncResult> {
  try {
    // With keepalive, the page is being left: the request starts now, from the subscription kept from before, with
    // nothing awaited first.
    const quick = keepalive && supported() ? known : null;
    const sub = quick ? null : await currentSubscription();
    if (!quick && !sub) return "off";
    const status = await (quick ? putWire(quick, rules, true) : putRules(sub!, rules, keepalive));
    if (status === 204) return "ok";
    if (status === 410) {
      known = null;
      const gone = sub ?? (await currentSubscription());
      await gone?.unsubscribe().catch(() => false);
      return "off";
    }
    return "error"; // a server busy (429) or without alerts for now (404): the subscription stays
  } catch {
    return "error";
  }
}

/** Deletes the subscription on our server, then here; says how far it got. */
export async function unsubscribe(): Promise<UnsubscribeResult> {
  try {
    const sub = await currentSubscription();
    if (!sub) return "none";
    known = null;
    const status = await send(SUBSCRIPTION_URL, "DELETE", { endpoint: sub.endpoint }).catch(() => 0);
    await sub.unsubscribe();
    track("push", "off");
    return status === 204 ? "deleted" : "device";
  } catch {
    return "error";
  }
}

/** Asks the server for the test alert. A server that does not know this device (its store was reset) gets the rules
 * again first. */
export async function sendTest(rules: AlertRules): Promise<TestResult> {
  try {
    const sub = await currentSubscription();
    if (!sub) return "off";
    let status = await send(TEST_URL, "POST", { endpoint: sub.endpoint });
    if (status === 404 && (await putRules(sub, rules)) === 204) {
      status = await send(TEST_URL, "POST", { endpoint: sub.endpoint });
    }
    if (status === 204) return "sent";
    if (status === 429) return "limited";
    if (status === 410) {
      known = null;
      await sub.unsubscribe().catch(() => false);
      return "off";
    }
    return "error";
  } catch {
    return "error";
  }
}

/** Whether this browser still holds a push subscription for the site, and whether it was made with the server's
 * current key (`publicKey`). A browser that does not say which key it used counts as current. */
export async function subscriptionState(publicKey: string | null): Promise<SubscriptionState> {
  try {
    const sub = await currentSubscription();
    if (!sub) return "none";
    const used = sub.options?.applicationServerKey;
    if (publicKey && used && !sameKey(used, keyBytes(publicKey))) {
      known = null; // an older key's subscription is not one to sync
      return "stale";
    }
    return "current";
  } catch {
    return "none";
  }
}
