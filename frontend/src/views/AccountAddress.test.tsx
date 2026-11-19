import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDevice, renderApp } from "../test/app";
import { RULES } from "../test/fixtures";
import { sceneSnapshot } from "../test/scene";

const live = () =>
  sceneSnapshot({
    rules: {
      ...RULES,
      coverage: { sports: ["nba", "nfl", "nhl", "soccer"], listings_complete: true, sales_window_h: 168, otd_as_of: "2026-11-12T17:40:00Z" },
    },
  });

describe("an analysis link (#account/<name>)", () => {
  beforeEach(() => freshDevice());
  afterEach(() => vi.restoreAllMocks());

  it("opens that account's analysis when the page loads on it", async () => {
    const asked: string[] = [];
    const fetchImpl = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/passes/import")) {
        asked.push(url);
        return new Response(JSON.stringify({ status: "not_found" }), { status: 404 });
      }
      return fetchImpl(input, init);
    });
    renderApp({ snap: live(), hash: "account/Some.Collector" });
    await waitFor(() => expect(screen.getByRole("dialog", { name: /Some\.Collector/ })).toBeInTheDocument());
    expect(asked).toEqual(["/api/passes/import?u=Some.Collector"]);
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveTextContent("No Real account is named Some.Collector."));
  });

  it("does nothing on the sample data, which has no feed to look a name up through", () => {
    const spy = vi.spyOn(globalThis, "fetch");
    renderApp({ snap: sceneSnapshot(), hash: "account/Some.Collector" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(spy.mock.calls.some(([u]) => String(u).startsWith("/api/passes/import"))).toBe(false);
  });
});
