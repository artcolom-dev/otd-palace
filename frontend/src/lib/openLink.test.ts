import { describe, expect, it } from "vitest";
import { toOpenUrl } from "./openLink";

const url = "https://www.realapp.com/D5h7FRFWPOKGR";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)";
const ANDROID = "Mozilla/5.0 (Linux; Android 15)";
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

describe("toOpenUrl", () => {
  it("leaves the link alone on iOS and desktop", () => {
    expect(toOpenUrl(url, IPHONE)).toBe(url);
    expect(toOpenUrl(url, DESKTOP)).toBe(url);
    expect(toOpenUrl(url, "")).toBe(url);
  });

  it("turns the link into an Android intent for the Real app, falling back to the web link", () => {
    const intent = toOpenUrl(url, ANDROID);
    expect(intent.startsWith("intent://www.realapp.com/D5h7FRFWPOKGR#Intent;scheme=https;package=vg.real;")).toBe(true);
    expect(intent).toContain("S.browser_fallback_url=https%3A%2F%2Fwww.realapp.com%2FD5h7FRFWPOKGR");
    expect(intent.endsWith(";end")).toBe(true);
  });

  it("matches Android case-insensitively", () => {
    expect(toOpenUrl(url, "mozilla/5.0 (linux; android 14)")).toMatch(/^intent:\/\//);
  });

  it("keeps a query string in the intent and encodes the whole link in the fallback", () => {
    const withQuery = "https://www.realapp.com/c/42?ref=site&x=1";
    const intent = toOpenUrl(withQuery, ANDROID);
    expect(intent.startsWith("intent://www.realapp.com/c/42?ref=site&x=1#Intent;")).toBe(true);
    expect(intent).toContain(`S.browser_fallback_url=${encodeURIComponent(withQuery)};end`);
  });

  it("drops a fragment from the intent part, which a second # would break", () => {
    const intent = toOpenUrl("https://www.realapp.com/a#top", ANDROID);
    expect(intent.startsWith("intent://www.realapp.com/a#Intent;")).toBe(true);
    expect(intent.match(/#/g)).toHaveLength(1);
  });

  it("leaves anything that is not an https link alone", () => {
    expect(toOpenUrl("http://www.realapp.com/a", ANDROID)).toBe("http://www.realapp.com/a");
    expect(toOpenUrl("not a url", ANDROID)).toBe("not a url");
  });
});
