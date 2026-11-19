import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REAL_PRO_KEY, readRealPro, realProNow, saveRealPro, subscribeRealPro } from "./realPro";

describe("I have Real Pro: the visitor's own answer, on this device only", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => saveRealPro(false));

  it("is off until ticked, and remembers a tick", () => {
    expect(readRealPro()).toBe(false);
    saveRealPro(true);
    expect(localStorage.getItem(REAL_PRO_KEY)).toBe("1");
    expect(readRealPro()).toBe(true);
    expect(realProNow()).toBe(true);
  });

  it("forgets on an untick, and reads anything it did not write as off", () => {
    saveRealPro(true);
    saveRealPro(false);
    expect(localStorage.getItem(REAL_PRO_KEY)).toBeNull();
    localStorage.setItem(REAL_PRO_KEY, "yes");
    expect(readRealPro()).toBe(false);
  });

  it("tells the screens that read it, and stops when they leave", () => {
    const heard = vi.fn();
    const stop = subscribeRealPro(heard);
    saveRealPro(true);
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    saveRealPro(false);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("a browser that refuses its storage still follows the answer for the visit", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    saveRealPro(true);
    expect(realProNow()).toBe(true);
    spy.mockRestore();
  });
});
