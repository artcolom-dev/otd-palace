import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDevice, renderApp } from "../test/app";
import { sceneSnapshot } from "../test/scene";
import { supportOf } from "./SupportSheet";

const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(400)));
const withSupport = (url: string | null = null) => {
  const snap = sceneSnapshot();
  return { ...snap, links: { ...snap.links, support: { account: "otdpalace", url } } };
};
const sheet = () => screen.getByRole("dialog", { name: "Support the Palace" });

describe("supportOf", () => {
  it("reads the account and a Real link, and nothing else", () => {
    expect(supportOf({ community: null, support: { account: "otdpalace", url: null } })).toEqual({ account: "otdpalace", url: null });
    expect(supportOf({ community: null, support: { account: "otdpalace", url: "https://www.realapp.com/Abc123" } })?.url).toBe(
      "https://www.realapp.com/Abc123",
    );
    // A link that is not Real's is dropped; an odd name or no entry names no account at all.
    expect(supportOf({ community: null, support: { account: "otdpalace", url: "https://evil.example/x" } })?.url).toBeNull();
    expect(supportOf({ community: null, support: { account: "<b>x</b>", url: null } })).toBeNull();
    expect(supportOf({ community: null })).toBeNull();
    expect(supportOf(undefined)).toBeNull();
  });
});

describe("Support the Palace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => vi.useRealTimers());

  it("opens from the footer: the account's name, the three steps, and that a gift buys nothing", async () => {
    renderApp({ snap: withSupport(), viewport: "desktop" });
    fireEvent.click(screen.getAllByRole("button", { name: "Support the Palace" })[0]!);
    expect(sheet()).toHaveAttribute("aria-modal", "true");
    expect(location.hash).toBe("#support");
    expect(within(sheet()).getByText("otdpalace")).toBeInTheDocument();
    expect(within(sheet()).getAllByRole("listitem")).toHaveLength(3);
    expect(sheet()).toHaveTextContent("a gift buys nothing");
    expect(sheet()).toHaveTextContent("Not affiliated with Real");
    expect(within(sheet()).queryByRole("link", { name: /on Real/ })).toBeNull(); // no card linked: no link
    fireEvent.keyDown(document, { key: "Escape" });
    await flush();
    expect(screen.queryByRole("dialog", { name: "Support the Palace" })).toBeNull();
    expect(`${location.pathname}${location.hash}`).toBe("/");
  });

  it("links the Palace's card when the server names one, in a new tab", () => {
    renderApp({ snap: withSupport("https://www.realapp.com/D5h7FRFWPOKGR"), viewport: "phone" });
    fireEvent.click(screen.getAllByRole("button", { name: "Support the Palace" })[0]!);
    const link = within(sheet()).getByRole("link", { name: /Open the Palace's card on Real/ });
    expect(link).toHaveAttribute("href", "https://www.realapp.com/D5h7FRFWPOKGR");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("copies the name, or says to type it where there is no clipboard", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderApp({ snap: withSupport(), viewport: "phone" });
    fireEvent.click(screen.getAllByRole("button", { name: "Support the Palace" })[0]!);
    await act(async () => fireEvent.click(within(sheet()).getByRole("button", { name: "Copy the name" })));
    expect(writeText).toHaveBeenCalledWith("otdpalace");
    expect(within(sheet()).getByRole("status")).toHaveTextContent("Copied.");
    writeText.mockRejectedValueOnce(new Error("no"));
    await act(async () => fireEvent.click(within(sheet()).getByRole("button", { name: "Copy the name" })));
    expect(within(sheet()).getByRole("status")).toHaveTextContent("Type it in Real's search: otdpalace");
  });

  it("opens from its address", () => {
    renderApp({ snap: withSupport(), viewport: "desktop", hash: "support" });
    expect(sheet()).toBeInTheDocument();
  });

  it("is not offered by a snapshot that names no account", () => {
    renderApp({ snap: sceneSnapshot(), viewport: "desktop", hash: "support" });
    expect(screen.queryByRole("button", { name: "Support the Palace" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Support the Palace" })).toBeNull();
  });
});
