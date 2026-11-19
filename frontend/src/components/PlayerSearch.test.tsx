// A phone's player search: the keyboard's own key says Search, and pressing it takes the top result, as a native search
// does, instead of doing nothing.
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { savePrefs } from "../data/prefs";
import { freshDevice, renderApp } from "../test/app";
import { makeDeal, makeSnapshot } from "../test/fixtures";

const snap = makeSnapshot({
  deals: [
    makeDeal({ listing_id: 1, player_id: 11, player_name: "Trae Young" }),
    makeDeal({ listing_id: 2, player_id: 12, player_name: "Paolo Banchero" }),
  ],
});

describe("player search on a phone", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => vi.useRealTimers());

  it("labels the keyboard's key Search, and that key takes the top result", async () => {
    savePrefs({ level: "regular", budget: 1000, sport: "all", sort: "best", tab: "deals", passBudget: 5000 });
    renderApp({ snap, viewport: "phone", hash: "deals" });
    fireEvent.click(screen.getByRole("button", { name: "Search a player" }));
    const sheet = screen.getByRole("dialog", { name: "Find a player" });
    const field = within(sheet).getByRole("searchbox", { name: "Player name" });
    expect(field).toHaveAttribute("enterkeyhint", "search");
    fireEvent.keyDown(field, { key: "Enter" }); // nothing typed: nothing chosen
    expect(screen.getByRole("dialog", { name: "Find a player" })).toBeInTheDocument();
    fireEvent.change(field, { target: { value: "pao" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await act(async () => {}); // the sheet's way out
    expect(screen.queryByRole("dialog", { name: "Find a player" })).toBeNull(); // as a tap on that result does
    const names = within(screen.getByRole("list", { name: "All deals" })).getAllByTestId("player").map((n) => n.textContent);
    expect(names).toEqual(["Paolo Banchero"]);
  });
});
