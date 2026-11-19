// Small pieces every part of the Passes tab draws: the rarity swatch, the drawn pass card and its fan, the tags.
import type { ReactNode } from "react";
import { useApp } from "../../AppContext";
import { multText, tierName } from "../../content/passWords";
import type { PassMarket, PassRung } from "../../data/types";
import { cls } from "../../lib/cls";
import { formatRax } from "../../lib/format";
import { tierIndex } from "../../lib/passes";
import { initials, shortName } from "../../lib/words";
import { TermButton } from "../InfoTip";
import { type AvatarSize, CardFace, PlayerAvatar } from "../PlayerAvatar";
import { RarityTag } from "../RarityTag";

/** The rarity's colour token class (`rar-0` General … `rar-7` Iconic), by its place on the pass's ladder. */
export function useRarity() {
  const { snap } = useApp();
  return (kind: string, tier: string) => `rar-${tierIndex(kind, tier, snap.rules.otd)}`;
}

export function Swatch({ kind, tier }: { kind: string; tier: string }) {
  const rar = useRarity();
  return <span className={cls("sw", rar(kind, tier))} aria-hidden="true" />;
}

/** A rarity in words with its swatch: "▮ Legendary". */
export function Rarity({ kind, tier, suffix, label }: { kind: string; tier: string; suffix?: ReactNode; label?: string | null }) {
  const { snap } = useApp();
  return <RarityTag rarity={tierIndex(kind, tier, snap.rules.otd)} label={label} suffix={suffix} />;
}

/** A pass's face in a row: the player's photo in the rarity's ring; a team's initials, since its id is no player's. */
export function PassFace({ market, rarity, size }: {
  market: Pick<PassMarket, "sport" | "player_id" | "player_name" | "team_id" | "kind">;
  rarity: string;
  size?: AvatarSize;
}) {
  return (
    <PlayerAvatar
      sport={market.sport}
      playerId={market.player_id}
      name={market.player_name}
      rarity={rarity}
      teamId={market.team_id}
      photo={market.kind !== "team"}
      size={size}
    />
  );
}

type Spot = "l" | "rt" | "m" | "p";

/**
 * One drawn pass: our own frame in the rarity's colour, its multiplier and entry rating, the player's photo (else a
 * monogram; always one for a team, whose id is no player's), a name.
 */
export function PassArtCard({ market, tier, spot, label }: { market: PassMarket; tier: [string, number, number]; spot: Spot; label?: string }) {
  const rar = useRarity();
  const mono = market.kind === "team" ? initials(market.player_name).slice(0, 3) : initials(market.player_name);
  return (
    <div className={cls("card", spot, rar(market.kind, tier[0]))} data-spot={spot}>
      <div className="ct">
        <b>{multText(tier[2])}</b>
        <span>{formatRax(tier[1])}</span>
      </div>
      <CardFace sport={market.sport} playerId={market.player_id} name={market.player_name} photo={market.kind !== "team"} mono={mono} />
      <div className="strip">{label ?? shortName(market.player_name)}</div>
    </div>
  );
}

/** The ladder as a hand: the rarity below, the pick, the rarity above. */
export function PassFan({ market, rung, single = false }: { market: PassMarket; rung: PassRung; single?: boolean }) {
  const { snap } = useApp();
  const ladder = snap.rules.otd.ladders[market.kind] ?? [];
  const i = ladder.findIndex(([t]) => t === rung.tier);
  const below = ladder[i - 1];
  const above = ladder[i + 1];
  const pick = ladder[i] ?? [rung.tier, rung.rating, rung.mult];
  return (
    <div className={cls("fan", single && "single")} aria-hidden="true">
      {!single && below && <PassArtCard market={market} tier={below} spot="l" label={tierName(below[0])} />}
      {!single && above && <PassArtCard market={market} tier={above} spot="rt" label={tierName(above[0])} />}
      <PassArtCard market={market} tier={pick} spot="m" />
    </div>
  );
}

/** "projection" and "estimated limit": tags that explain themselves when tapped (plain words on a phone). */
export function PassTags({ market, rung }: { market: PassMarket; rung: PassRung | null }) {
  const { layout } = useApp();
  const tags: [ReactNode, "projection" | "estimate"][] = [];
  if (rung?.projected) tags.push(["projection", "projection"]);
  if (rung?.limit_estimated) tags.push(["estimated limit", "estimate"]);
  if (!tags.length) return null;
  return (
    <>
      {tags.map(([text, term]) =>
        layout.phone ? (
          <span key={term} className="tg">
            {text}
          </span>
        ) : (
          <TermButton key={term} term={term} className="tg">
            {text}
          </TermButton>
        ),
      )}
      {market.month_share_estimated && <span className="tg">months estimated</span>}
    </>
  );
}
