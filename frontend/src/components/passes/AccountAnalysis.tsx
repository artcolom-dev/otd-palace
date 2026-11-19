// A Real account's passes, read through the site's server and laid out like the visitor's own: what they pay a year,
// how full each sport is, the passes that pay most, what to add next. Two ways in: "Link your Real account" (`link`),
// where every answer read becomes this device's passes at once (and, for a member of our Discord, the server's link),
// and "Look up someone else", read only (a friend's, a rival's): nothing here touches this device's passes then.
// Every pass counts, a big account's included: the server values the passes this site does not list from their season's
// earnings ranking (`answer.markets`). While some seasons are still being read the panel says so and asks again every
// ASK_AGAIN_MS, for up to ASK_FOR_MS, and the figures fill in as they come.
import { Said } from "../Said";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../AppContext";
import { IDLE_TITLE, about, idleLine, tierName, titleText } from "../../content/passWords";
import { DEVICE_PASSES, local } from "../../data/local";
import { haptic } from "../../lib/haptics";
import { fetchPasses, importWords, withAccountMarkets } from "../../lib/accountPasses";
import { type LinkAnswer, fetchForLink, saveLinkSettings, unlinkCount } from "../../lib/link";
import { MemberContext } from "../MemberLine";
import { formatRax } from "../../lib/format";
import { type CardShareResult, bestPlayersToFollow, profileCardModel, renderProfileCard, shareProfileCard } from "../../lib/profileCard";
import { nextRax } from "../../lib/nextRax";
import { idlePasses, planHoldings } from "../../lib/passes";
import { Row as NextMoveRow } from "../NextRax";
import { type OverlayContentProps, useOverlay } from "../Overlay";
import { Icon } from "../Icon";
import { SportBlock } from "./MyPasses";
import { BusyButton, useLongWait } from "../BusyButton";
import { WaitBar } from "../WaitBar";
import { useAccess } from "../Access";
import { SignInLink } from "../SignInLink";
import { loginHref } from "../../lib/gate";
import { PassFace } from "./bits";

type Answer = LinkAnswer;

export const ASK_AGAIN_MS = 15_000;
/** The passes that hardly ever get a claim shown here: the most unused first, the rest as a count. */
export const IDLE_SHOWN = 8;
const ASK_FOR_MS = 55 * 60_000;

export { withAccountMarkets } from "../../lib/accountPasses";

const SHARED: Record<CardShareResult, string> = {
  shared: "Shared.",
  cancelled: "",
  downloaded: "Saved as a picture.",
  failed: "Could not make the picture here.",
};

export function AccountAnalysis({ username, ctx, link = false }: { username: string; ctx: OverlayContentProps; link?: boolean }) {
  const { snap, prefs, now } = useApp();
  const member = useContext(MemberContext);
  const { state } = useAccess();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [said, setSaid] = useState("");
  const [drawing, setDrawing] = useState(false);
  const firstWaitLong = useLongWait(answer === null);
  const followBest = useRef(false); // a first link: follow the account's best players once its plan is known
  const sentFor = useRef<Answer | null>(null);
  const siteMarkets = useRef(snap.otd.markets);
  siteMarkets.current = snap.otd.markets;
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    let reading = false; // an answer said some seasons were still being read
    const opened = unlinkCount();
    let linkedHere = false; // this sheet linked the device: the device losing its link later is an unlink
    const unlinked = () => unlinkCount() !== opened || (linkedHere && local.get().link === null);
    const ask = () => {
      if (link && unlinked()) return; // unlinked since this sheet opened (here, in another tab, from Discord): stop
      const began = unlinkCount();
      void (link ? fetchForLink(username, member) : (fetchPasses(username) as Promise<LinkAnswer>)).then((a) => {
        if (!live) return;
        if (link && (unlinkCount() !== began || unlinked())) return; // unlinked while this was read: no link, no further asking
        // A busy answer while seasons are being read keeps what was valued so far, and the page asks again; a busy
        // first answer is the answer.
        if (a.status === "ok") reading = a.waiting > 0;
        if (link && a.status === "ok") {
          // Linking: the account's passes are this device's from the first answer on (each later one refines them).
          const first = local.get().link?.username.toLowerCase() !== (a.username ?? username).toLowerCase();
          local.link(a.username ?? username, a.passes, a.markets, new Set(siteMarkets.current.map((m) => m.key)));
          linkedHere = true;
          if (first) {
            followBest.current = true;
            haptic("success");
          }
        } else if (link && !linkedHere && a.status !== "ok") {
          haptic("warning"); // not found, private, or Real not answering: the link did not happen
        }
        setAnswer((was) => (a.status === "busy" && was?.status === "ok" ? was : a));
        if (reading && Date.now() - started < ASK_FOR_MS) timer = setTimeout(ask, ASK_AGAIN_MS);
      });
    };
    ask();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one reading per name and way in
  }, [username, link]);

  const markets = useMemo(
    () => (answer?.status === "ok" ? withAccountMarkets(snap.otd.markets, answer.markets) : snap.otd.markets),
    [answer, snap.otd.markets],
  );
  const plan = useMemo(
    () => (answer?.status === "ok" ? planHoldings(answer.passes, markets, snap.rules.otd, snap.otd.sports) : null),
    [answer, markets, snap.rules.otd, snap.otd.sports],
  );
  // A first link follows the players behind the passes that pay most (their deals come first), and a member's yearly
  // estimate goes to the server with the players followed (their personal deal pings).
  useEffect(() => {
    if (!link || !plan || answer?.status !== "ok") return;
    if (followBest.current) {
      followBest.current = false;
      for (const k of bestPlayersToFollow(plan, 20)) if (!local.get().follows.includes(k)) local.toggleFollow(k);
    }
    if (member && answer.waiting === 0 && sentFor.current !== answer) {
      sentFor.current = answer; // once per answer, not at every refresh of the market
      void saveLinkSettings(member, { year: Math.round(plan.total), follows: local.get().follows });
    }
  }, [link, plan, answer, member]);

  // What this account should add next: the same advice as "Your next Rax", on its passes; passes only (the deals of
  // the moment are the visitor's, not the account's).
  const next = useMemo(
    () =>
      answer?.status === "ok"
        ? nextRax({ ...snap, otd: { ...snap.otd, markets } }, {
            holdings: answer.passes,
            level: prefs.level,
            budget: prefs.budget,
            passBudget: prefs.passBudget,
            balance: null,
            now: Math.floor(now / 60_000) * 60_000,
            paused: true,
            n: 8,
          }).moves.filter((m) => m.kind !== "deal").slice(0, 4)
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once a minute is plenty for pass advice
    [answer, markets, snap.otd, snap.rules.otd, prefs.level, prefs.passBudget, Math.floor(now / 60_000)],
  );
  const name = answer?.username ?? username;
  const header = (
    <div className="dwhd">
      <div className="dwtitle">
        <span id={ctx.titleId} className="sr">
          Analysis of {name}
        </span>
        <h2>{name}</h2>
        <p className="meta">
          {link && answer?.status === "ok" ? "Your Real account, linked: these passes are now yours for all advice here." : "A Real account, read from what Real shows on its profile."}
        </p>
      </div>
    </div>
  );
  if (!answer) {
    return (
      <>
        {header}
        <div className="dwbody">
          <div className="dsec">
            <p role="status">
              {link ? "Linking" : "Reading"} {username}'s passes… this can take up to half a minute.
              {firstWaitLong && " Still reading: a big account takes longer. You can leave this open."}
            </p>
            {/* Real answers in one go: nothing tells how far the first reading is, so the bar only moves. */}
            <WaitBar />
          </div>
        </div>
      </>
    );
  }
  if (answer.status !== "ok" || !plan) {
    return (
      <>
        {header}
        <div className="dwbody">
          <p className="dsec" role="status">
            {importWords(answer, username, 0)}
          </p>
          {answer.status === "signin" && state !== "banned" && (
            <SignInLink className="btn fill unlock-go" href={loginHref()}>
              <Icon name="chat" />
              {state === "out" ? "Join the server" : "Continue with Discord"}
            </SignInLink>
          )}
        </div>
      </>
    );
  }

  const known = plan.held.length;
  const total = Math.round(plan.total);
  const top = [...plan.held].filter((h) => !h.spent && h.year > 0).sort((a, b) => b.year - a.year).slice(0, 8);
  const sports = Object.values(plan.sports).sort((a, b) => b.total - a.total);
  const idle = idlePasses(plan);
  const rar = (kind: string, tier: string) => `rar-${Math.max(0, (snap.rules.otd.ladders[kind] ?? []).findIndex(([t]) => t === tier))}`;

  const share = async () => {
    setDrawing(true);
    try {
      const model = { ...profileCardModel(plan), who: name, url: `${location.origin}/a/${encodeURIComponent(name)}` };
      const png = await renderProfileCard(model);
      setSaid(png ? SHARED[await shareProfileCard(model, png)] : SHARED.failed);
    } finally {
      setDrawing(false);
    }
  };
  const copyLink = async () => {
    const url = `${location.origin}/a/${encodeURIComponent(name)}`; // its preview page, then the analysis
    try {
      await navigator.clipboard.writeText(url);
      setSaid("Link copied: it opens this analysis.");
    } catch {
      setSaid(url);
    }
  };
  return (
    <>
      {header}
      <div className="dwbody">
        {answer.waiting > 0 && (
          <p className="dsec acc-wait" role="status">
            {/* No count here: the bar under it says how far, in the server's own measure. This site's count of the
                passes it can value already (its markets included) would read "12 of 12" above "4 of 12 read". */}
            <b>
              Still reading {answer.seasons_waiting > 1 ? `${formatRax(answer.seasons_waiting)} seasons` : "a season"} of
              their passes.
            </b>{" "}
            The figures fill in on their own. A big account can take a while: leave this open, or come back to the link
            later.
          </p>
        )}
        {answer.waiting > 0 && (
          // How far is known here: the server says how many of the account's passes Real has not valued yet. That,
          // not this site's own count (which already knows the passes of the markets it lists), is the reading.
          <div className="acc-read">
            <WaitBar
              value={answer.passes.length - answer.waiting}
              max={answer.passes.length}
              label="Passes read from Real"
              valueText={`${formatRax(answer.passes.length - answer.waiting)} of ${formatRax(answer.passes.length)} passes read from Real`}
            />
            <small>
              {formatRax(answer.passes.length - answer.waiting)} of {formatRax(answer.passes.length)} passes read from Real so far
            </small>
          </div>
        )}
        <section className="dsec acc-total">
          <p>
            {answer.waiting > 0 ? "So far, " : ""}
            {link ? (answer.waiting > 0 ? "your" : "Your") : answer.waiting > 0 ? "their" : "Their"} passes pay about
          </p>
          <strong>{about(total)}</strong>
          <small>
            Rax a year · estimate ·{" "}
            {known === answer.passes.length
              ? `all ${formatRax(known)} passes counted`
              : `${formatRax(known)} of ${formatRax(answer.passes.length)} passes counted`}
            {answer.truncated ? ` (the first ${formatRax(answer.passes.length)})` : ""}
          </small>
        </section>
        <section className="dsec">
          <h3>
            <Icon name="layers" />
            How full each sport is
          </h3>
          {sports.map((x) => (
            <SportBlock key={x.sport} x={x} />
          ))}
        </section>
        <section className="dsec">
          <h3>
            <Icon name="cards" />
            The passes that pay most
          </h3>
          <ul className="mlist">
            {top.map((p) => (
              <li key={p.market.key} className="mp" data-key={p.market.key}>
                <PassFace market={p.market} rarity={rar(p.market.kind, p.tier)} size={28} />
                <div>
                  <b>{titleText(p.market)}</b>
                  <small>{p.tier.charAt(0).toUpperCase() + p.tier.slice(1)}</small>
                </div>
                <span className="yr">
                  <b>{about(p.year)}</b> a year
                </span>
              </li>
            ))}
          </ul>
        </section>
        {idle.length > 0 && (
          <section className="dsec acc-idle">
            <h3>
              <Icon name="pause" />
              {IDLE_TITLE}
            </h3>
            <p className="pnote">{idleLine(idle.length, snap.rules.otd.claims_per_sport_day)}</p>
            <ul className="mlist">
              {idle.slice(0, IDLE_SHOWN).map(({ pass: p, alone, gets }) => (
                <li key={p.market.key} className="mp" data-key={p.market.key}>
                  <PassFace market={p.market} rarity={rar(p.market.kind, p.tier)} size={28} />
                  <div>
                    <b>{titleText(p.market)}</b>
                    <small>{tierName(p.tier)}</small>
                  </div>
                  <span className="yr">
                    <b>{about(gets)}</b> of {about(alone)} a year
                  </span>
                </li>
              ))}
            </ul>
            {idle.length > IDLE_SHOWN && (
              <p className="pnote">
                And {formatRax(idle.length - IDLE_SHOWN)} more{link ? ". My passes marks each of them." : "."}
              </p>
            )}
          </section>
        )}
        <section className="dsec">
          <h3>
            <Icon name="bolt" />
            {link ? "What to add next" : "What this account should add next"}
          </h3>
          {next.length > 0 ? (
            <ol className="nrx-list" aria-label="Next moves for this account">
              {next.map((move, i) => (
                <li key={move.key}>
                  <NextMoveRow move={move} pos={i} />
                </li>
              ))}
            </ol>
          ) : (
            <p className="pnote">Nothing that pays back fits this budget right now. A bigger budget per pass shows more.</p>
          )}
        </section>
        {answer.passes.length > known && answer.waiting === 0 && (
          <p className="pnote">
            {formatRax(answer.passes.length - known)} of their passes could not be valued, so they are not counted in the
            total.
          </p>
        )}
      </div>
      <div className="dwft accft">
        {link && answer.note && (
          <p className="pnote" role="status">
            {answer.note}
          </p>
        )}
        {link && (
          <p className="pnote acc-linked">
            <Icon name="check" />
            {answer.passes.length > DEVICE_PASSES
              ? `Linked: their ${formatRax(DEVICE_PASSES)} best-rated passes of ${formatRax(answer.passes.length)} are yours on this device (a device keeps ${formatRax(DEVICE_PASSES)}).`
              : `Linked: ${formatRax(answer.passes.length)} pass${answer.passes.length === 1 ? " is" : "es are"} yours for all advice here.`}
          </p>
        )}
        <button type="button" className="btn ghost" onClick={copyLink}>
          <Icon name="ext" />
          Copy link
        </button>
        <BusyButton type="button" className="btn fill" busy={drawing} busyLabel={<><Icon name="share" />Drawing the picture…</>} onClick={() => void share()}>
          <Icon name="share" />
          Share this analysis
        </BusyButton>
        <Said text={said} />
      </div>
    </>
  );
}

/** Opens the analysis of a username as a panel (the drawer, or the sheet on a phone); `link` links it as the
 * visitor's own account. */
export function useOpenAccount() {
  const overlay = useOverlay();
  return (username: string, anchor: HTMLElement | null, { link = false }: { link?: boolean } = {}) =>
    overlay.open({
      title: link ? `Linking ${username}` : `${username}, a Real account`,
      anchor,
      layer: "panel",
      body: (ctx) => <AccountAnalysis key={`${link ? "link" : "look"}:${username}`} username={username} ctx={ctx} link={link} />,
    });
}
