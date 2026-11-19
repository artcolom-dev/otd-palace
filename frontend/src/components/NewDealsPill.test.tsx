import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewDealsPill } from "./NewDealsPill";

describe("NewDealsPill", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is hidden with nothing queued", () => {
    render(<NewDealsPill count={0} onMerge={() => undefined} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says how many arrived and merges on a tap", () => {
    const onMerge = vi.fn();
    render(<NewDealsPill count={3} onMerge={onMerge} />);
    const pill = screen.getByRole("button", { name: /3 new deals/ });
    expect(pill.closest("[aria-live]")).toBeNull(); // the pill itself is not read out on every change
    fireEvent.click(pill);
    expect(onMerge).toHaveBeenCalledOnce();
  });

  describe("what a screen reader hears", () => {
    const said = () => screen.getByTestId("new-deals-said");
    const at = (count: number, rerender: (ui: ReactElement) => void) =>
      rerender(<NewDealsPill count={count} onMerge={() => undefined} />);
    const wait = (ms: number) =>
      act(() => {
        vi.advanceTimersByTime(ms);
      });

    it("is a polite live region that starts silent", () => {
      render(<NewDealsPill count={0} onMerge={() => undefined} />);
      expect(said()).toHaveAttribute("aria-live", "polite");
      expect(said()).toHaveTextContent("");
    });

    it("hears the first arrivals at once, then at most once a minute, with the count as it stands then", () => {
      const { rerender } = render(<NewDealsPill count={0} onMerge={() => undefined} />);
      at(2, rerender);
      expect(said()).toHaveTextContent("2 new deals");
      wait(5_000);
      at(3, rerender);
      wait(5_000);
      at(5, rerender);
      expect(said()).toHaveTextContent("2 new deals"); // not 3, not 5: under a minute since the last time
      wait(49_999);
      expect(said()).toHaveTextContent("2 new deals");
      wait(1);
      expect(said()).toHaveTextContent("5 new deals");
      at(6, rerender);
      wait(30_000);
      expect(said()).toHaveTextContent("5 new deals");
    });

    it("goes quiet when the pill goes, and hears the next arrivals at once", () => {
      const { rerender } = render(<NewDealsPill count={0} onMerge={() => undefined} />);
      at(4, rerender);
      at(0, rerender);
      expect(said()).toHaveTextContent("");
      at(1, rerender);
      expect(said()).toHaveTextContent("1 new deal");
    });
  });

  it("throttles the count it shows to one change every 2 seconds", () => {
    const { rerender } = render(<NewDealsPill count={1} onMerge={() => undefined} />);
    rerender(<NewDealsPill count={2} onMerge={() => undefined} />);
    rerender(<NewDealsPill count={4} onMerge={() => undefined} />);
    expect(screen.getByRole("button")).toHaveTextContent("1 new deal");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole("button")).toHaveTextContent("4 new deals");
  });
});
