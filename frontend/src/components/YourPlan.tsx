// "Your plan": what the visitor's passes can pay a year (always "up to"), the account type that makes them, how far the
// next type is, the one best move and two more, what to do, skip and watch at this size, and the ladder of types. A
// visitor with no linked account starts from "Where are you with Real?". The page (views/PlanView) draws everything;
// Today's rail draws the compact card. One source for the words (content/yourPlan, content/accountTypes), one for the
// numbers (lib/yourPlan: the planner the Passes tab uses).
import { type ReactNode, useId, useState } from "react";
import { useApp } from "../AppContext";
import { ACCOUNT_TYPES, type AccountType, UP_TO_NOTE } from "../content/accountTypes";
import { SURENESS_WORDS, TIER_PLANS } from "../content/earn";
import { rarityClass } from "../content/real";
import {
  CHOICES, FIRST_PASS, KEEP_IN_MIND, LINKED_NOTE_HAND, NO_MOVES, PLAN_TITLE, TOP_TYPE, WHAT_IS_A_PASS, WHERE_TITLE, type ChoiceKey,
} from "../content/yourPlan";
import { useLocal } from "../data/local";
import { useFirstPasses, useYourPlan } from "../hooks/useYourPlan";
import { cls } from "../lib/cls";
import { formatRax } from "../lib/format";
import { canLink } from "../lib/link";
import { type PlanChoice, readPlanChoice, savePlanChoice } from "../lib/planChoice";
import { type PlanMove, type YourPlan, moveWords, todayOf } from "../lib/yourPlan";
import { AccountForm, LinkChip } from "./AccountLookup";
import { Icon } from "./Icon";
import { CountUp } from "./CountUp";
import { Meter } from "./Meter";
import { useOpenPass } from "./passes/PassCard";

const start = TIER_PLANS.find((p) => p.id === "start")!;
const justStarted = TIER_PLANS.find((p) => p.id === "beginner")!;

/** The type's colour as a small card-shaped swatch (Real's rarity colours: never text, a colour beside the name). */
function Swatch({ type }: { type: AccountType }) {
  return <span className={cls("sw", "plan-sw", rarityClass(type.color))} aria-hidden="true" />;
}

const range = (t: AccountType) =>
  t.to === null ? `${formatRax(t.from)} and up` : t.from === 0 ? "0" : `${formatRax(t.from)} to ${formatRax(t.to)}`;

const pctText = (n: number) => String(n);

/** "2,900 of 10,000 · 29 % of the way to Steady", and the bar under it; at the top, a line and no bar. */
function Progress({ plan }: { plan: YourPlan }) {
  const p = plan.progress;
  if (!p) return <p className="plan-prog-t">{TOP_TYPE}</p>;
  const pct = Math.floor(p.fraction * 100);
  return (
    <div className="plan-prog">
      <Meter value={p.fraction} label={`Way to ${p.next.name}`} />
      <p className="plan-prog-t">
        {plan.year < 1 ? (
          FIRST_PASS(p.next.name)
        ) : (
          <>
            <b><CountUp value={p.year} /></b> of {formatRax(p.target)} · <CountUp value={pct} format={pctText} />% of the way to <b>{p.next.name}</b>
          </>
        )}
      </p>
    </div>
  );
}

/** One move as a row: the pass, what it costs, what it adds a year, when it pays back. A tap opens the pass. */
function MoveRow({ move, today, plan, lead }: { move: PlanMove; today: string; plan: YourPlan; lead?: boolean }) {
  const openPass = useOpenPass();
  const w = moveWords(move, today);
  const next = plan.progress?.next;
  const alone = lead && next && move.year >= plan.progress!.toGo;
  return (
    <button
      type="button"
      className={cls("plan-move", lead && "lead")}
      disabled={!move.market || !move.rung}
      onClick={(e) => move.market && move.rung && openPass(move.market, move.rung.tier, e.currentTarget)}
    >
      <span className="plan-move-main">
        <b>{move.title}</b>
        <small>{move.what}</small>
        <span className="plan-move-fig">
          Costs about <b>{w.cost}</b> Rax · adds about <b>{w.year}</b> Rax a year
        </span>
        {w.payback && <span className="plan-move-pay">{w.payback}</span>}
        {alone && <span className="plan-move-pay">Enough on its own to make you {next.name}.</span>}
      </span>
      <Icon name="arrow" />
    </button>
  );
}

function Moves({ plan, today, lead = true }: { plan: YourPlan; today: string; lead?: boolean }) {
  if (plan.moves.length === 0) return <p className="plan-none">{NO_MOVES}</p>;
  return (
    <ol className="plan-moves">
      {plan.moves.map((m, i) => (
        <li key={m.key}>
          <MoveRow move={m} today={today} plan={plan} lead={lead && i === 0} />
        </li>
      ))}
    </ol>
  );
}

/** Do, skip and watch for the type. */
function Lines({ type }: { type: AccountType }) {
  const rows: [string, string][] = [
    ["Do", type.do],
    ["Skip", type.skip],
    ["Watch", type.watch],
  ];
  return (
    <dl className="plan-lines">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** What each type is, the visitor's highlighted. */
function Ladder({ current }: { current: AccountType }) {
  return (
    <ol className="plan-ladder">
      {[...ACCOUNT_TYPES].reverse().map((t) => (
        <li key={t.key} aria-current={t === current ? "true" : undefined}>
          <Swatch type={t} />
          <span className="plan-lad-main">
            <b>{t.name}</b>
            <small>{range(t)} Rax a year</small>
            <span>{t.meaning}</span>
          </span>
          {t === current && <span className="plan-here">You are here</span>}
        </li>
      ))}
    </ol>
  );
}

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section className={cls("plan-sec", className)} aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

/** The linked (or hand-filled) account's plan, as the page shows it. */
export function LinkedPlan({ onSaid }: { onSaid?: (words: string) => void } = {}) {
  const { snap } = useApp();
  const { link } = useLocal();
  const plan = useYourPlan();
  const today = todayOf(snap);
  const [lead, ...more] = plan.moves;
  return (
    <div className="plan plan-swap">
      <section className="plan-head" aria-labelledby="plan-year">
        <p className="plan-eyebrow">{plan.year < 1 ? "No pass pays you yet" : "Your passes can pay up to"}</p>
        <h2 id="plan-year" className="plan-year">
          {plan.year < 1 ? (
            "Nothing a year, so far"
          ) : (
            <>
              <CountUp value={plan.year} /> <span>Rax a year</span>
            </>
          )}
        </h2>
        <p className="plan-type">
          <Swatch type={plan.type} />
          <b>{plan.type.name}</b>
          <span>{plan.type.meaning}</span>
        </p>
        <Progress plan={plan} />
        <p className="plan-note">{UP_TO_NOTE}</p>
        {!link && <p className="plan-note">{LINKED_NOTE_HAND}</p>}
      </section>
      <Section title="Your best next move" className="plan-one">
        {lead ? <Moves plan={{ ...plan, moves: [lead] }} today={today} /> : <p className="plan-none">{NO_MOVES}</p>}
      </Section>
      {more.length > 0 && (
        <Section title="Two more to look at">
          <Moves plan={{ ...plan, moves: more }} today={today} lead={false} />
        </Section>
      )}
      <Section title={`For a ${plan.type.name} account`}>
        <Lines type={plan.type} />
      </Section>
      <Section title="What each type is">
        <Ladder current={plan.type} />
      </Section>
      <LinkChipLine onSaid={onSaid} />
    </div>
  );
}

/** Under the plan: which account it reads, with Refresh and Unlink (nothing when only added by hand). */
function LinkChipLine({ onSaid }: { onSaid?: (words: string) => void }) {
  const { link } = useLocal();
  const [said, setSaid] = useState("");
  if (!link) return null;
  return (
    <div className="plan-acct">
      {said && <p className="plan-note" role="status">{said}</p>}
      <LinkChip onSaid={(w) => { setSaid(w); onSaid?.(w); }} />
    </div>
  );
}

/** The first steps and the first passes for a visitor who has not started. */
function StartPlan() {
  const { snap } = useApp();
  const first = useFirstPasses();
  const today = todayOf(snap);
  return (
    <div className="plan-swap">
      <Section title="Your first steps">
        <p className="plan-note">{WHAT_IS_A_PASS}</p>
        <ol className="plan-steps">
          {start.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <p className="plan-est">
          <b>{start.estimate}</b> <span>{SURENESS_WORDS[start.sureness]}.</span>
        </p>
      </Section>
      {first.moves.length > 0 && (
        <Section title="When you have Rax: the best first passes right now">
          <Moves plan={first} today={today} lead={false} />
        </Section>
      )}
      <KeepInMind />
    </div>
  );
}

/** What to do with a few first passes. */
function NewPlan() {
  return (
    <div className="plan-swap">
      <Section title="Your first passes">
        <ol className="plan-steps">
          {justStarted.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <p className="plan-est">
          <b>{justStarted.estimate}</b> <span>{SURENESS_WORDS[justStarted.sureness]}.</span>
        </p>
      </Section>
      <KeepInMind />
    </div>
  );
}

function KeepInMind() {
  return (
    <Section title="Keep in mind">
      <ul className="plan-mind">
        {KEEP_IN_MIND.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </Section>
  );
}

/** "Where are you with Real?": the three choices. `compact` is the rail's. */
function Choices({ picked, onPick, compact }: { picked: ChoiceKey | null; onPick: (k: ChoiceKey) => void; compact?: boolean }) {
  return (
    <div className={cls("plan-choices", compact && "compact")} role="group" aria-label={WHERE_TITLE}>
      {CHOICES.map((c) => (
        <button key={c.key} type="button" className="plan-choice" aria-pressed={picked === c.key} onClick={() => onPick(c.key)}>
          <b>{c.title}</b>
          <small>{c.sub}</small>
          {c.key === "link" && <small className="plan-privacy">Reads your public profile. No password.</small>}
        </button>
      ))}
    </div>
  );
}

/** The link form that a "link my account" choice opens. */
function LinkForm() {
  return (
    <div className="plan-link plan-swap">
      <AccountForm autoFocus />
      <p className="plan-note">Only the name is sent. Your plan is read from your public profile. Unlink any time.</p>
    </div>
  );
}

/** The choice saved on this device, and the choice open now (a link form is not saved: linking is the answer). */
function useWhere(): [ChoiceKey | null, (k: ChoiceKey | null) => void] {
  const { snap } = useApp();
  const [saved, setSaved] = useState<PlanChoice | null>(readPlanChoice);
  const [open, setOpen] = useState<ChoiceKey | null>(null);
  const able = canLink(snap);
  const picked = open ?? saved;
  const pick = (k: ChoiceKey | null) => {
    if (k === "link" && !able) return;
    setOpen(k === "link" ? "link" : null);
    if (k !== "link") {
      savePlanChoice(k);
      setSaved(k);
    }
  };
  return [picked, pick];
}

/** The page's body for a visitor with nothing linked: the question, then the plan that fits the answer. */
export function WherePlan() {
  const { snap } = useApp();
  const [picked, pick] = useWhere();
  const able = canLink(snap);
  return (
    <div className="plan">
      <Section title={WHERE_TITLE} className="plan-where">
        <Choices picked={picked} onPick={pick} />
        {picked === "link" && able && <LinkForm />}
      </Section>
      {picked === "start" && <StartPlan />}
      {picked === "new" && <NewPlan />}
    </div>
  );
}

/** Whether the device holds an account (linked, or passes added by hand): the plan is the real one. */
export function useHasPlan(): boolean {
  const { link, passes } = useLocal();
  return link !== null || passes.length > 0;
}

/** Today's compact card, top of the rail (a phone: with the account card). */
export function PlanCard() {
  const { layout } = useApp();
  const has = useHasPlan();
  return (
    <section className={cls(layout.phone ? "pnl" : "panel", "plan-card")} aria-labelledby="plancard-h">
      <div className="ph">
        <h2 id="plancard-h">
          <Icon name="flag" />
          {PLAN_TITLE}
        </h2>
      </div>
      {has ? <LinkedCard /> : <WhereCard />}
    </section>
  );
}

// The card gives the type and the figure only: the best next moves are "Your next Rax" right below it on Today, and
// the full list is on the plan page, so the same advice is never written twice on one screen.
function LinkedCard() {
  const plan = useYourPlan();
  return (
    <div className="plan-swap">
      <p className="plan-eyebrow">{plan.year < 1 ? "No pass pays you yet" : "Your passes can pay up to"}</p>
      <p className="plan-year sm">
        {plan.year < 1 ? "Nothing a year, so far" : <><CountUp value={plan.year} /> <span>Rax a year</span></>}
      </p>
      <p className="plan-type sm">
        <Swatch type={plan.type} />
        <b>{plan.type.name}</b>
        <span>{plan.type.meaning}</span>
      </p>
      <Progress plan={plan} />
      <PlanLink />
      <p className="plan-note">Up to: if you claim every claim day.</p>
    </div>
  );
}

function PlanLink({ label = "See your whole plan" }: { label?: string }) {
  const { navigate } = useApp();
  return (
    <a
      className="lnk plain plan-go"
      href="#plan"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        navigate("plan");
      }}
    >
      {label}
      <Icon name="arrow" />
    </a>
  );
}

function WhereCard() {
  const { snap } = useApp();
  const [picked, pick] = useWhere();
  const able = canLink(snap);
  const said = picked === "start" ? start.steps[0] : picked === "new" ? justStarted.steps[0] : null;
  return (
    <div className="plan-swap">
      <p className="plan-ask">{WHERE_TITLE}</p>
      <Choices picked={picked} onPick={pick} compact />
      {picked === "link" && able && <LinkForm />}
      {said && <p className="plan-card-move"><b>First step</b><span>{said}</span></p>}
      {said && <PlanLink label="See the whole plan" />}
    </div>
  );
}

/** The plan page's body. */
export function PlanBody() {
  // The words of an unlink are kept here: the plan they were said under is replaced by the questions when it ends.
  const [said, setSaid] = useState("");
  const has = useHasPlan();
  return has ? (
    <LinkedPlan onSaid={setSaid} />
  ) : (
    <>
      {said && <p className="plan-note plan-said" role="status">{said}</p>}
      <WherePlan />
    </>
  );
}

export { PlanLink };
