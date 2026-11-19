import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BATCH_MAX,
  FLUSH_MS,
  SESSION_GAP_MS,
  dropActivity,
  flushActivity,
  pendingForTests,
  resetActivityForTests,
  startActivity,
  track,
  word,
} from "./activity";
import { VISIT_KEY, forgetDevice, mayCount, resetVisitForTests } from "./visit";

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

function stubBeacon() {
  const beacon = vi.fn((_url: string | URL, _data?: BodyInit | null) => true);
  Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true, writable: true });
  return beacon;
}

async function sent(beacon: ReturnType<typeof stubBeacon>, call = 0) {
  const [url, data] = beacon.mock.calls[call]!;
  return { url, body: JSON.parse(await blobText(data as Blob)) as { d: string; k: string; a: boolean; e: unknown[] } };
}

function setVisibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

function setMark(state: string | null) {
  document.getElementById("me")?.remove();
  if (state === null) return;
  const tag = document.createElement("script");
  tag.id = "me";
  tag.type = "application/json";
  tag.textContent = JSON.stringify({ gate: true, member: state === "in", state });
  document.body.append(tag);
}

describe("the page's activity events", () => {
  beforeEach(() => {
    localStorage.clear();
    resetActivityForTests();
    resetVisitForTests();
    setMark(null);
    Object.defineProperty(navigator, "doNotTrack", { value: null, configurable: true });
    Object.defineProperty(navigator, "globalPrivacyControl", { value: undefined, configurable: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("wait in a queue and leave together, in one beacon with the visit id", async () => {
    const beacon = stubBeacon();
    track("sport", "nba");
    track("lookup", "@KingCards");
    track("deal", 123456);
    track("time", null, 42.4);
    expect(beacon).not.toHaveBeenCalled();
    flushActivity();
    const { url, body } = await sent(beacon);
    expect(url).toBe("/api/events");
    expect(body.d).toBe(localStorage.getItem(VISIT_KEY));
    expect(body.e).toEqual([["sport", "nba"], ["lookup", "KingCards"], ["deal", "123456"], ["time", null, 42]]);
    expect(pendingForTests()).toEqual([]);
  });

  it("drop here what the server would refuse", () => {
    track("lookup", "has space");
    track("deal", "12a");
    track("time", null, 0);
    track("time", null, 5 * 3600);
    track("year", "kingcards", -3);
    track("sheet", "!!!");
    expect(pendingForTests()).toEqual([]);
  });

  it("make plain words of any text", () => {
    expect(word("How it works")).toBe("how-it-works");
    expect(word("Café · Ünder 40%")).toBe("cafe-under-40");
    expect(word("x".repeat(80))).toHaveLength(32);
    expect(word("¿?")).toBeNull();
  });

  it("leave at once when the batch is full", () => {
    const beacon = stubBeacon();
    for (let i = 0; i < BATCH_MAX; i++) track("refresh");
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(pendingForTests()).toEqual([]);
  });

  it("are never sent while the browser asks not to be tracked and nobody is signed in", () => {
    const beacon = stubBeacon();
    Object.defineProperty(navigator, "globalPrivacyControl", { value: true, configurable: true });
    track("refresh");
    flushActivity();
    expect(beacon).not.toHaveBeenCalled();
    expect(localStorage.getItem(VISIT_KEY)).toBeNull();
  });

  it("are sent for someone signed in, whose activity goes with their Discord account", () => {
    const beacon = stubBeacon();
    Object.defineProperty(navigator, "doNotTrack", { value: "1", configurable: true });
    setMark("out");
    expect(mayCount()).toBe(true);
    track("refresh");
    flushActivity();
    expect(beacon).toHaveBeenCalledTimes(1);
  });

  it("stop for good once Delete my data signed the page out", () => {
    const beacon = stubBeacon();
    Object.defineProperty(navigator, "globalPrivacyControl", { value: true, configurable: true });
    setMark("in");
    track("refresh");
    dropActivity();
    forgetDevice();
    track("refresh");
    flushActivity();
    expect(beacon).not.toHaveBeenCalled();
  });

  it("fall back on a keepalive POST when there is no beacon", () => {
    Object.defineProperty(navigator, "sendBeacon", { value: undefined, configurable: true, writable: true });
    const fetcher = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetcher);
    track("refresh");
    flushActivity();
    expect(fetcher).toHaveBeenCalledWith("/api/events", expect.objectContaining({ method: "POST", keepalive: true }));
  });
});

describe("sessions and time on screen", () => {
  beforeEach(() => {
    localStorage.clear();
    resetActivityForTests();
    resetVisitForTests();
    setVisibility("visible");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("start a session, report the seconds on screen when hidden, and a new session only after a long absence", async () => {
    const beacon = stubBeacon();
    let t = 1_000_000;
    const stop = startActivity(document, () => t);
    t += 95_000;
    setVisibility("hidden");
    expect((await sent(beacon, 0)).body.e).toEqual([["session"], ["time", null, 95]]);
    t += 60_000; // back within the gap: the same session
    setVisibility("visible");
    t += 10_000;
    setVisibility("hidden");
    expect((await sent(beacon, 1)).body.e).toEqual([["time", null, 10]]);
    t += SESSION_GAP_MS;
    setVisibility("visible");
    t += 2_000;
    setVisibility("hidden");
    expect((await sent(beacon, 2)).body.e).toEqual([["session"], ["time", null, 2]]);
    stop();
  });

  it("send what waits regularly while the page is on screen", () => {
    vi.useFakeTimers();
    const beacon = stubBeacon();
    const stop = startActivity();
    track("refresh");
    vi.advanceTimersByTime(FLUSH_MS);
    expect(beacon).toHaveBeenCalledTimes(1);
    stop();
  });
});
