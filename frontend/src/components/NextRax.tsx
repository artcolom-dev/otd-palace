// "Your next Rax": the three to five best things to do with the next Rax, ranked by what each returns per Rax over a
// year (lib/nextRax.ts). On Today a short list; on Passes the fuller one. A pass opens its card, a deal opens Real.
import { useId, useMemo } from "react";
import { useApp } from "../AppContext";
import { about } from "../content/passWords";
import { useLocal } from "../data/local";
import { useHeldMarkets } from "../hooks/useHeldMarkets";
import { cls } from "../lib/cls";
import { formatRax } from "../lib/format";
import { FREE_ORDER, type NextMove, type NextRaxInput, dealMoves, passMoves, rankMoves, resellText } from "../lib/nextRax";
import { toOpenUrl } from "../lib/openLink";
import { TermTip } from "./InfoTip";
import { AllPassesLink, usePassPick } from "./PassPickPanel";
import { useOpenPass } from "./passes/PassCard";
import { usePaused } from "./Paused";

const userAgent = () => (typeof navigator === "undefined" ? "" : navigator.userAgent);
const BUCKET_MS = 5_000; // the deals' clock is looked at every few seconds, not every second

export function Row({ move, pos }: { move: NextMove; pos: number }) {
  const { openDeal } = useApp();
  const openPass = useOpenPass();
  const body = (
    <>
      <span className="nrx-main">
        <b>{move.title}</b>
        <small>{move.what}</small>
        <span className="nrx-ret">{move.returns}</span>
        <span className="nrx-meta">{resellText(move.resell)}</span>
        {move.note && <span className="nrx-meta">{move.note}</span>}
      </span>
      <span className="nrx-cost">
        {move.kind === "deal" ? formatRax(move.cost) : about(move.cost)}
        <small>Rax</small>
      </span>
    </>
  );
  if (move.deal) {
    const deal = move.deal;
    return (
      <a
        className="nrx-row"
        href={toOpenUrl(deal.url, userAgent())}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${deal.player_name} in Real: ${formatRax(deal.price)} Rax, ${move.returns}`}
        onClick={() => openDeal(deal, "deals", pos)}
        onAuxClick={(e) => {
          if (e.button === 1) openDeal(deal, "deals", pos);
        }}
      >
        {body}
      </a>
    );
  }
  return (
    <button type="button" className="nrx-row" onClick={(e) => openPass(move.market!, move.rung!.tier, e.currentTarget)}>
      {body}
    </button>
  );
}

export function NextRaxCard({ variant }: { variant: "today" | "full" }) {
  const { snap, prefs, now, layout } = useApp();
  const { passes, balance } = useLocal();
  const paused = usePaused().paused;
  const id = useId();
  const tick = Math.floor(now / BUCKET_MS);
  const n = variant === "full" ? 5 : 3;
  // On Today the pass worth getting sits beside this list: buying that pass is left out here, so the page never says it
  // twice. Lifting it, when the visitor already holds it, is another move and stays.
  const pick = usePassPick();
  const markets = useHeldMarkets();
  const skip = variant === "today" ? (pick?.market.key ?? null) : null;
  const want = skip === null ? n : n + 1;
  // The passes' moves are worked out when the passes or the choices change (a big account's take a while); the
  // deals', every few seconds.
  const input = (now: number): NextRaxInput => ({
    holdings: passes, level: prefs.level, budget: prefs.budget, passBudget: prefs.passBudget, balance, now, paused, n: want,
  });
  const forPasses = useMemo(
    () => passMoves({ rules: snap.rules, otd: markets === snap.otd.markets ? snap.otd : { ...snap.otd, markets } }, input(0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the rules' pass part is what passMoves reads of them
    [snap.otd, snap.rules.otd, markets, passes, prefs.level, prefs.passBudget, balance, want],
  );
  const result = useMemo(() => {
    const got = rankMoves([...forPasses, ...dealMoves(snap, input(tick * BUCKET_MS))], input(0));
    return skip === null ? got : { ...got, moves: got.moves.filter((m) => m.kind !== "slot" || m.market?.key !== skip).slice(0, n) };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `input` is rebuilt from the listed values
  }, [forPasses, snap, passes, prefs.level, prefs.budget, prefs.passBudget, balance, tick, paused, n, want, skip]);
  if (snap.otd.markets.length === 0 && snap.deals.length === 0) return null;
  return (
    <section className={cls(layout.phone ? "pnl" : "panel", "nrx")} aria-labelledby={`${id}h`}>
      <div className="ph">
        <h2 id={`${id}h`}>Your next Rax</h2>
      </div>
      <p className="pnote">
        {balance === null ? "Best uses of your next Rax" : `Best uses of your ${formatRax(balance)} Rax`}, by what each
        returns per Rax over a year
        <TermTip term="yearBack" />
      </p>
      {result.free && (
        <div className="nrx-order">
          <b>Where to start</b>
          <ol>
            {FREE_ORDER.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </div>
      )}
      {result.moves.length > 0 ? (
        <ol className="nrx-list" aria-label="Your next moves">
          {result.moves.map((move, i) => (
            <li key={move.key}>
              <Row move={move} pos={i} />
            </li>
          ))}
        </ol>
      ) : (
        <p className="nrx-none">
          {result.paused
            ? "Prices are paused right now. Passes that fit will show here."
            : "Nothing that pays back fits right now. A bigger balance or budget shows more."}
        </p>
      )}
      {result.paused && result.moves.length > 0 && <p className="nrx-meta">Deals are left out while prices are paused.</p>}
      <p className="nrx-foot">
        Estimates, not promises: a deal counts once, a pass counts a year. Keep some Rax in hand for a countdown deal.
      </p>
      {variant === "today" && <AllPassesLink />}
    </section>
  );
}
