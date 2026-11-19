import { describe, expect, it } from "vitest";
import { detectInApp, escapeTo, maybeSafariView, manualStep, signInUrl } from "./inapp";
import { UA } from "./inapp.fixtures";


const SIGN_IN = "https://otdpalace.com/auth/discord?next=%2F%23deals";

describe("an app's built-in browser, told from a real browser", () => {
  it("leaves real browsers alone, on phones and desktops", () => {
    for (const ua of [
      UA.safariIos,
      UA.chromeIos,
      UA.firefoxIos,
      UA.chromeAndroid,
      UA.samsungInternet,
      UA.desktopChrome,
      UA.desktopSafari,
    ]) {
      expect(detectInApp(ua)).toBeNull();
    }
  });

  it("cannot tell Discord's in-app view from the browser it borrows (Safari's view on iOS, a Custom Tab on Android)", () => {
    expect(detectInApp(UA.discordIos)).toBeNull();
    expect(detectInApp(UA.discordAndroid)).toBeNull();
  });

  it("names the iOS apps that open links in their own web view", () => {
    expect(detectInApp(UA.instagramIos)).toEqual({ os: "ios", app: "instagram", name: "Instagram" });
    expect(detectInApp(UA.threadsIos)).toEqual({ os: "ios", app: "threads", name: "Threads" });
    expect(detectInApp(UA.facebookIos)).toEqual({ os: "ios", app: "facebook", name: "Facebook" });
    expect(detectInApp(UA.messengerIos)).toEqual({ os: "ios", app: "messenger", name: "Messenger" });
    expect(detectInApp(UA.tiktokIos)).toEqual({ os: "ios", app: "tiktok", name: "TikTok" });
    expect(detectInApp(UA.googleAppIos)).toEqual({ os: "ios", app: "google", name: "the Google app" });
    expect(detectInApp(UA.lineIos)).toEqual({ os: "ios", app: "line", name: "LINE" });
  });

  it("catches an unknown iOS web view by the missing Safari/", () => {
    expect(detectInApp(UA.otherIosWebView)).toEqual({ os: "ios", app: null, name: null });
  });

  it("does not take the site on the home screen for an app's browser", () => {
    expect(detectInApp(UA.homeScreenIos, { standalone: true })).toBeNull();
    expect(detectInApp(UA.instagramAndroid, { standalone: true })).toBeNull();
  });

  it("catches Android web views (; wv)) and names the known apps", () => {
    expect(detectInApp(UA.androidWebView)).toEqual({ os: "android", app: null, name: null });
    expect(detectInApp(UA.instagramAndroid)).toEqual({ os: "android", app: "instagram", name: "Instagram" });
    expect(detectInApp(UA.facebookAndroid)).toEqual({ os: "android", app: "facebook", name: "Facebook" });
    expect(detectInApp(UA.tiktokAndroid)).toEqual({ os: "android", app: "tiktok", name: "TikTok" });
  });
});

describe("the way out to the phone's own browser", () => {
  it("on Android, a packageless intent: the default browser opens the sign-in itself", () => {
    const out = escapeTo(SIGN_IN, detectInApp(UA.androidWebView)!);
    expect(out).toEqual({
      href:
        "intent://otdpalace.com/auth/discord?next=%2F%23deals#Intent;scheme=https;" +
        "S.browser_fallback_url=https%3A%2F%2Fotdpalace.com%2Fauth%2Fdiscord%3Fnext%3D%252F%2523deals;end",
      label: "Open in your browser",
      newTab: false,
    });
    expect(out!.href).not.toContain("package=");
    expect(escapeTo(SIGN_IN, detectInApp(UA.instagramAndroid)!)!.href).toMatch(/^intent:\/\/otdpalace\.com\//);
    expect(escapeTo(SIGN_IN, detectInApp(UA.facebookAndroid)!)!.href).toMatch(/^intent:\/\/otdpalace\.com\//);
  });

  it("on iOS, Instagram and Threads through their own open-outside link", () => {
    expect(escapeTo(SIGN_IN, detectInApp(UA.instagramIos)!)).toEqual({
      href: `instagram://extbrowser/?url=${encodeURIComponent(SIGN_IN)}`,
      label: "Open in your browser",
      newTab: false,
    });
    expect(escapeTo(SIGN_IN, detectInApp(UA.threadsIos)!)!.href).toBe(
      `barcelona://extbrowser/?url=${encodeURIComponent(SIGN_IN)}`,
    );
  });

  it("on iOS, Facebook through a new window (the one way it hands a link to Safari)", () => {
    expect(escapeTo(SIGN_IN, detectInApp(UA.facebookIos)!)).toEqual({
      href: SIGN_IN,
      label: "Open in Safari",
      newTab: true,
    });
  });

  it("on iOS, other web views through Safari's x-safari-https link", () => {
    for (const ua of [UA.messengerIos, UA.googleAppIos, UA.lineIos, UA.otherIosWebView]) {
      expect(escapeTo(SIGN_IN, detectInApp(ua)!)).toEqual({
        href: "x-safari-https://otdpalace.com/auth/discord?next=%2F%23deals",
        label: "Open in Safari",
        newTab: false,
      });
    }
  });

  it("offers no button where the app blocks every way out (TikTok on iOS)", () => {
    expect(escapeTo(SIGN_IN, detectInApp(UA.tiktokIos)!)).toBeNull();
  });

  it("says where the app's own menu is, for when nothing opens", () => {
    expect(manualStep(detectInApp(UA.instagramIos)!)).toBe("Tap ⋯ at the top right, then Open in external browser.");
    expect(manualStep(detectInApp(UA.facebookAndroid)!)).toBe(
      "Tap ⋮ or ⋯ at the top right, then Open in browser (or Open in Chrome).",
    );
    expect(manualStep(detectInApp(UA.tiktokIos)!)).toBe("Tap ⋯ at the top right, then Open in browser.");
    expect(manualStep(detectInApp(UA.otherIosWebView)!)).toBe(
      "Open this app's menu (⋯ or the share icon), then Open in Safari.",
    );
    expect(manualStep(detectInApp(UA.androidWebView)!)).toBe(
      "Open this app's menu (⋮ or ⋯), then Open in browser.",
    );
  });
});

describe("the sign-in link, whole", () => {
  it("is the site's own login on this origin, coming back to the same page", () => {
    expect(signInUrl("/auth/discord?next=%2F%23deals", "https://otdpalace.com")).toBe(SIGN_IN);
  });
});

describe("where Discord's in-app view on iOS may be hiding", () => {
  it("is any iOS visit that looks like Safari (Safari's own view sends the same), outside the home-screen app", () => {
    expect(maybeSafariView(UA.discordIos)).toBe(true);
    expect(maybeSafariView(UA.safariIos)).toBe(true);
    expect(maybeSafariView(UA.homeScreenIos, { standalone: true })).toBe(false);
    expect(maybeSafariView(UA.safariIos, { standalone: true })).toBe(false);
  });

  it("is never another browser, an app's web view (it has its own sheet), Android or a desktop", () => {
    for (const ua of [UA.chromeIos, UA.firefoxIos, UA.instagramIos, UA.googleAppIos, UA.chromeAndroid, UA.desktopSafari]) {
      expect(maybeSafariView(ua)).toBe(false);
    }
  });
});
