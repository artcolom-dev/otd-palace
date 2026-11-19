import { Fragment, type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import { useApp } from "../AppContext";
import { EmptyState, useEmptyReason } from "../components/EmptyState";
import { CoverageNote } from "../components/CoverageNote";
import { InjuryNotes } from "../components/InjuryNotes";
import { DealList } from "../components/DealList";
import { DealTable } from "../components/DealTable";
import { Icon } from "../components/Icon";
import { InfoTip, TermButton } from "../components/InfoTip";
import { NewDealsPill } from "../components/NewDealsPill";
import { useOverlay } from "../components/Overlay";
import { SortMenu } from "../components/SortMenu";
import { RarityStrip } from "../components/RarityStrip";
import { SportTabs } from "../components/SportTabs";
import { GLOSSARY, type TermKey, explain } from "../content/glossary";
import { type DealRow } from "../components/DealTable";
import { dealKey, hurtHidden, sortDeals, sortLabel, sportCounts, visibleDeals, visibleGone } from "../data/deals";
import type { Deal, GoneDeal } from "../data/types";
import { useFreeze } from "../hooks/useFreeze";
import { useOwned } from "../hooks/useOwned";
import { dealOwned } from "../lib/owned";
import { passSortValue } from "../lib/dealPass";
import { useStableList } from "../hooks/useStableList";
import { fallingLast } from "../hooks/useTopTiles";
import { DUR, EASE_OUT, flipFrom, measureTops, play, stagger } from "../lib/motion";
import { formatRax } from "../lib/format";
import { LockedDeals } from "../components/Access";

const rowKey = (el: HTMLElement) => el.dataset.key ?? "";
const rowEls = (body: HTMLElement | null) => (body ? Array.from(body.querySelectorAll<HTMLElement>("[data-key]")) : []);

const TERMS_NEW: [TermKey, string][] = [
  ["start", "to start"],
  ["usual", "usual price"],
  ["cheaper", "% cheaper"],
  ["rating", "rating"],
  ["noProfit", "no profit after fees"],
];
const TERMS_FULL: [TermKey, string][] = [
  ["start", "to start"],
  ["bid", "top bid"],
  ["usual", "usual price"],
  ["under", "% under"],
  ["perPoint", "per rating pt"],
  ["fees", "after fees"],
  ["thin", "thin"],
  ["falling", "falling"],
  ["noProfit", "no profit after fees"],
];

/** Every word of the table and what it means, behind "What the words mean". */
export function Glossary({ keys }: { keys: TermKey[] }) {
  return (
    <dl className="gl">
      {keys.map((key) => (
        <div key={key}>
          <dt>{GLOSSARY[key].title}</dt>
          <dd>{explain(key)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The visitor's deals in order, held still under the thumb: the rows on screen, the arrivals behind the pill. */
export interface DealRanking {
  rows: DealRow[];
  queued: (Deal | GoneDeal)[];
  merge: () => void;
  frozen: boolean; // the visitor is busy with the deals (hovering, touching, scrolling) or an overlay is open
  bind: ReturnType<typeof useFreeze>["bind"];
}

/**
 * The deals this visitor sees and the ones that just went away, in their sort, as a stable list. Deals keeps one;
 * Today keeps one for its top three and the list under them, so the two are one ranking.
 */
export function useDealRanking({ tiles = false }: { tiles?: boolean } = {}): DealRanking {
  const { snap, prefs, follows, now, query, cards } = useApp();
  const overlay = useOverlay();
  const freeze = useFreeze();
  const owned = useOwned();

  const items = useMemo(() => {
    // "See these cards" from a pass: that player-season's cards only, in its sport, at any price.
    const scope = cards ? { ...prefs, sport: cards.sport, budget: null } : prefs;
    const mine = (d: Deal | GoneDeal) => !cards || (d.player_id === cards.player_id && d.season === cards.season);
    const live = visibleDeals(snap, scope, follows, now, query).filter(mine);
    const gone = visibleGone(snap, scope, follows, new Set(live.map(dealKey)), query).filter(mine);
    const sorted = sortDeals<Deal | GoneDeal>(
      [...live, ...gone], prefs.sort, follows, prefs.sort === "passes" ? passSortValue(snap) : undefined,
    );
    // Today's tiles under the default sort: never a falling deal on top while one that is not falling exists, nor a
    // card of a pass the visitor holds at its rarity or higher (it stays in the list, tagged "You own this one").
    if (!tiles || prefs.sort !== "best") return sorted;
    const ranked = fallingLast(sorted);
    if (owned.size === 0) return ranked;
    const held = (d: Deal | GoneDeal) => dealOwned(d, owned) !== null;
    return [...ranked.filter((d) => !held(d)), ...ranked.filter(held)];
  }, [snap, prefs, follows, now, query, cards, tiles, owned]);

  const resetKey = [
    prefs.level, prefs.budget, prefs.sport, prefs.rarity ?? "", prefs.rarer === true, prefs.sort, query, [...follows].sort().join(","), cards?.label ?? "", owned.size,
  ].join("|");
  const frozen = freeze.frozen || overlay.isOpen;
  const { rows, queued, merge } = useStableList(items, { frozen, resetKey });
  return { rows, queued, merge, frozen, bind: freeze.bind };
}

/** The deals list of the Deals tab ("All deals"): its own ranking, from rank 1. */
export function DealsSection({ title, heading }: { title: string; heading: "h1" | "h2" }) {
  const ranking = useDealRanking();
  return <DealsBody title={title} heading={heading} ranking={ranking} rows={ranking.rows} />;
}

/**
 * The deals list, shared by Deals ("All deals") and Today ("More deals", under the top three): sport tabs, sort, the
 * rows (a table on desktop, row links on a phone), the "new deals" pill, gone rows in place, and the empty state.
 * Under Today's tiles (`top`) the rows carry their rank from 4 and the counts leave the tiles out.
 */
export function DealsBody({
  title,
  heading,
  ranking,
  rows,
  top,
  limit,
}: {
  title: string;
  heading: "h1" | "h2";
  ranking: DealRanking;
  rows: DealRow[];
  top?: { keys: ReadonlySet<string>; count: number };
  limit?: number; // show this many rows at most, then "See all deals" (a phone's Today)
}) {
  const app = useApp();
  const { snap, prefs, follows, now, query, setQuery, layout, status, cards, clearCards, flash } = app;
  const overlay = useOverlay();
  const { queued, merge } = ranking;
  // What New hid because a player is hurt, counted in the list's own scope (a pass's cards lift the budget).
  const hurt = hurtHidden(
    snap,
    cards ? { ...prefs, sport: cards.sport, budget: null } : prefs,
    follows,
    now,
    query,
    (d) => !cards || (d.player_id === cards.player_id && d.season === cards.season),
  );

  // A tap on the pill: rows already shown slide to their new places (FLIP), arrivals drop in from above, and the
  // focus (on the pill, which goes) moves to the first arrival's link.
  const body = useRef<HTMLElement | null>(null);
  const section = useRef<HTMLElement>(null);
  const flipTops = useRef<Map<string, number> | null>(null);
  const onMerge = () => {
    flipTops.current = measureTops(rowEls(body.current), rowKey);
    merge();
    const top = section.current?.getBoundingClientRect().top ?? 0;
    if ((top < 0 || top > window.innerHeight - 200) && typeof section.current?.scrollIntoView === "function") {
      section.current.scrollIntoView({ block: "start" });
    }
  };
  useLayoutEffect(() => {
    const tops = flipTops.current;
    if (!tops) return;
    flipTops.current = null;
    const els = rowEls(body.current);
    flipFrom(tops, els, rowKey);
    els.find((el) => !tops.has(rowKey(el)))?.querySelector<HTMLElement>("a[href]")?.focus({ preventScroll: true });
    let n = 0;
    for (const el of els) {
      if (tops.has(rowKey(el))) continue;
      play(el, [{ opacity: 0, transform: "translateY(-14px)" }, { opacity: 1, transform: "none" }], {
        duration: DUR.glide,
        easing: EASE_OUT,
        delay: stagger(n++, 70),
        fill: "backwards",
      });
    }
  });

  // A row an alert points at is scrolled into the middle of the screen (once per pointing), smoothly unless the
  // visitor asks for less motion.
  const scrolledFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    const target = flash ? `${flash.listing}:${flash.seq}` : null;
    if (!flash || scrolledFor.current === target) return;
    const el = rowEls(body.current).find((row) => rowKey(row).startsWith(`${flash.listing}:`));
    if (!el) return; // not drawn yet: the next render tries again
    scrolledFor.current = target;
    if (typeof el.scrollIntoView === "function") {
      const still = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
    }
  });

  const under = top !== undefined;
  const more = under ? sportCounts(snap, prefs, follows, now, top.keys, query).all : 0;
  // Under the tiles with nothing at all besides them (no row, none waiting, no filter of the visitor's to clear):
  // the list keeps its heading and its nudge, without tabs that would all read 0, a sort or words for no rows.
  const bare = under && more === 0 && rows.length === 0 && queued.length === 0 && !cards && !query;
  // The phone's count line. Paused, it says so first and drops the deals-taken count it can no longer vouch for.
  const paused = status === "stale";
  const metaParts: ReactNode[] = [];
  if (paused) metaParts.push(<b key="p">Paused</b>);
  if (!under) {
    metaParts.push(
      <>
        <b>{formatRax(app.openCount)}</b> {app.openCount === 1 ? "deal" : "deals"} for you
      </>,
    );
  } else if (layout.phone && more > 0) {
    // Under the tiles, the count the All tab shows: the deals there are besides the top three, never 0.
    metaParts.push(
      <>
        <b>{formatRax(more)}</b> more {more === 1 ? "deal" : "deals"} for you
      </>,
    );
  }
  if (!paused && snap.taken_10m > 0) {
    metaParts.push(
      <>
        <b>{formatRax(snap.taken_10m)}</b> taken in the last 10 min
      </>,
    );
  }
  const empty = useEmptyReason(under);
  const Heading = heading;
  const stale = status === "stale";
  const full = prefs.level !== "new";
  const terms = full ? TERMS_FULL : TERMS_NEW;
  const pill = <NewDealsPill count={queued.length} onMerge={onMerge} className={layout.wide ? "in-table" : "floating"} />;
  const capped = limit !== undefined && rows.length > limit;
  const rowsProps = {
    label: title,
    rows: capped ? rows.slice(0, limit) : rows,
    stale,
    bind: ranking.bind,
    rankFrom: top ? top.count + 1 : undefined,
    bodyRef: (el: HTMLElement | null) => {
      body.current = el;
    },
  };
  const realMinted = (
    <p>
      Only cards sold by players: Real's own listings are hidden.
      <InfoTip term="realMinted" />
    </p>
  );

  return (
    <section ref={section} className="deals" aria-labelledby={`${heading}-deals`}>
      <div className="dhead">
        <Heading id={`${heading}-deals`}>{title}</Heading>
        {/* The free site's few deals have no sport tabs or sort to choose: those come with Discord. */}
        {!layout.phone && !bare && !snap.locked && <SportTabs exclude={top?.keys} />}
        {!bare && !snap.locked && <SortMenu />}
      </div>
      {/* Deals by rarity: the member's strip wherever the sport tabs are; a visitor's locked one on Deals only. */}
      {!layout.phone && !bare && (!snap.locked || !under) && <RarityStrip exclude={top?.keys} />}
      {!bare && follows.size > 0 && <p className="dmeta pinnote">Players you star come first, then {sortLabel(prefs.sort, prefs.level).toLowerCase()}.</p>}
      {layout.phone && bare && metaParts.length > 0 && (
        <p className="dmeta">
          {metaParts.map((part, i) => (
            <Fragment key={i}>
              {i > 0 && " · "}
              {part}
            </Fragment>
          ))}
        </p>
      )}
      {layout.phone && !bare && (
        <>
          {metaParts.length > 0 && (
            <p className="dmeta">
              {metaParts.map((part, i) => (
                <Fragment key={i}>
                  {i > 0 && " · "}
                  {part}
                </Fragment>
              ))}
            </p>
          )}
          {!snap.locked && <SportTabs exclude={top?.keys} />}
          {(!snap.locked || !under) && <RarityStrip exclude={top?.keys} />}
          <div className="terms">
            <span>Words:</span>
            {terms.map(([key, label]) => (
              <TermButton key={key} term={key} className="term">
                {label}
                <Icon name="info" />
              </TermButton>
            ))}
          </div>
        </>
      )}
      {cards && (
        <div className="frow">
          <span className="fchip">
            Showing <b>{cards.label}</b> cards
            <button type="button" className="icb" aria-label="Clear the card filter" onClick={clearCards}>
              <Icon name="x" />
            </button>
          </span>
        </div>
      )}
      {query && (
        <div className="frow">
          <span className="fchip">
            Showing <b>{query}</b>
            <button type="button" className="icb" aria-label="Clear search" onClick={() => setQuery("")}>
              <Icon name="x" />
            </button>
          </span>
        </div>
      )}
      <div className="tblwrap">
        {layout.wide && pill}
        {rows.length > 0 && (layout.wide ? <DealTable {...rowsProps} /> : <DealList {...rowsProps} />)}
      </div>
      {capped && (
        <button type="button" className="lnk seeall" onClick={() => app.navigate("deals")}>
          See all deals
          <Icon name="arrow" />
        </button>
      )}
      {!layout.wide && pill}
      {snap.locked && !under && <LockedDeals shown={rows.length} />}
      {rows.length === 0 &&
        (cards ? (
          <EmptyState
            message={<b>No {cards.label} cards are a deal right now.</b>}
            actions={[{ label: "Show all deals", run: clearCards }]}
          />
        ) : (
          <EmptyState message={empty.message} actions={empty.actions} />
        ))}
      <div className="tfoot">
        {realMinted}
        <CoverageNote />
        <InjuryNotes hidden={hurt} />
        {!layout.phone && (
          <button
            type="button"
            className="lnk"
            onClick={(e) =>
              overlay.open({
                title: "What the words mean",
                anchor: e.currentTarget,
                size: "wide",
                body: () => <Glossary keys={["rating", ...terms.map(([k]) => k).filter((k) => k !== "rating"), "realMinted"]} />,
              })
            }
          >
            <Icon name="info" />
            What the words mean
          </button>
        )}
      </div>
    </section>
  );
}
