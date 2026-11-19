import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WaitBar } from "./WaitBar";

describe("WaitBar", () => {
  it("without a measure it only moves: no progress bar role, no percentage, hidden from screen readers", () => {
    const { container } = render(<WaitBar />);
    const bar = container.querySelector(".wbar")!;
    expect(bar).toHaveAttribute("data-kind", "busy");
    expect(bar).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("with a real measure it is a progress bar that says how far, in the page's own words", () => {
    render(<WaitBar value={12} max={57} label="Passes counted" valueText="12 of 57 passes counted" />);
    const bar = screen.getByRole("progressbar", { name: "Passes counted" });
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "57");
    expect(bar).toHaveAttribute("aria-valuenow", "12");
    expect(bar).toHaveAttribute("aria-valuetext", "12 of 57 passes counted");
    expect((bar.firstElementChild as HTMLElement).style.transform).toBe("scaleX(0.211)");
  });

  it("keeps its measure inside 0 and the end", () => {
    render(<WaitBar value={80} max={57} label="Passes counted" valueText="all counted" />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "57");
    expect((bar.firstElementChild as HTMLElement).style.transform).toMatch(/^scaleX\(1(\.000)?\)$/);
  });
});
