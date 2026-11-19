// The paused contract, on a stand-in hero: whatever layout the best-deal block takes, it reads the status through
// usePaused, carries data-stale on its root while paused, shows PausedNotice and keeps its actions usable.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppContext, type AppState } from "../AppContext";
import type { SnapshotStatus } from "../data/useSnapshot";
import { PausedNotice, usePaused } from "./Paused";

function StandInHero() {
  const paused = usePaused();
  return (
    <section aria-label="Hero" {...paused.rootProps}>
      <h2>Any player</h2>
      <PausedNotice {...paused} />
      <a href="https://www.realapp.com/x" {...paused.actionProps}>
        Open in Real
      </a>
    </section>
  );
}

const renderAt = (status: SnapshotStatus) =>
  render(
    <AppContext.Provider value={{ status } as AppState}>
      <StandInHero />
    </AppContext.Provider>,
  );

describe("usePaused and PausedNotice", () => {
  it("say nothing while the data is live", () => {
    renderAt("live");
    const hero = screen.getByRole("region", { name: "Hero" });
    expect(hero).not.toHaveAttribute("data-stale");
    expect(screen.queryByText(/Paused/)).toBeNull();
    expect(screen.getByRole("link", { name: "Open in Real" })).not.toHaveAttribute("aria-describedby");
  });

  it("mark the hero, show the notice and describe its actions by it while paused", () => {
    renderAt("stale");
    expect(screen.getByRole("region", { name: "Hero" })).toHaveAttribute("data-stale", "");
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("Paused · prices may have changed");
    const link = screen.getByRole("link", { name: "Open in Real" });
    expect(link).toHaveAttribute("href", "https://www.realapp.com/x");
    expect(link).not.toHaveAttribute("aria-disabled");
    expect(link).toHaveAccessibleDescription("Paused · prices may have changed");
  });

  it("are not paused while the first snapshot is still loading", () => {
    renderAt("loading");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
