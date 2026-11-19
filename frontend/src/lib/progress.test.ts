import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgress } from "./progress";

const make = (extra: Parameters<typeof createProgress>[0] = {}) =>
  createProgress({ delayMs: 180, minShowMs: 400, doneMs: 250, longMs: 8000, trickleMs: 250, reducedMotion: () => false, ...extra });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the top bar's timing", () => {
  it("never shows for a wait shorter than the delay: a fast action does not flash", () => {
    const bar = make();
    const seen: string[] = [];
    bar.subscribe(() => seen.push(bar.get().phase));
    const done = bar.start();
    vi.advanceTimersByTime(150);
    done();
    vi.advanceTimersByTime(2000);
    expect(seen).not.toContain("running");
    expect(bar.get()).toMatchObject({ phase: "idle", value: 0 });
  });

  it("shows once the wait passes the delay, and trickles forward without ever reaching the end", () => {
    const bar = make();
    bar.start();
    vi.advanceTimersByTime(179);
    expect(bar.get().phase).toBe("idle");
    vi.advanceTimersByTime(1);
    const first = bar.get();
    expect(first.phase).toBe("running");
    expect(first.value).toBeGreaterThan(0);
    vi.advanceTimersByTime(1000);
    const later = bar.get().value;
    expect(later).toBeGreaterThan(first.value);
    vi.advanceTimersByTime(120_000);
    expect(bar.get().value).toBeLessThan(0.95);
    expect(bar.get().value).toBeGreaterThan(later);
  });

  it("stays at least its minimum time once shown, then completes to the end and fades away", () => {
    const bar = make();
    const done = bar.start();
    vi.advanceTimersByTime(200); // shown at 180
    done();
    expect(bar.get().phase).toBe("running"); // shown 20 ms: held until 400 ms of display
    vi.advanceTimersByTime(379);
    expect(bar.get().phase).toBe("running");
    vi.advanceTimersByTime(1);
    expect(bar.get()).toMatchObject({ phase: "done", value: 1 });
    vi.advanceTimersByTime(250);
    expect(bar.get()).toMatchObject({ phase: "idle", value: 0 });
  });

  it("completes at once when it has already been shown long enough", () => {
    const bar = make();
    const done = bar.start();
    vi.advanceTimersByTime(1500);
    done();
    expect(bar.get()).toMatchObject({ phase: "done", value: 1 });
  });

  it("counts waits that overlap: it ends only when the last one does", () => {
    const bar = make();
    const a = bar.start();
    vi.advanceTimersByTime(300);
    const b = bar.start();
    a();
    vi.advanceTimersByTime(1000);
    expect(bar.get().phase).toBe("running");
    b();
    expect(bar.get().phase).toBe("done");
  });

  it("a release called twice counts once", () => {
    const bar = make();
    const a = bar.start();
    const b = bar.start();
    vi.advanceTimersByTime(1000);
    a();
    a();
    expect(bar.get().phase).toBe("running");
    b();
    expect(bar.get().phase).toBe("done");
  });

  it("a wait that starts while the bar fades picks it up again where it is, with no new delay", () => {
    const bar = make();
    const a = bar.start();
    vi.advanceTimersByTime(1000);
    a();
    expect(bar.get().phase).toBe("done");
    const b = bar.start();
    expect(bar.get().phase).toBe("running");
    vi.advanceTimersByTime(1000);
    expect(bar.get().phase).toBe("running");
    b();
    vi.advanceTimersByTime(250);
    expect(bar.get().phase).toBe("idle");
  });

  it("a wait that starts during the minimum display keeps the bar running", () => {
    const bar = make();
    const a = bar.start();
    vi.advanceTimersByTime(200);
    a();
    const b = bar.start();
    vi.advanceTimersByTime(1000);
    expect(bar.get().phase).toBe("running");
    b();
    expect(bar.get().phase).toBe("done");
  });

  it("says a wait is long after 8 s, counted from its start, and forgets it once done", () => {
    const bar = make();
    const a = bar.start();
    vi.advanceTimersByTime(7999);
    expect(bar.get().long).toBe(false);
    vi.advanceTimersByTime(1);
    expect(bar.get().long).toBe(true);
    a();
    expect(bar.get().long).toBe(false);
  });

  it("does not trickle under reduced motion: the bar stands still until it completes", () => {
    const bar = make({ reducedMotion: () => true });
    const a = bar.start();
    vi.advanceTimersByTime(200);
    const shown = bar.get().value;
    vi.advanceTimersByTime(5000);
    expect(bar.get().value).toBe(shown);
    a();
    expect(bar.get()).toMatchObject({ phase: "done", value: 1 });
  });

  it("finish() shows a page that just arrived as completed, unless a wait is under way", () => {
    const bar = make();
    bar.finish();
    expect(bar.get()).toMatchObject({ phase: "done", value: 1 });
    vi.advanceTimersByTime(250);
    expect(bar.get().phase).toBe("idle");
    const a = bar.start();
    vi.advanceTimersByTime(500);
    bar.finish();
    expect(bar.get().phase).toBe("running");
    a();
  });

  it("tells its listeners of every change, and stops when asked", () => {
    const bar = make();
    const heard = vi.fn();
    const stop = bar.subscribe(heard);
    bar.start();
    vi.advanceTimersByTime(180);
    expect(heard).toHaveBeenCalled();
    stop();
    heard.mockClear();
    vi.advanceTimersByTime(1000);
    expect(heard).not.toHaveBeenCalled();
  });

  it("returns the same view object between changes (useSyncExternalStore needs a stable snapshot)", () => {
    const bar = make();
    expect(bar.get()).toBe(bar.get());
    bar.start();
    vi.advanceTimersByTime(180);
    expect(bar.get()).toBe(bar.get());
  });

  it("reset() drops every wait and timer", () => {
    const bar = make();
    bar.start();
    vi.advanceTimersByTime(500);
    bar.reset();
    expect(bar.get()).toMatchObject({ phase: "idle", value: 0, long: false });
    vi.advanceTimersByTime(10_000);
    expect(bar.get().phase).toBe("idle");
  });
});
