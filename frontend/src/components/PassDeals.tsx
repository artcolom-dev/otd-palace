import { useId, useMemo } from "react";
import { useApp } from "../AppContext";
import type { Locked } from "../data/types";
import { useLocal } from "../data/local";
import { loadPrefs } from "../data/prefs";
import { useHeldMarkets } from "../hooks/useHeldMarkets";
import { liveBySport } from "../lib/budget";
import { passDealWords, passDeals } from "../lib/passDeals";
import { PassFace, Rarity, useRarity } from "./passes/bits";
import { AllPassesLink } from "./PassPickPanel";
import { Icon } from "./Icon";
import { Term, TermTip } from "./InfoTip";
import { useOpenPass } from "./passes/PassCard";
import { Unlock, useAccess, useLocked } from "./Access";
import { passDealsSwitch } from "../lib/passDealsSwitch";

export { PASS_DEALS_ON, passDealsSwitch } from "../lib/passDealsSwitch";

/** How many pass deals the block shows; the rest are on the Passes tab. */
export const PASS_DEALS_SHOWN = 3;
/** The least saving the locked teaser says, in percent (advisor/rules.py PASS_DEALS_PCT_MIN): under it, the count alone. */
export const PASS_DEALS_PCT_MIN = 10;

/**
 * The locked teaser's words for `passes` pass deals whose best saving is at least `pct`% (rounded down by the server;
 * null: none). From PASS_DEALS_PCT_MIN up the title says the saving; under it, "at least 5% less" sells nothing, so the
 * count is the title and the line above it does not say it again.
 */
export function lockedWords(passes: number, pct: number | null): { body: string; title: string; line: string } {
  const one = passes === 1;
  const noun = one ? "pass" : "passes";
  const sees = one ? "it" : passes > PASS_DEALS_SHOWN ? `the best ${PASS_DEALS_SHOWN}` : "each one";
  const line = `Discord members see ${sees}: the pass, what its cards cost and what it pays. One click, free.`;
  if (pct !== null && pct >= PASS_DEALS_PCT_MIN) {
    return {
      body: `Cards on sale now build ${passes} ${noun} for less than usual.`,
      title: `${one ? "It" : "The best one"} costs at least ${pct}% less than usual`,
      line,
    };
  }
  // No percent said: lead with the count, and claim only what holds whatever the usual rate says (it uses cards on
  // sale now and pays back its cost there; lib/passDeals.ts keeps only those).
  return {
    body: one ? "It uses cards on sale right now and pays back its cost." : "Each uses cards on sale right now and pays back its cost.",
    title: `${passes} ${noun} worth building today`,
    line,
  };
}

/**
 * "Pass deals", at the top of Deals: a block for members of our Discord server. A member (or anyone, with the gate off)
 * gets the passes themselves; anyone else, on the free site's snapshot, gets its locked place.
 */
export function PassDeals() {
  const locked = useLocked();
  if (!passDealsSwitch.on) return null;
  return locked ? <LockedPassDeals locked={locked} /> : <MemberPassDeals />;
}

/**
 * "Pass deals", at the top of Deals: the passes whose cards on sale right now reach a paying rarity for less than the
 * usual rate (lib/passDeals.ts), in the visitor's sport tab, within their pass budget, never one they hold, and no more
 * in a sport than the claims their live passes there leave. Each opens its pass. Nothing when there is none: the deals
 * stay the page's heart.
 */
function MemberPassDeals() {
  const { snap, prefs } = useApp();
  const { passes } = useLocal();
  const heldMarkets = useHeldMarkets();
  const openPass = useOpenPass();
  const rar = useRarity();
  const id = useId();
  const list = useMemo(
    () =>
      passDeals(snap.otd, snap.rules.otd, {
        level: prefs.level,
        sport: prefs.sport,
        budget: prefs.passBudget,
        held: new Set(passes.map((h) => h.key)),
        live: liveBySport(passes, heldMarkets, snap.rules.otd, snap.otd.sports),
      }).slice(0, PASS_DEALS_SHOWN),
    [snap.otd, snap.rules.otd, prefs.level, prefs.sport, prefs.passBudget, passes, heldMarkets],
  );
  if (list.length === 0) return null;
  return (
    <section className="pdeals" aria-labelledby={`${id}h`}>
      <div className="pdeals-hd">
        <h2 id={`${id}h`}>Pass deals</h2>
        <p>
          Cards on sale now build these <Term term="pass">passes</Term> for less than usual.
        </p>
      </div>
      <ul className="pdeals-list">
        {list.map((d) => {
          const w = passDealWords(d, prefs.level);
          return (
            <li key={d.market.key}>
              <button type="button" className="pdeal" onClick={(e) => openPass(d.market, d.rung.tier, e.currentTarget)}>
                <PassFace market={d.market} rarity={rar(d.market.kind, d.rung.tier)} size={32} />
                <span className="pdeal-t">
                  <b>{w.title}</b>
                  <Rarity kind={d.market.kind} tier={d.rung.tier} />
                </span>
                <Icon name="arrow" />
                <span className="pdeal-s">{w.sale}</span>
                <span className="pdeal-p">{w.pay}</span>
              </button>
              {w.offer && (
                <p className="pdeal-o">
                  {w.offer}
                  <TermTip term="offer" />
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <AllPassesLink />
    </section>
  );
}

/**
 * The free site's place for "Pass deals": how many passes the cards on sale build for less than usual today and the best
 * saving (two numbers the server counts for each level from what the block would show a member, `locked.pass_deals`:
 * every pass, each on its sport's tab, and the saving of the first PASS_DEALS_SHOWN, the ones a member lands on, rounded
 * down and capped, so "at least"), blank rows shaped like the block (no data in them) and the way in. Past
 * PASS_DEALS_SHOWN passes, it says a member sees the best ones, not each one; under PASS_DEALS_PCT_MIN, the count is its
 * hook and no percent is said (`lockedWords`). It never reads a pass: the block's
 * passes, prices and offers are a member's. Nothing when there is no pass deal to tease (no number is made up), for a
 * snapshot that does not count them, or for an account Discord refused (no way in to offer).
 */
function LockedPassDeals({ locked }: { locked: Locked }) {
  const { state } = useAccess();
  const { snap } = useApp();
  const id = useId();
  // The level this device chose: the free site shows everyone New's deals, but a member gets their own level back, and
  // the block they unlock is that level's (the top-level pair is New's, a first visit's).
  const level = useMemo(() => loadPrefs(snap.levels).level, [snap.levels]);
  const teaser = locked.pass_deals?.levels?.[level] ?? locked.pass_deals;
  const passes = teaser?.passes ?? 0;
  const pct = teaser?.best_pct ?? null;
  if (!(passes > 0) || (state !== "anon" && state !== "out")) return null;
  const words = lockedWords(passes, pct);
  return (
    <section className="pdeals pdeals-locked" aria-labelledby={`${id}h`}>
      <div className="pdeals-hd">
        <h2 id={`${id}h`}>Pass deals</h2>
        <p>{words.body}</p>
      </div>
      <ul className="pdeals-list pdeals-blank" aria-hidden="true">
        {Array.from({ length: Math.min(passes, PASS_DEALS_SHOWN) }, (_, i) => (
          <li key={i}>
            <span className="lr-face" />
            <span className="lr-lines">
              <i />
              <i className="s" />
            </span>
            <span className="lr-num" />
          </li>
        ))}
      </ul>
      <Unlock
        area="passdeals"
        heading="h3"
        title={words.title}
        line={words.line}
      />
    </section>
  );
}
