// "Discord perks": what linking unlocks for a member signed in through our Discord, with the state of each. Synced
// passes on every device, roles in the server, #linked-lounge (and #big-accounts from 500,000 Rax a year), and personal deal
// pings by DM, which the member turns off here. Nothing for anyone else (the gate off, or not a member).
import { useContext, useEffect, useState } from "react";
import { ACCOUNT_TYPES } from "../content/accountTypes";
import { useLocal } from "../data/local";
import { formatRax } from "../lib/format";
import { fetchMemberLink, saveLinkSettings, useMemberLink } from "../lib/link";
import { Icon } from "./Icon";
import { MemberContext } from "./MemberLine";

function Perk({ on, title, children }: { on: boolean; title: string; children: string }) {
  return (
    <li className={on ? "perk on" : "perk"}>
      <Icon name={on ? "check" : "plus"} />
      <span>
        <b>{title}</b> <span className="perk-s">{children}</span>
      </span>
    </li>
  );
}

/** Where #big-accounts opens: the Big type's edge, rax a year (the table in content/accountTypes). */
const BIG_FROM = ACCOUNT_TYPES.find((t) => t.key === "big")!.from;

export function DiscordPerks() {
  const member = useContext(MemberContext);
  const state = useMemberLink();
  const { link: device, follows } = useLocal();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (member && state === null) void fetchMemberLink(member.fetchImpl);
  }, [member, state]);
  if (!member) return null;
  const perks = state?.perks;
  const linked = Boolean(state?.link) || Boolean(device);
  const roles = perks?.roles ?? [];
  const toggle = async (on: boolean) => {
    setSaving(true);
    setFailed(false);
    const done = await saveLinkSettings(member, { pings: on, follows });
    setSaving(false);
    if (!done) setFailed(true);
  };
  // Everything that can be on is on: one line, the details a tap away (the rail stays short).
  const done = Boolean(state?.link) && roles.length > 0 && Boolean(perks?.lounge) && Boolean(perks?.pings) && !perks?.dm_closed;
  const content = (
    <>
      <ul>
        <Perk on={Boolean(state?.link)} title="Synced on every device.">
          {state?.link ? "Sign in anywhere and your passes are here." : "Link your account to keep it everywhere."}
        </Perk>
        <Perk on={roles.length > 0} title="Your roles.">
          {roles.length ? roles.join(", ") : "Linked, your sports and your account type, shown in the server."}
        </Perk>
        <Perk on={Boolean(perks?.lounge)} title="#linked-lounge.">
          {perks?.lounge ? "Open to you in the server." : "Opens once you link."}
        </Perk>
        <Perk on={Boolean(perks?.big_accounts)} title="#big-accounts.">
          {perks?.big_accounts ? `Open to you: ${formatRax(BIG_FROM)} Rax a year or more.` : `Opens at ${formatRax(BIG_FROM)} Rax a year.`}
        </Perk>
      </ul>
      <label className="perk-ping">
        <input
          type="checkbox"
          name="discord-pings"
          checked={Boolean(perks?.pings) && !perks?.dm_closed}
          disabled={!state?.link || saving}
          aria-busy={saving || undefined}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span>Ping me on Discord for deals on my players</span>
      </label>
      {perks?.dm_closed && (
        <p className="impn" role="status">
          Your Discord DMs are closed to our bot, so pings stopped. Open them, then turn this on again.
        </p>
      )}
      {!linked && <p className="impn">Up to 3 a day, only for players you hold or follow.</p>}
      {failed && (
        <p className="impn" role="status">
          That did not save. Try again in a moment.
        </p>
      )}
    </>
  );
  const shown = open || !done;
  return (
    <details className={done ? "perks adv" : "perks adv fixed"} open={shown}>
      <summary
        onClick={(e) => {
          e.preventDefault(); // we own `open`: a toggle inside never folds it away under the member's hands
          if (done) setOpen(!shown);
        }}
      >
        <span>Discord perks</span>
        {done && (
          <span className="perk-all">
            <Icon name="check" /> All on
          </span>
        )}
      </summary>
      {content}
    </details>
  );
}
