import { describe, expect, it } from "vitest";
import { DRAG_SLOP, FLICK_SPEED, PULL_ARM, PULL_MAX, lockAxis, pullTravel, rubberBand, settleSheet, velocityOf } from "./gestures";

describe("reading a touch's direction", () => {
  it("waits until the finger has really moved", () => {
    expect(lockAxis(0, 0)).toBeNull();
    expect(lockAxis(DRAG_SLOP - 1, -(DRAG_SLOP - 1))).toBeNull();
  });

  it("calls a clearly vertical move vertical", () => {
    expect(lockAxis(2, 20)).toBe("y");
    expect(lockAxis(-3, -12)).toBe("y");
  });

  it("leaves a sideways or diagonal swipe to the sideways list under it", () => {
    expect(lockAxis(20, 4)).toBe("x");
    expect(lockAxis(15, 15)).toBe("x"); // 45 degrees is not a pull
    expect(lockAxis(10, 11)).toBe("x");
  });
});

describe("the rubber band", () => {
  it("gives nothing for nothing, then less and less, never past its limit", () => {
    expect(rubberBand(0, 100)).toBe(0);
    expect(rubberBand(-20, 100)).toBe(0);
    const a = rubberBand(50, 100);
    const b = rubberBand(100, 100);
    const c = rubberBand(10_000, 100);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(50);
    expect(b - a).toBeLessThan(a); // the second 50 px give less than the first
    expect(c).toBeLessThan(100);
  });
});

describe("the speed of a let-go", () => {
  it("is 0 without two samples", () => {
    expect(velocityOf([])).toBe(0);
    expect(velocityOf([{ t: 0, y: 0 }])).toBe(0);
  });

  it("reads only the last moments, not a slow start", () => {
    const samples = [
      { t: 0, y: 0 },
      { t: 400, y: 10 }, // a slow start
      { t: 450, y: 40 },
      { t: 500, y: 90 }, // then a flick
    ];
    expect(velocityOf(samples)).toBeCloseTo(80 / 100, 5); // the last 100 ms: from t=400
    expect(velocityOf(samples, 60)).toBeCloseTo(50 / 50, 5); // the flick alone
    expect(velocityOf(samples, 1000)).toBeCloseTo(90 / 500, 5); // the whole move, slow start included
  });
});

describe("where a let-go sheet comes to rest", () => {
  const H = 600;

  it("springs back open after a short, slow drag", () => {
    expect(settleSheet(60, 0.05, [0], H)).toEqual({ to: 0, dismiss: false });
  });

  it("goes after a long drag, or a short one let go with a flick", () => {
    expect(settleSheet(400, 0, [0], H)).toEqual({ to: H, dismiss: true });
    expect(settleSheet(40, FLICK_SPEED + 0.1, [0], H)).toEqual({ to: H, dismiss: true });
  });

  it("stays when flicked back up, however far it was dragged", () => {
    expect(settleSheet(420, -(FLICK_SPEED + 0.1), [0], H)).toEqual({ to: 0, dismiss: false });
  });

  it("rests at the middle stop of a tall sheet, and moves one stop per flick", () => {
    const half = 300;
    expect(settleSheet(260, 0, [0, half], H)).toEqual({ to: half, dismiss: false });
    expect(settleSheet(20, FLICK_SPEED + 0.05, [0, half], H)).toEqual({ to: half, dismiss: false }); // open -> middle
    expect(settleSheet(half + 20, FLICK_SPEED + 0.05, [0, half], H)).toEqual({ to: H, dismiss: true }); // middle -> gone
    expect(settleSheet(half - 10, -(FLICK_SPEED + 0.05), [0, half], H)).toEqual({ to: 0, dismiss: false }); // middle -> open
  });

  it("comes back from above its top (a pull past open) to open", () => {
    expect(settleSheet(-30, 0, [0], H)).toEqual({ to: 0, dismiss: false });
  });

  it("ignores stops outside the sheet", () => {
    expect(settleSheet(10, 0, [-50, 0, 900], H)).toEqual({ to: 0, dismiss: false });
  });
});

describe("the pull to refresh", () => {
  it("does not move for a push up", () => {
    expect(pullTravel(-40)).toBe(0);
    expect(pullTravel(0)).toBe(0);
  });

  it("comes down half the finger's way, arms after a deliberate pull, and stops before its most", () => {
    expect(pullTravel(40)).toBe(20);
    expect(pullTravel(2 * PULL_ARM - 2)).toBeLessThan(PULL_ARM);
    expect(pullTravel(2 * PULL_ARM)).toBe(PULL_ARM);
    expect(pullTravel(2 * PULL_ARM + 100)).toBeGreaterThan(PULL_ARM);
    expect(pullTravel(5000)).toBeLessThan(PULL_MAX);
  });
});
