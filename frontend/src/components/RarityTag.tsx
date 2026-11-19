// A rarity, the one way every screen shows it: Real's colour as a small card-shaped swatch, then Real's name for it,
// with its sub-level when Real's label gives one ("▮ Legendary 3"). Deals, the top tiles, passes and the analysis all
// draw this; the colour comes from the --rarity-N tokens through the rar-N class.
import type { ReactNode } from "react";
import { rarityClass, rarityLabel } from "../content/real";
import { cls } from "../lib/cls";

export function RarityTag({ rarity, label, suffix, className }: {
  rarity: number;
  label?: string | null;
  suffix?: ReactNode;
  className?: string;
}) {
  return (
    <span className={cls("rar", rarityClass(rarity), className)}>
      <span className="sw" aria-hidden="true" />
      {rarityLabel(rarity, label)}
      {suffix}
    </span>
  );
}
