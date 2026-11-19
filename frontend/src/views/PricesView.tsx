// Prices: every move of today, risers or fallers, in the visitor's sport tab. Each row leads to that player's deals.
import { useId } from "react";
import { useApp } from "../AppContext";
import { InfoTip } from "../components/InfoTip";
import { MOVE_ADVICE, MoveRows, MoveTabs } from "../components/MovesPanel";
import { SellButton } from "../components/SellHelper";
import { SportTabs } from "../components/SportTabs";
import { moveCounts, moveSports, visibleMoves } from "../data/moves";
import { cls } from "../lib/cls";
import { LockedMoves } from "../components/Access";

export function PricesView() {
  const { snap, prefs, setPrefs, follows, layout, movesDir, setMovesDir } = useApp();
  const id = useId();
  const moves = visibleMoves(snap, movesDir, prefs.sport, follows);
  const sports = moveSports(snap);
  if (prefs.sport !== "all" && prefs.sport !== "mine" && !sports.includes(prefs.sport)) sports.push(prefs.sport);

  return (
    <section className={cls("page", "prices-page", layout.phone && "phone")} aria-labelledby={`${id}h`}>
      <header className="phead">
        <h1 id={`${id}h`}>Prices moving today</h1>
        <p className="lede">
          Players whose cards sold for much more, or much less, today than over the last 7 days.
        </p>
        <SellButton className="lnk box sellbtn" />
      </header>
      <div className="mvbar">
        <MoveTabs dir={movesDir} onDir={setMovesDir} controls={`${id}l`} />
        {!snap.locked && <SportTabs counts={moveCounts(snap, movesDir, follows)} sports={sports} />}
      </div>
      <p className="pnote">
        Typical sale in Rax: today ← last 7 days
        <InfoTip term="moves" />
      </p>
      <div id={`${id}l`} role="tabpanel" aria-label={movesDir === "risers" ? "Risers" : "Fallers"}>
        {moves.length > 0 ? (
          <MoveRows moves={moves} dir={movesDir} full />
        ) : (
          <div className="empty mvnone">
            <p>
              <b>Not enough sales yet today.</b> A move shows once a player has 5 or more sales today and over the
              last 7 days.
            </p>
            {prefs.sport !== "all" && (
              <div className="eacts">
                <button type="button" className="lnk box" onClick={() => setPrefs({ sport: "all" })}>
                  Show every sport
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      {moves.length > 0 && <p className="advice">{MOVE_ADVICE[movesDir]}</p>}
      <LockedMoves />
    </section>
  );
}
