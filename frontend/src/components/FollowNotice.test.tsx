// A star on a phone moves its player's deals to the top of the list, away from under the finger: a short bar says what
// happened and offers Undo, as a native app does after an action that moves things.
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { local } from "../data/local";
import { savePrefs } from "../data/prefs";
import { freshDevice, renderApp } from "../test/app";
import { makeDeal, makeSnapshot } from "../test/fixtures";

const snap = makeSnapshot({
  deals: [
    makeDeal({ listing_id: 1, player_id: 11, player_name: "Trae Young", discount: 0.5 }),
    makeDeal({ listing_id: 2, player_id: 12, player_name: "Paolo Banchero", discount: 0.3 }),
  ],
});
const list = () => screen.getByRole("list", { name: "All deals" });
const offer = () => screen.queryByText(/^(Following|Stopped following) /);

describe("following a player from a list", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => vi.useRealTimers());

  it("says so with Undo, which puts the star back; the bar goes on its own", () => {
    savePrefs({ level: "regular", budget: 1000, sport: "all", sort: "best", tab: "deals", passBudget: 5000 });
    renderApp({ snap, hash: "deals" });
    fireEvent.click(within(list()).getByRole("button", { name: "Follow Paolo Banchero" }));
    expect(local.get().follows).toHaveLength(1);
    expect(offer()).toHaveTextContent("Following Paolo Banchero: their deals now come first");
    expect(offer()!.closest("[aria-live=polite]")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(local.get().follows).toEqual([]);
    expect(offer()).toBeNull();

    fireEvent.click(within(list()).getByRole("button", { name: "Follow Paolo Banchero" }));
    fireEvent.click(within(list()).getByRole("button", { name: "Unfollow Paolo Banchero" }));
    expect(offer()).toHaveTextContent("Stopped following Paolo Banchero");
    act(() => vi.advanceTimersByTime(7000));
    expect(offer()).toBeNull();
    expect(local.get().follows).toEqual([]);
  });
});
