// "Support the Palace": how to give Rax to the site, in a drawer (desktop) or a tall sheet (phone). From the footer
// and from the address (#support). On Real, Rax moves from one account to another through the market only, so the
// sheet names the account to look for (`links.support.account`), offers to copy its name and, when the server has one
// (`links.support.url`), links one of its cards. A gift buys nothing: the sheet says so. Without `links.support`
// (an older snapshot), the footer has no such link and the address opens nothing.
import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../AppContext";
import type { Links } from "../data/types";
import { tabPath } from "../lib/tabHint";
import { Icon } from "./Icon";
import { type OverlayContentProps, useOverlay } from "./Overlay";

export const SUPPORT_HASH = "#support";
export const SUPPORT_TITLE = "Support the Palace";

/** The account a gift goes to and its card's link, or null when the snapshot names none (or names it badly). */
export function supportOf(links: Links | undefined): { account: string; url: string | null } | null {
  const s: unknown = links?.support;
  if (typeof s !== "object" || s === null) return null;
  const { account, url } = s as { account?: unknown; url?: unknown };
  if (typeof account !== "string" || !/^[A-Za-z0-9_.-]{2,32}$/.test(account)) return null;
  return { account, url: typeof url === "string" && url.startsWith("https://www.realapp.com/") ? url : null };
}

export function SupportSheet({ ctx, account, url }: { ctx: OverlayContentProps; account: string; url: string | null }) {
  const { tab } = useApp();
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const [said, setSaid] = useState("");

  // The address says where the visitor is while the sheet is open, and goes back to the tab when it closes.
  useEffect(() => {
    history.replaceState(null, "", SUPPORT_HASH);
    return () => history.replaceState(null, "", `${tabPath(tabRef.current)}${location.search}`);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(account);
      setSaid("Copied.");
    } catch {
      setSaid(`Type it in Real's search: ${account}`); // many web views give no clipboard
    }
  };

  return (
    <div className="hws support">
      {ctx.phone && (
        <span id={ctx.titleId} className="sr">
          {SUPPORT_TITLE}
        </span>
      )}
      <div className="dwhd">
        <div className="dwtitle">
          <h2 id={ctx.phone ? undefined : ctx.titleId}>{SUPPORT_TITLE}</h2>
          <p className="meta">Give Rax, if the site saved you some</p>
        </div>
      </div>
      <div className="dwbody">
        <div className="how-list">
          <section className="how-item" aria-labelledby="support-why">
            <h3 id="support-why">Free, and it stays free</h3>
            <p>
              OTD Palace costs nothing and a gift buys nothing: every member keeps the same deals, passes and alerts. If
              it saved you Rax and you want to give some back, this is how.
            </p>
          </section>
          <section className="how-item" aria-labelledby="support-how">
            <h3 id="support-how">How to give Rax</h3>
            <p>On Real, Rax goes from one account to another through the market: you bid on a card the other account sells.</p>
            <ol className="support-steps">
              <li>
                In Real, search for the account <b className="support-name">{account}</b>.{" "}
                <button type="button" className="tlink" onClick={copy}>
                  Copy the name
                </button>
              </li>
              <li>Bid on a card that account has on sale, for the amount you want to give.</li>
              <li>If your bid wins when the auction ends, your Rax goes to the Palace and the card is yours. Real keeps its usual fee.</li>
            </ol>
            <p className="support-said" role="status">
              {said}
            </p>
            {url && (
              <a className="tlink how-go" href={url} target="_blank" rel="noopener noreferrer">
                Open the Palace's card on Real
                <Icon name="ext" />
              </a>
            )}
          </section>
          <section className="how-item" aria-labelledby="support-none">
            <h3 id="support-none">No card on sale?</h3>
            <p>Then there is nothing to bid on right now. Come back later, or say so in our Discord.</p>
          </section>
        </div>
        <p className="how-note">A gift is your choice and cannot be taken back. Not affiliated with Real.</p>
      </div>
    </div>
  );
}

/** Opens the sheet from `anchor` (focus returns there when it closes); null while the snapshot names no account. */
export function useOpenSupport() {
  const overlay = useOverlay();
  const { layout, snap } = useApp();
  const support = supportOf(snap.links);
  const account = support?.account ?? null;
  const url = support?.url ?? null;
  const open = useCallback(
    (anchor: HTMLElement | null) => {
      if (account === null) return;
      overlay.open({
        title: SUPPORT_TITLE,
        anchor,
        layer: "panel",
        body: (ctx) => <SupportSheet ctx={{ ...ctx, phone: layout.phone }} account={account} url={url} />,
      });
    },
    [overlay, layout.phone, account, url],
  );
  return account === null ? null : open;
}

/** The footer's link; nothing while the snapshot names no account. */
export function SupportLink({ className }: { className?: string }) {
  const open = useOpenSupport();
  if (open === null) return null;
  return (
    <button type="button" className={className ?? "tlink howlink"} aria-haspopup="dialog" onClick={(e) => open(e.currentTarget)}>
      {SUPPORT_TITLE}
    </button>
  );
}

/** Opens the sheet for an address that asks for it (#support), at load and whenever the address changes. */
export function SupportFromAddress() {
  const open = useOpenSupport();
  const openRef = useRef(open);
  openRef.current = open;
  const ready = open !== null;
  useEffect(() => {
    const check = () => {
      if (location.hash.toLowerCase() === SUPPORT_HASH) openRef.current?.(null);
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, [ready]);
  return null;
}
