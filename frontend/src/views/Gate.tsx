import { useEffect, useState } from "react";
import { Icon, type IconName } from "../components/Icon";
import { WHAT_IS_REAL } from "../content/intro";
import { useLocal } from "../data/local";
import { rarityClass, rarityName } from "../content/real";
import { cls } from "../lib/cls";
import { type Teaser, fetchTeaser, loginHref, teaserAge, teaserLine } from "../lib/gate";
import { PrivacyLink } from "../components/PrivacyLink";
import { Brand } from "../components/Brand";
import { CheckAgain, useAccess } from "../components/Access";
import { DeleteData } from "../components/DeleteData";
import { SignInLink } from "../components/SignInLink";
import { maybeSafariView } from "../lib/inapp";
import { isStandalone } from "../lib/install";
import { passDealsSwitch } from "../lib/passDealsSwitch";

/** How often the live counts are asked again while the screen stays open (the server keeps them a minute). */
const TEASER_REFRESH_MS = 60_000;

/**
 * The live line's place before the counts come: the same box, holding blank marks shaped like the sentence so it wraps
 * to the same height. Without it the button and everything under it jumped down the moment the counts arrived.
 */
const blank = (words: string) => words.replace(/[^\s·%]/g, "e");
const WAIT_LINE = blank(teaserLine({ deals: 88, sports: 8, best_pct: 38, generated_at: null }) ?? "");
const WAIT_AGE = blank("Checked just now");

/** What anyone gets, with no login. */
const FREE: { icon: IconName; title: string; line: string }[] = [
  { icon: "today", title: "Today's best deals", line: "The top deals right now, priced from real sales." },
  { icon: "prices", title: "Prices moving", line: "The biggest risers and fallers of the day." },
  { icon: "passes", title: "The best passes", line: "Each sport's best On This Day passes, and the move for a small account." },
  { icon: "book", title: "How Real works", line: "The guides, the words, and a page for any deal you share." },
];

/** What a member of our Discord server gets on top, free too. */
const MORE: { icon: IconName; title: string; line: string }[] = [
  { icon: "deals", title: "Every live deal", line: "All of them, with your level, budget and sport filters, and each deal's recent sales." },
  { icon: "passes", title: "Pass deals", line: "The passes that cards on sale build for less than usual today." },
  { icon: "fall", title: "Every price move", line: "Every riser and faller today, in every sport." },
  { icon: "user", title: "Your own plan", line: "Link your Real account: what your passes can pay a year, your next Rax, a 12-month plan." },
  { icon: "bell", title: "Deals pinged to you", line: "By Discord DM and as alerts on this device, for the players you follow." },
  { icon: "chat", title: "The server", line: "The deal channels, the daily pass picks and roles for your sports." },
];

/** Our own drawn cards in Real's rarity colours: the look of the site, before the visitor is in (desktop only). */
function GateFan() {
  return (
    <div className="gate-fan" aria-hidden="true">
      {(
        [
          [1, "6.8"],
          [5, "9.4"],
          [4, "8.1"],
        ] as const
      ).map(([rarity, rating]) => (
        <div key={rarity} className={cls("gate-art", rarityClass(rarity))}>
          <span>{rarityName(rarity)}</span>
          <b>{rating}</b>
          <i />
          <i className="s" />
        </div>
      ))}
    </div>
  );
}

function List({ items, label }: { items: typeof FREE; label: string }) {
  return (
    <ul className="gate-list" aria-label={label}>
      {items.map((item) => (
        <li key={item.title} className="gate-item">
          <span className="gate-ic" aria-hidden="true">
            <Icon name={item.icon} />
          </span>
          <span>
            <b>{item.title}</b>
            <span className="gate-line">{item.line}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The way in, for this visitor's state: the login (which joins the server), or why there is none. */
function WayIn({ invite }: { invite: string | null }) {
  const { state } = useAccess();
  const home = loginHref({ pathname: "/", search: "", hash: "" });
  // Discord opens links on iOS in Safari's own in-app view, which cannot be told from Safari: a line of advice only.
  const [safariView] = useState(() => maybeSafariView(navigator.userAgent, { standalone: isStandalone() }));
  if (state === "in" || state === "open") {
    return (
      <p className="gate-sub gate-done">
        <Icon name="check" /> You're in: everything is unlocked.
      </p>
    );
  }
  if (state === "banned") {
    return (
      <p className="gate-sub gate-done" role="note">
        Discord won't let this account join the OTD Palace server, so the extras stay off. Everything free here stays free.
      </p>
    );
  }
  return (
    <>
      <SignInLink className="btn fill gate-go" href={home}>
        <Icon name="chat" />
        {state === "out" ? "Join the OTD Palace server" : "Continue with Discord"}
      </SignInLink>
      {safariView && (
        <p className="gate-sub gate-safari">
          Opened this from Discord? Open it in Safari first (Discord's ⋯ or Safari button): you stay signed in there.
        </p>
      )}
      {state === "out" && (
        <div className="gate-again">
          <p className="gate-sub">
            You're signed in, but not in the server{invite ? ". Join with the button, or with the invite and check again:" : "."}
          </p>
          <div className="unlock-acts">
            {invite && (
              <a className="lnk box" href={invite} target="_blank" rel="noopener noreferrer">
                Open the invite
                <Icon name="ext" />
              </a>
            )}
            <CheckAgain />
          </div>
        </div>
      )}
    </>
  );
}

/**
 * What Discord unlocks (`#join`): the site is free for everyone, and joining our Discord server, free too, unlocks the
 * rest. It says what is free and what Discord adds, live counts of the market (no deal, no name, no price), and the one
 * button that logs in with Discord and adds the visitor to the server. The button is a plain link: the login is a
 * top-level visit to Discord and back, never a form or a popup. "Keep browsing" goes back to the site.
 */
export function Join({ fetchImpl = fetch, invite = null }: { fetchImpl?: typeof fetch; invite?: string | null }) {
  const { welcomeDismissed } = useLocal(); // someone who put the welcome away knows what Real is
  const { state } = useAccess();
  const [teaser, setTeaser] = useState<Teaser | null>(null);
  const [asked, setAsked] = useState(false); // the first answer is in, counts or none
  const [at, setAt] = useState(() => Date.now());

  useEffect(() => {
    const was = document.title;
    document.title = "Free with Discord · OTD Palace";
    return () => {
      document.title = was;
    };
  }, []);

  useEffect(() => {
    let live = true;
    const load = () =>
      void fetchTeaser(fetchImpl).then((found) => {
        if (live) setAsked(true);
        if (!live || found === null) return;
        setTeaser(found);
        setAt(Date.now());
      });
    load();
    const timer = setInterval(load, TEASER_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [fetchImpl]);

  const line = teaser ? teaserLine(teaser) : null;
  const age = teaser ? teaserAge(teaser.generated_at, at) : null;

  return (
    <div className="gate-page">
      <header className="top gate-bar">
        <a className="gate-home" href="#today" aria-label="OTD Palace, back to the site">
          <Brand />
        </a>
        <a className="lnk box gate-back" href="#today">
          <Icon name="back" />
          Keep browsing
        </a>
      </header>
      <main id="main" className="gate-main" tabIndex={-1}>
        <section className="gate-card" aria-labelledby="gate-title">
          <h1 id="gate-title" className="gate-title">
            Free. <span className="gate-then">Join the Discord and it's basically a cheat code. Also free.</span>
          </h1>
          <p className="gate-sub">
            Use OTD Palace with no account. Continue with Discord and we add you to our server: that unlocks the rest.
          </p>
          {!welcomeDismissed && <p className="gate-sub gate-what">{WHAT_IS_REAL}</p>}
          {line ? (
            <p className="gate-live">
              <span className="gate-dot" aria-hidden="true" />
              <span className="gate-count">{line}</span>
              {age && <span className="gate-age">{age}</span>}
            </p>
          ) : (
            !asked && (
              <p className="gate-live wait" aria-hidden="true" data-testid="gate-live-wait">
                <span className="gate-dot" />
                <span className="gate-count">{WAIT_LINE}</span>
                <span className="gate-age">{WAIT_AGE}</span>
              </p>
            )
          )}
          <WayIn invite={invite} />
          <p className="gate-privacy">
            We keep your Discord id and name, plus what you choose to link. Never your email or messages, and we never
            post for you. <PrivacyLink className="gate-privacy-link">Read the privacy notice.</PrivacyLink>
          </p>
          {/* Someone signed in who is not in the server has no account panel: their data is erased from here. */}
          {(state === "out" || state === "banned") && <DeleteData level={2} />}
        </section>
        <section className="gate-inside" aria-labelledby="gate-inside-title">
          <GateFan />
          <h2 id="gate-inside-title" className="gate-h2">
            With Discord, free
          </h2>
          <List items={MORE.filter((item) => item.title !== "Pass deals" || passDealsSwitch.on)} label="With Discord" />
          <h2 className="gate-h2 gate-h2-free">Free for everyone, no login</h2>
          <List items={FREE} label="Free for everyone" />
        </section>
      </main>
      <footer className="gate-foot">
        Not affiliated with Real. <PrivacyLink className="gate-privacy-link" />
      </footer>
    </div>
  );
}
