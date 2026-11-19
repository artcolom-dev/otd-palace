import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HANDOFF_POLL_MS, nav } from "../lib/handoff";
import { UA } from "../lib/inapp.fixtures";
import { SignInLink } from "./SignInLink";

const HREF = "/auth/discord?next=%2F";
const WHOLE = `${location.origin}/auth/discord?next=%2F`;

function as(ua: string) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
}

function renderLink() {
  render(
    <SignInLink className="btn fill" href={HREF}>
      Continue with Discord
    </SignInLink>,
  );
  return screen.getByRole("link", { name: "Continue with Discord" });
}

/** Taps the link; says whether the browser would have followed it (false: the tap was stopped). */
const tap = (link: HTMLElement) => fireEvent.click(link);

describe("the sign-in link", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("is a plain link to the login in a real browser, on a phone or a desktop", () => {
    for (const ua of [UA.safariIos, UA.chromeIos, UA.chromeAndroid, UA.samsungInternet, UA.desktopChrome, UA.discordIos]) {
      as(ua);
      const link = renderLink();
      expect(link).toHaveAttribute("href", HREF);
      expect(tap(link)).toBe(true); // followed: nothing stands in the way
      expect(screen.queryByRole("dialog")).toBeNull();
      cleanup();
    }
  });

  it("in Instagram on iOS, asks to sign in from the browser and opens the sign-in itself there", () => {
    as(UA.instagramIos);
    const link = renderLink();
    expect(link).toHaveAttribute("href", HREF); // still a real link for anything that reads it
    expect(tap(link)).toBe(false); // not followed inside the app
    const sheet = screen.getByRole("dialog", { name: "Sign in from your browser" });
    expect(sheet).toHaveTextContent("You're in Instagram's built-in browser.");
    expect(screen.getByRole("link", { name: "Open in your browser" })).toHaveAttribute(
      "href",
      `instagram://extbrowser/?url=${encodeURIComponent(WHOLE)}`,
    );
    expect(sheet).toHaveTextContent("Tap ⋯ at the top right, then Open in external browser.");
    expect(screen.getByRole("textbox", { name: "Sign-in link" })).toHaveValue(WHOLE);
    expect(screen.getByRole("link", { name: "Sign in here instead" })).toHaveAttribute("href", HREF);
  });

  it("in an Android web view, opens the sign-in in the default browser through an intent", () => {
    as(UA.facebookAndroid);
    tap(renderLink());
    const out = screen.getByRole("link", { name: "Open in your browser" });
    expect(out.getAttribute("href")).toMatch(/^intent:\/\/localhost(:\d+)?\/auth\/discord\?next=%2F#Intent;scheme=https;/);
    expect(out).not.toHaveAttribute("target");
  });

  it("in Facebook on iOS, opens a new window, which Facebook gives to Safari", () => {
    as(UA.facebookIos);
    tap(renderLink());
    const out = screen.getByRole("link", { name: "Open in Safari" });
    expect(out).toHaveAttribute("href", WHOLE);
    expect(out).toHaveAttribute("target", "_blank");
  });

  it("in TikTok on iOS, which lets nothing out, gives the steps and the link to copy", () => {
    as(UA.tiktokIos);
    tap(renderLink());
    expect(screen.queryByRole("link", { name: /^Open in/ })).toBeNull();
    expect(screen.getByRole("dialog")).toHaveTextContent("Tap ⋯ at the top right, then Open in browser.");
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });

  it("copies the sign-in link, and says so", async () => {
    as(UA.otherIosWebView);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    tap(renderLink());
    expect(screen.getByRole("link", { name: "Open in Safari" })).toHaveAttribute(
      "href",
      WHOLE.replace(/^http/, "x-safari-http"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(await screen.findByText("Copied. Paste it in Safari.")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(WHOLE);
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  });

  it("without a clipboard, selects the link to copy by hand", async () => {
    as(UA.androidWebView);
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    tap(renderLink());
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(await screen.findByText("Press and hold the link to copy it.")).toBeInTheDocument();
  });

  it("closes, and leaves the visitor where they were", () => {
    as(UA.instagramIos);
    tap(renderLink());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("in the installed app, starts the login itself and signs the app in once Discord is done elsewhere", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    as(UA.homeScreenIos);
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(display-mode: standalone)" }) as MediaQueryList);
    const DISCORD = "https://discord.com/oauth2/authorize?state=s";
    const answers = ["waiting", "done"];
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith("/auth/handoff?")
        ? new Response(JSON.stringify({ url: DISCORD }), { status: 200 })
        : new Response(JSON.stringify({ status: answers.shift() }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.spyOn(nav, "assign").mockImplementation(() => undefined);
    const reload = vi.spyOn(nav, "reload").mockImplementation(() => undefined);
    expect(tap(renderLink())).toBe(false); // the app opens Discord itself
    await screen.findByRole("dialog", { name: "Finish signing in with Discord" });
    expect(fetchMock.mock.calls[0]![0]).toBe("/auth/handoff?next=%2F");
    expect(assign).toHaveBeenCalledWith(DISCORD);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HANDOFF_POLL_MS * 2 + 10);
    });
    expect(fetchMock.mock.calls.filter(([u]) => u === "/auth/handoff/claim")).toHaveLength(2);
    expect(reload.mock.calls.length + assign.mock.calls.filter(([u]) => u === "/").length).toBe(1);
    vi.useRealTimers();
  });

  it("in the installed app, says so when the login ran out, with a way to start again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    as(UA.homeScreenIos);
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(display-mode: standalone)" }) as MediaQueryList);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("/auth/handoff?")
          ? new Response(JSON.stringify({ url: "https://discord.com/oauth2/authorize?state=s" }), { status: 200 })
          : new Response(JSON.stringify({ status: "gone" }), { status: 200 }),
      ),
    );
    vi.spyOn(nav, "assign").mockImplementation(() => undefined);
    tap(renderLink());
    await screen.findByRole("dialog", { name: "Finish signing in with Discord" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HANDOFF_POLL_MS + 10);
    });
    expect(screen.getByRole("dialog", { name: "That sign-in ran out" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("in the installed app, falls back to the plain login when the server gives no handoff", async () => {
    as(UA.homeScreenIos);
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(display-mode: standalone)" }) as MediaQueryList);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
    const assign = vi.spyOn(nav, "assign").mockImplementation(() => undefined);
    tap(renderLink());
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith(HREF));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
