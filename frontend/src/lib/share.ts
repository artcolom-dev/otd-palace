// Sharing a deal: its public page on this site (/d/<listing id>), through the browser's share sheet when it has one,
// else copied to the clipboard. The link carries nothing about the sharer.
import type { Deal } from "../data/types";
import { formatPct, formatRax } from "./format";

export type ShareResult = "shared" | "copied" | "cancelled" | "failed";

/** A deal's public page; `origin` is this site's address (the page's own by default). */
export function shareUrl(listingId: number, origin: string = location.origin): string {
  return `${origin}/d/${listingId}`;
}

type Shareable = Pick<Deal, "listing_id" | "player_name" | "price" | "kind" | "discount">;

/**
 * Shares the deal's page: the share sheet if there is one (closing it is no error), else the clipboard. `failed` hands
 * the link back to be copied by hand. Never throws.
 */
export async function shareDeal(
  deal: Shareable,
  nav: Navigator = navigator,
  origin: string = location.origin,
): Promise<{ result: ShareResult; url: string }> {
  const url = shareUrl(deal.listing_id, origin);
  if (typeof nav.share === "function") {
    try {
      await nav.share({
        title: `${deal.player_name} · OTD Palace`,
        text: `${deal.player_name}: ${formatRax(deal.price)} Rax ${deal.kind === "target" ? "to start" : "top bid"}, ${formatPct(deal.discount)} under the usual price.`,
        url,
      });
      return { result: "shared", url };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return { result: "cancelled", url };
      // the sheet broke: the clipboard is the next best thing
    }
  }
  try {
    if (!nav.clipboard) return { result: "failed", url };
    await nav.clipboard.writeText(url);
    return { result: "copied", url };
  } catch {
    return { result: "failed", url };
  }
}
