import { describe, expect, it, vi } from "vitest";
import { MIN_GAP_MS, PATTERNS, STORAGE_KEY, createHaptics, detectEngine, isIosLike } from "./haptics";

const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";

function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    m,
  };
}

/** An Android phone with a clock the test moves. */
function android(opts: { reduced?: boolean; visible?: boolean; vibrateOk?: boolean } = {}) {
  let t = 1000;
  const vibrate = vi.fn((_p: number | number[]) => opts.vibrateOk ?? true);
  const storage = memoryStore();
  const h = createHaptics({
    nav: { vibrate, userAgent: ANDROID, maxTouchPoints: 5 },
    doc: null,
    hasSwitch: () => false,
    now: () => t,
    reducedMotion: () => opts.reduced ?? false,
    visible: () => opts.visible ?? true,
    storage,
  });
  return { h, vibrate, storage, advance: (ms: number) => (t += ms) };
}

describe("which way a device buzzes", () => {
  it("vibrates on a touch device with the Vibration API", () => {
    expect(detectEngine({ vibrate: () => true, userAgent: ANDROID, maxTouchPoints: 5 }, false)).toBe("vibrate");
  });

  it("does nothing on a desktop, even one whose browser has vibrate()", () => {
    expect(detectEngine({ vibrate: () => true, userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/131.0", maxTouchPoints: 0 }, false)).toBe("none");
    expect(detectEngine({ userAgent: MAC, maxTouchPoints: 0 }, true)).toBe("none");
    expect(detectEngine(null, true)).toBe("none");
  });

  it("uses the switch on an iPhone or an iPad that knows it, and nothing on an older one", () => {
    expect(detectEngine({ userAgent: IPHONE, maxTouchPoints: 5 }, true)).toBe("ios-switch");
    expect(detectEngine({ userAgent: MAC, maxTouchPoints: 5 }, true)).toBe("ios-switch"); // an iPad asking for desktop sites
    expect(detectEngine({ userAgent: IPHONE, maxTouchPoints: 5 }, false)).toBe("none");
    // A WebView that adds a vibrate() on iOS still takes the switch: the system's tick is the real one.
    expect(detectEngine({ vibrate: () => true, userAgent: IPHONE, maxTouchPoints: 5 }, true)).toBe("ios-switch");
  });

  it("tells an iPad dressed as a Mac by its touch points", () => {
    expect(isIosLike(MAC, 5)).toBe(true);
    expect(isIosLike(MAC, 0)).toBe(false);
    expect(isIosLike(ANDROID, 5)).toBe(false);
  });
});

describe("firing on Android", () => {
  it("sends each named pattern to vibrate()", () => {
    const { h, vibrate, advance } = android();
    for (const name of ["tap", "select", "success", "warning"] as const) {
      expect(h.fire(name)).toBe(true);
      advance(MIN_GAP_MS);
    }
    expect(vibrate.mock.calls.map((c) => c[0])).toEqual([PATTERNS.tap, PATTERNS.select, [...PATTERNS.success as number[]], [...PATTERNS.warning as number[]]]);
  });

  it("keeps every pattern short and light", () => {
    for (const p of Object.values(PATTERNS)) {
      const parts = typeof p === "number" ? [p] : p;
      expect(parts.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(150);
      parts.forEach((ms, i) => i % 2 === 0 && expect(ms).toBeLessThanOrEqual(30)); // each buzz itself is a tick
    }
  });

  it("never rattles: a second buzz inside the gap is dropped, the next one after it goes", () => {
    const { h, vibrate, advance } = android();
    expect(h.fire("tap")).toBe(true);
    advance(MIN_GAP_MS - 1);
    expect(h.fire("select")).toBe(false);
    advance(1);
    expect(h.fire("select")).toBe(true);
    expect(vibrate).toHaveBeenCalledTimes(2);
  });

  it("a refused vibrate() does not count against the gap", () => {
    const { h, vibrate } = android({ vibrateOk: false });
    expect(h.fire("tap")).toBe(false);
    expect(h.fire("tap")).toBe(false);
    expect(vibrate).toHaveBeenCalledTimes(2);
  });

  it("stays still for a visitor who asks for less motion, and on a hidden page", () => {
    for (const opts of [{ reduced: true }, { visible: false }]) {
      const { h, vibrate } = android(opts);
      expect(h.fire("tap")).toBe(false);
      expect(vibrate).not.toHaveBeenCalled();
    }
    expect(android({ reduced: true }).h.stilled()).toBe(true);
    expect(android().h.stilled()).toBe(false);
  });
});

describe("the visitor's switch", () => {
  it("is on by default, off once turned off, and kept on this device", () => {
    const { h, vibrate, storage } = android();
    expect(h.enabled()).toBe(true);
    h.setEnabled(false);
    expect(storage.m.get(STORAGE_KEY)).toBe("off");
    expect(h.fire("tap")).toBe(false);
    expect(vibrate).not.toHaveBeenCalled();
    h.setEnabled(true);
    expect(storage.m.has(STORAGE_KEY)).toBe(false);
    expect(h.fire("tap")).toBe(true);
  });

  it("reads a choice made on an earlier visit", () => {
    const storage = memoryStore();
    storage.setItem(STORAGE_KEY, "off");
    const h = createHaptics({ nav: { vibrate: () => true, userAgent: ANDROID, maxTouchPoints: 5 }, storage, now: () => 0, reducedMotion: () => false, visible: () => true });
    expect(h.enabled()).toBe(false);
  });

  it("lasts the visit where storage is blocked", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const h = createHaptics({ nav: { vibrate: () => true, userAgent: ANDROID, maxTouchPoints: 5 }, storage: blocked, now: () => 0, reducedMotion: () => false, visible: () => true });
    expect(h.enabled()).toBe(true);
    h.setEnabled(false);
    expect(h.enabled()).toBe(false);
  });

  it("tells its listeners", () => {
    const { h } = android();
    const listener = vi.fn();
    const stop = h.subscribe(listener);
    h.setEnabled(false);
    stop();
    h.setEnabled(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("is offered only where the device can buzz", () => {
    expect(android().h.available()).toBe(true);
    const desktop = createHaptics({ nav: { vibrate: () => true, userAgent: MAC, maxTouchPoints: 0 }, storage: null, hasSwitch: () => false });
    expect(desktop.available()).toBe(false);
    expect(desktop.fire("tap")).toBe(false);
  });
});

describe("firing on an iPhone", () => {
  function iphone() {
    let t = 0;
    const h = createHaptics({
      nav: { userAgent: IPHONE, maxTouchPoints: 5 },
      doc: document,
      hasSwitch: () => true,
      now: () => t,
      reducedMotion: () => false,
      visible: () => true,
      storage: memoryStore(),
    });
    return { h, advance: (ms: number) => (t += ms) };
  }

  it("clicks one hidden switch's label: one system tick, nothing seen, nothing read aloud", () => {
    const { h } = iphone();
    const clicks = vi.fn();
    document.addEventListener("click", clicks);
    expect(h.fire("success")).toBe(true);
    document.removeEventListener("click", clicks);
    const labels = document.querySelectorAll("label.haptic");
    expect(labels).toHaveLength(1);
    const label = labels[0] as HTMLLabelElement;
    expect(label.hidden).toBe(true);
    expect(label.getAttribute("aria-hidden")).toBe("true");
    const input = label.querySelector("input")!;
    expect(input.type).toBe("checkbox");
    expect(input.hasAttribute("switch")).toBe(true);
    expect(input.tabIndex).toBe(-1);
    expect(clicks).toHaveBeenCalled();
    label.remove();
  });

  it("reuses the same switch, and moves it into an open modal sheet (the page under it is inert)", () => {
    const { h, advance } = iphone();
    h.fire("tap");
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    advance(MIN_GAP_MS);
    h.fire("tap");
    expect(document.querySelectorAll("label.haptic")).toHaveLength(1);
    expect(dialog.querySelector("label.haptic")).not.toBeNull();
    dialog.remove();
  });
});
