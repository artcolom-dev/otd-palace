// How the account analysis shows its waits: the first reading (one answer, nothing to measure), then a big account's
// seasons still being read (measured: the server says how many passes are left).
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppContext, type AppState } from "../../AppContext";
import { local } from "../../data/local";
import { passSnapshot } from "../../test/passScene";
import { AccountAnalysis } from "./AccountAnalysis";

const ctx = { titleId: "t", close: () => undefined, phone: false };
const show = (username: string) =>
  render(
    <AppContext.Provider
      value={{ snap: passSnapshot(), prefs: { level: "regular", budget: null, passBudget: null, sport: "all" }, now: Date.now() } as unknown as AppState}
    >
      <AccountAnalysis username={username} ctx={ctx} />
    </AppContext.Provider>,
  );

beforeEach(() => {
  localStorage.clear();
  local.reload();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the account analysis while it waits", () => {
  it("first answer: a moving bar that claims no measure, and after 8 s a word that a big account takes longer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => undefined));
    const { container } = show("whale");
    expect(screen.getByRole("status")).toHaveTextContent("Reading whale's passes… this can take up to half a minute.");
    expect(container.querySelector('.wbar[data-kind="busy"]')).not.toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("status")).not.toHaveTextContent(/big account/);
    await act(async () => void (await vi.advanceTimersByTimeAsync(8000)));
    expect(screen.getByRole("status")).toHaveTextContent(/Still reading: a big account takes longer\. You can leave this open\./);
  });

  it("seasons still being read: a progress bar filled to what the server has read, said in words", async () => {
    const site = passSnapshot().otd.markets;
    const passes = site.slice(0, 4).map((m) => ({ key: m.key, tier: "common" }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", username: "Whale", truncated: false, passes, markets: [], waiting: 3, seasons_waiting: 2 }), { status: 200 }),
    );
    show("whale");
    const bar = await screen.findByRole("progressbar", { name: "Passes read from Real" });
    expect(bar).toHaveAttribute("aria-valuenow", "1");
    expect(bar).toHaveAttribute("aria-valuemax", "4");
    expect(bar).toHaveAttribute("aria-valuetext", "1 of 4 passes read from Real");
    expect(screen.getByText("1 of 4 passes read from Real so far")).toBeInTheDocument();
  });

  it("every pass read: no bar left", async () => {
    const site = passSnapshot().otd.markets;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ status: "ok", username: "Whale", truncated: false, passes: [{ key: site[0]!.key, tier: "common" }], markets: [], waiting: 0, seasons_waiting: 0 }),
        { status: 200 },
      ),
    );
    const { container } = show("whale");
    await waitFor(() => expect(screen.getByText("Their passes pay about")).toBeInTheDocument());
    expect(container.querySelector(".wbar")).toBeNull();
  });
});
