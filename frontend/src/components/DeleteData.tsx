// "Delete my data", in a signed-in member's account panel (and on the join page for someone signed in who is not in the
// server, or no longer: what we hold about them is theirs to erase too): one button, then a plain confirmation (what goes, what stays)
// with Delete and Cancel. The server forgets everything it holds under their Discord id and signs them out; this page
// then clears the link on the device too (or the next sign-in would send it back) and starts over at the front door.
import { type KeyboardEvent, useContext, useEffect, useId, useRef, useState } from "react";
import { local } from "../data/local";
import { PRIVACY_HREF, deleteMyData } from "../lib/privacy";
import { MemberContext } from "./MemberLine";
import { useAccess } from "./Access";
import { BusyButton } from "./BusyButton";
import { startNavigation } from "./TopProgress";

type Step = "idle" | "confirm" | "busy" | "failed";

/** `level`: the heading's level where it is drawn (3 in the account panel, under its title; 2 on the join page, under
 * its h1). */
export function DeleteData({ level = 3 }: { level?: 2 | 3 } = {}) {
  const access = useAccess();
  const member = useContext(MemberContext) ?? (access.name ? { name: access.name, fetchImpl: access.fetchImpl } : null);
  const id = useId();
  const [step, setStep] = useState<Step>("idle");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);
  const asking = step === "confirm" || step === "busy" || step === "failed";
  useEffect(() => {
    // Focus follows the step: into the question (on the safe answer), and back to its button when it is dismissed.
    if (asking && !wasAsking.current) cancelRef.current?.focus();
    if (!asking && wasAsking.current) openRef.current?.focus();
    wasAsking.current = asking;
  }, [asking]);
  useEffect(() => {
    if (step === "failed") cancelRef.current?.focus(); // after a failure, the focus waits on the safe answer
  }, [step]);
  if (!member) return null;
  const erase = async () => {
    setStep("busy");
    if (await deleteMyData(member.fetchImpl)) {
      local.unlink();
      startNavigation(); // Delete stays busy and the top bar runs until the front door is drawn
      window.location.assign("/");
      return;
    }
    setStep("failed");
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && step !== "busy") setStep("idle");
  };
  return (
    <section className="delete-data" aria-labelledby={`${id}h`}>
      {level === 2 ? <h2 id={`${id}h`}>Your data</h2> : <h3 id={`${id}h`}>Your data</h3>}
      {!asking ? (
        <>
          <p className="impn">
            What we keep, and for how long, is in our <a href={PRIVACY_HREF}>privacy notice</a>.
          </p>
          <button ref={openRef} type="button" className="lnk box del-open" onClick={() => setStep("confirm")}>
            Delete my data
          </button>
        </>
      ) : (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape closes the question
        <div role="group" className="del-ask" aria-labelledby={`${id}q`} onKeyDown={onKeyDown}>
          <p id={`${id}q`} className="del-q">
            This removes your link, followed players and settings, and the activity we recorded with your Discord account on the site and in our Discord, from our server. You stay in the Discord server.
          </p>
          <p className="impn">It also unlinks your Real account on this device.</p>
          <div className="del-b">
            <BusyButton type="button" className="lnk box del-go" busy={step === "busy"} busyLabel="Deleting…" slowLabel="Still deleting…" onClick={() => void erase()}>
              Delete
            </BusyButton>
            <button ref={cancelRef} type="button" className="lnk box" disabled={step === "busy"} onClick={() => setStep("idle")}>
              Cancel
            </button>
          </div>
          {step === "failed" && (
            <p className="impn" role="status">
              Couldn't delete. Nothing was changed. Try again in a moment.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
