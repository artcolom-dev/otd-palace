import { type MouseEvent, type ReactNode, startTransition, useCallback, useEffect, useState } from "react";
import { useApp } from "../AppContext";
import { Brand } from "../components/Brand";
import { AlertsButton, SettingsLink } from "../components/AlertsSheet";
import { BudgetChip, BudgetChips, PassBudgetChip, PassBudgetChips } from "../components/BudgetChips";
import { CommunityCta } from "../components/CommunityCta";
import { EarnLink } from "../components/EarnSheet";
import { SupportLink } from "../components/SupportSheet";
import { HowLink } from "../components/HowSheet";
import { Icon, type IconName } from "../components/Icon";
import { LevelControl, LevelMeaning } from "../components/LevelControl";
import { AccountButton } from "../components/AccountLookup";
import { DiscordButton, useAccess, useLocked } from "../components/Access";
import { BudgetButton } from "../components/BudgetBuddy";
import { LivePill } from "../components/LivePill";
import { MemberLine } from "../components/MemberLine";
import { PrivacyLink } from "../components/PrivacyLink";
import { PullToRefresh } from "../components/PullToRefresh";
import { useProgress, useReconnecting } from "../components/TopProgress";
import { SearchBox, SearchButton } from "../components/PlayerSearch";
import { UndoBar } from "../components/UndoBar";
import { WelcomeStrip } from "../components/WelcomeStrip";
import { PassTotal } from "../components/passes/MyPasses";
import { useLocal } from "../data/local";
import type { TabKey } from "../data/prefs";
import { tabPath } from "../lib/tabHint";
import { cls } from "../lib/cls";
import { formatRax } from "../lib/format";
import { SavedSlot } from "./slots";

export { Brand };

const NAV: { tab: TabKey; label: string; icon: IconName }[] = [
  { tab: "today", label: "Today", icon: "today" },
  { tab: "deals", label: "Deals", icon: "deals" },
  { tab: "prices", label: "Prices", icon: "prices" },
  { tab: "passes", label: "Passes", icon: "passes" },
  { tab: "plan", label: "Your plan", icon: "flag" },
];

/**
 * The menu's clicks, and the tab the menu shows as current. A tap lights its tab at once (the next frame), and the
 * page it names is drawn as a transition React can split into short slices: the finger never waits for a whole page
 * to be built, and the old page stays until the new one is ready (no skeleton flash for a view already fetched).
 */
function useNav(tab: TabKey) {
  const { navigate } = useApp();
  const [pending, setPending] = useState<TabKey | null>(null);
  useEffect(() => setPending(null), [tab]);
  useProgress(pending !== null); // the new page's code still on its way: the top bar (after 180 ms, so never for a page at hand)
  const onNav = (next: TabKey) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; // a new tab or window: the browser's
    e.preventDefault();
    if (next === tab) {
      navigate(next); // back to the top of the page already open
      return;
    }
    setPending(next);
    startTransition(() => navigate(next, { restore: true }));
  };
  return { current: pending ?? tab, onNav };
}

/** "Not affiliated with Real.", tagged "Sample data" while the server runs on the bundled sample. */
function LegalLine({ className, demo, children }: { className: string; demo: boolean; children?: ReactNode }) {
  return (
    <footer className={className}>
      {demo && <span className="tag">Sample data</span>}
      <span>Not affiliated with Real.</span>
      {children}
    </footer>
  );
}

function Legal({ className }: { className: string }) {
  const { snap } = useApp();
  return (
    <LegalLine className={className} demo={snap.rules.demo === true}>
      <HowLink className="howlink" />
      <EarnLink className="howlink" />
      <PrivacyLink className="howlink" />
      <SettingsLink className="howlink" />
      <SupportLink className="howlink" />
      <MemberLine />
    </LegalLine>
  );
}

/** On every tab while the server runs on the bundled sample: these deals are not the market. */
function DemoBanner() {
  const { snap } = useApp();
  if (snap.rules.demo !== true) return null;
  return (
    <section className="demo-banner" aria-label="Sample data">
      <Icon name="info" />
      <p>
        <b>Sample data</b>, not the live market
      </p>
    </section>
  );
}

/**
 * A phone's Level and Max-price row. The pages that lead with a long list or a plan keep it behind one "Filters"
 * button (Passes), or leave it out (Your plan, which reads the account, not these), so the page starts higher.
 */
function PhoneFilters({ tab }: { tab: TabKey }) {
  const [open, setOpen] = useState(false);
  const locked = useLocked();
  if (tab === "plan" || locked) return null; // the free site has no filters: they come with Discord
  const collapsible = tab === "passes";
  const body = (
    <section className="filters" id="phone-filters" aria-label="Level and budget">
      <div className="ctrl">
        <LevelControl variant="phone" />
        {tab === "passes" ? <PassBudgetChip /> : <BudgetChip />}
      </div>
      <LevelMeaning />
    </section>
  );
  if (!collapsible) return body;
  return (
    <>
      <div className="ctrl filters-toggle">
        <button
          type="button"
          className="lnk box"
          aria-expanded={open}
          aria-controls="phone-filters"
          onClick={() => setOpen((v) => !v)}
        >
          Filters
          <Icon name="chev" />
        </button>
      </div>
      {open && body}
    </>
  );
}

/**
 * The frame around every tab. Desktop: a left sidebar (menu, level, budget, community, footer) and a top bar
 * (search, live line). Phone: a top bar (brand, live, search), one row of controls (level, budget), the page,
 * and a bottom tab bar.
 */
export function Shell({ tab, children }: { tab: TabKey; children: ReactNode }) {
  const { layout, openCount, follows, status, refresh, notice, notify } = useApp();
  const dropNotice = useCallback(() => notify(null), [notify]);
  const { saved } = useLocal();
  const locked = useLocked(); // the free site: no level, budget, follows or alerts here (they come with Discord)
  const access = useAccess();
  const discord = access.state === "anon" || access.state === "out"; // the top bar carries the Discord button
  const { current, onNav } = useNav(tab);
  useProgress(useReconnecting(status)); // the network came back: the bar until the market reads live again
  // The first-visit line is about the deals: it shows where they are, not on Prices or Passes.
  const welcome = (tab === "today" || tab === "deals") && <WelcomeStrip />;

  if (layout.phone) {
    return (
      <div className="app phone">
        {/* Paused, the pill needs the room its words take: the brand keeps its mark and gives up its name. */}
        <header className={cls("top", status === "stale" && "paused", discord && "with-discord")}>
          <Brand />
          <LivePill compact />
          <AlertsButton variant="phone" />
          <AccountButton variant="phone" />
          <SearchButton />
          <DiscordButton variant="phone" />
        </header>
        <DemoBanner />
        {welcome}
        <PhoneFilters tab={tab} />
        <main id="main" className="main" tabIndex={-1}>
          {children}
          {!locked && follows.size === 0 && (tab === "today" || tab === "deals") && (
            <p className="nextstep">
              <Icon name="star" />
              Star a player to pin their deals at the top.
            </p>
          )}
          {/* On Today the invite sits after the top deals; the member's switch stays here. */}
          <CommunityCta show={tab === "today" ? "member" : undefined} />
          <Legal className="legal" />
        </main>
        {/* The lists that change by the minute refresh with a pull from the top. */}
        {(tab === "today" || tab === "deals") && <PullToRefresh onRefresh={refresh} />}
        <UndoBar offer={notice} onGone={dropNotice} />
        <nav className="tabbar" aria-label="Sections">
          {NAV.map((item) => (
            <a
              key={item.tab}
              href={tabPath(item.tab)}
              aria-current={current === item.tab ? "page" : undefined}
              onClick={onNav(item.tab)}
            >
              <span>
                <Icon name={item.icon} />
              </span>
              {item.label}
            </a>
          ))}
        </nav>
      </div>
    );
  }

  return (
    <div className="app desk">
      <aside className="side" aria-label="Menu and filters">
        <Brand />
        <nav aria-label="Sections">
          {NAV.map((item) => (
            <a
              key={item.tab}
              href={tabPath(item.tab)}
              aria-current={current === item.tab ? "page" : undefined}
              onClick={onNav(item.tab)}
            >
              <Icon name={item.icon} />
              {item.label}
              {item.tab === "deals" && <span className="n">{formatRax(openCount)}</span>}
            </a>
          ))}
        </nav>
        {!locked && (
          <>
            <div className="sec">Filters</div>
            <LevelControl variant="side" />
            {tab === "passes" || tab === "plan" ? <PassBudgetChips /> : <BudgetChips />}
          </>
        )}
        {/* On Passes the pass total sits here, unless the saved total has something to say: one figure, not two. */}
        {tab === "passes" && saved <= 0 ? (
          <PassTotal className="saved ptotal" />
        ) : (
          <div className="slot" data-slot="saved">
            <SavedSlot />
          </div>
        )}
        <div className="side-end">
          <AlertsButton variant="side" />
          {/* Today's right column carries the community link itself. */}
          {tab !== "today" && <CommunityCta />}
          <Legal className="foot" />
        </div>
      </aside>
      <main id="main" className="main" tabIndex={-1}>
        <DemoBanner />
        <header className="bar">
          <SearchBox />
          <AccountButton variant="bar" />
          {!locked && <BudgetButton />}
          <LivePill />
          <DiscordButton variant="bar" />
        </header>
        {welcome}
        {children}
      </main>
      <UndoBar offer={notice} onGone={dropNotice} />
    </div>
  );
}

/** In a tab's place while its code is still on the way: grey blocks, nothing that spins, and the top bar. A short page (Your plan) has a
 * short placeholder, so what sits under it does not jump when the page arrives. */
export function ViewLoading({ tab }: { tab?: TabKey }) {
  useProgress(true);
  return (
    <div className="skeleton" data-view={tab} aria-busy="true" aria-label="Loading">
      <div className="sk sk-hero" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="sk sk-row" />
      ))}
    </div>
  );
}

/**
 * While there is no data yet: the frame and grey blocks where the deals will be, nothing that spins. Once the first
 * polls have failed (`failed`), it says so, offers Retry (the polls keep going on their own) and shows the footer.
 */
export function LoadingShell({ failed = false, onRetry }: { failed?: boolean; onRetry?: () => void }) {
  useProgress(!failed); // a failed load says so in words, with Retry: the bar stops rather than run on
  return (
    <div className={cls("app", "loading", failed && "failed")}>
      <header className="top">
        <Brand />
      </header>
      <main id="main" className="main" tabIndex={-1}>
        {failed && (
          <div className="loadfail">
            <p role="alert">
              <b>Can't load the market right now.</b> Retrying every few seconds.
            </p>
            <button type="button" className="btn ghost" onClick={onRetry}>
              Retry
            </button>
          </div>
        )}
        <div className="skeleton" data-testid="skeleton" aria-busy="true" aria-label="Loading deals">
          <div className="sk sk-hero" />
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="sk sk-row" />
          ))}
        </div>
        {failed && <LegalLine className="legal" demo={false} />}
      </main>
    </div>
  );
}
