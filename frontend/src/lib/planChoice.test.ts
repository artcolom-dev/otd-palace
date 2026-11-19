import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLAN_CHOICE_KEY, readPlanChoice, savePlanChoice } from "./planChoice";

describe("where the visitor says they are with Real, kept on this device", () => {
  beforeEach(() => localStorage.clear());

  it("remembers 'start' and 'new', and forgets with null", () => {
    expect(readPlanChoice()).toBeNull();
    savePlanChoice("start");
    expect(readPlanChoice()).toBe("start");
    savePlanChoice("new");
    expect(readPlanChoice()).toBe("new");
    savePlanChoice(null);
    expect(readPlanChoice()).toBeNull();
    expect(localStorage.getItem(PLAN_CHOICE_KEY)).toBeNull();
  });

  it("reads nothing from a value it does not know", () => {
    localStorage.setItem(PLAN_CHOICE_KEY, "giant");
    expect(readPlanChoice()).toBeNull();
    localStorage.setItem(PLAN_CHOICE_KEY, JSON.stringify({ a: 1 }));
    expect(readPlanChoice()).toBeNull();
  });

  it("never throws when the browser refuses its storage (private window, blocked data)", () => {
    const boom = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const put = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readPlanChoice()).toBeNull();
    expect(() => savePlanChoice("start")).not.toThrow();
    boom.mockRestore();
    put.mockRestore();
  });
});
