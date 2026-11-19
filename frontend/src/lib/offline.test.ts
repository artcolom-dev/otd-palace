import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEEP_AFTER_MS, keepForOffline } from "./offline";

function env(readyState: DocumentReadyState, serviceWorker: unknown = { register: vi.fn(async () => ({})) }) {
  const listeners: [string, () => void][] = [];
  return {
    env: {
      nav: { serviceWorker } as unknown as Pick<Navigator, "serviceWorker">,
      win: { addEventListener: (type: string, fn: () => void) => listeners.push([type, fn]) } as unknown as Window,
      doc: { readyState } as Document,
    },
    register: (serviceWorker as { register?: ReturnType<typeof vi.fn> } | undefined)?.register,
    load: () => listeners.filter(([type]) => type === "load").forEach(([, fn]) => fn()),
  };
}

describe("keepForOffline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("registers the worker for the whole site a few seconds after the page has loaded", () => {
    const page = env("interactive");
    keepForOffline(page.env);
    vi.advanceTimersByTime(KEEP_AFTER_MS * 2);
    expect(page.register).not.toHaveBeenCalled(); // not before load
    page.load();
    vi.advanceTimersByTime(KEEP_AFTER_MS - 1);
    expect(page.register).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(page.register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  });

  it("counts from now on a page already loaded", () => {
    const page = env("complete");
    keepForOffline(page.env);
    vi.advanceTimersByTime(KEEP_AFTER_MS);
    expect(page.register).toHaveBeenCalledTimes(1);
  });

  it("does nothing where there are no workers, and stays quiet when the browser refuses one", async () => {
    const none = env("complete", undefined);
    expect(() => keepForOffline(none.env)).not.toThrow();
    vi.advanceTimersByTime(KEEP_AFTER_MS);
    const refused = env("complete", { register: vi.fn(async () => Promise.reject(new DOMException("no", "SecurityError"))) });
    keepForOffline(refused.env);
    vi.advanceTimersByTime(KEEP_AFTER_MS);
    await Promise.resolve();
    expect(refused.register).toHaveBeenCalledTimes(1);
  });
});
