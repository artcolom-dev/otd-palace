import { useContext, useEffect, useState } from "react";
import { useApp } from "../AppContext";
import { useLocal } from "../data/local";
import { fetchMemberLink, saveLinkSettings, useMemberLink } from "../lib/link";
import { trackOut } from "../lib/track";
import { Icon } from "./Icon";
import { MemberContext } from "./MemberLine";
import { useAccess, useLocked } from "./Access";
import { loginHref } from "../lib/gate";
import { SignInLink } from "./SignInLink";

/**
 * Our community, only once there is one: the link is counted like any other that leaves the site. A member is already
 * in the server, so they are not asked to join: one switch says whether their deal pings are on and turns them on or
 * off right there (a member who has not linked yet is sent to the Passes page to link first).
 */
export function CommunityCta({ show }: { show?: "invite" | "member" } = {}) {
  const { snap, prefs } = useApp();
  const member = useContext(MemberContext);
  const access = useAccess();
  const locked = useLocked();
  const state = useMemberLink();
  const { follows } = useLocal();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (member && state === null) void fetchMemberLink(member.fetchImpl);
  }, [member, state]);
  const url = snap.links.community;
  // One place asks a visitor to join (after the top deals on a phone), another keeps the member's switch (the foot).
  if (show === "invite" && member) return null;
  if (show === "member" && !member) return null;
  // The free site: the alerts' place is the way in with Discord (the login also joins the server), never a loop for
  // an account the server refused.
  if (locked && !member) {
    if (access.state !== "anon" && access.state !== "out") return null;
    return (
      <SignInLink className="community unlock-cta" href={loginHref()}>
        <Icon name="bell" />
        <span className="cm-text">
          Get deals pinged
          <small>
            {access.state === "out"
              ? "Join the OTD Palace server to turn on DM pings and alerts"
              : "Free with Discord: by DM and as alerts here"}
          </small>
        </span>
        <Icon name="lock" className="end" />
      </SignInLink>
    );
  }
  if (member) {
    if (state === null) return null;
    const on = state.perks.pings && !state.perks.dm_closed;
    if (!state.link) {
      return (
        <a className="community member" href="#passes">
          <Icon name="chat" />
          <span className="cm-text">
            Deal pings: off
            <small>Link your account to turn them on</small>
          </span>
          <Icon name="arrow" className="end" />
        </a>
      );
    }
    const flip = async () => {
      setSaving(true);
      setFailed(false);
      const done = await saveLinkSettings(member, { pings: !on, follows });
      setSaving(false);
      if (!done) setFailed(true);
    };
    const note = failed
      ? "That did not save. Try again."
      : state.perks.dm_closed
        ? "Your DMs are closed to the bot"
        : on
          ? "By DM, up to 3 a day"
          : "Tap to turn them on";
    return (
      <div className={on ? "community member on" : "community member"}>
        <Icon name="chat" />
        <span className="cm-text">
          Deal pings: {on ? "on" : "off"}
          <small role={failed ? "status" : undefined}>{note}</small>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Deal pings"
          className="switch"
          disabled={saving}
          aria-busy={saving || undefined}
          onClick={() => void flip()}
        >
          <span className="knob" aria-hidden="true" />
        </button>
      </div>
    );
  }
  if (!url) return null;
  return (
    <a
      className="community"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => trackOut({ panel: "community", target: "community", level: prefs.level, sport: prefs.sport, pos: 0 })}
    >
      <Icon name="chat" />
      <span className="cm-text">
        Join the Discord: it's a cheat code
        <small>Every deal, your own plan, deals pinged. Free.</small>
      </span>
      <Icon name="ext" className="end" />
    </a>
  );
}
