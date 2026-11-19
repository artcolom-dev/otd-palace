// "Delete my data": a plain two-step confirmation in a member's account panel; nothing is sent until they say Delete.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { local } from "../data/local";
import { memberLinkStore } from "../lib/link";
import { freshDevice } from "../test/app";
import { DeleteData } from "./DeleteData";
import { type Member, MemberContext } from "./MemberLine";

const ASK = "This removes your link, followed players and settings, and the activity we recorded with your Discord account on the site and in our Discord, from our server. You stay in the Discord server.";

function setup(status: number | "offline" = 204) {
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    if (status === "offline") throw new TypeError("offline");
    return new Response(null, { status });
  });
  const member: Member = { name: "Deal Hunter", fetchImpl };
  render(
    <MemberContext.Provider value={member}>
      <DeleteData />
    </MemberContext.Provider>,
  );
  return fetchImpl;
}

const open = () => fireEvent.click(screen.getByRole("button", { name: "Delete my data" }));

describe("Delete my data", () => {
  const assign = vi.fn();
  beforeEach(() => {
    freshDevice();
    assign.mockReset();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign } as Location);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    memberLinkStore.set(null);
  });

  it("is there for a member only", () => {
    render(<DeleteData />);
    expect(screen.queryByRole("button", { name: "Delete my data" })).not.toBeInTheDocument();
  });

  it("starts as one button and a link to the notice, and sends nothing", () => {
    const fetchImpl = setup();
    expect(screen.getByRole("link", { name: "privacy notice" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("button", { name: "Delete my data" })).toBeInTheDocument();
    expect(screen.queryByText(ASK)).not.toBeInTheDocument();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("asks first, in plain words, with Delete and Cancel, and still sends nothing", () => {
    const fetchImpl = setup();
    open();
    expect(screen.getByRole("group", { name: ASK })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(); // the safe answer is the one in reach
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("Cancel and Escape put the question away and give the focus back to the button", () => {
    const fetchImpl = setup();
    open();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(ASK)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete my data" })).toHaveFocus();
    open();
    fireEvent.keyDown(screen.getByRole("group"), { key: "Escape" });
    expect(screen.queryByText(ASK)).not.toBeInTheDocument();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("Delete asks the server once, clears the link on this device and returns to the front door", async () => {
    local.link("Shaedon", [], [], new Set());
    expect(local.get().link).not.toBeNull();
    const fetchImpl = setup(204);
    open();
    const del = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(del);
    fireEvent.click(del); // a second tap while it works sends nothing more
    const busy = screen.getByRole("button", { name: "Deleting…" }); // says it works, keeps its place and the focus
    expect(busy).toBe(del);
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(busy).toHaveAttribute("aria-disabled", "true");
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("/api/me", expect.objectContaining({ method: "DELETE", credentials: "same-origin" }));
    expect(local.get().link).toBeNull();
  });

  it.each([["a refusal", 429], ["a server error", 500], ["no answer at all", "offline" as const]])(
    "after %s it says so, changes nothing and lets them try again",
    async (_, status) => {
      local.link("Shaedon", [], [], new Set());
      setup(status);
      open();
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      const said = await screen.findByRole("status");
      expect(said).toHaveTextContent("Couldn't delete. Nothing was changed.");
      expect(assign).not.toHaveBeenCalled();
      expect(local.get().link).not.toBeNull();
      expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(); // not stranded on the page behind
    },
  );
});
