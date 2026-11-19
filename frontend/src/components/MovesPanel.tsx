// Today's price moves: the Risers / Fallers tabs, the rows (shared by the "Moving today" panel and the Prices page),
// and the panel itself. A row leads to that player's deals; its arrow draws in when the list appears.
import { type KeyboardEvent, type MouseEvent, useId, useLayoutEffect, useRef } from "react";
import { useApp } from "../AppContext";
import { type MoveDir, MOVE_DIRS, bandText, changeText, moveKey, visibleMoves } from "../data/moves";
import type { Move } from "../data/types";
import { cls } from "../lib/cls";
import { formatRax } from "../lib/format";
import { rovingIndex } from "../lib/keys";
import { DUR, EASE_OUT, play, stagger } from "../lib/motion";
import { priceCurve } from "../lib/priceCurve";
import { plural, sportLabel, seasonLabel } from "../lib/words";
import { FollowStar } from "./FollowStar";
import { Icon } from "./Icon";
import { MoveCurve } from "./MoveCurve";
import { PausedNotice, usePaused } from "./Paused";
import { PlayerAvatar } from "./PlayerAvatar";

const DIR_LABEL: Record<MoveDir, string> = { risers: "Risers", fallers: "Fallers" };

/** What to make of each side, in words the data backs. */
export const MOVE_ADVICE: Record<MoveDir, string> = {
  risers: "Own one? Prices that jump in a day can fall back just as fast.",
  fallers: "Deals on these players may be traps: their usual price may be out of date.",
};

/** A plain click on a link inside the page (a modified click is the browser's: a new tab or window). */
const plainClick = (e: MouseEvent) => !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0);

/** Risers / Fallers as one tab stop: the arrows, Home and End switch sides. */
export function MoveTabs({ dir, onDir, controls }: { dir: MoveDir; onDir: (dir: MoveDir) => void; controls: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = rovingIndex(e.key, MOVE_DIRS.indexOf(dir), MOVE_DIRS.length, "horizontal");
    if (i === null) return;
    e.preventDefault();
    const next = MOVE_DIRS[i]!;
    onDir(next);
    ref.current?.querySelector<HTMLElement>(`[data-dir="${next}"]`)?.focus();
  };
  return (
    <div ref={ref} className="mvtabs" role="tablist" aria-label="Risers or fallers" onKeyDown={onKeyDown}>
      {MOVE_DIRS.map((d) => (
        <button
          key={d}
          type="button"
          role="tab"
          data-dir={d}
          aria-selected={dir === d}
          aria-controls={controls}
          tabIndex={dir === d ? 0 : -1}
          onClick={() => onDir(d)}
        >
          <span>{DIR_LABEL[d]}</span>
        </button>
      ))}
    </div>
  );
}

/** The arrow of a move, drawn as one stroke so it can draw itself in. */
function MoveArrow({ up }: { up: boolean }) {
  return (
    <svg className="i draw" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path pathLength={1} d={up ? "M7 17L17 7M9 7h8v8" : "M7 7l10 10M17 9v8H9"} />
    </svg>
  );
}

/** Opens Deals on one player: their sport, and the player search set to their name. */
export function useShowPlayerDeals() {
  const { setPrefs, setQuery, navigate } = useApp();
  return (m: Pick<Move, "sport" | "player_name">) => {
    setPrefs({ sport: m.sport });
    setQuery(m.player_name);
    navigate("deals");
  };
}

/**
 * The rows of one side. Each row is a link to that player's deals, with the follow star above it; `full` adds the
 * season and rating band (the Prices page) and, when the snapshot carries one, the market's curve (lib/priceCurve.ts):
 * the list makes room for it only when some row has one to draw, so without curves it is laid out as before. The
 * arrows draw in when the list appears and when the side changes.
 */
export function MoveRows({
  moves,
  dir,
  full = false,
  describedBy,
}: {
  moves: Move[];
  dir: MoveDir;
  full?: boolean;
  describedBy?: string; // paused: each row's link is described by the panel's notice
}) {
  const showDeals = useShowPlayerDeals();
  const { snap } = useApp(); // the free site has no follow stars: its rows give their column up
  const ref = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    ref.current?.querySelectorAll<SVGPathElement>(".draw path").forEach((path, i) => {
      play(
        path,
        [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }],
        { duration: DUR.enter, easing: EASE_OUT, delay: DUR.fast + stagger(i, 60), fill: "backwards" },
        [{ opacity: 0 }, { opacity: 1 }],
      );
    });
  }, [dir]);

  const curves = full ? moves.map(priceCurve) : [];
  const curved = curves.some(Boolean);
  return (
    <ul ref={ref} className={cls("mvlist", full && "full", curved && "curved")} aria-label={DIR_LABEL[dir]}>
      {moves.map((m, i) => {
        const curve = curves[i] ?? null;
        const up = m.change > 0;
        const change = changeText(m.change);
        const sales = `${plural(m.sales_recent, "sale", "sales")} today`;
        return (
          <li key={moveKey(m)} className={cls("mv", full && "full", snap.locked && "nostar", curved && "curved")}>
            <a
              className="rl"
              href="#deals"
              aria-label={`See deals for ${m.player_name}: ${formatRax(m.median_recent)} Rax today, ${formatRax(m.median_base)} over the last 7 days, ${change}, ${sales}`}
              aria-describedby={describedBy}
              onClick={(e) => {
                if (!plainClick(e)) return;
                e.preventDefault();
                showDeals(m);
              }}
            />
            <FollowStar player={m} />
            <PlayerAvatar sport={m.sport} playerId={m.player_id} name={m.player_name} size={full ? 32 : 28} />
            <span className="mvn">
              <b data-testid="move-player">{m.player_name}</b>
              <span className="sp">{sportLabel(m.sport)}</span>
              {full && (
                <small>
                  {seasonLabel(m.sport, m.season)} · {bandText(m.bucket)}
                </small>
              )}
            </span>
            <span className="mvsub">
              <span className="mvp" data-testid="move-prices">
                <em>{formatRax(m.median_recent)}</em> <span aria-hidden="true">←</span> {formatRax(m.median_base)}
              </span>
              <span className="sep" aria-hidden="true">
                {" · "}
              </span>
              <span className="mvs">{sales}</span>
            </span>
            {curve && <MoveCurve curve={curve} />}
            <span className={cls("chg", up ? "up" : "down")} data-testid="move-change">
              <MoveArrow up={up} />
              {change}
            </span>
            {full && (
              <span className="mvgo" aria-hidden="true">
                Deals
                <Icon name="arrow" />
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** "Moving today" on Today: the top 4 (3 on a phone) of the chosen side in the visitor's sport, then Prices. */
export function MovesPanel() {
  const { snap, prefs, follows, layout, movesDir, setMovesDir, navigate } = useApp();
  const id = useId();
  const top = visibleMoves(snap, movesDir, prefs.sport, follows).slice(0, layout.phone ? 3 : 4);
  // Paused, the panel says so (quietly: the top tiles already said it out loud) and its rows are described by it.
  const paused = usePaused();
  return (
    <section className={cls(layout.phone ? "pnl" : "panel", "moves")} aria-labelledby={`${id}h`} {...paused.rootProps}>
      <div className="ph">
        <h2 id={`${id}h`}>Moving today</h2>
        <MoveTabs dir={movesDir} onDir={setMovesDir} controls={`${id}l`} />
      </div>
      <p className="pnote">Typical sale: today ← last 7 days</p>
      <PausedNotice {...paused} quiet />
      <div id={`${id}l`} role="tabpanel" aria-labelledby={`${id}h`} data-stale-quiet>
        {top.length > 0 ? (
          <MoveRows moves={top} dir={movesDir} describedBy={paused.actionProps["aria-describedby"]} />
        ) : (
          <p className="mvempty">Not enough sales yet today.</p>
        )}
      </div>
      {top.length > 0 && <p className="advice">{MOVE_ADVICE[movesDir]}</p>}
      <a
        className="plink"
        href="#prices"
        onClick={(e) => {
          if (!plainClick(e)) return;
          e.preventDefault();
          navigate("prices");
        }}
      >
        See all moves
        <Icon name="arrow" />
      </a>
    </section>
  );
}
