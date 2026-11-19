import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OutMeta, trackOut } from "./track";

const meta: OutMeta = { panel: "deals", target: "listing", level: "regular", sport: "nba", pos: 3 };

// FileReader, because the test DOM's Blob is not one the runtime's Response can read.
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe("trackOut", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, "sendBeacon");
  });

  function stubBeacon(impl: (url: string | URL, data?: BodyInit | null) => boolean) {
    const beacon = vi.fn(impl);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true, writable: true });
    return beacon;
  }

  it("sends a beacon to /api/out carrying the click as a JSON blob, and nothing else", async () => {
    const beacon = stubBeacon(() => true);
    expect(trackOut(meta)).toBeUndefined();
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, body] = beacon.mock.calls[0]!;
    expect(url).toBe("/api/out");
    expect(body).toBeInstanceOf(Blob);
    expect((body as Blob).type).toBe("application/json");
    expect(JSON.parse(await blobText(body as Blob))).toEqual(meta);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to a keepalive fetch when there is no beacon", () => {
    Reflect.deleteProperty(navigator, "sendBeacon");
    trackOut(meta);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/out");
    expect(init).toMatchObject({ method: "POST", keepalive: true });
    expect(JSON.parse(init!.body as string)).toEqual(meta);
    expect(new Headers(init!.headers).get("Content-Type")).toBe("application/json");
  });

  it("falls back to a keepalive fetch when the beacon is refused", () => {
    const beacon = stubBeacon(() => false);
    trackOut(meta);
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "POST", keepalive: true });
  });

  it("swallows every error: a beacon that throws, a fetch that throws, a fetch that fails", async () => {
    stubBeacon(() => {
      throw new TypeError("beacon broken");
    });
    fetchMock.mockImplementation(() => {
      throw new TypeError("fetch broken");
    });
    expect(() => trackOut(meta)).not.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1); // a beacon that throws is a beacon refused

    // A fetch that fails later: its rejection must be handled (an unhandled one would also fail this run).
    let handled = false;
    const failing = Promise.reject(new TypeError("network down"));
    const then = failing.then.bind(failing);
    failing.then = ((onFulfilled, onRejected) => {
      if (onRejected) handled = true;
      return then(onFulfilled, onRejected);
    }) as typeof failing.then;
    // A plain function, not a vi.fn: a mock watches the promises it returns, which would handle the rejection itself.
    vi.stubGlobal("fetch", () => failing);
    expect(() => trackOut(meta)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handled).toBe(true);

    // Nothing to send with: no beacon, and a fetch that is not there.
    Reflect.deleteProperty(navigator, "sendBeacon");
    vi.stubGlobal("fetch", undefined);
    expect(() => trackOut(meta)).not.toThrow();
  });

  it("returns at once, before any request settles, so it never holds up the navigation", () => {
    Reflect.deleteProperty(navigator, "sendBeacon");
    fetchMock.mockImplementation(() => new Promise<Response>(() => {})); // never settles
    expect(trackOut(meta)).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
