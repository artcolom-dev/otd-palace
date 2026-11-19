// "Pass worth getting" on Today: the Passes tab's top pick for this visitor's pass budget and sport, in one plain
// sentence, with the way to its cards and to the rest of the passes.
import { type MouseEvent, useId, useMemo } from "react";
import { useApp } from "../AppContext";
import { sportLabel } from "../lib/words";
import { about, big, seasonText, spanText, tierName, titleText } from "../content/passWords";
import { defaultSeason, passList } from "../data/passList";
import { cls } from "../lib/cls";
import { dayOf, monthsToLimit } from "../lib/passes";
import { useOwned } from "../hooks/useOwned";
import { FollowStar } from "./FollowStar";
import { Icon } from "./Icon";
import { InfoTip } from "./InfoTip";
import { PassFace, PassTags, Swatch, useRarity } from "./passes/bits";

const plainClick = (e: MouseEvent) => !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0);
const monthsWord = (months: number) => {
  const n = Math.max(1, Math.round(months));
  return `${n} month${n === 1 ? "" : "s"}`;
};

/** The pass this panel offers (the Passes tab's top pick for the visitor's pass budget and sport), or null: never one
 * the visitor holds already, at any rung. */
export function usePassPick() {
  const { snap, prefs } = useApp();
  const owned = useOwned();
  const sport = snap.otd.sports[prefs.sport] ? prefs.sport : "all";
  return useMemo(
    () =>
      snap.otd.markets.length === 0
        ? null
        : passList(snap, {
            level: prefs.level,
            budget: prefs.passBudget,
            sport,
            season: defaultSeason(prefs.level),
            soon: false,
            showAll: false,
            sort: "ret",
            query: "",
            owned,
          }).top,
    [snap, prefs.level, prefs.passBudget, sport, owned],
  );
}

/** "See all passes": the Passes tab, in place on a plain click; a modified click keeps the browser's own way. */
export function AllPassesLink() {
  const { navigate } = useApp();
  const toPasses = (e: MouseEvent) => {
    if (!plainClick(e)) return;
    e.preventDefault();
    navigate("passes");
  };
  return (
    <a className="plink" href="#passes" onClick={toPasses}>
      See all passes
      <Icon name="arrow" />
    </a>
  );
}

export function PassPickPanel() {
  const { snap, prefs, layout, showCards } = useApp();
  const id = useId();
  const rar = useRarity();
  const sport = snap.otd.sports[prefs.sport] ? prefs.sport : "all";
  const top = usePassPick();
  const allPasses = <AllPassesLink />;

  let body;
  if (snap.otd.markets.length === 0) {
    body = <p className="mvempty">No pass data yet.</p>;
  } else if (!top) {
    body = (
      <>
        <p className="mvempty">
          No pass pays back {prefs.passBudget === null ? "right now" : `for ${big(prefs.passBudget)} or less`}
          {sport === "all" ? "" : " in this sport"}.
        </p>
        {allPasses}
      </>
    );
  } else {
    const { market: m, rung: r } = top;
    const today = dayOf(snap.otd.as_of);
    const months = r.payback_months;
    const toLimit = r.limit === null ? null : monthsToLimit(m, r, snap.rules.otd, today);
    body = (
      <>
        <div className="pp-top">
          <PassFace market={m} rarity={rar(m.kind, r.tier)} size={40} />
          <div className="pp-who">
            <span className="ppn">
              <h3>{m.player_name}</h3>
              {m.kind !== "team" && <FollowStar player={m} />}
            </span>
            <small>
              {sportLabel(m.sport)} {m.season_label} · <Swatch kind={m.kind} tier={r.tier} />
              {tierName(r.tier)} pass · {seasonText(m)}
            </small>
            <PassTags market={m} rung={r} />
          </div>
        </div>
        {months !== null && (
          <p className="pay">
            Pays back in about <strong>{spanText(months)}</strong>
          </p>
        )}
        <p className="ppline">
          Pays about <b>{about(r.year_rax)}</b> Rax a year on game days.
          {r.cost !== null && months !== null && (
            <>
              {" "}
              Your <b>{about(r.cost)}</b> comes back in about <b>{monthsWord(months)}</b>
              {r.limit !== null && (
                <>
                  ; it stops after {r.limit_estimated ? "about " : ""}
                  <b>{big(r.limit)}</b> in total{toLimit !== null && <> (~{monthsWord(toLimit)})</>}
                </>
              )}
              .
            </>
          )}
        </p>
        <div className="pplinks">
          <a
            className="plink"
            href="#deals"
            onClick={(e) => {
              if (!plainClick(e)) return;
              e.preventDefault();
              showCards({ sport: m.sport, player_id: m.player_id, season: m.season, label: titleText(m) });
            }}
          >
            See deals for {m.player_name}
            <Icon name="arrow" />
          </a>
          {allPasses}
        </div>
      </>
    );
  }

  return (
    <section className={cls(layout.phone ? "pnl" : "panel", "passpick")} aria-labelledby={`${id}h`}>
      <div className="ph">
        <h2 id={`${id}h`}>Pass worth getting</h2>
        <InfoTip term="otd" />
      </div>
      {body}
    </section>
  );
}
