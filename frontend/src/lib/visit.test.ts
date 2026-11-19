import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VISIT_KEY,
  campaignTag,
  deviceClass,
  deviceId,
  forgetDevice,
  noteTab,
  resetVisitForTests,
  referrerHost,
  sendVisit,
  watchReturn,
  watchSignIn,
} from "./visit";

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

function stubBeacon(impl: (url: string | URL, data?: BodyInit | null) => boolean) {
  const beacon = vi.fn(impl);
  Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true, writable: true });
  return beacon;
}

function stubMedia(matches: (query: string) => boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: matches(query), media: query }) as MediaQueryList);
}

describe("the anonymous visit id", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("is 22 random url-safe characters, made once and kept in the browser's own storage", () => {
    const id = deviceId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(localStorage.getItem(VISIT_KEY)).toBe(id);
    expect(deviceId()).toBe(id);
    expect(document.cookie).toBe(""); // never a cookie
  });

  it("replaces a stored value that is not one", () => {
    localStorage.setItem(VISIT_KEY, "not an id <script>");
    expect(deviceId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("is null when the storage cannot be used, so nothing is sent rather than a new device each time", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(deviceId()).toBeNull();
  });

  it("can be forgotten: the old one is handed back once, and a new one is made next time", () => {
    const id = deviceId();
    expect(forgetDevice()).toBe(id);
    expect(localStorage.getItem(VISIT_KEY)).toBeNull();
    expect(forgetDevice()).toBeNull();
    expect(deviceId()).not.toBe(id);
  });
});

describe("what a visit says", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("the referring site's host name only, never our own, never a path", () => {
    expect(referrerHost("https://www.google.com/search?q=real+deals", "otdpalace.com")).toBe("www.google.com");
    expect(referrerHost("android-app://com.discord/", "otdpalace.com")).toBe("com.discord");
    expect(referrerHost("https://otdpalace.com/#deals", "otdpalace.com")).toBeUndefined();
    expect(referrerHost("", "otdpalace.com")).toBeUndefined();
    expect(referrerHost("not a url", "otdpalace.com")).toBeUndefined();
  });

  it("a campaign tag from ?ref= or utm_source, short and plain, else nothing", () => {
    expect(campaignTag("?ref=Spring_Launch")).toBe("spring_launch");
    expect(campaignTag("?utm_source=tiktok&utm_medium=bio")).toBe("tiktok");
    expect(campaignTag("?ref=a&utm_source=b")).toBe("a");
    expect(campaignTag("?ref=" + "x".repeat(40))).toBeUndefined();
    expect(campaignTag("?ref=%3Cscript%3E")).toBeUndefined();
    expect(campaignTag("")).toBeUndefined();
  });

  it("a coarse device class from the pointer and the screen", () => {
    stubMedia((q) => q === "(pointer: coarse)");
    vi.stubGlobal("screen", { width: 390, height: 844 });
    expect(deviceClass()).toBe("phone");
    vi.stubGlobal("screen", { width: 820, height: 1180 });
    expect(deviceClass()).toBe("tablet");
    stubMedia(() => false);
    vi.stubGlobal("screen", { width: 1440, height: 900 });
    expect(deviceClass()).toBe("desktop");
  });
});

describe("sendVisit", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    stubMedia(() => false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, "sendBeacon");
  });

  it("beacons a page load with its tab, class, home-screen flag, referrer host and tag", async () => {
    const beacon = stubBeacon(() => true);
    sendVisit("load", "deals", { referrer: "https://news.example.com/a/b", search: "?ref=launch" });
    const [url, body] = beacon.mock.calls[0]!;
    expect(url).toBe("/api/visit");
    const sent = JSON.parse(await blobText(body as Blob));
    expect(sent).toEqual({ d: deviceId(), e: "load", t: "deals", k: "desktop", a: false, r: "news.example.com", s: "launch" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a tab view carries no referrer and no tag", async () => {
    const beacon = stubBeacon(() => true);
    sendVisit("view", "plan", { referrer: "https://news.example.com/", search: "?ref=launch" });
    const sent = JSON.parse(await blobText(beacon.mock.calls[0]![1] as Blob));
    expect(sent).toEqual({ d: deviceId(), e: "view", t: "plan", k: "desktop", a: false });
  });

  it("falls back to a keepalive fetch when there is no beacon, and never throws", () => {
    sendVisit("load", "today");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/visit");
    expect(init).toMatchObject({ method: "POST", keepalive: true, credentials: "same-origin" });
    fetchMock.mockImplementation(() => {
      throw new Error("offline");
    });
    expect(() => sendVisit("view", "today")).not.toThrow();
  });

  it("sends nothing without a usable id", () => {
    const beacon = stubBeacon(() => true);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    sendVisit("load", "today");
    expect(beacon).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a press on a Discord sign-in link anywhere on the page is reported once, before it leaves", async () => {
    const beacon = stubBeacon(() => true);
    const stop = watchSignIn(document);
    const link = document.createElement("a");
    link.href = "/auth/discord?next=%2F";
    link.innerHTML = "<span>Continue with Discord</span>";
    link.addEventListener("click", (e) => e.preventDefault());
    document.body.append(link);
    (link.firstChild as HTMLElement).click();
    const other = document.createElement("a");
    other.href = "/privacy";
    other.addEventListener("click", (e) => e.preventDefault());
    document.body.append(other);
    other.click();
    expect(beacon).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(await blobText(beacon.mock.calls[0]![1] as Blob));
    expect(sent).toMatchObject({ e: "signin" });
    expect(sent.t).toBeUndefined();
    stop();
    link.click();
    expect(beacon).toHaveBeenCalledTimes(1);
    link.remove();
    other.remove();
  });
});

describe("noteTab", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "sendBeacon");
    resetVisitForTests();
  });

  it("reports the load once, then a view at each change of tab only", async () => {
    localStorage.clear();
    vi.stubGlobal("matchMedia", () => ({ matches: false }) as MediaQueryList);
    const beacon = stubBeacon(() => true);
    noteTab("today");
    noteTab("today"); // drawn again
    noteTab("deals");
    noteTab("deals");
    noteTab("today");
    const events = await Promise.all(beacon.mock.calls.map(async ([, body]) => JSON.parse(await blobText(body as Blob))));
    expect(events.map((e) => [e.e, e.t])).toEqual([["load", "today"], ["view", "deals"], ["view", "today"]]);
  });
});

describe("a page left open across days", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "sendBeacon");
    resetVisitForTests();
  });

  it("reports the tab again when it comes back on a new UTC day, not within the same day", async () => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T22:00:00Z"));
    vi.stubGlobal("matchMedia", () => ({ matches: false }) as MediaQueryList);
    const beacon = stubBeacon(() => true);
    const stop = watchReturn(document);
    noteTab("deals");
    const show = () => document.dispatchEvent(new Event("visibilitychange"));
    show(); // same day: nothing
    expect(beacon).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-11-19T07:00:00Z")); // a home-screen app resumed the next morning
    show();
    show();
    expect(beacon).toHaveBeenCalledTimes(2);
    const sent = JSON.parse(await blobText(beacon.mock.calls[1]![1] as Blob));
    expect(sent).toMatchObject({ e: "view", t: "deals" });
    stop();
  });
});

describe("a browser that asks not to be tracked", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, "sendBeacon");
    Reflect.deleteProperty(navigator, "globalPrivacyControl");
    Reflect.deleteProperty(navigator, "doNotTrack");
    vi.unstubAllGlobals();
  });

  it.each([
    ["globalPrivacyControl", true],
    ["doNotTrack", "1"],
  ])("sends nothing and stores no id when %s says so", (name, value) => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
    const beacon = stubBeacon(() => true);
    Object.defineProperty(navigator, name, { value, configurable: true });
    sendVisit("load", "today");
    expect(beacon).not.toHaveBeenCalled();
    expect(localStorage.getItem(VISIT_KEY)).toBeNull();
  });
});
