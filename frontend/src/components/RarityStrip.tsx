// Deals by rarity: one row of chips, All then Real's eight rarities from General to Iconic, each in Real's colour (the
// --rarity-N tokens through the rar-N class, as RarityTag draws them) with how many deals it holds.
//
// A member (or anyone with the gate off) gets the working strip: the counts are live under every other filter (level,
// budget, sport or My players, search), a tap narrows the deals to that rarity, "And rarer" widens it to that rarity
// and every rarer one, and the choice is kept with the other prefs on this device. Anyone else gets the locked strip:
// the same chips, counted on the server from every deal a member sees (`locked.by_rarity`, eight counts and nothing
// else), and a tap opens the join page instead of filtering. A chip with 0 deals stays, quiet, so the row never jumps.
import { type KeyboardEvent, useId, useLayoutEffect, useRef } from "react";
import { useApp } from "../AppContext";
import { RARITIES, isRarity, rarityClass } from "../content/real";
import { rarityCounts } from "../data/deals";
import type { Locked } from "../data/types";
import { track } from "../lib/activity";
import { cls } from "../lib/cls";
import { formatRax } from "../lib/format";
import { rovingIndex } from "../lib/keys";
import { JOIN_HASH, useAccess, useLocked } from "./Access";
import { Icon } from "./Icon";

/**
 * "Legendary 4 deals": a chip's name for a screen reader, the count in words. It starts with the chip's visible words
 * ("Legendary 4"), with no comma between them, so a voice user who says what they see reaches it.
 */
export const chipLabel = (name: string, n: number) => `${name} ${formatRax(n)} ${n === 1 ? "deal" : "deals"}`;

/**
 * The free snapshot's rarity counts as eight whole numbers by Real's rarity index, or null when it has none (an older
 * snapshot, or the members' own). Anything that is not a whole count of 0 or more reads as 0, and no other key is
 * read: whatever else such a field held, the page would never show it.
 */
export function lockedCounts(locked: Locked): number[] | null {
  const counts: unknown = locked.by_rarity;
  if (typeof counts !== "object" || counts === null || Array.isArray(counts)) return null;
  const byKey = counts as Record<string, unknown>;
  return RARITIES.map((_, i) => {
    const n = byKey[String(i)];
    return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
  });
}

/** Scrolls a chip into view inside its row only, never the page, at once when the visitor asks for less motion. */
function reveal(el: HTMLElement | null | undefined, smooth: boolean) {
  const row = el?.parentElement;
  if (!el || !row || row.scrollWidth <= row.clientWidth) return;
  const still = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const left = el.offsetLeft - row.offsetLeft;
  const right = left + el.offsetWidth;
  let to: number | null = null;
  if (left < row.scrollLeft) to = left - 16;
  else if (right > row.scrollLeft + row.clientWidth) to = right - row.clientWidth + 16;
  if (to === null) return;
  if (typeof row.scrollTo === "function") row.scrollTo({ left: to, behavior: smooth && !still ? "smooth" : "auto" });
  else row.scrollLeft = to;
}

/** The strip for this visitor: the working one, the locked one, or nothing (a refused account, no counts to show). */
export function RarityStrip({ exclude }: { exclude?: ReadonlySet<string> }) {
  const locked = useLocked();
  return locked ? <LockedRarityStrip locked={locked} /> : <MemberRarityStrip exclude={exclude} />;
}

/** One chip of a strip: `key` null is the strip's first, colourless choice ("All", "Best for each"). */
export interface RarityChip {
  key: number | null;
  name: string; // as drawn
  label: string; // for a screen reader
  n?: number; // a count drawn after the name, when the strip has one
  zero?: boolean; // nothing there: drawn quiet
  inrange?: boolean; // in by "And rarer"
}

/**
 * A row of rarity chips as a radio group, each in Real's colour (the deals' strip, Build to on Passes): one tab stop;
 * the arrows, Home and End move along it and choose as they go, as the sport tabs do. A choice kept from an earlier
 * visit that sits past the edge of a phone's row is brought into view once.
 */
export function RarityChips({
  label,
  chips,
  picked,
  onChoose,
}: {
  label: string;
  chips: readonly RarityChip[];
  picked: number | null;
  onChoose: (key: number | null) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const current = chips.findIndex((c) => c.key === picked);
  const at = (key: number | null) => rowRef.current?.querySelector<HTMLElement>(`[data-rarity="${key ?? "all"}"]`);

  useLayoutEffect(() => {
    reveal(at(picked), false);
  }, []); // once, on the first paint: later picks bring their own chip into view

  const choose = (key: number | null) => {
    if (key !== picked) onChoose(key);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = chips.findIndex((c) => String(c.key ?? "all") === (e.target as HTMLElement).dataset.rarity);
    const i = rovingIndex(e.key, from < 0 ? current : from, chips.length, "horizontal");
    if (i === null) return;
    e.preventDefault();
    const next = chips[i]!.key;
    choose(next);
    const el = at(next);
    el?.focus({ preventScroll: true });
    reveal(el, true);
  };

  return (
    <div ref={rowRef} className="rchips" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {chips.map((c, i) => {
        const on = c.key === picked;
        return (
          <button
            key={c.key ?? "all"}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={c.label}
            tabIndex={i === Math.max(0, current) ? 0 : -1}
            data-rarity={c.key ?? "all"}
            className={cls("rchip", c.key !== null && rarityClass(c.key), c.zero && "zero", c.inrange && "inrange")}
            onClick={(e) => {
              choose(c.key);
              reveal(e.currentTarget, true);
            }}
          >
            {c.key !== null && <span className="sw" aria-hidden="true" />}
            {c.name}
            {c.n !== undefined && <span className="n">{formatRax(c.n)}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The member's strip: the chips (RarityChips), then the "And rarer" switch, which waits for a rarity to be picked. The
 * counts leave out the rows in `exclude` (Today's top three), like the sport tabs'.
 */
export function MemberRarityStrip({ exclude }: { exclude?: ReadonlySet<string> }) {
  const { snap, prefs, setPrefs, follows, now, query } = useApp();
  const counts = rarityCounts(snap, prefs, follows, now, exclude, query);
  const picked = isRarity(prefs.rarity) ? prefs.rarity : null;
  const rarer = prefs.rarer === true;
  // The chips, All first: key null is All.
  const chips: RarityChip[] = [
    { key: null, name: "All", label: chipLabel("All", counts.all), n: counts.all, zero: counts.all === 0 },
    ...RARITIES.map((r, i) => {
      const n = counts.byRarity[i] ?? 0;
      return { key: i, name: r.name, label: chipLabel(r.name, n), n, zero: n === 0, inrange: rarer && picked !== null && i > picked };
    }),
  ];

  return (
    <div className="rstrip">
      <RarityChips
        label="Filter by rarity"
        chips={chips}
        picked={picked}
        onChoose={(key) => {
          track("filter", key === null ? "rarity-all" : `rarity-${RARITIES[key]!.key}`);
          setPrefs({ rarity: key });
        }}
      />
      <button
        type="button"
        role="switch"
        aria-checked={rarer}
        className="rarer"
        disabled={picked === null}
        title={picked === null ? "Pick a rarity first" : undefined}
        onClick={() => {
          track("filter", rarer ? "rarity-exact" : "rarity-rarer");
          setPrefs({ rarer: !rarer });
        }}
      >
        <span className="rtrack" aria-hidden="true" />
        And rarer
      </button>
    </div>
  );
}

/**
 * The visitor's strip (not signed in, or signed in but not in the server): every rarity with how many deals a member
 * sees there right now, counted by the server; a tap opens the join page and filters nothing. Nothing for an account
 * the server refused (no way in to offer), or for a snapshot that does not carry the counts.
 */
export function LockedRarityStrip({ locked }: { locked: Locked }) {
  const { state } = useAccess();
  const id = useId();
  const counts = lockedCounts(locked);
  if (!counts || (state !== "anon" && state !== "out")) return null;
  const join = (key: string) => {
    track("filter", `rarity-locked-${key}`);
    location.hash = JOIN_HASH;
  };
  return (
    <div className="rstrip rstrip-locked">
      <p className="rlead" id={`${id}l`}>
        <Icon name="lock" />
        Filter by rarity, free with Discord
      </p>
      <div className="rchips" role="group" aria-labelledby={`${id}l`}>
        {RARITIES.map((r, i) => {
          const n = counts[i] ?? 0;
          return (
            <button
              key={r.key}
              type="button"
              aria-label={chipLabel(r.name, n)}
              className={cls("rchip", rarityClass(i), n === 0 && "zero")}
              onClick={() => join(r.key)}
            >
              <span className="sw" aria-hidden="true" />
              {r.name}
              <span className="n">{formatRax(n)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
