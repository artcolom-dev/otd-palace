import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { local } from "../../data/local";
import { REAL_PRO_KEY, saveRealPro } from "../../lib/realPro";
import { freshDevice, renderApp } from "../../test/app";
import { JOKIC, MACKINNON, MURRAY, passSnapshot } from "../../test/passScene";

// Jokić 2024-25 at Epic from a linked account: 5,100 earned against its 5,000 cap, so its On This Day pay stopped.
const JOKIC_FULL = { key: JOKIC.key, rarity: "epic", rating: 212, mult: 10, cap: 5000, earned: 5100, from: "real" as const };
const MURRAY_ROOM = { key: MURRAY.key, rarity: "rare", rating: 100, mult: 4, cap: 2000, earned: 1500, from: "real" as const };

const summary = () => screen.getByRole("region", { name: "Passes done paying" });
const tick = () => fireEvent.click(within(summary()).getByRole("button", { name: "I have Real Pro" }));

describe("Recycle on My passes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
    saveRealPro(false);
  });
  afterEach(() => {
    saveRealPro(false);
    vi.useRealTimers();
  });

  it("is not there while no pass is done paying", () => {
    local.addPass(MURRAY_ROOM);
    renderApp({ snap: passSnapshot(), hash: "passes", viewport: "desktop" });
    expect(screen.queryByRole("region", { name: "Passes done paying" })).toBeNull();
  });

  it("without Real Pro: the lift that reopens the full pass, linked to it, and no selling route", () => {
    local.addPass(JOKIC_FULL);
    local.addPass(MURRAY_ROOM);
    renderApp({ snap: passSnapshot(), hash: "passes", viewport: "phone" });
    fireEvent.click(screen.getByRole("tab", { name: /My passes/ }));
    expect(screen.getByTestId("recycle-summary")).toHaveTextContent(
      "1 pass is done paying. A lift reopens it. No Real Pro needed. With Real Pro, its cards could also be sold for a pass that pays.",
    );
    const line = screen.getByTestId("recycle-line");
    expect(line).toHaveTextContent("Lift it to Legendary for about 1,700 Rax and it pays again, up to about 7,400 more. No Real Pro needed.");
    // Quick Sell is said second, as what not to do while a lift reopens the pass; no listing route without Real Pro.
    expect(line).toHaveTextContent(
      "Quick Sell would bring only about 210 Rax, and it ends the lift. Lift first: you keep the cards.",
    );
    expect(line).not.toHaveTextContent(/Listing|Enough for/);
    fireEvent.click(within(line).getByRole("button", { name: /See the lift/ }));
    expect(screen.getByRole("dialog", { name: /Nikola Jokić 2024-25/ })).toBeInTheDocument();
  });

  it("without Real Pro, a full pass no lift reopens: Quick Sell, instant and Pro-free, beside what listing would bring", () => {
    local.addPass({ ...JOKIC_FULL, earned: 50000 }); // every next rarity's limit already earned: no lift
    local.addPass(MURRAY_ROOM);
    renderApp({ snap: passSnapshot(), hash: "passes", viewport: "phone" });
    fireEvent.click(screen.getByRole("tab", { name: /My passes/ }));
    expect(screen.getByTestId("recycle-summary")).toHaveTextContent(
      "1 pass is done paying. Quick Sell would bring about 210 Rax for its cards now, with no Real Pro, but that is about an eighth of what cards usually sell for. With Real Pro, listing them might bring several times more.",
    );
    const line = screen.getByTestId("recycle-line");
    expect(line).toHaveTextContent(
      "Quick Sell its cards now for about 210 Rax: instant, and no Real Pro needed. But it pays far less, about an eighth of what cards usually sell for. Listed with Real Pro, they might bring several times more.",
    );
    expect(within(line).queryByRole("button", { name: /See the lift/ })).toBeNull();
    // No lift reopens it, so its row does not say one does: just "full", the line under it says the rest.
    const row = line.closest("li")!;
    expect(row).not.toHaveTextContent(/lift reopens it/);
    expect(within(row).getByText("full")).toBeInTheDocument();
    // The glossary's Quick Sell entry is one tap away.
    expect(within(line).getByRole("button", { name: /quick sell/i })).toBeInTheDocument();
  });

  it("ticking Real Pro: what the cards would sell for, the pass that builds, Real Pro said; kept on this device", () => {
    local.addPass(JOKIC_FULL);
    local.addPass(MURRAY_ROOM);
    local.addPass({ key: MACKINNON.key, tier: "rare", spent: true });
    renderApp({ snap: passSnapshot(), hash: "passes", viewport: "desktop" });
    tick();
    expect(localStorage.getItem(REAL_PRO_KEY)).toBe("1");
    expect(within(summary()).getByRole("button", { name: "I have Real Pro" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("recycle-summary")).toHaveTextContent(/^2 passes are done paying\. Their cards would sell for about [\d,]+ Rax \(estimate\)\. Sold, that could build /);
    expect(within(summary()).getByText(/Listing cards for sale in Real needs Real Pro/)).toBeInTheDocument();
    // One short note on Quick Sell, and no Quick Sell line under the passes.
    expect(within(summary()).getByText(/Real's Quick Sell is instant and needs no Real Pro, but it pays about 1 Rax a rating point, about an eighth/)).toBeInTheDocument();
    // The passes it builds open from the summary.
    expect(within(summary()).getAllByRole("button", { name: /\+[\d,]+\/yr/ }).length).toBeGreaterThan(0);
    // Each done pass says what its cards would sell for, in the list.
    fireEvent.click(screen.getByRole("button", { name: /Show my 3 passes/ }));
    const lines = screen.getAllByTestId("recycle-line");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent("Its cards would sell for about 1,900 Rax (estimate). Enough for Connor McDavid 2025-26 at Rare");
    expect(lines[0]).toHaveTextContent("Listing them needs Real Pro.");
    for (const l of lines) expect(l).not.toHaveTextContent(/Quick Sell/);
    tick();
    expect(localStorage.getItem(REAL_PRO_KEY)).toBeNull();
    expect(screen.getByTestId("recycle-summary")).not.toHaveTextContent(/would sell for/);
  });
});
