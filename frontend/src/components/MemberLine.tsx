import { createContext, useState } from "react";
import { signOut } from "../lib/gate";
import { useAccess } from "./Access";
import { BusyButton } from "./BusyButton";
import { startNavigation } from "./TopProgress";

export interface Member {
  name: string;
  fetchImpl: typeof fetch;
}

/** The member the Discord gate let in, while it is on and their name is known; null otherwise (and with it off). */
export const MemberContext = createContext<Member | null>(null);

/**
 * In the footers while the Discord gate is on and the visitor is signed in with Discord (in our server or not): their
 * Discord name and Sign out. Signing out clears the session on the server, then the page starts over as the free site;
 * when the server did not answer, they stay signed in and are told so.
 */
export function MemberLine() {
  const { name, fetchImpl, state } = useAccess();
  const member = name ? { name, fetchImpl } : null;
  const [leaving, setLeaving] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!member) return null;
  const leave = async () => {
    setLeaving(true);
    setFailed(false);
    if (await signOut(member.fetchImpl)) {
      startNavigation(); // still "Signing out…", and the top bar, until the free site is drawn
      window.location.assign("/");
      return;
    }
    setLeaving(false); // still signed in: say so, and let them try again
    setFailed(true);
  };
  return (
    <span className="member-line">
      <span className="member-name" title={`Signed in with Discord as ${member.name}`}>
        <span className="sr">Signed in with Discord as </span>
        {member.name}
      </span>
      <BusyButton type="button" className="member-out" busy={leaving} busyLabel="Signing out…" onClick={() => void leave()}>
        Sign out
      </BusyButton>
      {/* Signed in but not in the server: no account panel here, so their data is reached from the join page. */}
      {(state === "out" || state === "banned") && (
        <a className="member-out" href="#join">
          Your data
        </a>
      )}
      {failed && (
        <span className="member-fail" role="status">
          Couldn't sign out. Try again.
        </span>
      )}
    </span>
  );
}
