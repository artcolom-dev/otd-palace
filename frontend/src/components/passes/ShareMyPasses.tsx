import { useState } from "react";
import { usePassPlan } from "../../views/passState";
import { type CardShareResult, profileCardModel, renderProfileCard, shareProfileCard } from "../../lib/profileCard";
import { BusyButton } from "../BusyButton";
import { Icon } from "../Icon";

const SAID: Record<CardShareResult, string> = {
  shared: "Shared.",
  cancelled: "",
  downloaded: "Saved as a picture.",
  failed: "Could not make the picture here.",
};

/** "Share my passes": a picture of what they pay, made on this device and shared (or saved). Nothing is uploaded. */
export function ShareMyPasses() {
  const { plan } = usePassPlan();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  if (plan.held.length === 0) return null;
  const run = async () => {
    setBusy(true);
    try {
      const model = profileCardModel(plan);
      const png = await renderProfileCard(model);
      setSaid(png ? SAID[await shareProfileCard(model, png)] : SAID.failed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="shm">
      <BusyButton type="button" className="lnk box" busy={busy} busyLabel={<><Icon name="share" />Drawing…</>} onClick={() => void run()}>
        <Icon name="share" />
        Share my passes
      </BusyButton>
      <p className="impn" role="status" aria-live="polite">
        {said || "A picture of the total and your best passes. No name on it."}
      </p>
    </div>
  );
}
