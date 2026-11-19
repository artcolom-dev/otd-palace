// "What can I do with…": the visitor types a balance in Rax and gets, passes first, the passes it can build (at most
// two a sport, so each wins its claims, around the passes this device holds) and the best set of deals it can buy (at
// their level, never two of one player-season), led by whichever gives more back over the next 12 months
// (lib/budget.ts). As a card on Today, and as a sheet from the top bar. Worked out on this device; the last balance is
// remembered on it.
import { useId, useMemo } from "react";
import { useApp } from "../AppContext";
import { shortOf } from "../content/glossary";
import { about, spanText, tierName } from "../content/passWords";
import { useLocal } from "../data/local";
import { useBalance } from "../hooks/useBalance";
import { useHeldMarkets } from "../hooks/useHeldMarkets";
import { buddyPlan, buddySentence, laterLine, offerRouteLine, passRoute, saveUpLine, startLine } from "../lib/budget";
import { cls } from "../lib/cls";
import { formatRax } from "../lib/format";
import { dayOf } from "../lib/passes";
import { sportLabel } from "../lib/words";
import { DealLink } from "./DealLink";
import { Icon } from "./Icon";
import { Term, TermTip } from "./InfoTip";
import { useOverlay } from "./Overlay";
import { PassButton } from "./passes/Panels";
import { usePaused } from "./Paused";

const ROWS = 6; // deals listed at most; the totals count them all

/** The field and what it finds. */
export function BudgetBuddy() {
  const { snap, prefs, now, status } = useApp();
  const { passes: holdings } = useLocal();
  const held = useHeldMarkets();
  const paused = usePaused();
  const field = useId();
  const { text, balance, onChange } = useBalance();
  // The sport the visitor chose; every sport when none is ("mine" is followed players, not a sport).
  const sport = prefs.sport === "mine" ? "all" : prefs.sport;
  const today = dayOf(snap.otd.as_of);
  // The passes do not depend on the clock: worked out when the balance, the level, the sport or the passes held change.
  const route = useMemo(
    () =>
      balance === null
        ? null
        : passRoute(snap.otd, snap.rules.otd, balance, { level: prefs.level, sport, holdings, held, sports: snap.otd.sports }),
    [snap.otd, snap.rules.otd, balance, prefs.level, sport, holdings, held],
  );
  // The deals, again each second, so an auction that just ended drops out; a basket takes a few milliseconds.
  const plan = useMemo(
    () => (balance === null || route === null ? null : buddyPlan(snap, prefs.level, balance, now, sport, route)),
    [snap, prefs.level, balance, now, sport, route],
  );

  const shown = plan ? plan.basket.deals.slice(0, ROWS) : [];
  const more = plan ? plan.basket.deals.slice(ROWS) : [];
  const picks = plan?.route.picks ?? [];
  const isNew = prefs.level === "new";

  const passSection = plan && picks.length > 0 && (
    <section className="bbpasses" data-testid="buddy-pass" aria-labelledby={`${field}p`}>
      <h3 id={`${field}p`} className="bbh">
        {plan.lead === "passes" ? "Passes to build" : "Or build a pass"}
        <TermTip term="yearBack" />
      </h3>
      <div className="nxl">
        {picks.map(({ market, rung }) => (
          <PassButton
            key={market.key}
            market={market}
            rung={rung}
            line={
              <>
                {tierName(rung.tier)} · about <b>{about(rung.year_rax)}</b> Rax a year
                {rung.payback_months !== null && <>, back in about {spanText(rung.payback_months)}</>}
                {market.season_state === "current" && <> · this season: pays every game</>}
              </>
            }
            right={
              <>
                {formatRax(Math.round(rung.cost))}
                <small>Rax to build</small>
              </>
            }
          />
        ))}
      </div>
      {startLine(plan.route, today) && <p className="bbmore">{startLine(plan.route, today)}</p>}
      {offerRouteLine(plan.route) && (
        <p className="bboffer" data-testid="buddy-offer">
          {offerRouteLine(plan.route)}
          <TermTip term="offer" />
        </p>
      )}
      <p className="bbmore">
        Estimates, at most 2 passes a sport so each one gets its daily claims. Tap one to see how it pays.
      </p>
    </section>
  );

  const dealSection = plan && shown.length > 0 && (
    <section className="bbdeals" aria-label="Deals">
      {plan.lead === "passes" && <h3 className="bbh">Or flip deals</h3>}
      <ol className="bbrows" aria-label="Deals to buy">
        {shown.map((deal, i) => (
          <li key={`${deal.listing_id}:${deal.kind}`}>
            <DealLink deal={deal} pos={i} paused={paused} />
          </li>
        ))}
      </ol>
      {more.length > 0 && (
        <p className="bbmore">
          and {formatRax(more.length)} smaller {more.length === 1 ? "deal" : "deals"}, saving{" "}
          {formatRax(more.reduce((sum, d) => sum + d.reference - d.price, 0))} more
        </p>
      )}
      <dl className="bbtot">
        <div>
          <dt>You pay</dt>
          <dd>{formatRax(plan.basket.spent)}</dd>
        </div>
        <div>
          <dt>Usually worth</dt>
          <dd>{formatRax(plan.basket.usual)}</dd>
        </div>
        <div>
          <dt>You save</dt>
          <dd className="good">{formatRax(plan.basket.saved)}</dd>
        </div>
      </dl>
    </section>
  );

  const saveUp = plan && balance !== null ? saveUpLine(balance, plan.route) : null;
  const later = plan ? laterLine(plan.route) : null;

  return (
    <div className="bb">
      <label className="bbf" htmlFor={field}>
        <input
          id={field}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          placeholder="840"
          aria-label="Your balance in Rax"
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
        <span aria-hidden="true">Rax</span>
      </label>
      {balance === null ? (
        <p className="bbhint">
          {text.trim() === ""
            ? "Type what you have to spend: we compare the passes it can build with the deals it can buy."
            : "Type a whole number of Rax, like 840."}
        </p>
      ) : (
        plan && (
          <div className="bbres">
            <p className="bbsay" data-testid="buddy-say">
              {buddySentence(balance, plan, status === "stale", sport, today)}
            </p>
            {status !== "stale" && (
              <>
                {isNew && plan.lead === "passes" && (
                  <p className="bbwhat">
                    <Term term="pass">A pass</Term> {shortOf("pass").replace(/^Your card/, "is your card")} From Common up to
                    Iconic, its <Term term="rarity">rarity</Term> multiplies what it pays.
                  </p>
                )}
                {saveUp && (
                  <p className="bbmore" data-testid="buddy-save-up">
                    {saveUp}
                    <TermTip term="offer" />
                  </p>
                )}
                {plan.lead === "deals" ? (
                  <>
                    {dealSection}
                    {passSection}
                  </>
                ) : (
                  <>
                    {passSection}
                    {dealSection}
                  </>
                )}
                {later && <p className="bbmore">{later}</p>}
                <p className="bbnote">
                  Deals for the {snap.levels[prefs.level]?.label ?? "chosen"} level
                  {sport === "all" ? "" : `, in ${sportLabel(sport)}`}. Falling deals are left out. Prices move fast:
                  check each one in Real before you bid.
                </p>
              </>
            )}
          </div>
        )
      )}
    </div>
  );
}

/** The card on Today (a panel in the right column on a desktop, a section on a phone). */
export function BudgetCard() {
  const { layout } = useApp();
  const id = useId();
  return (
    <section className={cls(layout.phone ? "pnl" : "panel", "buddy")} aria-labelledby={`${id}h`}>
      <div className="ph">
        <h2 id={`${id}h`}>What can I do with…</h2>
      </div>
      <BudgetBuddy />
    </section>
  );
}

/** The desktop top bar's way in: the same thing as a sheet. A phone has the card on Today instead. */
export function BudgetButton() {
  const overlay = useOverlay();
  const open = (anchor: HTMLElement) =>
    overlay.open({ title: "What can I do with…", anchor, size: "wide", body: () => <BudgetBuddy /> });
  return (
    <button type="button" className="lnk box buddybtn" onClick={(e) => open(e.currentTarget)}>
      <Icon name="wallet" />
      What can I do with…
    </button>
  );
}
