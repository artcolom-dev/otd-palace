import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVICE_PASSES, local } from "../data/local";
import { encodeProfile } from "../data/profileCode";
import { MemberContext } from "./MemberLine";
import { ProfileCard, ProfileLink, restoredText } from "./ProfileCard";

describe("ProfileCard", () => {
  beforeEach(() => {
    localStorage.clear();
    local.reload();
  });

  it("a bad code changes nothing", async () => {
    render(<ProfileCard />);
    const box = screen.getByLabelText("Restore from a code");
    fireEvent.change(box, { target: { value: "garbage" } });
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByText("That is not a code from this site.")).toBeInTheDocument();
    expect(local.get().follows).toEqual([]);
  });

  it("restores a pasted code onto this device and says what came in, in good English", async () => {
    const code = await encodeProfile({ ...local.get(), follows: ["nba:5"], passes: [{ key: "nba:2026:player:5", tier: "rare" }] });
    render(<ProfileCard />);
    fireEvent.change(screen.getByLabelText("Restore from a code"), { target: { value: code } });
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByText("Restored: 1 followed player, 1 pass.")).toBeInTheDocument();
    expect(local.get().follows).toEqual(["nba:5"]);
  });

  it("says each count with its own singular or plural, and says plainly when passes had to go", () => {
    expect(restoredText({ ok: true, follows: 0, passes: 0, dropped: 0 })).toBe("Restored: no followed player, no pass.");
    expect(restoredText({ ok: true, follows: 2, passes: 2149, dropped: 0 })).toBe("Restored: 2 followed players, 2,149 passes.");
    expect(restoredText({ ok: true, follows: 1, passes: 30, dropped: 1 })).toBe(
      `Restored: 1 followed player, 30 passes. A device keeps ${DEVICE_PASSES.toLocaleString("en-US")} passes: 1 older pass of this device was removed to make room.`,
    );
    expect(restoredText({ ok: true, follows: 1, passes: 30, dropped: 12 })).toMatch(/12 older passes of this device were removed/);
  });

  it("copies this device's code to the clipboard", async () => {
    local.toggleFollow("nba:7");
    let copied = "";
    Object.assign(navigator, { clipboard: { writeText: async (s: string) => void (copied = s) } });
    render(<ProfileCard />);
    fireEvent.click(screen.getByRole("button", { name: "Copy my code" }));
    await screen.findByText(/Copied/);
    expect(copied).toMatch(/^MP[12]\./);
  });

  it("on an empty device, says there is nothing to carry instead of copying a useless code", async () => {
    let copied = "";
    Object.assign(navigator, { clipboard: { writeText: async (s: string) => void (copied = s) } });
    render(<ProfileCard />);
    fireEvent.click(screen.getByRole("button", { name: "Copy my code" }));
    expect(await screen.findByText(/Nothing to carry yet/)).toBeInTheDocument();
    expect(copied).toBe("");
  });
});

describe("Use it on another device, for a Discord member", () => {
  beforeEach(() => {
    localStorage.clear();
    local.reload();
  });
  const member = { name: "Ana", fetchImpl: (() => Promise.reject(new Error("no"))) as unknown as typeof fetch };

  it("is hidden for a member, whose link already follows them to every device", () => {
    const { container } = render(
      <MemberContext.Provider value={member}>
        <ProfileCard />
        <ProfileLink />
      </MemberContext.Provider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("stays, folded away as an advanced option, where there is no Discord session", () => {
    render(<ProfileCard />);
    const summary = screen.getByText("Use it on another device", { selector: "summary" });
    expect(summary.closest("details")).not.toHaveAttribute("open");
  });
});
