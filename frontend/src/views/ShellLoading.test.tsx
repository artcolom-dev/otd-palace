// The page-level waits hold the site's one top bar: a tab's code on its way, the first market. A failed first load
// says so in words and stops the bar.
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { progress } from "../lib/progress";
import { LoadingShell, ViewLoading } from "./Shell";

beforeEach(() => {
  vi.useFakeTimers();
  progress.reset();
});
afterEach(() => {
  progress.reset();
  vi.useRealTimers();
});

describe("the page's waits and the top bar", () => {
  it("a tab's skeleton runs the bar (after its delay) and lets go when the page arrives", () => {
    const { unmount } = render(<ViewLoading tab="passes" />);
    expect(progress.get().phase).toBe("idle");
    act(() => void vi.advanceTimersByTime(1000));
    expect(progress.get().phase).toBe("running");
    unmount();
    expect(progress.get().phase).toBe("done");
  });

  it("the first market's skeleton runs it, a failed load stops it", () => {
    const { rerender } = render(<LoadingShell />);
    act(() => void vi.advanceTimersByTime(1000));
    expect(progress.get().phase).toBe("running");
    rerender(<LoadingShell failed onRetry={() => undefined} />);
    expect(progress.get().phase).toBe("done");
  });
});
