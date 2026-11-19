// "Earn more Rax": a plan for each kind of player (opened at the visitor's own), what pays this month in each sport,
// the mistakes that cost Rax, and two small sums (a sale after fees, the daily streak). In a drawer (desktop) or a tall
// sheet (phone), like "How Real works"; from Today's "This month in Real", the footer, and the address (#earn).
import { type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useApp } from "../AppContext";
import { MISTAKES, SURENESS_WORDS, TIER_PLANS } from "../content/earn";
import { useLocal } from "../data/local";
import { parseBudget } from "../data/prefs";
import { GUIDE_TIERS, type GuideTier, bestStreak, guideTier, saleCompare, streakPay } from "../lib/earn";
import { formatRax } from "../lib/format";
import { rovingIndex } from "../lib/keys";
import { type SeasonNow, phaseLabel, realMonth, seasonBoard, seasonMove } from "../lib/season";
import { sportLabel } from "../lib/words";
import { type OverlayContentProps, useOverlay } from "./Overlay";
import { tabPath } from "../lib/tabHint";

export const EARN_HASH = "#earn";
export const EARN_TITLE = "Earn more Rax";

/** Every sport's season this month, the most urgent first; empty without the season months. */
export function useSeasonBoard(): SeasonNow[] {
  const { snap, now } = useApp();
  const months = snap.rules.otd?.sport_months;
  // The month changes rarely: the board is worked out again only when the month does.
  const month = realMonth(now);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the board reads only the New York month of `now`
  return useMemo(() => (months ? seasonBoard(months, now) : []), [months, month]);
}

function Plan({ start }: { start: GuideTier }) {
  const [tier, setTier] = useState<GuideTier>(start);
  const ref = useRef<HTMLDivElement>(null);
  const base = useId();
  const plan = TIER_PLANS.find((p) => p.id === tier)!;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = rovingIndex(e.key, GUIDE_TIERS.indexOf(tier), GUIDE_TIERS.length, "horizontal");
    if (i === null) return;
    e.preventDefault();
    const next = GUIDE_TIERS[i]!;
    setTier(next);
    ref.current?.querySelector<HTMLElement>(`[data-tier="${next}"]`)?.focus();
  };
  return (
    <section className="earn-sec" aria-labelledby={`${base}h`}>
      <h3 id={`${base}h`}>Your plan</h3>
      <div ref={ref} className="mvtabs earn-tabs" role="tablist" aria-label="Your plan" onKeyDown={onKeyDown}>
        {TIER_PLANS.map((p) => (
          <button
            key={p.id}
            id={`${base}t-${p.id}`}
            type="button"
            role="tab"
            data-tier={p.id}
            aria-selected={tier === p.id}
            aria-controls={`${base}p`}
            tabIndex={tier === p.id ? 0 : -1}
            onClick={() => setTier(p.id)}
          >
            <span>{p.tab}</span>
          </button>
        ))}
      </div>
      <div id={`${base}p`} className="earn-plan" role="tabpanel" aria-labelledby={`${base}t-${tier}`}>
        <p className="earn-who">
          <b>{plan.title}</b> {plan.who}
        </p>
        <ol className="earn-steps">
          {plan.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <p className="earn-est">
          <b>{plan.estimate}</b>
          <span>{SURENESS_WORDS[plan.sureness]}.</span>
        </p>
      </div>
    </section>
  );
}

/** A window that closes soon: a preseason, a season's first month, an off-season with its dates two months away. */
const isSoon = (s: SeasonNow) =>
  s.phase === "preseason" || (s.phase === "season" && s.early) || (s.phase === "off" && s.monthsToStart === 2);

function Clock({ board }: { board: SeasonNow[] }) {
  const id = useId();
  if (board.length === 0) return null;
  const seen = new Set<string>();
  return (
    <section className="earn-sec" aria-labelledby={id}>
      <h3 id={id}>This month, by sport</h3>
      <p className="earn-note">
        Season months, not exact days: Real doesn't publish opening days we can read, so a month where a season starts or
        ends may be partly either.
      </p>
      <ul className="earn-clock" aria-label="Season clock">
        {board.map((s) => {
          const { move, detail } = seasonMove(s);
          const first = !seen.has(move);
          seen.add(move);
          return (
            <li key={s.sport} data-phase={s.phase} data-soon={isSoon(s) || undefined}>
              <span className="earn-sp">
                <b>{sportLabel(s.sport)}</b>
                <span className="earn-ph">{phaseLabel(s)}</span>
              </span>
              <span className="earn-mv">
                {move}
                {first && <small>{detail}</small>}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Mistakes() {
  const id = useId();
  return (
    <section className="earn-sec" aria-labelledby={id}>
      <h3 id={id}>Mistakes that cost Rax</h3>
      <ul className="earn-mis" aria-label="Mistakes that cost Rax">
        {MISTAKES.map((m) => (
          <li key={m.text}>
            {m.unsure && <span className="earn-tag">Not confirmed</span>}
            {m.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SaleCalc() {
  const { snap } = useApp();
  const field = useId();
  const [text, setText] = useState("");
  const price = parseBudget(text);
  const sale = price === null ? null : saleCompare(price, snap.rules.fee, snap.rules.listing_fee);
  const pct = Math.round(snap.rules.fee * 100);
  const keep = (n: number) => (n <= 0 ? "nothing" : `${formatRax(n)} Rax`);
  return (
    <fieldset className="earn-calc">
      <legend>What a sale leaves you</legend>
      <label className="earn-lbl" htmlFor={field}>
        Sale price
      </label>
      <span className="bbf">
        <input
          id={field}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          placeholder="100"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <span aria-hidden="true">Rax</span>
      </span>
      {sale ? (
        <div className="earn-out" aria-live="polite">
          <p>
            <span>Normal listing</span>
            <b>{keep(sale.normal)}</b>
          </p>
          <p>
            <span>Quick List</span>
            <b>{keep(sale.quick)}</b>
          </p>
        </div>
      ) : (
        <p className="earn-hint">{text.trim() === "" ? "Type a price to see what you keep." : "Type a price in whole Rax, like 100."}</p>
      )}
      <p className="earn-note">
        Real keeps {pct}% of every sale. A normal listing also costs {formatRax(snap.rules.listing_fee)} Rax, kept even when
        the card doesn't sell. Quick List has no fee, but it lists at Real's floor price, not one you pick.
      </p>
    </fieldset>
  );
}

function StreakCalc() {
  const field = useId();
  const [text, setText] = useState("");
  const raw = text.trim() === "" ? null : Number(text);
  const ok = raw !== null && Number.isFinite(raw) && raw >= 0 && raw <= 100;
  const plan = ok ? bestStreak(raw / 100) : null;
  return (
    <fieldset className="earn-calc">
      <legend>Daily streak</legend>
      <label className="earn-lbl" htmlFor={field}>
        How often you pick right, in %
      </label>
      <span className="bbf">
        <input
          id={field}
          type="number"
          inputMode="numeric"
          min={0}
          max={100}
          step={1}
          placeholder="60"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <span aria-hidden="true">%</span>
      </span>
      {plan ? (
        <div className="earn-out" aria-live="polite">
          <p>
            <span>Best</span>
            <b>
              {plan.target === 8 ? "Ride to 8 in a row" : `Cash out at ${plan.target} in a row`} ({formatRax(streakPay(plan.target))} Rax)
            </b>
          </p>
          <p className="earn-sub">
            That is about {plan.perDay.toFixed(1)} Rax a day per sport
            {plan.target !== 2 && `, against ${plan.atTwo.toFixed(1)} cashing out at 2`}.
          </p>
        </div>
      ) : (
        <p className="earn-hint">{text.trim() === "" ? "Type your share of right picks, like 60." : "Type a number from 0 to 100."}</p>
      )}
      <p className="earn-note">
        One streak poll per sport a day. 2 right in a row cash out 5 Rax, and each more doubles it, up to 320 for 8.
        Cashing out starts the run again.
      </p>
    </fieldset>
  );
}

export function EarnSheet({ ctx }: { ctx: OverlayContentProps }) {
  const { tab, prefs } = useApp();
  const { balance } = useLocal();
  const board = useSeasonBoard();
  const tabRef = useRef(tab);
  tabRef.current = tab;
  // The plan opens at the visitor's own; the choice inside it is theirs from then on.
  const [start] = useState(() => guideTier(prefs.level, balance));

  // The address says where the visitor is while the sheet is open, and goes back to the tab when it closes.
  useEffect(() => {
    history.replaceState(null, "", EARN_HASH);
    return () => history.replaceState(null, "", `${tabPath(tabRef.current)}${location.search}`);
  }, []);

  const title = (
    <div className="dwhd">
      <div className="dwtitle">
        <h2 id={ctx.phone ? undefined : ctx.titleId}>{EARN_TITLE}</h2>
        <p className="meta">A plan for your level, what pays this month, and the sums</p>
      </div>
    </div>
  );
  return (
    <div className="hws earn">
      {ctx.phone && (
        <span id={ctx.titleId} className="sr">
          {EARN_TITLE}
        </span>
      )}
      {title}
      <div className="dwbody">
        <Plan start={start} />
        <Clock board={board} />
        <Mistakes />
        <section className="earn-sec" aria-label="Quick sums">
          <h3>Quick sums</h3>
          <div className="earn-calcs">
            <SaleCalc />
            <StreakCalc />
          </div>
        </section>
        <p className="how-note">
          From Real's own rules and what we measured on real accounts (November 2026). Estimates, not promises. Not
          affiliated with Real.
        </p>
      </div>
    </div>
  );
}

/** Opens the guide from `anchor`: focus returns there when it closes. */
export function useOpenEarn() {
  const overlay = useOverlay();
  const { layout } = useApp();
  return useCallback(
    (anchor: HTMLElement | null) =>
      overlay.open({
        title: EARN_TITLE,
        anchor,
        layer: "panel",
        body: (ctx) => <EarnSheet ctx={{ ...ctx, phone: layout.phone }} />,
      }),
    [overlay, layout.phone],
  );
}

/** The footer's link. */
export function EarnLink({ className }: { className?: string }) {
  const open = useOpenEarn();
  return (
    <button type="button" className={className ?? "tlink howlink"} aria-haspopup="dialog" onClick={(e) => open(e.currentTarget)}>
      {EARN_TITLE}
    </button>
  );
}

/** Opens the guide for an address that asks for it (#earn), at load and whenever the address changes. */
export function EarnFromAddress() {
  const open = useOpenEarn();
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const check = () => {
      if (location.hash.toLowerCase() === EARN_HASH) openRef.current(null);
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, []);
  return null;
}
