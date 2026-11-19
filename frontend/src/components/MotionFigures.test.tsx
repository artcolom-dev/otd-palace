import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chg } from "./Chg";
import { CountUp } from "./CountUp";
import { Said } from "./Said";

const canAnimate = () => {
  Element.prototype.animate = vi.fn() as unknown as Element["animate"];
};

describe("CountUp", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    // biome-ignore lint/performance/noDelete: restore jsdom's lack of the Web Animations API
    delete (Element.prototype as { animate?: unknown }).animate;
  });

  it("is just the value where nothing can animate", () => {
    const { container } = render(<CountUp value={3901} />);
    expect(container.textContent).toBe("3,901");
  });

  it("counts from 0 over 500 ms the first time, and ends on the value", () => {
    canAnimate();
    const { container } = render(<CountUp value={3901} />);
    expect(container.textContent).toBe("0");
    act(() => void vi.advanceTimersByTime(250));
    const mid = Number(container.textContent!.replace(/,/g, ""));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(3901);
    act(() => void vi.advanceTimersByTime(400));
    expect(container.textContent).toBe("3,901");
  });

  it("does nothing when a refresh brings the same value, and glides from the old one when it changes", () => {
    canAnimate();
    const { container, rerender } = render(<CountUp value={1000} />);
    act(() => void vi.advanceTimersByTime(600));
    rerender(<CountUp value={1000} />);
    expect(container.textContent).toBe("1,000");
    rerender(<CountUp value={2000} />);
    expect(container.textContent).toBe("1,000");
    act(() => void vi.advanceTimersByTime(500));
    expect(container.textContent).toBe("2,000");
  });

  it("keeps the final text in data-final so the width never moves", () => {
    const { container } = render(<CountUp value={12345} />);
    expect(container.querySelector(".cu")).toHaveAttribute("data-final", "12,345");
  });
});

describe("Chg", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("washes only when the value changes, then settles", () => {
    const { rerender } = render(<Chg value={95} />);
    expect(screen.getByText("95")).not.toHaveClass("chg");
    rerender(<Chg value={95} />);
    expect(screen.getByText("95")).not.toHaveClass("chg");
    rerender(<Chg value={90} />);
    expect(screen.getByText("90")).toHaveClass("chg");
    act(() => void vi.advanceTimersByTime(1300));
    expect(screen.getByText("90")).not.toHaveClass("chg");
  });
});

describe("Said", () => {
  it("is an empty live region until there is a message, and draws a check for good news only", () => {
    const { rerender, container } = render(<Said text="" />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    rerender(<Said text="Copied. Paste it on your other device." />);
    expect(container.querySelector(".tick")).not.toBeNull();
    rerender(<Said text="Not unlinked: Discord's side did not answer." />);
    expect(container.querySelector(".tick")).toBeNull();
  });
});
