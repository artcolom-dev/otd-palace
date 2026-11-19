import { describe, expect, it, vi } from "vitest";
import { claimHandoff, handsOff, nextOf, startHandoff } from "./handoff";
import { UA } from "./inapp.fixtures";

describe("the home-screen sign-in", () => {
  it("goes through a handoff only on a phone's home screen", () => {
    expect(handsOff(UA.homeScreenIos, true)).toBe(true);
    expect(handsOff(UA.chromeAndroid, true)).toBe(true);
    expect(handsOff(UA.safariIos, false)).toBe(false);
    expect(handsOff(UA.desktopChrome, true)).toBe(false); // a desktop app window keeps the login in it
  });

  it("reads the page to come back to from the sign-in link", () => {
    expect(nextOf("/auth/discord?next=%2F%23passes")).toBe("/#passes");
    expect(nextOf("/auth/discord")).toBe("/");
  });

  it("only opens a Discord address the server gives", async () => {
    const answer = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
    expect(await startHandoff("/", answer({ url: "https://discord.com/oauth2/authorize?x" }))).toBe(
      "https://discord.com/oauth2/authorize?x",
    );
    expect(await startHandoff("/", answer({ url: "https://evil.example/" }))).toBeNull();
    expect(await startHandoff("/", answer({}, 429))).toBeNull();
    expect(await startHandoff("/", vi.fn(async () => Promise.reject(new Error("offline"))))).toBeNull();
  });

  it("tells the claim's answers apart", async () => {
    const answer = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
    expect(await claimHandoff(answer({ status: "done" }))).toBe("done");
    expect(await claimHandoff(answer({ status: "waiting" }))).toBe("waiting");
    expect(await claimHandoff(answer({ status: "gone" }))).toBe("gone");
    expect(await claimHandoff(answer({ status: "???" }))).toBe("error");
    expect(await claimHandoff(answer({}, 429))).toBe("error");
  });
});
