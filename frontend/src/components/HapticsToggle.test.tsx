import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const device = vi.hoisted(() => ({ vibrate: vi.fn((_p: number | number[]) => true), can: true, reduced: false }));
vi.mock("../lib/haptics", async (original) => {
  const real = await original<typeof import("../lib/haptics")>();
  const store = new Map<string, string>();
  const h = real.createHaptics({
    nav: { vibrate: device.vibrate, userAgent: "Mozilla/5.0 (Linux; Android 14) Mobile", maxTouchPoints: 5 },
    doc: null,
    now: () => performance.now() + 1e6 * Math.random(), // never inside the gap in this test
    reducedMotion: () => device.reduced,
    visible: () => true,
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) },
  });
  const haptics = { ...h, available: () => device.can && h.available() };
  return { ...real, haptics, haptic: (p: Parameters<typeof h.fire>[0]) => h.fire(p) };
});

import { haptics } from "../lib/haptics";
import { HapticsToggle } from "./AlertsSheet";

describe("the Vibration switch", () => {
  it("is the site's one switch, on by default, and turning it off keeps this phone still", () => {
    render(<HapticsToggle />);
    const sw = screen.getByRole("switch", { name: "Vibration" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(sw.querySelector(".knob")).not.toBeNull();
    fireEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(haptics.enabled()).toBe(false);
    expect(haptics.fire("tap")).toBe(false);
    expect(device.vibrate).not.toHaveBeenCalled();
    fireEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(haptics.fire("tap")).toBe(true);
    expect(device.vibrate).toHaveBeenCalledTimes(1);
  });

  it("says it is off, and cannot be turned on, while the phone asks for less motion", () => {
    device.reduced = true;
    render(<HapticsToggle />);
    const sw = screen.getByRole("switch", { name: "Vibration" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw).toBeDisabled();
    expect(sw).toHaveAccessibleDescription(/less motion/);
    device.reduced = false;
  });

  it("is not drawn on a device that cannot buzz", () => {
    device.can = false;
    render(<HapticsToggle />);
    expect(screen.queryByRole("switch", { name: "Vibration" })).toBeNull();
    device.can = true;
  });
});
