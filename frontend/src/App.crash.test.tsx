import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDevice, renderApp } from "./test/app";
import { sceneSnapshot } from "./test/scene";

vi.mock("./lib/track", () => ({ trackOut: vi.fn() }));
const bug = vi.hoisted(() => ({ on: true }));
vi.mock("./views/TodayView", () => ({
  TodayView: () => {
    if (bug.on) throw new Error("a bug in Today");
    return <h1>Today, mended</h1>;
  },
}));

describe("a page that breaks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
    bug.on = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined); // React reports the error it caught
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("says so inside the shell with a reload, instead of a blank page, and the other tabs still work", () => {
    renderApp({ viewport: "desktop" });
    const nav = screen.getByRole("navigation", { name: "Sections" });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong. Try again, or reload the page.");
    expect(within(alert).getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    fireEvent.click(within(nav).getByRole("link", { name: /Deals/ }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "All deals", level: 1 })).toBeInTheDocument();
  });

  it("keeps the phone shell too", () => {
    renderApp();
    expect(screen.getByRole("navigation", { name: "Sections" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
  });

  it("tries the page again when a newer snapshot arrives, and not before", async () => {
    const { push, advance } = renderApp();
    bug.on = false;
    await advance(10_000); // polls answer "not modified": the same data, so the same broken page
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await push(sceneSnapshot({ version: 2 }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Today, mended" })).toBeInTheDocument();
  });
});
