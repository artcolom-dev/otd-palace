// The phone's two gestures, driven by touch events as a phone sends them: the pull to refresh (Today, Deals) and a
// bottom sheet's drag. jsdom draws nothing, so a sheet is given its height and each touch its time.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const buzz = vi.hoisted(() => ({ calls: [] as string[], engine: "vibrate" as "vibrate" | "ios-switch" | "none" }));
vi.mock("../lib/haptics", () => ({
  haptic: (p: string) => {
    buzz.calls.push(p);
    return true;
  },
  haptics: { engine: () => buzz.engine },
}));

import { PULL_ARM } from "../lib/gestures";
import { OverlayProvider, useOverlay } from "./Overlay";
import { PullToRefresh } from "./PullToRefresh";

let clock = 0;
function touch(type: "touchstart" | "touchmove" | "touchend", target: EventTarget, points: { x: number; y: number }[], dt = 16) {
  clock += dt;
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "touches", { value: points.map((p) => ({ clientX: p.x, clientY: p.y })) });
  Object.defineProperty(e, "timeStamp", { value: clock });
  act(() => {
    target.dispatchEvent(e);
  });
}

/** A finger from (x, y0) to (x + dx, y1) in `steps` moves `dt` ms apart, lifted at the end unless `hold`. */
function swipe(target: EventTarget, { x = 200, y0, y1, dx = 0, steps = 10, dt = 16, hold = false }: { x?: number; y0: number; y1: number; dx?: number; steps?: number; dt?: number; hold?: boolean }) {
  touch("touchstart", target, [{ x, y: y0 }], 0);
  for (let i = 1; i <= steps; i++) touch("touchmove", target, [{ x: x + (dx * i) / steps, y: y0 + ((y1 - y0) * i) / steps }], dt);
  if (!hold) touch("touchend", target, [], dt);
}

beforeEach(() => {
  buzz.calls = [];
  buzz.engine = "vibrate";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pull to refresh", () => {
  const chip = () => screen.getByTestId("ptr");

  it("arms after a deliberate pull from the top of the page, ticks once, refreshes once and goes away", async () => {
    vi.useFakeTimers();
    let finish: (v: boolean) => void = () => undefined;
    const onRefresh = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    render(<PullToRefresh onRefresh={onRefresh} />);
    swipe(document.body, { y0: 300, y1: 300 + 2 * PULL_ARM + 40, hold: true });
    expect(chip().hasAttribute("data-armed")).toBe(true);
    expect(buzz.calls).toEqual(["select"]); // Android: as it arms
    touch("touchend", document.body, []);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(chip().dataset.state).toBe("busy");
    await act(async () => {
      finish(true);
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(chip().dataset.state).toBe("settle");
    expect(chip().hasAttribute("data-armed")).toBe(false);
    expect(buzz.calls).toEqual(["select"]); // one tick for one pull
  });

  it("on an iPhone ticks as it is let go, the only moment iOS allows", () => {
    buzz.engine = "ios-switch";
    const onRefresh = vi.fn(() => Promise.resolve(true));
    render(<PullToRefresh onRefresh={onRefresh} />);
    swipe(document.body, { y0: 300, y1: 300 + 2 * PULL_ARM + 40, hold: true });
    expect(buzz.calls).toEqual([]);
    touch("touchend", document.body, []);
    expect(buzz.calls).toEqual(["select"]);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a short pull, a sideways swipe, a page scrolled down, or with a sheet open", () => {
    const onRefresh = vi.fn(() => Promise.resolve(true));
    render(<PullToRefresh onRefresh={onRefresh} />);
    swipe(document.body, { y0: 300, y1: 300 + PULL_ARM }); // half the finger's way: not armed
    swipe(document.body, { y0: 300, y1: 340, dx: 160 }); // a sideways list
    swipe(document.body, { y0: 300, y1: 100 }); // a scroll down the page

    Object.defineProperty(window, "scrollY", { value: 400, configurable: true });
    swipe(document.body, { y0: 300, y1: 600 });
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });

    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    swipe(document.body, { y0: 300, y1: 600 });
    dialog.remove();

    expect(onRefresh).not.toHaveBeenCalled();
    expect(buzz.calls).toEqual([]);
  });

  it("never starts on the tab bar or the top bar", () => {
    const onRefresh = vi.fn(() => Promise.resolve(true));
    render(
      <>
        <header className="top" data-testid="top" />
        <nav className="tabbar" data-testid="tabbar" />
        <PullToRefresh onRefresh={onRefresh} />
      </>,
    );
    swipe(screen.getByTestId("top"), { y0: 20, y1: 400 });
    swipe(screen.getByTestId("tabbar"), { y0: 800, y1: 1100 });
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

describe("a bottom sheet's drag", () => {
  function Opener({ title = "Sort", tall = false }: { title?: string; tall?: boolean }) {
    const overlay = useOverlay();
    return (
      <button
        type="button"
        onClick={(e) =>
          overlay.open({
            title,
            anchor: e.currentTarget,
            layer: tall ? "panel" : undefined,
            body: () => (
              <div>
                <h2>Body</h2>
                <button type="button">Inside</button>
              </div>
            ),
          })
        }
      >
        Open
      </button>
    );
  }

  function openSheet(tall = false, height = 500) {
    render(
      <OverlayProvider phone>
        <Opener tall={tall} />
      </OverlayProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = document.querySelector("dialog.sheet") as HTMLDialogElement;
    dialog.getBoundingClientRect = () => ({ height, width: 390, top: 844 - height, bottom: 844, left: 0, right: 390, x: 0, y: 844 - height, toJSON: () => ({}) });
    return dialog;
  }

  it("springs back after a short, slow drag by its grip, with no tick", () => {
    const dialog = openSheet();
    swipe(dialog.querySelector(".grab")!, { y0: 360, y1: 400, steps: 8, dt: 40 });
    expect(document.querySelector("dialog.sheet")).not.toBeNull();
    expect(dialog.style.transform).toBe("");
    expect(dialog.hasAttribute("data-drag")).toBe(false);
    expect(buzz.calls).toEqual([]);
  });

  it("goes after a long drag, or a flick, and ticks as it goes", () => {
    let dialog = openSheet();
    swipe(dialog.querySelector(".grab")!, { y0: 360, y1: 700, steps: 10, dt: 40 });
    expect(document.querySelector("dialog.sheet")).toBeNull();
    expect(buzz.calls).toEqual(["tap"]);

    buzz.calls = [];
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    dialog = document.querySelector("dialog.sheet") as HTMLDialogElement;
    dialog.getBoundingClientRect = () => ({ height: 500, width: 390, top: 344, bottom: 844, left: 0, right: 390, x: 0, y: 344, toJSON: () => ({}) });
    swipe(dialog.querySelector(".shd")!, { y0: 360, y1: 440, steps: 4, dt: 12 }); // 80 px in 48 ms: a flick
    expect(document.querySelector("dialog.sheet")).toBeNull();
    expect(buzz.calls).toEqual(["tap"]);
  });

  it("leaves a sideways move and a drag that starts in its scrolled content alone", () => {
    const dialog = openSheet();
    swipe(dialog.querySelector(".grab")!, { y0: 360, y1: 380, dx: 120 });
    const scroller = dialog.querySelector(".sheet-in") as HTMLElement;
    scroller.scrollTop = 120;
    Object.defineProperty(scroller, "scrollTop", { value: 120, configurable: true });
    swipe(dialog.querySelector("h2")!, { y0: 500, y1: 800, steps: 10, dt: 40 });
    expect(document.querySelector("dialog.sheet")).not.toBeNull();
    expect(dialog.style.transform).toBe("");
  });

  it("is dragged from its content once that content is at its top", () => {
    const dialog = openSheet();
    swipe(dialog.querySelector("h2")!, { y0: 500, y1: 850, steps: 10, dt: 40 });
    expect(document.querySelector("dialog.sheet")).toBeNull();
  });

  it("a tall sheet rests at its middle stop, ticking, then goes from there", () => {
    Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
    const dialog = openSheet(true, 776);
    // 776 tall, the middle stop shows half of 844: it rests 354 px down.
    swipe(dialog.querySelector(".grab")!, { y0: 100, y1: 440, steps: 10, dt: 60 });
    expect(document.querySelector("dialog.sheet")).not.toBeNull();
    expect(dialog.hasAttribute("data-middle")).toBe(true);
    expect(dialog.style.transform).toMatch(/^translate3d\(0(px)?, 354px, 0(px)?\)$/);
    expect(buzz.calls).toEqual(["tap"]);
    // At the middle stop the content holds still: a drag anywhere moves the sheet.
    swipe(dialog.querySelector("h2")!, { y0: 500, y1: 800, steps: 10, dt: 40 });
    expect(document.querySelector("dialog.sheet")).toBeNull();
  });

  it("a drag does not leave a tap behind on the button it started on", () => {
    const dialog = openSheet();
    const close = dialog.querySelector<HTMLButtonElement>("[data-close]")!;
    swipe(close, { y0: 360, y1: 400, steps: 8, dt: 40 }); // starts on the close button in the title row
    fireEvent.click(close);
    expect(document.querySelector("dialog.sheet")).not.toBeNull(); // that click was the drag's
    fireEvent.pointerDown(close);
    fireEvent.click(close);
    expect(document.querySelector("dialog.sheet")).toBeNull(); // a real tap closes it
  });
});
