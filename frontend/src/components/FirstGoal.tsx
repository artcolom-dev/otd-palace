// "Your first pass": for a visitor who holds no pass, the cheapest sensible one to aim at, a bar toward its cost from
// the balance they typed, and (only if they give their own daily Rax) about how many days that takes. We do not know
// what an account makes in a day, so nothing here guesses it.
import { useId, useMemo, useState } from "react";
import { useApp } from "../AppContext";
import { about, tierName, titleText } from "../content/passWords";
import { local, useLocal } from "../data/local";
import { parseBudget } from "../data/prefs";
import { useBalance } from "../hooks/useBalance";
import { cls } from "../lib/cls";
import { firstGoal } from "../lib/firstGoal";
import { formatRax } from "../lib/format";
import { sportLabel } from "../lib/words";
import { Icon } from "./Icon";
import { TermTip } from "./InfoTip";
import { Meter } from "./Meter";
import { PassFace, useRarity } from "./passes/bits";


export function FirstGoalCard() {
  const { snap, layout, showCards } = useApp();
  const { passes, dailyRax } = useLocal();
  const rar = useRarity();
  const id = useId();
  const { text, balance, onChange } = useBalance();
  const [daily, setDaily] = useState(() => (dailyRax === null ? "" : formatRax(dailyRax)));
  const goal = useMemo(() => firstGoal(snap, balance, dailyRax), [snap, balance, dailyRax]);
  if (passes.length > 0 || !goal) return null;
  const { market, rung } = goal;
  const sport = sportLabel(market.sport);

  const onDaily = (value: string) => {
    setDaily(value);
    local.setDailyRax(parseBudget(value));
  };

  return (
    <section className={cls(layout.phone ? "pnl" : "panel", "fgl")} aria-labelledby={`${id}h`}>
      <div className="ph">
        <h2 id={`${id}h`}>Your first pass</h2>
      </div>
      <div className="fg-pass">
        <PassFace market={market} rarity={rar(market.kind, rung.tier)} size={40} />
        <p>
          <b>{titleText(market)}</b>
          <small>
            {sport} · {tierName(rung.tier)}
            <TermTip term="rarity" /> · about {about(goal.cost)} Rax
          </small>
        </p>
      </div>
      <p className="fg-pays">
        Pays about <b>{about(goal.year)}</b> Rax a year (estimate).
        <TermTip term="passYear" />
      </p>
      <label className="bbf fg-field" htmlFor={`${id}b`}>
        <input
          id={`${id}b`}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          placeholder="0"
          aria-label="Rax you have now"
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
        <span aria-hidden="true">Rax now</span>
      </label>
      <Meter className="fg-bar" value={goal.fill} label="Toward your first pass" />
      <p className="fg-say" role="status">
        {goal.need === 0
          ? "You have enough for it."
          : `${formatRax(Math.round(goal.need))} Rax to go${balance === null ? "" : ` of ${formatRax(Math.round(goal.cost))}`}.`}
        {goal.days !== null && ` About ${formatRax(goal.days)} ${goal.days === 1 ? "day" : "days"} to go (your estimate).`}
      </p>
      {goal.offer !== null && goal.offer < goal.cost && goal.need > 0 && (
        <p className="fg-offer" data-testid="first-offer">
          Cheaper with offers: offer under the usual price on many of its cards. If enough are accepted it costs about{" "}
          {about(goal.offer)} Rax{goal.offerNeed === 0 ? ", which you have." : `, so about ${about(goal.offerNeed ?? 0)} to go.`}
          <TermTip term="offer" />
        </p>
      )}
      <label className="fg-daily" htmlFor={`${id}d`}>
        <span>Rax I make on a typical day (optional)</span>
        <span className="bbf">
          <input
            id={`${id}d`}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            placeholder="e.g. 20"
            aria-label="Rax I make on a typical day (optional)"
            value={daily}
            onChange={(e) => onDaily(e.target.value)}
          />
          <span aria-hidden="true">a day</span>
        </span>
      </label>
      <p className="fg-hint">Your own number: we do not guess what an account earns.</p>
      <button
        type="button"
        className="btn fill fg-go"
        onClick={() => showCards({ sport: market.sport, player_id: market.player_id, season: market.season, label: titleText(market) })}
      >
        See cards for this pass
        <Icon name="arrow" />
      </button>
    </section>
  );
}
