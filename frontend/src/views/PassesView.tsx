// Passes: the daily-pay pass advisor. The top pick, the ranked passes with their filters, and around them what this
// device holds (My passes), what to do next ("Your next Rax"), the 12-month plan, the rating planner (Pro) and how
// passes work. On a phone, Best passes and My passes are two views.
//
// A screen says what to add once. "Your next Rax" is that list wherever it is drawn (the desktop rail, a phone's My
// passes): it ranks the passes to add and the ones to lift by what each Rax returns, so no second panel repeats them
// beside it. "Cheapest way to start" is drawn only on the screen that has no such list (a phone's Best passes), and the
// 12-month plan keeps its month-by-month steps behind its table (components/passes/Snowball.tsx).
import { useMemo } from "react";
import { LockedPlan } from "../components/Access";
import { useApp } from "../AppContext";
import { Icon } from "../components/Icon";
import { MyPassesPanel, MyPassesView } from "../components/passes/MyPasses";
import { useOverlay } from "../components/Overlay";
import { NextRaxCard } from "../components/NextRax";
import { HowPasses, PassGlossary, RatingPlanner, StarterPanel } from "../components/passes/Panels";
import { SnowballCard } from "../components/passes/Snowball";
import { PassHero } from "../components/passes/PassHero";
import { PassListSection } from "../components/passes/PassList";
import { useLocal } from "../data/local";
import { useOwned } from "../hooks/useOwned";
import { passList } from "../data/passList";
import { buildToTier } from "../lib/buildToSwitch";
import { formatRax } from "../lib/format";
import { usePassUi } from "./passState";

/** "Player and team passes pay you Rax On This Day…": what a pass is, in one line, until dismissed for the visit. */
function Intro({ onHide }: { onHide: () => void }) {
  return (
    <div className="pintro" role="note">
      <Icon name="passes" />
      <p>
        <b>On This Day</b> means a pass pays you Rax on the anniversary of one of its games, until a lifetime limit.
        Real pays 2 passes per sport a day.
      </p>
      <button
        type="button"
        className="lnk"
        onClick={() => document.getElementById("how-passes")?.scrollIntoView({ block: "start" })}
      >
        How passes work
      </button>
      <button type="button" className="icb x" aria-label="Dismiss this note" onClick={onHide}>
        <Icon name="x" />
      </button>
    </div>
  );
}

/** On a phone, under How passes work: every word of the tab, in a sheet. */
function WordsButton() {
  const { prefs } = useApp();
  const overlay = useOverlay();
  return (
    <button
      type="button"
      className="lnk plain words"
      onClick={(e) =>
        overlay.open({
          title: "What the words mean",
          anchor: e.currentTarget,
          body: () => <PassGlossary level={prefs.level} />,
        })
      }
    >
      What the words mean
      <Icon name="arrow" />
    </button>
  );
}

export function PassesView() {
  const { snap, prefs, layout, query } = useApp();
  const locked = snap.locked !== undefined; // the free site: the best passes; the visitor's own come with Discord
  const [ui, setUi] = usePassUi(prefs.level);
  const { passes } = useLocal();
  const held = useMemo(() => new Set(passes.map((p) => p.key)), [passes]);
  const owned = useOwned();
  const sport = ui.sport === "all" || snap.otd.sports[ui.sport] ? ui.sport : "all";
  const buildTo = buildToTier(prefs.buildTo); // null for Best for each, and while the switch is off
  const state = useMemo(
    () =>
      passList(snap, {
        level: prefs.level,
        budget: prefs.passBudget,
        sport,
        season: ui.season,
        soon: ui.soon,
        showAll: ui.showAll,
        sort: ui.sort,
        query,
        held,
        owned,
        buildTo,
      }),
    [snap, prefs.level, prefs.passBudget, sport, ui.season, ui.soon, ui.showAll, ui.sort, query, held, owned, buildTo],
  );
  const shown = { ...ui, sport };
  const pro = prefs.level === "pro";

  if (snap.otd.markets.length === 0) {
    return (
      <div className="page passes-page">
        <section className="hero none passhero" aria-label="On This Day passes">
          <div className="nohero">
            <h1>On This Day passes</h1>
            <p>No pass data yet. The passes appear here once the next update has read their seasons and card sales.</p>
          </div>
        </section>
      </div>
    );
  }

  const planner = pro && (
    <RatingPlanner
      className={layout.phone ? "pnl" : "panel"}
      planKey={ui.planKey ?? state.top?.market.key ?? null}
      rating={ui.planRating}
      onKey={(planKey) => setUi({ planKey })}
      onRating={(planRating) => setUi({ planRating })}
    />
  );

  if (layout.phone) {
    const mine = ui.view === "mine";
    return (
      <div className="page passes-page phone">
        <h1 className="sr">On This Day passes</h1>
        <div className="views" role="tablist" aria-label="Passes">
          <button
            type="button"
            role="tab"
            id="pv-best"
            aria-selected={!mine}
            aria-controls="pv-panel"
            onClick={() => setUi({ view: "best" })}
          >
            <span>Best passes</span>
          </button>
          <button
            type="button"
            role="tab"
            id="pv-mine"
            aria-selected={mine}
            aria-controls="pv-panel"
            onClick={() => setUi({ view: "mine" })}
          >
            <span>
              My passes{" "}
              <span className="n">{formatRax(passes.length)}</span>
            </span>
          </button>
        </div>
        <div id="pv-panel" role="tabpanel" aria-labelledby={mine ? "pv-mine" : "pv-best"}>
          {mine ? (
            locked ? (
              <LockedPlan />
            ) : (
              <>
                <MyPassesView flash={ui.flash} />
                <NextRaxCard variant="full" />
                <SnowballCard />
              </>
            )
          ) : (
            <>
              <PassHero top={state.top} sport={sport} allHeld={state.rows.length > 0} buildTo={buildTo} />
              <PassListSection state={state} ui={shown} setUi={setUi} />
              <StarterPanel className="pnl" />
              {!locked && <SnowballCard />}
              {planner}
              <HowPasses className="pnl phow" id="how-passes">
                <WordsButton />
              </HowPasses>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="pwrap passes-page">
      <h1 className="sr">On This Day passes</h1>
      <div className="lcol">
        {!ui.introHidden && <Intro onHide={() => setUi({ introHidden: true })} />}
        <PassHero top={state.top} sport={sport} allHeld={state.rows.length > 0} buildTo={buildTo} />
        <PassListSection state={state} ui={shown} setUi={setUi} />
        {!locked && <SnowballCard />}
        <HowPasses className="howto" id="how-passes" />
      </div>
      <div className="prail" role="complementary" aria-label="Your passes">
        {locked ? (
          <LockedPlan />
        ) : (
          <>
            <MyPassesPanel open={ui.mineOpen} flash={ui.flash} />
            <NextRaxCard variant="full" />
            {planner}
          </>
        )}
      </div>
    </div>
  );
}
