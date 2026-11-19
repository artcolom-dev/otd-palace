import { Said } from "./Said";
import { useContext, useId, useState } from "react";
import { DEVICE_PASSES, local } from "../data/local";
import { type ApplyResult, applyProfile, encodeProfile, isEmptyProfile } from "../data/profileCode";
import { track } from "../lib/activity";
import { formatRax } from "../lib/format";
import { Icon } from "./Icon";
import { MemberContext } from "./MemberLine";
import { useOverlay } from "./Overlay";
import { BusyButton } from "./BusyButton";

const TITLE = "Use it on another device";

/** "1 pass", "2,149 passes", "no pass". */
const count = (n: number, one: string, many: string) => (n === 0 ? `no ${one}` : `${formatRax(n)} ${n === 1 ? one : many}`);

/** What a restore says: what came in, and, honestly, the passes of this device that made room. */
export function restoredText(r: ApplyResult): string {
  if (!r.ok && r.reason === "unsupported")
    return "This browser is too old to read this code. Update it, or open this page in another browser.";
  if (!r.ok) return "That is not a code from this site.";
  const came = `Restored: ${count(r.follows, "followed player", "followed players")}, ${count(r.passes, "pass", "passes")}.`;
  if (r.dropped === 0) return came;
  const went = r.dropped === 1 ? "1 older pass of this device was" : `${formatRax(r.dropped)} older passes of this device were`;
  return `${came} A device keeps ${formatRax(DEVICE_PASSES)} passes: ${went} removed to make room.`;
}

/** The code and the restore, without a frame: in the panel, or in the sheet the link opens. */
function ProfileBody() {
  const id = useId();
  const [code, setCode] = useState("");
  const [said, setSaid] = useState("");
  const [busy, setBusy] = useState(false);
  const copy = async () => {
    track("share", "profile-code");
    const state = local.get();
    if (isEmptyProfile(state)) {
      setSaid("Nothing to carry yet: follow a player or add a pass first.");
      return;
    }
    const mine = await encodeProfile(state);
    try {
      await navigator.clipboard.writeText(mine);
      setSaid("Copied. Paste it on your other device.");
    } catch {
      setCode(mine);
      setSaid("Select the code below and copy it.");
    }
  };
  const restore = async () => {
    setBusy(true);
    const r = await applyProfile(code).finally(() => setBusy(false));
    setSaid(restoredText(r));
    if (r.ok) setCode("");
  };
  return (
    <>
      <p className="pnote">
        Your passes and followed players live on this device. Copy a code here, paste it there: no account, no name.
      </p>
      <div className="impr">
        <button type="button" className="btn" onClick={copy}>
          Copy my code
        </button>
      </div>
      <label className="impl" htmlFor={id}>
        Restore from a code
      </label>
      <div className="impr">
        <input
          id={id}
          value={code}
          placeholder="MP2.…"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setCode(e.target.value)}
        />
        <BusyButton type="button" className="btn" busy={busy} busyLabel="Restoring…" disabled={!code.trim()} onClick={() => void restore()}>
          Restore
        </BusyButton>
      </div>
      <Said text={said} />
    </>
  );
}

/**
 * "Use it on another device": a code to carry what this device keeps to another one, and to restore it. No account,
 * nothing stored on a server, no name in it. A Discord member does not need it (their link follows them to every
 * device), so they never see it; anyone else finds it folded away, as an advanced way to move between devices.
 */
export function ProfileCard() {
  const member = useContext(MemberContext);
  if (member) return null;
  return (
    <details className="panel profile adv">
      <summary>{TITLE}</summary>
      <ProfileBody />
    </details>
  );
}

/** A link next to "On this device only" that opens the same code and restore in a sheet (phone) or popover (desktop). */
export function ProfileLink({ className }: { className?: string }) {
  const overlay = useOverlay();
  const member = useContext(MemberContext);
  if (member) return null;
  return (
    <button
      type="button"
      className={className ?? "lnk"}
      onClick={(e) =>
        overlay.open({
          title: TITLE,
          anchor: e.currentTarget,
          size: "narrow",
          body: () => (
            <div className="profile">
              <ProfileBody />
            </div>
          ),
        })
      }
    >
      <Icon name="phone" />
      {TITLE}
    </button>
  );
}
