import { describe, expect, it } from "vitest";
import { isIos, isIosInApp } from "./install";

const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const CHROME_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1";
const WEBVIEW = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 357.0.0.25.101";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36";

describe("where a visitor can add the site to the home screen", () => {
  it("tells an app's own browser on iOS from Safari and the other iOS browsers", () => {
    expect(isIos(WEBVIEW)).toBe(true);
    expect(isIosInApp(WEBVIEW)).toBe(true);
    expect(isIosInApp(SAFARI)).toBe(false);
    expect(isIosInApp(CHROME_IOS)).toBe(false);
    expect(isIosInApp(ANDROID)).toBe(false);
  });
});
