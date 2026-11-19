// Open with perks: OTD Palace is free for everyone, and free members of our Discord server get the extras. This file
// holds who is asking (the access state) and the one prompt each locked area shows, worded for that state.
import { createContext, useContext, useId, useState } from "react";
import { useApp } from "../AppContext";
import type { Locked } from "../data/types";
import { type GateState, loginHref, recheck } from "../lib/gate";
import { formatRax } from "../lib/format";
import { BusyButton } from "./BusyButton";
import { Icon } from "./Icon";
import { SignInLink } from "./SignInLink";
import { startNavigation } from "./TopProgress";

/** "open": the gate is off (everything for everyone); else the server's state for this visitor (see lib/gate). */
export type AccessState = "open" | GateState;

export interface Access {
  state: AccessState;
  /** The Discord name, once signed in (in our server or not); null otherwise. */
  name: string | null;
  fetchImpl: typeof fetch;
  /** Asks the server again who this is (after "Check again", or a 401 from a member route). */
  refresh: () => void;
}

export const AccessContext = createContext<Access>({
  state: "open",
  name: null,
  fetchImpl: (input, init) => fetch(input, init),
  refresh: () => undefined,
});

export function useAccess(): Access {
  return useContext(AccessContext);
}

/** What the snapshot on screen leaves out (the free site's), or null when it is the whole one. */
export function useLocked(): Locked | null {
  return useApp().snap.locked ?? null;
}

/** The address of the page that explains what Discord unlocks. */
export const JOIN_HASH = "#join";

/** The Discord button of the top bar: "Continue with Discord" when not signed in, "Join the server" when signed in but
 * not in it. Nothing for a member, with the gate off, or for an account the server refused (no way round it). */
export function DiscordButton({ variant }: { variant: "bar" | "phone" }) {
  const { state } = useAccess();
  if (state !== "anon" && state !== "out") return null;
  const label = state === "anon" ? "Continue with Discord" : "Join the server";
  return (
    <SignInLink className={variant === "bar" ? "btn fill discord-go" : "btn fill discord-go discord-go-phone"} href={loginHref()}>
      <Icon name="chat" />
      <span>{variant === "phone" && state === "anon" ? "Continue" : label}</span>
      {variant === "phone" && state === "anon" && (
        <>
          {" "}
          <span className="sr">with Discord</span>
        </>
      )}
    </SignInLink>
  );
}

/** "Check again" for someone signed in but not in the server who joined by the invite: the server asks Discord now. */
export function CheckAgain() {
  const { fetchImpl, refresh } = useAccess();
  const [asking, setAsking] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const run = async () => {
    setAsking(true);
    setSaid(null);
    const state = await recheck(fetchImpl);
    if (state === "in") {
      startNavigation(); // the button stays busy and the top bar runs until the member's page comes
      window.location.reload(); // a member's page: the whole snapshot and the member's code paths, from the start
      return;
    }
    setAsking(false);
    setSaid(state === null ? "Couldn't check just now. Try again in a moment." : "Not in the server yet.");
    refresh();
  };
  return (
    <>
      <BusyButton type="button" className="lnk box unlock-again" busy={asking} busyLabel="Checking…" onClick={() => void run()}>
        I've joined: check again
      </BusyButton>
      {said && (
        <span className="unlock-said" role="status">
          {said}
        </span>
      )}
    </>
  );
}

/**
 * The one prompt of a locked area: what joining unlocks here, in a line, and the way in for this visitor. Not signed
 * in: "Unlock it all free" (one click: the login also joins the server). Signed in but not in the server: "Join
 * the server" (the login again, which joins) and "Check again" (after a join by the invite). Refused by the server:
 * a plain line, once (on the deals), and no button that would go round the same refusal.
 */
export function Unlock({ title, line, area, heading = "h2" }: {
  title: string;
  line: string;
  area: "deals" | "moves" | "plan" | "alerts" | "passdeals";
  heading?: "h2" | "h3";
}) {
  const { state } = useAccess();
  const id = useId();
  if (state === "open" || state === "in") return null;
  if (state === "banned" && area !== "deals") return null;
  const Heading = heading;
  return (
    <section className={`unlock unlock-${area}`} aria-labelledby={`${id}t`}>
      <span className="unlock-ic" aria-hidden="true">
        <Icon name="lock" />
      </span>
      <div className="unlock-body">
        <Heading id={`${id}t`} className="unlock-title">
          {title}
        </Heading>
        <p className="unlock-line">
          {state === "banned"
            ? "Discord won't let this account join the OTD Palace server, so this stays locked. The rest of the site stays free."
            : state === "out"
              ? `${line} You're signed in, but not in the OTD Palace server yet: join it to unlock this.`
              : line}
        </p>
        {state !== "banned" && (
          <div className="unlock-acts">
            <SignInLink className="btn fill unlock-go" href={loginHref()}>
              <Icon name="chat" />
              {state === "out" ? "Join the server" : "Unlock it all free"}
            </SignInLink>
            {state === "out" ? (
              <CheckAgain />
            ) : (
              <a className="lnk unlock-more" href={JOIN_HASH}>
                What you get
              </a>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** "See all 42 deals": the deals list's place for a visitor, with blank rows shaped like deals (no data in them). */
export function LockedDeals({ shown }: { shown: number }) {
  const locked = useLocked();
  if (!locked) return null;
  const more = locked.deals > shown;
  return (
    <div className="locked-deals">
      <div className="locked-rows" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="locked-row">
            <span className="lr-face" />
            <span className="lr-lines">
              <i />
              <i className="s" />
            </span>
            <span className="lr-num" />
          </div>
        ))}
      </div>
      <Unlock
        area="deals"
        title={more ? `${formatRax(locked.deals - shown)} more deals are hidden` : "See every deal as it comes"}
        line="Discord members see every live deal, with level, budget and sport filters and each deal's recent sales. One click, free: it's basically a cheat code."
      />
    </div>
  );
}

/** Under the free site's moves: the rest of today's risers and fallers. */
export function LockedMoves() {
  const locked = useLocked();
  if (!locked) return null;
  const all = locked.risers + locked.fallers;
  return (
    <Unlock
      area="moves"
      title={all > 0 ? `See all ${formatRax(all)} price moves` : "See every price move"}
      line="Every riser and faller today, in every sport, to the last sale. Members spot the jump before everyone else."
    />
  );
}

/** In the plan's places for a visitor: linking a Real account, and what it gives. */
export function LockedPlan({ heading }: { heading?: "h2" | "h3" }) {
  const locked = useLocked();
  if (!locked) return null;
  return (
    <Unlock
      area="plan"
      heading={heading}
      title="Link your Real account for your own plan"
      line="What your passes can pay a year, your next Rax and a 12-month plan, with tips that skip what you own. Like playing with the answers."
    />
  );
}

/** The alerts' place for a visitor: deal pings by Discord DM and on this device. */
export function LockedAlerts() {
  const locked = useLocked();
  if (!locked) return null;
  return (
    <Unlock
      area="alerts"
      title="Get deals pinged"
      line="The best new deals sent to you by Discord DM, for the players you follow. Be first on the cheap cards."
    />
  );
}
