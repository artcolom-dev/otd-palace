// "Delete my data" lives in a member's account panel (LinkBox), and only there.
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppContext, type AppState } from "../AppContext";
import { local } from "../data/local";
import { memberLinkStore } from "../lib/link";
import { sceneSnapshot } from "../test/scene";
import { AccountCard } from "./AccountLookup";
import { type Member, MemberContext } from "./MemberLine";
import { OverlayProvider } from "./Overlay";

const state = () => {
  const snap = sceneSnapshot();
  return {
    snap: { ...snap, links: { ...snap.links, accounts: true } },
    layout: { phone: false },
    now: Date.now(),
  } as unknown as AppState;
};
const show = (member: Member | null) =>
  render(
    <AppContext.Provider value={state()}>
      <MemberContext.Provider value={member}>
        <OverlayProvider phone={false}>
          <AccountCard />
        </OverlayProvider>
      </MemberContext.Provider>
    </AppContext.Provider>,
  );

describe("the account panel and deleting data", () => {
  beforeEach(() => {
    localStorage.clear();
    local.reload();
    memberLinkStore.set(null);
  });

  it("a signed-in member finds Delete my data and the notice, linked or not", () => {
    show({ name: "Deal Hunter", fetchImpl: vi.fn<typeof fetch>(async () => new Response(null, { status: 404 })) });
    expect(screen.getByRole("button", { name: "Delete my data" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "privacy notice" })).toHaveAttribute("href", "/privacy");
  });

  it("anyone else (the gate off) has no account to delete", () => {
    show(null);
    expect(screen.queryByRole("button", { name: "Delete my data" })).not.toBeInTheDocument();
  });
});
