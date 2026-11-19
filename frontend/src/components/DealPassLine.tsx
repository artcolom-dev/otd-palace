import { useMemo } from "react";
import { useApp } from "../AppContext";
import type { Deal, PassMarket } from "../data/types";
import { cls } from "../lib/cls";
import { dealOffer, dealOfferWords } from "../lib/dealOffer";
import { dealPass, dealPassMarket, dealPassWords, passMarketIndex, servedMarkets } from "../lib/dealPass";
import { offerHintSwitch } from "../lib/offerHintSwitch";
import { type Owned, heldFor } from "../lib/owned";
import { dayOf } from "../lib/passes";
import { useAccess } from "./Access";
import { TermTip } from "./InfoTip";
import { useOpenPass } from "./passes/PassCard";

/** The served passes by key, this season's too, once per snapshot: what a deal's card builds is looked up in it. */
export function usePassIndex(): ReadonlyMap<string, PassMarket> {
  const { snap } = useApp();
  const { markets, current_markets } = snap.otd;
  return useMemo(() => passMarketIndex(servedMarkets({ markets, current_markets })), [markets, current_markets]);
}

/**
 * Under a deal whose card builds a pass the site tracks: a "Pass" chip that opens that pass, the card's share of the
 * next rarity at its price per point against the pass's usual, what that rarity pays when the card reaches it, and an
 * offer (or why none). Nothing for a deal that builds no tracked pass. In the phone list the row is a link: the chip
 * sits above it, as the star does.
 *
 * A member at the Pro level reads, as the offer, what accepted offers on cards like this one went for (lib/dealOffer.ts,
 * behind lib/offerHintSwitch.ts) whenever the feed measured the card's cell, and that alone, with no chip, on a deal
 * whose pass has nothing else to say. Everyone else reads the line as before.
 */
export function DealPassLine({
  deal,
  index,
  owned,
  as = "row",
}: {
  deal: Deal;
  index: ReadonlyMap<string, PassMarket>;
  owned: ReadonlyMap<string, Owned>;
  as?: "row" | "cell";
}) {
  const { snap, prefs } = useApp();
  const { state } = useAccess();
  const openPass = useOpenPass();
  const market = dealPassMarket(deal, index);
  if (!market) return null;
  const dp = dealPass(deal, market, snap.rules.otd, dayOf(snap.otd.as_of), heldFor(deal, owned));
  // The whole site's reader (a member, or anyone with the gate off) at the Pro level; never the free site's.
  const member = (state === "in" || state === "open") && !snap.locked;
  const measured = offerHintSwitch.on && member && prefs.level === "pro" ? dealOffer(deal, market, snap.rules.quicksell_per_point) : null;
  const hint = measured && dealOfferWords(measured);
  if (!dp && !hint) return null;
  const w = dp && dealPassWords(dp, prefs.level);
  const offer = hint ? hint.text : (w?.offer ?? null);
  const tip = hint ? hint.offerable : dp !== null && dp.offer !== null;
  const Tag = as === "row" ? "span" : "div";
  return (
    <Tag className={cls("dpass", as === "row" && "ln")} data-testid="deal-pass">
      {dp && w && (
        <button
          type="button"
          className="dpass-chip"
          aria-label={w.label}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openPass(market, dp.target.tier, e.currentTarget);
          }}
        >
          {w.chip}
        </button>
      )}
      <span className="dpass-tx">
        {w?.line}
        {w?.pay && <b className="dpass-pay"> {w.pay}</b>}
        {offer && (
          <span className="dpass-off" data-testid={hint ? "deal-offer" : undefined}>
            {w ? " " : ""}
            {hint ? (
              <>
                {/* The short form for the eye, the full sentences for a screen reader (lib/dealOffer.ts). */}
                <span aria-hidden="true" data-testid="deal-offer-short">
                  {hint.text}
                </span>
                <span className="sr">{hint.spoken}</span>
              </>
            ) : (
              offer
            )}
            {tip && <TermTip term="offer" />}
          </span>
        )}
      </span>
    </Tag>
  );
}
