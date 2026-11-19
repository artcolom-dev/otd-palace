import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Access, AccessContext } from "../components/Access";
import { local } from "../data/local";
import { Join } from "./Gate";
import { PASS_DEALS_ON, passDealsSwitch } from "../components/PassDeals";
import { UA } from "../lib/inapp.fixtures";

const teaser = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));

/** The join page as a visitor in `state` sees it. */
function Gate({ fetchImpl, state = "anon", invite = null, name = null }: {
  fetchImpl: typeof fetch;
  state?: Access["state"];
  invite?: string | null;
  name?: string | null;
}) {
  const access: Access = { state, name, fetchImpl, refresh: () => undefined };
  return (
    <AccessContext.Provider value={access}>
      <Join fetchImpl={fetchImpl} invite={invite} />
    </AccessContext.Provider>
  );
}

describe("the join page", () => {
  afterEach(() => history.replaceState(null, "", "/"));

  it("says once that the site is free and Discord unlocks more, free too", () => {
    render(<Gate fetchImpl={teaser({}, 503)} />);
    expect(screen.getByRole("heading", { level: 1, name: "Free. Join the Discord and it's basically a cheat code. Also free." })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Use OTD Palace with no account. Continue with Discord and we add you to our server: that unlocks the rest.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "We keep your Discord id and name, plus what you choose to link. Never your email or messages, and we never post for you.",
        { exact: false },
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Read the privacy notice." })).toHaveAttribute("href", "/privacy");
    expect(screen.getByText("OTD Palace")).toBeInTheDocument();
  });

  it("says what Real and Rax are, until the visitor has put the welcome away", () => {
    const { unmount } = render(<Gate fetchImpl={teaser({}, 503)} />);
    expect(screen.getByText("Real is a sports card app; Rax is its in-app currency.")).toBeInTheDocument();
    unmount();
    local.dismissWelcome();
    render(<Gate fetchImpl={teaser({}, 503)} />);
    expect(screen.queryByText("Real is a sports card app; Rax is its in-app currency.")).not.toBeInTheDocument();
  });

  it("leads to the login, back to the site, and back to browsing", () => {
    history.replaceState(null, "", "/#join");
    render(<Gate fetchImpl={teaser({}, 503)} />);
    const go = screen.getByRole("link", { name: /Continue with Discord/ });
    expect(go).toHaveAttribute("href", "/auth/discord?next=%2F");
    expect(screen.getByRole("link", { name: /Keep browsing/ })).toHaveAttribute("href", "#today");
  });

  it("on an iPhone that looks like Safari, says how to leave Discord's in-app view first", () => {
    const ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(UA.discordIos);
    render(<Gate fetchImpl={teaser({}, 503)} />);
    expect(
      screen.getByText("Opened this from Discord? Open it in Safari first (Discord's ⋯ or Safari button): you stay signed in there."),
    ).toBeInTheDocument();
    ua.mockReturnValue(UA.chromeAndroid);
    cleanup();
    render(<Gate fetchImpl={teaser({}, 503)} />);
    expect(screen.queryByText(/Opened this from Discord/)).not.toBeInTheDocument();
    ua.mockRestore();
  });

  it("lists Pass deals among what Discord adds while the block is on", () => {
    passDealsSwitch.on = true;
    try {
      render(<Gate fetchImpl={teaser({}, 503)} />);
      expect(screen.getByRole("list", { name: "With Discord" }).textContent).toContain("Pass deals");
    } finally {
      passDealsSwitch.on = PASS_DEALS_ON;
    }
  });

  it("lists what Discord adds, then what is free for everyone", () => {
    render(<Gate fetchImpl={teaser({}, 503)} />);
    const more = screen.getByRole("list", { name: "With Discord" }).textContent;
    const free = screen.getByRole("list", { name: "Free for everyone" }).textContent;
    for (const words of ["Every live deal", "Every price move", "Your own plan", "Deals pinged to you", "The server"]) {
      expect(more).toContain(words);
    }
    expect(more).not.toContain("Pass deals"); // switched off: not promised while nobody can see it
    for (const words of ["Today's best deals", "Prices moving", "The best passes", "How Real works"]) {
      expect(free).toContain(words);
    }
  });

  it("offers someone out of the server the join, the invite and Check again", () => {
    render(<Gate fetchImpl={teaser({}, 503)} state="out" invite="https://discord.gg/palace" />);
    expect(screen.getByRole("link", { name: /Join the OTD Palace server/ })).toHaveAttribute("href", "/auth/discord?next=%2F");
    expect(screen.getByRole("link", { name: /Open the invite/ })).toHaveAttribute("href", "https://discord.gg/palace");
    expect(screen.getByRole("button", { name: "I've joined: check again" })).toBeInTheDocument();
  });

  it("lets someone signed in but not in the server erase their data here, and nobody else", () => {
    const { unmount } = render(<Gate fetchImpl={teaser({}, 503)} state="out" name="Deal Hunter" />);
    expect(screen.getByRole("button", { name: /Delete my data/ })).toBeInTheDocument();
    unmount();
    render(<Gate fetchImpl={teaser({}, 503)} />);
    expect(screen.queryByRole("button", { name: /Delete my data/ })).not.toBeInTheDocument();
  });

  it("keeps its headings in order for a screen reader where it offers to erase the data (no h1 then h3)", () => {
    for (const state of ["out", "banned"] as const) {
      const { container, unmount } = render(<Gate fetchImpl={teaser({}, 503)} state={state} name="Deal Hunter" />);
      const levels = [...container.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => Number(h.tagName[1]));
      levels.forEach((level, i) => expect(level - (levels[i - 1] ?? 0), `${state}: ${levels.join(" ")}`).toBeLessThanOrEqual(1));
      expect(screen.getByRole("heading", { name: "Your data" })).toBeInTheDocument();
      unmount();
    }
  });

  it("offers an account the server refused no way round it, and tells a member they are in", () => {
    const { unmount } = render(<Gate fetchImpl={teaser({}, 503)} state="banned" />);
    expect(screen.getByText(/Discord won't let this account join/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Continue with Discord|Join the/ })).not.toBeInTheDocument();
    unmount();
    render(<Gate fetchImpl={teaser({}, 503)} state="in" />);
    expect(screen.getByText(/You're in: everything is unlocked/)).toBeInTheDocument();
  });

  it("shows the live counts once they come", async () => {
    const f = teaser({ deals: 143, sports: 8, best_pct: 38, generated_at: new Date(Date.now() - 12_000).toISOString() });
    render(<Gate fetchImpl={f} />);
    expect(await screen.findByText("143 live deals right now across 8 sports · best 38% under")).toBeInTheDocument();
    expect(screen.getByText(/Checked \d+ s ago/)).toBeInTheDocument();
    // Counts that change every minute are not announced every minute.
    expect(screen.getByText("143 live deals right now across 8 sports · best 38% under").closest("[aria-live]")).toBeNull();
    expect(f).toHaveBeenCalledWith("/api/teaser", expect.anything());
  });

  it("holds the live line's place while it asks, so the button does not move when the counts come", async () => {
    let answer: (r: Response) => void = () => undefined;
    const f = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => (answer = resolve)));
    render(<Gate fetchImpl={f} />);
    const wait = screen.getByTestId("gate-live-wait");
    expect(wait).toHaveClass("gate-live", "wait");
    expect(wait).toHaveAttribute("aria-hidden", "true"); // nothing to read yet
    expect(wait.textContent).not.toMatch(/[a-df-z0-9]/i); // blank marks only: no word, no figure made up
    // shaped like the sentence it waits for: the same number of words, so it wraps alike
    expect(wait.querySelector(".gate-count")!.textContent!.split(" ")).toHaveLength("88 live deals right now across 8 sports · best 38% under".split(" ").length);
    expect(wait.compareDocumentPosition(screen.getByRole("link", { name: /Continue with Discord/ })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    answer(new Response(JSON.stringify({ deals: 143, sports: 8, best_pct: 38, generated_at: null }), { status: 200 }));
    const line = await screen.findByText("143 live deals right now across 8 sports · best 38% under");
    expect(line.closest(".gate-live")).not.toHaveClass("wait");
    expect(screen.queryByTestId("gate-live-wait")).toBeNull();
  });

  it("gives the place up when no counts come", async () => {
    render(<Gate fetchImpl={teaser({}, 503)} />);
    await waitFor(() => expect(screen.queryByTestId("gate-live-wait")).toBeNull());
    expect(document.querySelector(".gate-live")).toBeNull();
  });

  it("leaves the counts out when there are none", async () => {
    const f = teaser({ deals: 0, sports: 0, best_pct: null, generated_at: null });
    render(<Gate fetchImpl={f} />);
    await waitFor(() => expect(f).toHaveBeenCalled());
    expect(screen.queryByText(/live deals? right now/)).not.toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(".gate-live")).toBeNull());
  });

  it("titles the window", () => {
    render(<Gate fetchImpl={teaser({}, 503)} />);
    expect(document.title).toBe("Free with Discord · OTD Palace");
  });
});
