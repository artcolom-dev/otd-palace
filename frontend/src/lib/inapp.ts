// An app's built-in browser (Instagram, Facebook, TikTok, a chat app...) and the way out of it to the phone's own
// browser, for the sign-in: a session made in an app's web view stays in that app, so the visitor is signed out the
// next time they open the site in Safari or Chrome. The sign-in should start in the phone's browser: the login's
// state cookie is set there, Discord sends them back there, and the session lives there.
//
// What can be told apart: an iOS web view says no "Safari/" (Safari, Chrome, Firefox and Edge on iOS all do), and an
// Android web view says "; wv)". What cannot: Discord opens links in Safari's own in-app view on iOS
// (SFSafariViewController) and in a Custom Tab of the default browser on Android; both send that browser's user agent.
// On Android the Custom Tab shares the default browser's cookies, so there is nothing to fix there. See
// the internal research notes for what each app does and the sources.
import { isIos, isStandalone } from "./install";

export type InAppKey =
  | "instagram"
  | "threads"
  | "facebook"
  | "messenger"
  | "tiktok"
  | "snapchat"
  | "x"
  | "linkedin"
  | "line"
  | "wechat"
  | "whatsapp"
  | "reddit"
  | "google"
  | "discord";

export interface InApp {
  os: "ios" | "android";
  /** The app, when its user agent names it; null for a web view that does not say whose it is. */
  app: InAppKey | null;
  /** The app's name, as a sentence says it; null when unknown. */
  name: string | null;
}

/** The apps' marks in their user agents, the more specific first (Messenger's also says FBAN). */
const APPS: readonly { key: InAppKey; name: string; mark: RegExp }[] = [
  { key: "messenger", name: "Messenger", mark: /\bFBAN\/Messenger|\bMessengerForiOS|\bFB_IAB\/MESSENGER|\bOrca-Android/i },
  { key: "instagram", name: "Instagram", mark: /\bInstagram\b/ },
  { key: "threads", name: "Threads", mark: /\bBarcelona\b/ },
  { key: "facebook", name: "Facebook", mark: /\bFBAN\/|\bFBAV\/|\bFB_IAB\/|\bFBIOS\b|\bFB4A\b/ },
  { key: "tiktok", name: "TikTok", mark: /musical_ly|Bytedance|\btrill_/i },
  { key: "snapchat", name: "Snapchat", mark: /\bSnapchat\b/i },
  { key: "x", name: "X", mark: /\bTwitter\b/i },
  { key: "linkedin", name: "LinkedIn", mark: /\bLinkedInApp\b/ },
  { key: "line", name: "LINE", mark: /\bLine\/\d/ },
  { key: "wechat", name: "WeChat", mark: /\bMicroMessenger\// },
  { key: "whatsapp", name: "WhatsApp", mark: /\b(WAiOS|WA4A)\// },
  { key: "reddit", name: "Reddit", mark: /\bReddit\//i },
  { key: "google", name: "the Google app", mark: /\bGSA\// },
  { key: "discord", name: "Discord", mark: /\bDiscord\// },
];

/**
 * The app's built-in browser this page runs in, or null in a real browser (or one we cannot tell from it). The site
 * on the home screen is never one: on iOS it has its own cookies, apart from Safari's, so its sign-in stays inside it.
 */
export function detectInApp(ua: string, { standalone = false }: { standalone?: boolean } = {}): InApp | null {
  if (standalone) return null;
  const known = APPS.find((a) => a.mark.test(ua)) ?? null;
  const named = (os: InApp["os"]): InApp => ({ os, app: known?.key ?? null, name: known?.name ?? null });
  if (isIos(ua)) return known || !/Safari\//.test(ua) ? named("ios") : null;
  if (/Android/.test(ua)) return known || /; wv\)/.test(ua) ? named("android") : null;
  return null;
}

/** The in-app browser this visit runs in, from the browser's own user agent; null in a real browser. */
export function inAppHere(): InApp | null {
  if (typeof navigator === "undefined") return null;
  return detectInApp(navigator.userAgent, { standalone: isStandalone() });
}

/** The sign-in link on this site, whole (a link that leaves the app must say where it goes). */
export function signInUrl(href: string, origin: string = location.origin): string {
  return new URL(href, origin).href;
}

export interface Escape {
  href: string;
  /** "Open in Safari" (iOS can only name Safari) or "Open in your browser". */
  label: string;
  /** Open in a new window: Facebook on iOS hands a new window to Safari, and nothing else. */
  newTab: boolean;
}

/**
 * The link that opens `url` (the sign-in, whole) in the phone's own browser from this app's web view, or null where
 * the app lets nothing out. Each is followed only on a tap, never on its own; the steps by hand stay beside it.
 * - Android: a packageless intent, which the system hands to the default browser (Chrome, Samsung Internet, ...).
 * - iOS Instagram and Threads: their own open-outside links.
 * - iOS Facebook: a new window, which it gives to Safari.
 * - iOS TikTok, WeChat, Snapchat, X: nothing gets out; the steps by hand only.
 * - Any other iOS web view: x-safari-https, which opens Safari (iOS 17 and later).
 */
export function escapeTo(url: string, inApp: InApp): Escape | null {
  const target = new URL(url);
  target.hash = ""; // the intent's own part follows the #
  const whole = target.href;
  if (inApp.os === "android") {
    const href = `intent://${target.host}${target.pathname}${target.search}#Intent;scheme=https;S.browser_fallback_url=${encodeURIComponent(whole)};end`;
    return { href, label: "Open in your browser", newTab: false };
  }
  switch (inApp.app) {
    case "instagram":
      return { href: `instagram://extbrowser/?url=${encodeURIComponent(whole)}`, label: "Open in your browser", newTab: false };
    case "threads":
      return { href: `barcelona://extbrowser/?url=${encodeURIComponent(whole)}`, label: "Open in your browser", newTab: false };
    case "facebook":
      return { href: whole, label: "Open in Safari", newTab: true };
    case "tiktok":
    case "wechat":
    case "snapchat":
    case "x":
      return null;
    default:
      return { href: `x-safari-${whole}`, label: "Open in Safari", newTab: false };
  }
}

/** Where the app's own menu is, to open this page in the browser by hand. */
export function manualStep(inApp: InApp): string {
  const meta = inApp.app === "instagram" || inApp.app === "threads" || inApp.app === "facebook" || inApp.app === "messenger";
  if (inApp.os === "ios") {
    if (meta) return "Tap ⋯ at the top right, then Open in external browser.";
    if (inApp.app === "tiktok") return "Tap ⋯ at the top right, then Open in browser.";
    return "Open this app's menu (⋯ or the share icon), then Open in Safari.";
  }
  if (meta || inApp.app === "tiktok") return "Tap ⋮ or ⋯ at the top right, then Open in browser (or Open in Chrome).";
  return "Open this app's menu (⋮ or ⋯), then Open in browser.";
}

/**
 * Whether this may be Discord's in-app view on iOS: Safari's own in-app view (SFSafariViewController) sends Safari's
 * user agent, so it is any iOS visit that looks like Safari (not Chrome, Firefox, Edge or Opera, not an app's web
 * view, not the home-screen app). Only a line of advice may hang on it, never a detour: Safari itself says the same.
 */
export function maybeSafariView(ua: string, { standalone = false }: { standalone?: boolean } = {}): boolean {
  if (standalone || !isIos(ua) || detectInApp(ua)) return false;
  return /Version\/[\d.]+ .*Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\//.test(ua);
}
