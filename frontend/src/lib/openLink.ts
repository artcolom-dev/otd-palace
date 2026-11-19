const REAL_ANDROID_PACKAGE = "vg.real";

/** Real's own home page: where the daily checklist sends a visitor (the site knows no other address in the app). */
export const REAL_HOME = "https://www.realapp.com/";

/**
 * The address to put on a link to Real's site: on Android an intent that opens the Real app and falls back
 * to the web link when it is not installed; everywhere else the link itself.
 */
export function toOpenUrl(url: string, userAgent: string): string {
  if (!/android/i.test(userAgent)) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== "https:") return url;
  // A fragment would end the intent's address early, so only the fallback keeps it.
  const target = `${parsed.host}${parsed.pathname}${parsed.search}`;
  return `intent://${target}#Intent;scheme=https;package=${REAL_ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(url)};end`;
}
