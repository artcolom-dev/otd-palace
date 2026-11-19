// The Passes tab's side panels: the cheapest way into a sport, the rating planner (Pro) and how passes work in plain
// words. (What to add to the passes held is "Your next Rax", components/NextRax.tsx: one list, said once.)
import { type ReactNode, useMemo } from "react";
import { useApp } from "../../AppContext";
import { GLOSSARY, type TermKey, explain } from "../../content/glossary";
import { about, big, monthsText, paybackWord, tierName, titleText } from "../../content/passWords";
import { useLocal } from "../../data/local";
import { starterPick } from "../../data/passList";
import type { PassMarket, PassRung } from "../../data/types";
import { climb, dayOf } from "../../lib/passes";
import { sportLabel } from "../../lib/words";
import { usePassPlan } from "../../views/passState";
import { Icon, type IconName } from "../Icon";
import { useOpenPass } from "./PassCard";
import { PassFace, Swatch, useRarity } from "./bits";

/** A pass to open, in one row: its swatch, its name and a line, and a figure on the right. */
export function PassButton({ market, rung, line, right }: { market: PassMarket; rung: PassRung; line: ReactNode; right: ReactNode }) {
  const rar = useRarity();
  const openPass = useOpenPass();
  return (
    <button type="button" className="nx" onClick={(e) => openPass(market, rung.tier, e.currentTarget)}>
      <PassFace market={market} rarity={rar(market.kind, rung.tier)} size={28} />
      <span>
        <b>{titleText(market)}</b>
        <small>{line}</small>
      </span>
      <span className="cost">{right}</span>
    </button>
  );
}

/** "Cheapest way to start": the best Common or Uncommon entry in a sport this device holds no pass in. */
export function StarterPanel({ className = "panel" }: { className?: string }) {
  const { snap } = useApp();
  const { plan } = usePassPlan();
  const held = useMemo(() => new Set(plan.held.map((p) => p.market.sport)), [plan]);
  const pick = useMemo(() => starterPick(snap, held), [snap, held]);
  if (!pick) return null;
  const { market, rung } = pick;
  const today = dayOf(snap.otd.as_of);
  const sport = sportLabel(market.sport);
  return (
    <section className={className} aria-labelledby="start-h">
      <div className="ph">
        <h2 id="start-h">Cheapest way to start</h2>
      </div>
      <p className="pnote">A Common or Uncommon pass in a sport you don't hold</p>
      <div className="st">
        <PassButton
          market={market}
          rung={rung}
          line={
            <>
              {sport} · {tierName(rung.tier)} · about <b>{about(rung.cost ?? 0)}</b> to build
            </>
          }
          right={
            <>
              {paybackWord(rung, today) ? <small>by end of</small> : null}
              {paybackWord(rung, today) ?? "—"}
              {paybackWord(rung, today) ? null : <small>pays back</small>}
            </>
          }
        />
        <p className="otdline">
          Pays about <b>{about(rung.year_rax)}</b> Rax a year: {sport}'s {snap.rules.otd.claims_per_sport_day} claims a day
          are all yours.
        </p>
      </div>
    </section>
  );
}

/** Pro: "I have [212] rating on [pass]": the rarity it reached, what the rest does, and the next two steps. */
export function RatingPlanner({
  planKey,
  rating,
  onKey,
  onRating,
  className = "panel",
}: {
  planKey: string | null;
  rating: string;
  onKey: (key: string) => void;
  onRating: (value: string) => void;
  className?: string;
}) {
  const { snap } = useApp();
  const { passes } = useLocal();
  const rules = snap.rules.otd;
  const today = dayOf(snap.otd.as_of);
  const players = snap.otd.markets.filter((m) => m.kind !== "team");
  const heldKeys = new Set(passes.map((h) => h.key));
  const fallback = players.find((m) => heldKeys.has(m.key)) ?? players[0];
  const market = players.find((m) => m.key === planKey) ?? fallback;
  if (!market) return null;
  const held = Math.max(0, Math.floor(Number(rating) || 0));
  const c = climb(market, held, rules, today, { minted: heldKeys.has(market.key) }); // held: no mint to pay again
  const option = (m: PassMarket) => (
    <option key={m.key} value={m.key}>
      {titleText(m)}
    </option>
  );
  const mine = players.filter((m) => heldKeys.has(m.key));
  const rest = players.filter((m) => !heldKeys.has(m.key));
  return (
    <section className={className} aria-labelledby="plan-h">
      <div className="ph">
        <h2 id="plan-h">Rating planner</h2>
      </div>
      <p className="pnote">What the rating you already hold is worth</p>
      <div className="pl">
        <label htmlFor="plan-r">I have</label>
        <input
          id="plan-r"
          type="number"
          min={0}
          max={20000}
          inputMode="numeric"
          value={rating}
          onChange={(e) => onRating(e.target.value)}
        />
        <label htmlFor="plan-k">rating on</label>
        <select id="plan-k" value={market.key} onChange={(e) => onKey(e.target.value)}>
          {mine.length > 0 && <optgroup label="My passes">{mine.map(option)}</optgroup>}
          <optgroup label={mine.length ? "Other passes" : "Passes"}>{rest.map(option)}</optgroup>
        </select>
      </div>
      <p className="pans" aria-live="polite">
        {big(held)} rating on {titleText(market)} = <Swatch kind={market.kind} tier={c.tier} /> <b>{tierName(c.tier)}</b>.{" "}
        {c.unused > 0 && c.next
          ? `${big(c.unused)} of it pays nothing until ${tierName(c.next.tier)} at ${big(c.next.rating)}.`
          : c.next
            ? "Every point of it counts."
            : "That's the top rarity."}
      </p>
      <ul className="popts">
        {c.options.map((o) => (
          <li key={o.tier}>
            <strong>
              <Swatch kind={market.kind} tier={o.tier} />
              Add {big(o.rating_to_add)} rating
            </strong>
            {o.cost === null ? "Cost unknown" : `About ${about(o.cost)}`} → about +{about(o.extra_year)} in the next 12 months
            {o.limit !== null && o.year_capped ? ` (it then reaches its ${big(o.limit)} limit)` : ""} ·{" "}
            {o.extra_pays_back === null
              ? "payback unknown"
              : o.extra_pays_back && o.extra_payback_months !== null
                ? `pays back in ${monthsText(o.extra_payback_months) === "<1" ? "<1 month" : `~${monthsText(o.extra_payback_months)} month${monthsText(o.extra_payback_months) === "1" ? "" : "s"}`}`
                : "never pays back"}
          </li>
        ))}
        {c.unused > 0 && c.sell !== null && (
          <li>
            <strong>
              <Icon name="deals" />
              Or sell the extra {big(c.unused)}
            </strong>
            About {about(c.sell)} at the typical price
          </li>
        )}
      </ul>
      <p className="pnote plnote">
        Assumes the pass hasn't used any of its limit yet; the app doesn't show how much it has. Not counting resale.
      </p>
    </section>
  );
}

const HOW: [IconName, ReactNode][] = [
  [
    "passes",
    <>
      Real pays at most <b>2 passes per sport each day</b>, and each pass at most once. A third pass with a game that day
      pays nothing.
    </>,
  ],
  [
    "cal",
    <>
      <b>Past season:</b> pays on the anniversaries of its game days; its figures are final. <b>Current season:</b> its
      live games pay now, and the games already played pay again on their anniversaries.
    </>,
  ],
  [
    "bolt",
    <>
      <b>Boosters</b> raise live game pay only; they don't change what a pass pays on anniversaries. The app may show a
      boosted multiplier.
    </>,
  ],
  [
    "cards",
    <>
      A <b>whole pass bought second-hand</b> from a past season may have used part of its limit; the app doesn't say how
      much.
    </>,
  ],
  [
    "layers",
    <>
      <b>Rarity raises pay per game day,</b> not how long the pass lasts: a player pass reaches its limit after the same
      number of game days at any rarity.
    </>,
  ],
];

/** "How passes work": the plain-words notes. */
export function HowPasses({ className, id, children }: { className: string; id?: string; children?: ReactNode }) {
  return (
    <section className={className} id={id} aria-labelledby="how-h">
      <h2 id="how-h">How passes work</h2>
      <ul className="howl">
        {HOW.map(([icon, text], i) => (
          <li key={i}>
            <Icon name={icon} />
            <span>{text}</span>
          </li>
        ))}
      </ul>
      {children}
    </section>
  );
}

const WORDS_NEW: TermKey[] = ["otd", "claims", "passYear", "payback", "limit", "buildCost"];
const WORDS_ALL: TermKey[] = [
  "otd",
  "claims",
  "passYear",
  "perGameDay",
  "payback",
  "limit",
  "limitCost",
  "buildCost",
  "onSale",
  "typical",
  "projection",
  "estimate",
  "weak",
  "team",
  "breakEven",
];

/** Every word of the Passes tab and what it means, behind "What the words mean". */
export function PassGlossary({ level }: { level: string }) {
  return (
    <dl className="gl">
      {(level === "new" ? WORDS_NEW : WORDS_ALL).map((key) => (
        <div key={key}>
          <dt>{GLOSSARY[key].title}</dt>
          <dd>{explain(key)}</dd>
        </div>
      ))}
    </dl>
  );
}
