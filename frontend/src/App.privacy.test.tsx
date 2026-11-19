// Where the privacy notice and "Delete my data" are reachable from: the join page, the legal line and a member's
// account panel (see AccountPanel.privacy.test.tsx).
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDevice, renderApp } from "./test/app";

vi.mock("./lib/track", () => ({ trackOut: vi.fn() }));

const VISITOR = '{"gate":true,"member":false,"state":"anon"}';
const gateServer = () => vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));

describe("the privacy notice and deleting data", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.getElementById("me")?.remove();
  });

  it("the join page says what is kept, accurately, and links the notice twice", () => {
    renderApp({ snap: null, me: VISITOR, gateFetch: gateServer(), hash: "join" });
    expect(screen.getByText(/We keep your Discord id and name/)).toHaveTextContent("Never your email or messages");
    expect(screen.queryByText(/We only see your Discord name/)).not.toBeInTheDocument();
    const links = screen.getAllByRole("link", { name: /privacy/i });
    expect(links.length).toBe(2);
    for (const link of links) expect(link).toHaveAttribute("href", "/privacy");
  });

  it("the legal line carries a Privacy link next to 'Not affiliated with Real'", () => {
    renderApp();
    const legal = screen.getAllByText("Not affiliated with Real.")[0]!.closest("footer")!;
    expect(within(legal).getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
  });
});
