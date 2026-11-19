// "This month in Real", on Today: the one season move that pays now (the most urgent sport first), how many sports
// pay On This Day this month, and the way into the full "Earn more Rax" guide. Nothing without the season months.
import { useId } from "react";
import { useApp } from "../AppContext";
import { cls } from "../lib/cls";
import { phaseLabel, seasonMove, topMove } from "../lib/season";
import { sportLabel } from "../lib/words";
import { EARN_TITLE, useOpenEarn, useSeasonBoard } from "./EarnSheet";
import { Icon } from "./Icon";

export function EarnCard() {
  const { layout } = useApp();
  const id = useId();
  const board = useSeasonBoard();
  const open = useOpenEarn();
  const top = topMove(board);
  if (!top) return null;
  const paying = board.filter((s) => s.phase === "season" || s.phase === "playoffs" || s.phase === "allyear").length;
  return (
    <section className={cls(layout.phone ? "pnl" : "panel", "earncard")} aria-labelledby={`${id}h`}>
      <div className="ph">
        <h2 id={`${id}h`}>This month in Real</h2>
      </div>
      <p className="earn-top">
        <b>{sportLabel(top.sport)}</b>
        <span className="earn-ph">{phaseLabel(top)}</span>
      </p>
      <p className="earn-move">{seasonMove(top).move}.</p>
      <p className="pnote">
        {paying} of {board.length} sports pay On This Day this month.
      </p>
      <button type="button" className="lnk box earn-go" aria-haspopup="dialog" onClick={(e) => open(e.currentTarget)}>
        {EARN_TITLE}
        <Icon name="arrow" />
      </button>
    </section>
  );
}
