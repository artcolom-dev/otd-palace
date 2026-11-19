import { CommunityCta } from "../components/CommunityCta";
import { type ReactNode, useMemo } from "react";
import { MovesPanel } from "../components/MovesPanel";
import { PassPickPanel } from "../components/PassPickPanel";
import { useApp } from "../AppContext";
import { TopDeals } from "../components/TopDeals";
import { budgetNudge, hiddenByLevel } from "../data/deals";
import { useOwned } from "../hooks/useOwned";
import { useTopTiles } from "../hooks/useTopTiles";
import { dealOwned } from "../lib/owned";
import { cls } from "../lib/cls";
import { formatRax } from "../lib/format";
import { AccountCard } from "../components/AccountLookup";
import { InstallPrompt } from "../components/InstallPrompt";
import { SavedTotal } from "../components/SavedTotal";
import { DealsBody, useDealRanking } from "./DealsSection";
import { LockedDeals, LockedPlan, useLocked } from "../components/Access";
import { CoachSlot, DaySlot, NextSlot, OpenedSlot, PanelsSlot, PlanSlot, SinceSlot } from "./slots";

const PHONE_ROWS = 5; // a phone's Today lists this many more deals under the top three, then "See all deals"

/**
 * In the top three's place when this visitor has no deal at all: it says so, at any level, and offers the one change
 * that helps (a budget that reaches any deal of this level and sport, or else the full list).
 */
function NoDeal() {
  const { snap, prefs, setPrefs, setLevel, follows, now, layout, navigate } = useApp();
  const nudge = budgetNudge(snap, prefs, follows, now);
  // At New, the deals that exist are often live auctions about to end, which only Regular shows: say so, offer it.
  const waiting = nudge ? 0 : hiddenByLevel(snap, prefs, follows, now); // a budget that reaches a deal comes first
  const action = waiting > 0
    ? { label: "Switch to Regular", run: () => setLevel("regular") }
    : nudge
    ? {
        label: nudge.next === null ? "Show any price" : `Show up to ${formatRax(nudge.next)}`,
        run: () => setPrefs({ budget: nudge.next }),
      }
    : { label: "See all deals", run: () => navigate("deals") };
  return (
    <section className={cls("hero", "none", layout.phone && "phone")} aria-label="Best deal for you right now">
      <div className="nohero">
        <h2>No deal for you right now</h2>
        <p>
          {waiting > 0
            ? `${waiting === 1 ? "1 deal is" : `${formatRax(waiting)} deals are`} live at Regular: auctions about to end, which New keeps out.`
            : "Nothing fits your level, budget and sport right now."}
          {waiting === 0 && nudge && ` The cheapest deal is ${formatRax(nudge.cheapest)}.`}
        </p>
      </div>
      {/* The free site has no level or budget to change: the way to every deal sits right under it. */}
      {!snap.locked && (
        <button type="button" className="lnk box" onClick={action.run}>
          {action.label}
        </button>
      )}
    </section>
  );
}

/**
 * Today: this visitor's top three deals as ranked tiles, then the rest of their deals from rank 4, one ranking held
 * still under the thumb. Around them, the reasons to come back (since the last visit, the deals opened, the saved
 * total) and the right column: prices moving today and the pass worth getting. A phone runs it all in one column:
 * the tiles, 5 more deals, moves, the pass, and the add-to-home-screen card.
 */
export function TodayView() {
  const { now, layout } = useApp();
  const locked = useLocked(); // the free site: its few deals as the tiles, then the way to the rest
  const ranking = useDealRanking({ tiles: true });
  const owned = useOwned();
  // A card of a pass the visitor holds at its rarity or higher is never a top tile: it waits in the list below,
  // tagged "You own this one" (the ranking already puts it last).
  const { open, mine } = useMemo(() => {
    if (owned.size === 0) return { open: ranking.rows, mine: [] };
    const held = (r: (typeof ranking.rows)[number]) => dealOwned(r.item, owned) !== null;
    return { open: ranking.rows.filter((r) => !held(r)), mine: ranking.rows.filter(held) };
  }, [ranking.rows, owned]);
  const { tiles, rest: others } = useTopTiles(open, ranking.frozen, now);
  const rest = mine.length ? [...others, ...mine] : others;
  const tileKeys = tiles.map((t) => t.row.key).join("|");
  const top = useMemo(
    () => ({ keys: new Set(tileKeys ? tileKeys.split("|") : []), count: tiles.length }),
    [tileKeys, tiles.length],
  );

  const hero = tiles.length > 0 ? <TopDeals tiles={tiles} bind={ranking.bind} /> : <NoDeal />;
  if (locked) return <FreeToday hero={hero} shown={tiles.length + rest.length} />;
  // With no deal at all, the nudge in the tiles' place is the whole page; but deals that arrived while every tile
  // went away wait behind the list's pill, so the list stays for them.
  const deals = (tiles.length > 0 || ranking.queued.length > 0) && (
    <DealsBody
      title="More deals"
      heading="h2"
      ranking={ranking}
      rows={rest}
      top={top}
      limit={layout.phone ? PHONE_ROWS : undefined}
    />
  );

  if (layout.phone) {
    return (
      <div className="page today">
        <h1 className="sr">Today</h1>
        <div className="slot" data-slot="coach">
          <CoachSlot />
        </div>
        <div className="slot" data-slot="since">
          <SinceSlot />
        </div>
        <div className="slot" data-slot="opened">
          <OpenedSlot />
        </div>
        {hero}
        {/* Right after the best three, where a phone's visitor is still looking; a member is not asked. */}
        <CommunityCta show="invite" />
        <SavedTotal variant="phone" />
        {deals}
        <div className="slot" data-slot="plan">
          <PlanSlot />
        </div>
        <div className="slot" data-slot="account">
          <AccountCard />
        </div>
        <div className="slot" data-slot="day">
          <DaySlot />
        </div>
        <div className="slot" data-slot="panels">
          <PanelsSlot />
        </div>
        <InstallPrompt />
      </div>
    );
  }

  return (
    <div className="wrap today">
      <h1 className="sr">Today</h1>
      <div className="lcol">
        <div className="slot" data-slot="coach">
          <CoachSlot />
        </div>
        <div className="slot" data-slot="since">
          <SinceSlot />
        </div>
        {hero}
        <div className="slot" data-slot="next">
          <NextSlot />
        </div>
        {deals}
      </div>
      <aside className="rcol" aria-label="Your deals, prices and passes">
        <div className="slot" data-slot="opened">
          <OpenedSlot />
        </div>
        <div className="slot" data-slot="plan">
          <PlanSlot />
        </div>
        <div className="slot" data-slot="account">
          <AccountCard />
        </div>
        <div className="slot" data-slot="day">
          <DaySlot />
        </div>
        <div className="slot" data-slot="panels">
          <PanelsSlot />
        </div>
      </aside>
    </div>
  );
}

/**
 * Today on the free site: the best deals the server gave it as the tiles, the way to every deal (the one prompt of the
 * deals), then what is free for everyone: the "Right now" coach, the day's checklist, the moves and the pass worth
 * getting. The plan's place says what linking an account gives. Nothing here asks twice.
 */
function FreeToday({ hero, shown }: { hero: ReactNode; shown: number }) {
  const { layout } = useApp();
  if (layout.phone) {
    // One column: the deals and their way in, then what is free, then the other two ways in, apart from each other.
    return (
      <div className="page today free">
        <h1 className="sr">Today</h1>
        <div className="slot" data-slot="coach">
          <CoachSlot />
        </div>
        <div className="slot" data-slot="opened">
          <OpenedSlot />
        </div>
        {hero}
        <LockedDeals shown={shown} />
        <div className="slot" data-slot="day">
          <DaySlot />
        </div>
        <div className="slot" data-slot="panels">
          <MovesPanel />
          <PassPickPanel />
        </div>
        <CommunityCta show="invite" />
        <div className="slot" data-slot="account">
          <LockedPlan />
        </div>
      </div>
    );
  }
  return (
    <div className="wrap today free">
      <h1 className="sr">Today</h1>
      <div className="lcol">
        <div className="slot" data-slot="coach">
          <CoachSlot />
        </div>
        {hero}
        <LockedDeals shown={shown} />
      </div>
      <aside className="rcol" aria-label="Prices, passes and the way to more">
        <div className="slot" data-slot="opened">
          <OpenedSlot />
        </div>
        <div className="slot" data-slot="account">
          <LockedPlan />
        </div>
        <div className="slot" data-slot="day">
          <DaySlot />
        </div>
        <div className="slot" data-slot="panels">
          <MovesPanel />
          <PassPickPanel />
          <CommunityCta />
        </div>
      </aside>
    </div>
  );
}
