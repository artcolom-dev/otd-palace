// Counts a click that leaves the site, for Real or our community, without saying anything about who clicked:
// where on the page it was, what it opened, the visitor's level and sport filter, and the row's position. "alert" is
// the deal a notification opened the page on, "share" the Open in Real button of a deal's public page (counted by that page), "routine" the daily checklist's links to the
// Real app (target "app").

import { track } from "./activity";

export interface OutMeta {
  panel: "hero" | "deals" | "moves" | "otd" | "community" | "alert" | "share" | "routine";
  target: "listing" | "card" | "community" | "app";
  level: string; // "new", "regular" or "pro"
  sport: string; // the sport filter, or "all"
  pos: number; // the row's position in its panel, 0 for the first
}

const OUT_URL = "/api/out";

/** Hand the body to the browser's beacon; false when there is none, or it refused or failed. */
function beacon(body: Blob): boolean {
  try {
    return typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function"
      ? navigator.sendBeacon(OUT_URL, body)
      : false;
  } catch {
    return false;
  }
}

/**
 * Report an outbound click, fire and forget: a beacon if the browser takes it, else a keepalive POST. It returns
 * at once, never throws and never waits on the network, so the link it sits on opens as if it were not there.
 */
export function trackOut(meta: OutMeta): void {
  track("out", meta.panel); // the same click, in the admin panel's feature use (under the visit id)
  try {
    const json = JSON.stringify(meta);
    if (beacon(new Blob([json], { type: "application/json" }))) return;
    fetch(OUT_URL, {
      method: "POST",
      body: json,
      headers: { "Content-Type": "application/json" },
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Counting is never worth breaking a click over.
  }
}
