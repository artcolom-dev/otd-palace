import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Meter, Pips } from "./Meter";

const fillOf = (el: HTMLElement) => el.style.getPropertyValue("--fill");

describe("Meter", () => {
  it("says its value to a screen reader, as a whole percent", () => {
    render(<Meter value={0.394} label="Toward your first pass" />);
    const bar = screen.getByRole("progressbar", { name: "Toward your first pass" });
    expect(bar).toHaveAttribute("aria-valuenow", "39");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
  });

  it("draws the value through a custom property, never a style attribute", () => {
    render(<Meter value={0.5} label="Half" />);
    const bar = screen.getByRole("progressbar");
    expect(fillOf(bar)).toBe("0.5000");
    expect(bar.getAttribute("style")).not.toMatch(/width/);
  });

  it("holds a value to 0..1, and a value that is not a number to 0", () => {
    const { rerender } = render(<Meter value={2.4} label="m" />);
    expect(fillOf(screen.getByRole("progressbar"))).toBe("1.0000");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    rerender(<Meter value={-1} label="m" />);
    expect(fillOf(screen.getByRole("progressbar"))).toBe("0.0000");
    rerender(<Meter value={Number.NaN} label="m" />);
    expect(fillOf(screen.getByRole("progressbar"))).toBe("0.0000");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });

  it("never draws a real but tiny share thinner than a sliver, and draws a share of 0 as nothing", () => {
    const { rerender } = render(<Meter value={0.004} label="m" />);
    expect(fillOf(screen.getByRole("progressbar"))).toBe("0.0300");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0"); // the number stays true
    rerender(<Meter value={0} label="m" />);
    expect(fillOf(screen.getByRole("progressbar"))).toBe("0.0000");
  });

  it("is hidden from a screen reader when it has no label (a line beside it says the same)", () => {
    const { container } = render(<Meter value={0.3} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(container.querySelector(".meter")).toHaveAttribute("aria-hidden", "true");
  });

  it("carries its tone and size for the style sheet", () => {
    const { container } = render(<Meter value={0.3} label="m" tone="quiet" size="s" className="extra" />);
    const bar = container.querySelector(".meter")!;
    expect(bar).toHaveAttribute("data-tone", "quiet");
    expect(bar).toHaveAttribute("data-size", "s");
    expect(bar).toHaveClass("extra");
  });
});

describe("Pips", () => {
  it("lights one pill for each thing done, under one label", () => {
    const { container } = render(<Pips done={2} total={5} label="2 of 5 done today" />);
    expect(screen.getByRole("img", { name: "2 of 5 done today" })).toBeInTheDocument();
    const pills = [...container.querySelectorAll("i")];
    expect(pills).toHaveLength(5);
    expect(pills.map((p) => p.classList.contains("lit"))).toEqual([true, true, false, false, false]);
  });

  it("holds the count to 0..total", () => {
    const { container, rerender } = render(<Pips done={9} total={5} label="x" />);
    expect(container.querySelectorAll("i.lit")).toHaveLength(5);
    rerender(<Pips done={-3} total={5} label="x" />);
    expect(container.querySelectorAll("i.lit")).toHaveLength(0);
    rerender(<Pips done={Number.NaN} total={5} label="x" />);
    expect(container.querySelectorAll("i.lit")).toHaveLength(0);
  });
});
