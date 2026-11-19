// A split view whose code fails to load (offline, or a deploy replaced the hashed files): the tab says so and offers
// Try again, which loads the code anew without reloading the page.
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDevice, renderApp } from "./test/app";

vi.mock("./lib/track", () => ({ trackOut: vi.fn() }));
const chunk = vi.hoisted(() => ({ fail: true, loads: 0 }));
vi.mock("./views/lazy", async (importOriginal) => {
  const real = await importOriginal<typeof import("./views/lazy")>();
  const { lazyView } = await import("./lib/lazyView");
  const prices = lazyView(async () => {
    chunk.loads += 1;
    if (chunk.fail) throw new TypeError("Failed to fetch dynamically imported module");
    return (await import("./views/PricesView")).PricesView;
  });
  return {
    ...real,
    PricesView: prices.View,
    preloadViews: () => Promise.resolve(),
    resetFailedViews: () => {
      real.resetFailedViews();
      prices.reset();
    },
  };
});

describe("a tab whose code cannot be loaded", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
    vi.spyOn(console, "error").mockImplementation(() => undefined); // React reports the error it caught
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("offers Try again, which loads it anew in place", async () => {
    const { advance } = renderApp({ viewport: "desktop", hash: "prices" });
    await advance(0);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong.");
    expect(within(alert).getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(chunk.loads).toBe(1);

    chunk.fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await advance(0);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("heading", { name: "Prices moving today", level: 1 })).toBeInTheDocument();
    expect(chunk.loads).toBe(2);
  });
});
