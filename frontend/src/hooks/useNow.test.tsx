import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNow } from "./useNow";

function Clock({ id }: { id: string }) {
  const now = useNow();
  return <p data-testid={id}>{Math.floor(now / 1000)}</p>;
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useNow: one shared one-second clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-11-12T18:00:00Z"));
  });
  afterEach(() => {
    setVisibility("visible");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("ticks every second, on one interval however many read it", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    render(
      <>
        <Clock id="a" />
        <Clock id="b" />
      </>,
    );
    const start = Number(screen.getByTestId("a").textContent);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(Number(screen.getByTestId("a").textContent)).toBe(start + 3);
    expect(screen.getByTestId("b").textContent).toBe(screen.getByTestId("a").textContent);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("stops while the tab is hidden and catches up when it comes back", () => {
    render(<Clock id="a" />);
    const start = Number(screen.getByTestId("a").textContent);
    act(() => setVisibility("hidden"));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(Number(screen.getByTestId("a").textContent)).toBe(start);
    expect(vi.getTimerCount()).toBe(0);
    act(() => setVisibility("visible"));
    expect(Number(screen.getByTestId("a").textContent)).toBe(start + 5);
  });
});
