// Recycle on My passes: the passes done paying (lib/recycle.ts), a line on top that adds them up, and under each one
// what to do with it, linked: the lift that reopens it (no Real Pro needed), and, for a visitor who says they have Real
// Pro, what its cards would sell for and the pass that Rax builds; without, what Real's Quick Sell would pay (no Real Pro
// needed, about an eighth of a sale) and whether to take it. Every figure but Quick Sell's is an estimate
// (content/recycleWords.ts).
import { useApp } from "../../AppContext";
import { about, tierName } from "../../content/passWords";
import {
  PRO_ASSUMED, PRO_BOX, PRO_TO_LIST, RECYCLE_TITLE, liftText, quickNote, quickText, sellText, summaryText, targetText,
  whyText,
} from "../../content/recycleWords";
import { useRealPro, useRecyclePlan } from "../../hooks/useRecycle";
import { cls } from "../../lib/cls";
import { saveRealPro } from "../../lib/realPro";
import { type DeadPass, shownLift } from "../../lib/recycle";
import { DealLink } from "../DealLink";
import { Icon } from "../Icon";
import { Term, TermTip } from "../InfoTip";
import { PassButton } from "./Panels";
import { useOpenPass } from "./PassCard";

/** "I have Real Pro": the visitor's own answer, kept on this device; what the site assumes, said under it. */
export function ProToggle() {
  const pro = useRealPro();
  return (
    <div className="rcy-pro">
      <button type="button" className="tgl" aria-pressed={pro} onClick={() => saveRealPro(!pro)}>
        <span className="bx">
          <Icon name="check" />
        </span>
        {PRO_BOX}
      </button>
      <TermTip term="realPro" />
      <small>{PRO_ASSUMED}</small>
    </div>
  );
}

/** The line on top: how many passes are done, what their cards would build (Real Pro), the passes to open. */
export function RecycleSummary({ className }: { className?: string }) {
  const r = useRecyclePlan();
  if (r.dead.length === 0) return null;
  const picks = r.pro ? (r.route?.picks ?? []) : [];
  const quick = r.dead.some((d) => d.quick) ? quickNote(r) : null; // with Real Pro: Quick Sell exists, and pays far less
  return (
    <section className={cls("rcyc", className)} aria-labelledby="rcy-h">
      <div className="sh">
        <h2 id="rcy-h">{RECYCLE_TITLE}</h2>
        <TermTip term="limit" />
      </div>
      <p className="rcy-sum" data-testid="recycle-summary">
        {summaryText(r)}
      </p>
      {picks.length > 0 && (
        <div className="st rcy-picks">
          {picks.map((p) => (
            <PassButton
              key={p.market.key}
              market={p.market}
              rung={p.rung}
              line={`${tierName(p.rung.tier)} · about ${about(p.rung.cost)} Rax`}
              right={<>+{about(p.rung.year_rax)}/yr</>}
            />
          ))}
        </div>
      )}
      {r.pro && r.value > 0 && <p className="rcy-note">{PRO_TO_LIST}</p>}
      {r.pro && quick && (
        <p className="rcy-note">
          {quick} <TermTip term="quickSell" />
        </p>
      )}
      <ProToggle />
    </section>
  );
}

/** Under a done pass in the list: why it is done, the lift that reopens it, and what selling it builds (Real Pro) or
 * what Quick Sell would pay (without). */
export function RecycleLine({ d }: { d: DeadPass }) {
  const { prefs } = useApp();
  const pro = useRealPro();
  const openPass = useOpenPass();
  const level = prefs.level;
  const lift = shownLift(d, pro);
  const sell = pro ? sellText(d, level) : null;
  const quick = pro ? null : quickText(d, level, lift !== null); // without Real Pro: Real's Quick Sell, and whether to
  if (!lift && !sell && !quick) return null;
  const target = pro ? d.target : null;
  return (
    <div className="rcy" data-testid="recycle-line">
      {level !== "new" && d.why !== "idle" && <small className="rcy-why">{whyText(d, level)}</small>}
      {lift && (
        <div className="rcy-l">
          <p>{liftText(lift, d.earned, level)}</p>
          {lift.deal ? (
            <DealLink deal={lift.deal} pos={0} />
          ) : (
            <button type="button" className="lnk" onClick={(e) => openPass(d.market, lift.tier, e.currentTarget)}>
              See the lift
              <Icon name="arrow" />
            </button>
          )}
        </div>
      )}
      {quick && (
        <div className="rcy-q" data-advice={d.quick?.advice}>
          <p>
            {quick} <TermTip term="quickSell" />
          </p>
        </div>
      )}
      {sell && (
        <div className="rcy-s">
          <p>
            {sell} {targetText(d)} Listing them needs <Term term="realPro">Real Pro</Term>.
          </p>
          {target && (
            <button type="button" className="lnk" onClick={(e) => openPass(target.market, target.rung.tier, e.currentTarget)}>
              See {target.market.player_name}
              <Icon name="arrow" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
