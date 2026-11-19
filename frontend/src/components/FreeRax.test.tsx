import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppContext, type AppState } from "../AppContext";
import type { Challenge, Snapshot } from "../data/types";
import { FreeRax, liveChallenges } from "./FreeRax";

const NOW = Date.parse("2026-11-12T18:00:00Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();

const renderWith = (challenges: Challenge[] | undefined, phone = false) =>
  render(
    <AppContext.Provider value={{ snap: { challenges } as Snapshot, now: NOW, layout: { phone } } as unknown as AppState}>
      <FreeRax />
    </AppContext.Provider>,
  );

describe("FreeRax", () => {
  it("shows nothing while no challenge runs", () => {
    const { container } = renderWith(undefined);
    expect(container).toBeEmptyDOMElement();
    expect(renderWith([{ title: "Old", reward: null, ends_at: at(-1000) }]).container).toBeEmptyDOMElement();
  });

  it("lists what Real pays for right now, with the reward and the time left", () => {
    renderWith([
      { title: "Watch every home run", reward: "250 Rax + MLB pack", ends_at: at(90 * 60_000) },
      { title: "Profile badge", reward: null, ends_at: null },
    ]);
    expect(screen.getByRole("heading", { name: "Free Rax right now" })).toBeInTheDocument();
    expect(screen.getByText("Watch every home run")).toBeInTheDocument();
    expect(screen.getByText("250 Rax + MLB pack")).toBeInTheDocument();
    expect(screen.getByText(/^ends in 1 h/)).toBeInTheDocument();
    expect(screen.getByText("Profile badge")).toBeInTheDocument();
  });

  it("gives two challenges of the same title and end their own rows, through every refresh", () => {
    // The snapshot leaves out the feed's own key: two of Real's challenges can read the same and end together.
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const twins = [
        { title: "Watch the plays", reward: "50 Rax", ends_at: at(60 * 60_000) },
        { title: "Watch the plays", reward: "NBA pack", ends_at: at(60 * 60_000) },
      ];
      const { rerender } = renderWith(twins);
      const next = [twins[1]!, { title: "Profile badge", reward: null, ends_at: null }];
      rerender(
        <AppContext.Provider value={{ snap: { challenges: next } as Snapshot, now: NOW, layout: { phone: false } } as unknown as AppState}>
          <FreeRax />
        </AppContext.Provider>,
      );
      expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
        expect.stringContaining("NBA pack"),
        expect.stringContaining("Profile badge"),
      ]);
      expect(errors.mock.calls.flat().join(" ")).not.toMatch(/same key/);
    } finally {
      errors.mockRestore();
    }
  });

  it("keeps the panel short: three at most, ended ones out", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ title: `C${i}`, reward: null, ends_at: at((i + 1) * 60_000) }));
    expect(liveChallenges(many, NOW).map((c) => c.title)).toEqual(["C0", "C1", "C2"]);
    expect(liveChallenges(many, NOW + 90_000).map((c) => c.title)).toEqual(["C1", "C2", "C3"]);
  });
});
