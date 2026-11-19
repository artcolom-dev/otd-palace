import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDevice, renderApp } from "./test/app";
import { sceneSnapshot } from "./test/scene";

vi.mock("./lib/track", () => ({ trackOut: vi.fn() }));
const bug = vi.hoisted(() => ({ on: true }));
vi.mock("./views/Shell", async (importOriginal) => {
  const real = await importOriginal<typeof import("./views/Shell")>();
  return {
    ...real,
    Shell: (props: Parameters<typeof real.Shell>[0]) => {
      if (bug.on) throw new Error("a bug in the frame");
      return <real.Shell {...props} />;
    },
  };
});

describe("when the frame itself breaks", () => {
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

  it.each(["phone", "desktop"] as const)("shows the brand and the reload card instead of a blank page (%s)", (viewport) => {
    renderApp({ viewport });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong. Try again, or reload the page.");
    expect(alert).toHaveTextContent("Your level, budget and stars are saved on this device.");
    expect(within(alert).getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.getByRole("banner")).toHaveTextContent("OTD Palace");
    expect(screen.queryByRole("navigation", { name: "Sections" })).toBeNull();
  });

  it("draws the site again on Try again, once whatever broke it is mended", () => {
    renderApp();
    bug.on = false;
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Try again" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Sections" })).toBeInTheDocument();
  });

  it("brings the site back when a newer snapshot arrives", async () => {
    const { push } = renderApp();
    bug.on = false;
    await push(sceneSnapshot({ version: 2 }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Sections" })).toBeInTheDocument();
  });
});
