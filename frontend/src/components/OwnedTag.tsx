import type { Deal } from "../data/types";
import { type Owned, dealOwned, ownedText } from "../lib/owned";

/** On a deal whose pass the visitor holds at the card's rarity or higher: "You own this one at Epic"; else nothing. */
export function OwnedTag({ deal, owned }: { deal: Pick<Deal, "sport" | "season" | "player_id" | "rarity">; owned: ReadonlyMap<string, Owned> }) {
  const tier = dealOwned(deal, owned);
  return tier ? <span className="owntag">{ownedText(tier)}</span> : null;
}
