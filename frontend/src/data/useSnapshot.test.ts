import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RULES, isoAt, makeDeal, makeSnapshot } from "../test/fixtures";
import type { Snapshot } from "./types";
import { snapshotProblem, useSnapshot } from "./useSnapshot";
import { onDiscordRequired } from "../lib/gate";

type FetchCall = Parameters<typeof fetch>;

const now = () => Date.now(); // the fake clock, injected the way the page injects performance.now
let wallJump = 0; // how far the wall clock has gone ahead of the monotonic one (sleep, a client clock set wrong)
const wallNow = () => Date.now() + wallJump;
const reply = (status: number, body?: unknown, etag?: string) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: etag ? { ETag: etag } : {},
  });
const ok = (snap: Snapshot) => reply(200, snap, `"${snap.version}"`);

function inlineSnapshot(text: string) {
  const el = document.createElement("script");
  el.id = "snapshot";
  el.type = "application/json";
  el.textContent = text;
  document.body.append(el);
}

function sentIfNoneMatch(call: FetchCall | undefined): string | undefined {
  return (call?.[1]?.headers as Record<string, string> | undefined)?.["If-None-Match"];
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function setup(fetchImpl: typeof fetch, options: { now?: () => number; wallNow?: () => number } = { now, wallNow }) {
  return renderHook(() => useSnapshot({ fetchImpl, ...options }));
}

describe("useSnapshot", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.useFakeTimers();
    wallJump = 0;
    fetchMock = vi.fn<typeof fetch>();
  });

  afterEach(() => {
    document.getElementById("snapshot")?.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("starts live on the snapshot inlined in the page, with no request yet", () => {
    inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1, deals: [makeDeal()] })));
    const { result } = setup(fetchMock);
    expect(result.current.status).toBe("live");
    expect(result.current.snap?.version).toBe(1);
    expect(result.current.snap?.deals).toHaveLength(1);
    expect(result.current.updatedAgoS).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("goes stale after 90 s without a new version, then live again on a new one, sending If-None-Match", async () => {
    inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
    fetchMock.mockImplementation(async () => reply(304));
    const { result } = setup(fetchMock);

    await advance(90_000);
    expect(result.current.status).toBe("live");
    await advance(1_000);
    expect(result.current.status).toBe("stale");
    expect(result.current.snap?.version).toBe(1); // still there, only marked

    expect(fetchMock.mock.calls.length).toBeGreaterThan(10);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/snapshot");
    for (const call of fetchMock.mock.calls) expect(sentIfNoneMatch(call)).toBe('"1"');

    fetchMock.mockImplementation(async () => ok(makeSnapshot({ version: 2 })));
    await advance(5_000);
    expect(result.current.status).toBe("live");
    expect(result.current.snap?.version).toBe(2);
    expect(result.current.updatedAgoS).toBeLessThanOrEqual(1);

    fetchMock.mockImplementation(async () => reply(304));
    fetchMock.mockClear();
    await advance(5_000);
    expect(sentIfNoneMatch(fetchMock.mock.calls[0])).toBe('"2"');
  });

  it("tells the gate when the server wants a member of our Discord, and counts it as a failed poll", async () => {
    const heard = vi.fn();
    const stop = onDiscordRequired(heard);
    fetchMock.mockResolvedValue(reply(401, { error: "discord_required" }));
    const { result } = setup(fetchMock);
    await advance(0);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(result.current.failures).toBe(1);
    stop();
  });

  it("counts seconds since the last new version", async () => {
    inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
    fetchMock.mockImplementation(async () => reply(304));
    const { result } = setup(fetchMock);
    await advance(12_000);
    expect(result.current.updatedAgoS).toBe(12);
    expect(result.current.status).toBe("live");
  });

  it("keeps the clock running while polls fail or the server is warming up", async () => {
    inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
    const answers = [() => reply(503, { error: "warming up" }), () => reply(500), () => Promise.reject(new TypeError("offline"))];
    let n = 0;
    fetchMock.mockImplementation(async () => answers[n++ % answers.length]!());
    const { result } = setup(fetchMock);

    await advance(12_000);
    expect(result.current.updatedAgoS).toBe(12);
    expect(result.current.snap?.version).toBe(1);
  });

  describe("polls that fail", () => {
    it("turns stale after two failed polls in a row, whatever the age, and live again on the next answer", async () => {
      inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
      fetchMock.mockImplementation(async () => Promise.reject(new TypeError("offline")));
      const { result } = setup(fetchMock);

      await advance(5_000);
      expect(result.current.failures).toBe(1);
      expect(result.current.status).toBe("live"); // one miss is no news yet
      await advance(5_000);
      expect(result.current.failures).toBe(2);
      expect(result.current.status).toBe("stale"); // 10 s old, far inside stale_after_s, but the server is gone
      expect(result.current.snap?.version).toBe(1);

      fetchMock.mockImplementation(async () => reply(304));
      await advance(5_000);
      expect(result.current.failures).toBe(0);
      expect(result.current.status).toBe("live");
    });

    it.each([
      ["a 503 while warming up", () => reply(503, { error: "warming up" })],
      ["a 500", () => reply(500)],
      ["a 404", () => reply(404)],
      ["no answer at all", () => Promise.reject(new TypeError("offline"))],
    ])("counts %s as unreachable", async (_name, answer) => {
      inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
      fetchMock.mockImplementation(async () => answer());
      const { result } = setup(fetchMock);
      expect(result.current.lastError).toBeNull();
      await advance(10_000);
      expect(result.current.lastError).toBe("unreachable");
      expect(result.current.status).toBe("stale");
    });

    it("counts a request that times out as unreachable", async () => {
      inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
      const timeouts: AbortController[] = [];
      vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
        const controller = new AbortController();
        timeouts.push(controller);
        return controller.signal;
      });
      fetchMock.mockImplementation(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      );
      const { result } = setup(fetchMock);
      await advance(5_000);
      await act(async () => timeouts.at(-1)?.abort(new DOMException("timed out", "TimeoutError")));
      expect(result.current.failures).toBe(1);
      expect(result.current.lastError).toBe("unreachable");
    });

    it("counts an answer it cannot read as unreadable, and says which field was missing", async () => {
      inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { levels: _levels, ...noLevels } = makeSnapshot({ version: 2 });
      fetchMock.mockImplementation(async () => reply(200, noLevels, '"2"'));
      const { result } = setup(fetchMock);
      await advance(5_000);
      expect(result.current.lastError).toBe("unreadable");
      expect(result.current.failures).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"levels"'));
      await advance(5_000);
      expect(result.current.status).toBe("stale");
      expect(result.current.snap?.version).toBe(1);
    });

    it("names the field inside a level, and an answer that is no JSON at all", async () => {
      inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const full = makeSnapshot({ version: 2 });
      const broken = { ...full, levels: { ...full.levels, pro: { ...full.levels.pro!, bid_max_left_min: undefined } } };
      const answers = [() => reply(200, broken, '"2"'), () => new Response("{oops", { status: 200 })];
      let n = 0;
      fetchMock.mockImplementation(async () => answers[n++]!());
      const { result } = setup(fetchMock);
      await advance(5_000);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"levels.pro.bid_max_left_min"'));
      await advance(5_000);
      expect(result.current.lastError).toBe("unreadable");
      expect(result.current.failures).toBe(2);
    });

    it("forgets the error once an answer comes", async () => {
      inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
      fetchMock.mockImplementationOnce(async () => reply(500));
      fetchMock.mockImplementation(async () => ok(makeSnapshot({ version: 2 })));
      const { result } = setup(fetchMock);
      await advance(5_000);
      expect(result.current.lastError).toBe("unreachable");
      await advance(5_000);
      expect(result.current.lastError).toBeNull();
      expect(result.current.failures).toBe(0);
      expect(result.current.snap?.version).toBe(2);
    });

    it("retries at once on demand, then keeps the usual rhythm", async () => {
      fetchMock.mockImplementation(async () => reply(503));
      const { result } = setup(fetchMock);
      await advance(10_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result.current.failures).toBe(3);

      fetchMock.mockImplementation(async () => ok(makeSnapshot({ version: 4 })));
      await act(async () => result.current.retry());
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(result.current.snap?.version).toBe(4);
      expect(result.current.failures).toBe(0);
    });
  });

  it("on Retry during a request, drops that request and asks again at once, without counting a failure", async () => {
    inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
    const signals: (AbortSignal | null | undefined)[] = [];
    fetchMock.mockImplementation((_input, init) => {
      signals.push(init?.signal);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    });
    const { result } = setup(fetchMock);
    await advance(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => result.current.retry());
    expect(signals[0]?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signals[1]?.aborted).toBe(false);
    expect(result.current.failures).toBe(0);
    expect(result.current.lastError).toBeNull();
  });

  it("refreshes on demand (a pull to refresh) and says when that poll is over, answered or not", async () => {
    inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
    fetchMock.mockImplementation(async () => ok(makeSnapshot({ version: 2 })));
    const { result } = setup(fetchMock);
    let answered: boolean | undefined;
    await act(async () => {
      answered = await result.current.refresh();
    });
    expect(answered).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.snap?.version).toBe(2);

    fetchMock.mockImplementation(async () => reply(503));
    await act(async () => {
      answered = await result.current.refresh();
    });
    expect(answered).toBe(false);
    expect(result.current.failures).toBe(1);
  });

  it("a refresh during a request waits for the request asked anew, and a page gone answers no", async () => {
    inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
    let release: (() => void) | undefined;
    fetchMock.mockImplementation((_input, init) => {
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        release = () => resolve(ok(makeSnapshot({ version: 3 })));
      });
    });
    const { result, unmount } = setup(fetchMock);
    await advance(5_000); // the usual poll is under way
    let answered: boolean | undefined;
    let pending: Promise<boolean> | undefined;
    await act(async () => {
      pending = result.current.refresh();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2); // the first dropped, a new one out
    await act(async () => {
      release?.();
      answered = await pending;
    });
    expect(answered).toBe(true);
    expect(result.current.snap?.version).toBe(3);

    await act(async () => {
      pending = result.current.refresh();
    });
    unmount();
    expect(await pending).toBe(false);
  });

  it("keeps polling where AbortSignal.timeout does not exist, and still gives up on a request that hangs", async () => {
    const timeout = AbortSignal.timeout;
    // @ts-expect-error an older browser
    delete AbortSignal.timeout;
    try {
      inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
      fetchMock.mockImplementation(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      );
      const { result } = setup(fetchMock);
      await advance(5_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await advance(10_000); // twice the poll interval: given up
      expect(result.current.failures).toBe(1);
      expect(result.current.lastError).toBe("unreachable");
      await advance(5_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      AbortSignal.timeout = timeout;
    }
  });

  it("warns once per distinct problem, not on every poll", async () => {
    inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const full = makeSnapshot({ version: 2 });
    const { levels: _levels, ...noLevels } = full;
    const { gone: _gone, ...noGone } = full;
    const answers = [noLevels, noLevels, noLevels, noGone, noGone];
    let n = 0;
    fetchMock.mockImplementation(async () => reply(200, answers[Math.min(n++, answers.length - 1)], '"2"'));
    setup(fetchMock);
    await advance(25_000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map(([m]) => String(m).match(/"([^"]+)"/)?.[1])).toEqual(["levels", "gone"]);
  });

  describe("passes sent only when they change", () => {
    const market = { key: "nba:1:2025" } as unknown as Snapshot["otd"]["markets"][number];
    const withPasses = (version: number, otdVersion: string, markets = [market]) =>
      makeSnapshot({ version, otd_version: otdVersion, otd: { ...makeSnapshot().otd, markets } });
    const lean = (snap: Snapshot) => Object.fromEntries(Object.entries(snap).filter(([k]) => k !== "otd"));

    it("asks without the passes it holds, and keeps them when the answer leaves them out", async () => {
      inlineSnapshot(JSON.stringify(withPasses(1, "p1")));
      fetchMock.mockImplementation(async () => reply(200, lean(withPasses(2, "p1", [])), '"2"'));
      const { result } = setup(fetchMock);
      await advance(5_000);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/snapshot?otd=p1");
      expect(result.current.snap?.version).toBe(2);
      expect(result.current.snap?.otd.markets).toEqual([market]);
      expect(result.current.lastError).toBeNull();
    });

    it("takes new passes when they come, and asks with their version from then on", async () => {
      inlineSnapshot(JSON.stringify(withPasses(1, "p1")));
      const other = { key: "nhl:9:2024" } as unknown as Snapshot["otd"]["markets"][number];
      fetchMock.mockImplementationOnce(async () => ok(withPasses(2, "p2", [other])));
      fetchMock.mockImplementation(async () => reply(304));
      const { result } = setup(fetchMock);
      await advance(5_000);
      expect(result.current.snap?.otd.markets).toEqual([other]);
      await advance(5_000);
      expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/snapshot?otd=p2");
    });

    it("asks for everything while it holds no pass version", async () => {
      inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
      fetchMock.mockImplementation(async () => reply(304));
      setup(fetchMock);
      await advance(5_000);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/snapshot");
    });

    it("refuses an answer without passes that names other passes than the ones it holds", async () => {
      inlineSnapshot(JSON.stringify(withPasses(1, "p1")));
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      fetchMock.mockImplementation(async () => reply(200, lean(withPasses(2, "p9")), '"2"'));
      const { result } = setup(fetchMock);
      await advance(5_000);
      expect(result.current.snap?.version).toBe(1);
      expect(result.current.lastError).toBe("unreadable");
    });

    it("asks for everything after refusing such an answer, then names the new passes", async () => {
      inlineSnapshot(JSON.stringify(withPasses(1, "p1")));
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      fetchMock.mockImplementationOnce(async () => reply(200, lean(withPasses(2, "p9")), '"2"'));
      fetchMock.mockImplementationOnce(async () => ok(withPasses(2, "p9")));
      fetchMock.mockImplementation(async () => reply(304));
      const { result } = setup(fetchMock);
      await advance(5_000);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/snapshot?otd=p1");
      await advance(5_000);
      expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/snapshot"); // the held passes are no longer named
      expect(result.current.snap?.version).toBe(2);
      await advance(5_000);
      expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/snapshot?otd=p9");
    });
  });

  describe("a hidden page", () => {
    const visibility = (state: "visible" | "hidden") => {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
      act(() => void document.dispatchEvent(new Event("visibilitychange")));
    };

    it("stops polling while hidden and polls at once when it comes back", async () => {
      inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
      fetchMock.mockImplementation(async () => reply(304));
      setup(fetchMock);
      await advance(5_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      visibility("hidden");
      await advance(120_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      visibility("visible");
      await advance(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await advance(5_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("stops the age ticker while hidden, and shows the true age when it comes back", async () => {
      inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
      fetchMock.mockImplementation(async () => reply(304));
      const { result } = setup(fetchMock);
      await advance(3_000);
      expect(result.current.updatedAgoS).toBe(3);
      visibility("hidden");
      await advance(30_000);
      expect(result.current.updatedAgoS).toBe(3); // nothing ticks in a hidden tab
      visibility("visible");
      expect(result.current.updatedAgoS).toBe(33);
    });

    it("waits for a tab that opens hidden to be shown before it polls or ticks", async () => {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
      fetchMock.mockImplementation(async () => reply(304));
      const { result } = setup(fetchMock);
      await advance(60_000);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.current.updatedAgoS).toBe(0);
      visibility("visible");
      await advance(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.current.updatedAgoS).toBe(60);
    });

    it("does not poll again on a quick flip back when the last answer is under 2 s old", async () => {
      inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
      fetchMock.mockImplementation(async () => reply(304));
      setup(fetchMock);
      await advance(5_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await advance(500);
      visibility("hidden");
      await advance(500);
      visibility("visible");
      await advance(0);
      expect(fetchMock).toHaveBeenCalledTimes(1); // answered 1 s ago
      await advance(3_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await advance(1);
      expect(fetchMock).toHaveBeenCalledTimes(2); // the usual turn, 5 s after the answer
    });

    it("polls on a flip back once the last answer is 2 s old or more", async () => {
      inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
      fetchMock.mockImplementation(async () => reply(304));
      setup(fetchMock);
      await advance(5_000);
      visibility("hidden");
      await advance(2_000);
      visibility("visible");
      await advance(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not schedule another poll when the page was hidden during a request", async () => {
      inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
      let answer!: (r: Response) => void;
      fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)));
      setup(fetchMock);
      await advance(5_000);
      visibility("hidden");
      await act(async () => answer(reply(304)));
      await advance(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it("is loading without an inlined snapshot, polls at once and every 5 s, then goes live", async () => {
    fetchMock.mockImplementation(async () => reply(503, { error: "warming up" }));
    const { result } = setup(fetchMock);
    expect(result.current).toEqual(
      expect.objectContaining({ snap: null, status: "loading", updatedAgoS: null, lastError: null, failures: 0 }),
    );

    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentIfNoneMatch(fetchMock.mock.calls[0])).toBeUndefined();
    await advance(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("loading");

    fetchMock.mockImplementation(async () => ok(makeSnapshot({ version: 7 })));
    await advance(5_000);
    expect(result.current.status).toBe("live");
    expect(result.current.snap?.version).toBe(7);
    expect(result.current.updatedAgoS).toBe(0);
  });

  it("is loading when the inlined snapshot is not readable", () => {
    inlineSnapshot("{broken");
    fetchMock.mockImplementation(async () => reply(503));
    expect(setup(fetchMock).result.current.status).toBe("loading");
  });

  it("polls every rules.poll_s seconds", async () => {
    inlineSnapshot(JSON.stringify(makeSnapshot({ rules: { ...RULES, stale_after_s: 90, poll_s: 10 } })));
    fetchMock.mockImplementation(async () => reply(304));
    setup(fetchMock);
    await advance(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("judges freshness by the stale_after_s the snapshot carries", async () => {
    inlineSnapshot(JSON.stringify(makeSnapshot({ rules: { ...RULES, stale_after_s: 20, poll_s: 5 } })));
    fetchMock.mockImplementation(async () => reply(304));
    const { result } = setup(fetchMock);
    await advance(20_000);
    expect(result.current.status).toBe("live");
    await advance(1_000);
    expect(result.current.status).toBe("stale");
  });

  it("does not count a reply with the same version as new", async () => {
    inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
    fetchMock.mockImplementation(async () => ok(makeSnapshot({ version: 1 })));
    const { result } = setup(fetchMock);
    await advance(91_000);
    expect(result.current.status).toBe("stale");
  });

  it("ignores a reply that is not a snapshot", async () => {
    inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
    const garbage = [{ version: 2 }, { version: 2, deals: "x" }, null, [], "text"];
    let n = 0;
    fetchMock.mockImplementation(async () => reply(200, garbage[n++ % garbage.length], '"2"'));
    const { result } = setup(fetchMock);
    await advance(30_000);
    expect(result.current.snap?.version).toBe(1);
    await advance(61_000);
    expect(result.current.status).toBe("stale");
  });

  it("ignores a reply missing the pulse, gone, taken_10m, or a level's bid window or hide_falling", async () => {
    // Each of these would break the page quietly: a level without bid_max_left_min, for one, makes the bid
    // filter compare against NaN and hide every bid; one without a true or false hide_falling hides falling deals
    // from the wrong visitors.
    inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
    const full = makeSnapshot({ version: 2 });
    const without = (key: keyof Snapshot) => Object.fromEntries(Object.entries(full).filter(([k]) => k !== key));
    const pro = full.levels.pro!;
    const broken = [
      without("pulse"),
      { ...full, pulse: null },
      { ...full, pulse: { window_min: 60 } },
      { ...full, pulse: { sales: [] } },
      { ...full, pulse: { window_min: "60", sales: [] } },
      without("gone"),
      { ...full, gone: {} },
      without("taken_10m"),
      { ...full, taken_10m: "3" },
      { ...full, levels: { ...full.levels, pro: { ...pro, bid_max_left_min: undefined } } },
      { ...full, levels: { ...full.levels, pro: { ...pro, bid_max_left_min: "120" } } },
      { ...full, levels: { ...full.levels, pro: null } },
      { ...full, levels: { ...full.levels, pro: { ...pro, hide_falling: undefined } } },
      { ...full, levels: { ...full.levels, pro: { ...pro, hide_falling: "false" } } },
      { ...full, levels: { ...full.levels, pro: { ...pro, hide_falling: 0 } } },
    ];
    let n = 0;
    fetchMock.mockImplementation(async () => reply(200, broken[n++ % broken.length], '"2"'));
    const { result } = setup(fetchMock);
    await advance(broken.length * 5_000);
    expect(fetchMock).toHaveBeenCalledTimes(broken.length);
    expect(result.current.snap?.version).toBe(1);
  });

  it("ignores a reply missing the passes' markets or picks, or the rules the pass planner needs", async () => {
    inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
    const full = makeSnapshot({ version: 2 });
    const { markets: _markets, ...noMarkets } = full.otd;
    const { picks: _picks, ...noPicks } = full.otd;
    const { otd: _otdRules, ...noPlannerRules } = full.rules;
    const broken = [
      { ...full, otd: noMarkets },
      { ...full, otd: { ...full.otd, markets: {} } },
      { ...full, otd: noPicks },
      { ...full, otd: { ...full.otd, picks: [] } },
      { ...full, rules: noPlannerRules },
      { ...full, rules: { ...full.rules, otd: null } },
      { ...full, rules: { ...full.rules, otd: [] } },
    ];
    let n = 0;
    fetchMock.mockImplementation(async () => reply(200, broken[n++ % broken.length], '"2"'));
    const { result } = setup(fetchMock);
    await advance(broken.length * 5_000);
    expect(fetchMock).toHaveBeenCalledTimes(broken.length);
    expect(result.current.snap?.version).toBe(1);
  });

  it("takes a reply carrying passes and the planner's rules", async () => {
    inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
    fetchMock.mockImplementation(async () => ok(makeSnapshot({ version: 2 })));
    const { result } = setup(fetchMock);
    await advance(5_000);
    expect(result.current.snap?.version).toBe(2);
    expect(result.current.snap?.rules.otd.claims_per_sport_day).toBe(2);
  });

  it("ignores a reply without its links, or with a community link that is not a string", async () => {
    inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
    const full = makeSnapshot({ version: 2 });
    const without = Object.fromEntries(Object.entries(full).filter(([k]) => k !== "links"));
    const broken = [without, { ...full, links: null }, { ...full, links: {} }, { ...full, links: { community: 1 } }];
    let n = 0;
    fetchMock.mockImplementation(async () => reply(200, broken[n++ % broken.length], '"2"'));
    const { result } = setup(fetchMock);
    await advance(broken.length * 5_000);
    expect(fetchMock).toHaveBeenCalledTimes(broken.length);
    expect(result.current.snap?.version).toBe(1);
  });

  it("takes a reply whose community link is set", async () => {
    inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
    const withLink = makeSnapshot({ version: 2, links: { community: "https://discord.gg/market-palace" } });
    fetchMock.mockImplementation(async () => ok(withLink));
    const { result } = setup(fetchMock);
    await advance(5_000);
    expect(result.current.snap?.links.community).toBe("https://discord.gg/market-palace");
  });

  it("is loading when the inlined snapshot lacks the gone deals", () => {
    const { gone: _gone, ...rest } = makeSnapshot();
    inlineSnapshot(JSON.stringify(rest));
    fetchMock.mockImplementation(async () => reply(503));
    expect(setup(fetchMock).result.current.status).toBe("loading");
  });

  it("falls back to the version for the ETag when the reply carries none", async () => {
    inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
    fetchMock.mockImplementationOnce(async () => reply(200, makeSnapshot({ version: 2 })));
    fetchMock.mockImplementation(async () => reply(304));
    setup(fetchMock);
    await advance(10_000);
    expect(sentIfNoneMatch(fetchMock.mock.calls[1])).toBe('"2"');
  });

  it("stops everything on unmount: no timers left, no more requests, the pending one aborted", async () => {
    inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
    let signal: AbortSignal | null | undefined;
    fetchMock.mockImplementation((_input, init) => {
      signal = init?.signal;
      return new Promise<Response>(() => {}); // never answers
    });
    const { unmount } = setup(fetchMock);
    await advance(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);

    unmount();
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not poll again after unmount even when the last reply lands late", async () => {
    inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
    let answer!: (r: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)));
    const { unmount } = setup(fetchMock);
    await advance(5_000);
    unmount();
    answer(ok(makeSnapshot({ version: 2 })));
    await advance(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  describe("freshness by the wall clock too", () => {
    const AGE_LIMIT_S = 90; // makeSnapshot's rules.stale_after_s
    const serverAge = (s: number) => isoAt(Date.now() - s * 1000);

    it("reads a snapshot generated 10 minutes ago as stale on the very first render", () => {
      inlineSnapshot(JSON.stringify(makeSnapshot({ generated_at: serverAge(600) })));
      const { result } = setup(fetchMock);
      expect(result.current.status).toBe("stale");
      expect(result.current.snap?.version).toBe(1);
      expect(result.current.updatedAgoS).toBeGreaterThanOrEqual(600);
    });

    it("goes live when a fresh version replaces that stale one", async () => {
      inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1, generated_at: serverAge(600) })));
      fetchMock.mockImplementation(async () => ok(makeSnapshot({ version: 2 })));
      const { result } = setup(fetchMock);
      await advance(5_000);
      expect(result.current.status).toBe("live");
      expect(result.current.snap?.version).toBe(2);
    });

    it("turns stale when the wall clock jumps 10 minutes ahead while the monotonic clock stays put", async () => {
      inlineSnapshot(JSON.stringify(makeSnapshot()));
      fetchMock.mockImplementation(async () => reply(304));
      const { result } = setup(fetchMock);
      expect(result.current.status).toBe("live");
      wallJump = 600_000; // the laptop slept
      await advance(1_000);
      expect(result.current.status).toBe("stale");
    });

    it("still reads fresh data as live when the client clock runs 20 s ahead of the server's", async () => {
      wallJump = 20_000;
      inlineSnapshot(JSON.stringify(makeSnapshot()));
      fetchMock.mockImplementation(async () => reply(304));
      const { result } = setup(fetchMock);
      expect(result.current.status).toBe("live");
      await advance(60_000);
      expect(result.current.status).toBe("live");
    });

    it("reads fresh data as live on a device whose clock runs 3 minutes ahead, by the server's own Date", async () => {
      wallJump = 180_000; // the device's clock is set wrong; the server's (Date.now()) is right
      let version = 1;
      inlineSnapshot(JSON.stringify(makeSnapshot({ version })));
      fetchMock.mockImplementation(async () => {
        version += 1;
        return new Response(JSON.stringify(makeSnapshot({ version, generated_at: isoAt(Date.now()) })), {
          status: 200,
          headers: { ETag: `"${version}"`, Date: new Date(Date.now()).toUTCString() },
        });
      });
      const { result } = setup(fetchMock);
      await advance(5_000);
      expect(result.current.snap?.version).toBe(2);
      expect(result.current.status).toBe("live");
      expect(result.current.updatedAgoS).toBeLessThan(5);
      await advance(60_000); // a new version every poll: live all along
      expect(result.current.status).toBe("live");
      // The data standing still is still caught: the server stops answering with anything new.
      fetchMock.mockImplementation(async () => new Response(null, { status: 304, headers: { Date: new Date(Date.now()).toUTCString() } }));
      await advance(AGE_LIMIT_S * 1000 + 1_000);
      expect(result.current.status).toBe("stale");
    });

    it("does not mind a server clock ahead of the client's", () => {
      inlineSnapshot(JSON.stringify(makeSnapshot({ generated_at: isoAt(Date.now() + 120_000) })));
      const { result } = setup(fetchMock);
      expect(result.current.status).toBe("live");
      expect(result.current.updatedAgoS).toBe(0);
    });

    it.each([
      [AGE_LIMIT_S + 20, "live"], // inside the 30 s allowance for client clock skew
      [AGE_LIMIT_S + 40, "stale"],
    ])("a snapshot generated %j s ago reads %s", (ageS, status) => {
      inlineSnapshot(JSON.stringify(makeSnapshot({ generated_at: serverAge(ageS) })));
      expect(setup(fetchMock).result.current.status).toBe(status);
    });

    it("reads a snapshot whose generated_at cannot be parsed as stale", async () => {
      inlineSnapshot(JSON.stringify(makeSnapshot({ generated_at: "yesterday-ish" })));
      fetchMock.mockImplementation(async () => reply(304));
      const { result } = setup(fetchMock);
      expect(result.current.status).toBe("stale");
      await advance(10_000);
      expect(result.current.status).toBe("stale");
    });
  });

  describe("requests that hang", () => {
    it("gives up after twice the poll interval, counts it as no news and polls again on schedule", async () => {
      inlineSnapshot(JSON.stringify(makeSnapshot()));
      const timeouts: AbortController[] = [];
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
        const controller = new AbortController();
        timeouts.push(controller);
        return controller.signal;
      });
      fetchMock.mockImplementation(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      );
      const { result } = setup(fetchMock);

      await advance(5_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(timeoutSpy).toHaveBeenCalledWith(10_000);

      await advance(5_000);
      expect(fetchMock).toHaveBeenCalledTimes(1); // still waiting: nothing polls on top of a pending request

      await act(async () => timeouts[0]?.abort(new DOMException("timed out", "TimeoutError")));
      await advance(4_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await advance(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.current.snap?.version).toBe(1);
    });
  });

  describe("coming back to the page", () => {
    const visible = () => vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const wakeUps: [string, () => void][] = [
      ["online", () => window.dispatchEvent(new Event("online"))],
      ["pageshow", () => window.dispatchEvent(new Event("pageshow"))],
      ["visibilitychange", () => document.dispatchEvent(new Event("visibilitychange"))],
    ];

    it.each(wakeUps)("on %s, checks the age and polls at once, then keeps the usual rhythm", async (_name, fire) => {
      visible();
      inlineSnapshot(JSON.stringify(makeSnapshot()));
      fetchMock.mockImplementation(async () => reply(304));
      const { result } = setup(fetchMock);
      await advance(1_000);
      expect(fetchMock).not.toHaveBeenCalled();

      wallJump = 600_000;
      act(() => fire());
      expect(result.current.status).toBe("stale"); // no wait for the next tick
      await advance(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sentIfNoneMatch(fetchMock.mock.calls[0])).toBe('"1"');

      await advance(4_999);
      expect(fetchMock).toHaveBeenCalledTimes(1); // the poll that was due at 5 s was replaced
      await advance(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("ignores visibilitychange while the page is hidden", async () => {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      inlineSnapshot(JSON.stringify(makeSnapshot()));
      fetchMock.mockImplementation(async () => reply(304));
      setup(fetchMock);
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await advance(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not start a second request while one is pending", async () => {
      inlineSnapshot(JSON.stringify(makeSnapshot()));
      fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
      setup(fetchMock);
      await advance(5_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      act(() => {
        window.dispatchEvent(new Event("online"));
      });
      await advance(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("stops listening on unmount", async () => {
      visible();
      inlineSnapshot(JSON.stringify(makeSnapshot()));
      fetchMock.mockImplementation(async () => reply(304));
      const added = [vi.spyOn(window, "addEventListener"), vi.spyOn(document, "addEventListener")];
      const removed = [vi.spyOn(window, "removeEventListener"), vi.spyOn(document, "removeEventListener")];
      const { unmount } = setup(fetchMock);
      unmount();

      const listenerFor = (type: string) => added.flatMap((spy) => spy.mock.calls).find(([t]) => t === type)?.[1];
      for (const type of ["online", "pageshow", "visibilitychange"]) {
        const listener = listenerFor(type);
        expect(listener, type).toBeDefined();
        expect(removed.flatMap((spy) => spy.mock.calls), type).toContainEqual([type, listener]);
      }
      for (const [, fire] of wakeUps) fire();
      await advance(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("a phone saving data or battery, or offline", () => {
    // A stand-in for the device: what it says, and the change events the hook listens to.
    function fakeThrift(start: { saving?: boolean; offline?: boolean } = {}) {
      const state = { saving: start.saving ?? false, offline: start.offline ?? false };
      const listeners = new Set<() => void>();
      const thrift = {
        saving: () => state.saving,
        offline: () => state.offline,
        watch: (onChange: () => void) => {
          listeners.add(onChange);
          return () => listeners.delete(onChange);
        },
      };
      const set = (next: Partial<typeof state>) => {
        Object.assign(state, next);
        act(() => listeners.forEach((fire) => fire()));
      };
      return { thrift, set, listeners };
    }
    const setupWith = (thrift: ReturnType<typeof fakeThrift>["thrift"]) =>
      renderHook(() => useSnapshot({ fetchImpl: fetchMock, now, wallNow, thrift }));

    it("polls every 20 s instead of 5 while the phone saves data or battery, and every 5 s again once it stops", async () => {
      inlineSnapshot(JSON.stringify(makeSnapshot()));
      fetchMock.mockImplementation(async () => reply(304));
      const device = fakeThrift({ saving: true });
      const { result } = setupWith(device.thrift);
      await advance(19_999);
      expect(fetchMock).not.toHaveBeenCalled();
      await advance(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await advance(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(result.current.status).toBe("live"); // 20 s is well inside stale_after_s: still live, not paused

      device.set({ saving: false }); // 0 s after the last poll: the next one comes 5 s after it, not 20
      await advance(4_999);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      await advance(1);
      expect(fetchMock).toHaveBeenCalledTimes(5);
      await advance(5_000);
      expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it("slows an upcoming poll as soon as saving starts, and polls at once when saving stops past the usual turn", async () => {
      inlineSnapshot(JSON.stringify(makeSnapshot()));
      fetchMock.mockImplementation(async () => reply(304));
      const device = fakeThrift();
      setupWith(device.thrift);
      await advance(5_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await advance(2_000);
      device.set({ saving: true }); // the poll due at 10 s now comes at 25 s
      await advance(17_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await advance(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await advance(8_000); // 8 s after that poll, saving stops: the usual 5 s are past
      device.set({ saving: false });
      await advance(0);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("never waits longer than half of stale_after_s, so the data never reads as paused for it", async () => {
      inlineSnapshot(JSON.stringify(makeSnapshot({ rules: { ...RULES, stale_after_s: 30 } })));
      fetchMock.mockImplementation(async () => reply(304));
      setupWith(fakeThrift({ saving: true }).thrift);
      await advance(14_999);
      expect(fetchMock).not.toHaveBeenCalled();
      await advance(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("asks nothing while the phone knows it is offline, says so at once, and polls the moment it is back", async () => {
      inlineSnapshot(JSON.stringify(makeSnapshot()));
      fetchMock.mockImplementation(async () => reply(304));
      const device = fakeThrift();
      const { result } = setupWith(device.thrift);
      expect(result.current.offline).toBe(false);
      device.set({ offline: true });
      act(() => {
        window.dispatchEvent(new Event("offline"));
      });
      expect(result.current.status).toBe("stale"); // no 10 s of "Live" over a dead link
      expect(result.current.offline).toBe(true);
      expect(result.current.snap?.version).toBe(1); // the last data stays on screen
      await advance(60_000);
      expect(fetchMock).not.toHaveBeenCalled();
      await expect(act(() => result.current.refresh())).resolves.toBe(false); // a pull answers at once: no network

      device.set({ offline: false });
      act(() => {
        window.dispatchEvent(new Event("online"));
      });
      await advance(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.current.status).toBe("live");
      expect(result.current.offline).toBe(false);
    });

    it("starts offline without asking, on a page opened with no network", async () => {
      inlineSnapshot(JSON.stringify(makeSnapshot()));
      const { result } = setupWith(fakeThrift({ offline: true }).thrift);
      await advance(30_000);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.current.status).toBe("stale");
      expect(result.current.offline).toBe(true);
    });

    it("stops listening to the device on unmount", () => {
      const device = fakeThrift();
      const { unmount } = setupWith(device.thrift);
      expect(device.listeners.size).toBe(1);
      unmount();
      expect(device.listeners.size).toBe(0);
    });
  });

  it("measures time with performance.now by default", async () => {
    inlineSnapshot(JSON.stringify(makeSnapshot({ version: 1 })));
    const spy = vi.spyOn(performance, "now");
    fetchMock.mockImplementation(async () => reply(304));
    const { result } = setup(fetchMock, {});
    expect(spy).toHaveBeenCalled();
    spy.mockReturnValue(spy.mock.results[0]!.value + 91_000);
    await advance(1_000);
    expect(result.current.status).toBe("stale");
    spy.mockRestore();
  });
});

describe("snapshotProblem and this season's passes", () => {
  it("takes a snapshot with or without current_markets, and names one that is not a list", () => {
    const full = makeSnapshot({ version: 2 });
    expect(snapshotProblem(full)).toBeNull(); // the free site's snapshot and an older server have none
    expect(snapshotProblem({ ...full, otd: { ...full.otd, current_markets: [] } })).toBeNull();
    expect(snapshotProblem({ ...full, otd: { ...full.otd, current_markets: {} } })).toBe("otd.current_markets");
  });
});
