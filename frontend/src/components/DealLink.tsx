// One deal as a compact row that is the link to its auction: a face, the name and the facts, the price and how far
// under the usual price. Similar deals, the budget buddy's list and the like all draw their rows with it.
import { useApp } from "../AppContext";
import type { Deal } from "../data/types";
import { formatPct, formatRax } from "../lib/format";
import { toOpenUrl } from "../lib/openLink";
import { rarityClass, ratingText, sportLabel, seasonLabel } from "../lib/words";
import { Icon } from "./Icon";
import type { Paused } from "./Paused";
import { PlayerAvatar } from "./PlayerAvatar";

const userAgent = () => (typeof navigator === "undefined" ? "" : navigator.userAgent);

/**
 * The row for `deal`. Opening it is opening the deal: the click is counted at `pos` and the deal is marked opened, as
 * any Open in Real is. `paused` describes the link by the paused notice while the data is paused.
 */
export function DealLink({ deal, pos, paused }: { deal: Deal; pos: number; paused?: Paused }) {
  const { openDeal, prefs } = useApp();
  const word = prefs.level === "new" ? "cheaper" : "under";
  const unit = deal.kind === "target" ? "to start" : "top bid";
  const facts = `${sportLabel(deal.sport)} ${seasonLabel(deal.sport, deal.season)} · ${ratingText(deal.rating)}`;
  return (
    <a
      className="dl"
      href={toOpenUrl(deal.url, userAgent())}
      target="_blank"
      rel="noopener noreferrer"
      // The name says the row's own words in their order (a voice command can use any of them), then where it goes.
      aria-label={`${deal.player_name}, ${facts}: ${formatRax(deal.price)} ${unit}, ${formatPct(deal.discount)} ${word}. Opens in Real`}
      {...paused?.actionProps}
      onClick={() => openDeal(deal, "deals", pos)}
      onAuxClick={(e) => {
        if (e.button === 1) openDeal(deal, "deals", pos); // a middle-click opens it in a new tab
      }}
    >
      <PlayerAvatar sport={deal.sport} playerId={deal.player_id} name={deal.player_name} rarity={rarityClass(deal.rarity)} size={28} />
      <span className="dln">
        <span className="dlnm">{deal.player_name}</span>
        <span className="dlm">
          {facts}
        </span>
      </span>
      <span className="dlp">
        <span className="dlpr">
          {formatRax(deal.price)} <span className="dlu">{unit}</span>
        </span>
        <span className={deal.falling ? "dlpc grey" : "dlpc"}>
          {formatPct(deal.discount)} {word}
        </span>
      </span>
      <Icon name="ext" />
    </a>
  );
}
