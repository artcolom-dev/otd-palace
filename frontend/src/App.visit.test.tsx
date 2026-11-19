// The anonymous visit count (lib/visit.ts) as the site uses it: the tab a visit opens on, then each tab moved to.
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDevice, renderApp } from "./test/app";
import { noteTab } from "./lib/visit";

vi.mock("./lib/track", () => ({ trackOut: vi.fn() }));
vi.mock("./lib/visit", () => ({ noteTab: vi.fn() }));

describe("the visit count", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
    vi.mocked(noteTab).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("notes the tab the visit opens on, then the tab moved to", () => {
    renderApp({ hash: "deals" });
    expect(noteTab).toHaveBeenLastCalledWith("deals");
    act(() => {
      location.hash = "#plan";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(noteTab).toHaveBeenLastCalledWith("plan");
  });
});
