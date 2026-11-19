// "Add OTD Palace to your home screen", on a phone from the second visit.
import { useId, useState } from "react";
import { useApp } from "../AppContext";
import { local, useLocal } from "../data/local";
import { track } from "../lib/activity";
import { isIos, isIosInApp, isStandalone, promptInstall, useInstallOffer } from "../lib/install";
import { Icon } from "./Icon";

/**
 * On a phone, from the second visit, when the site is not already on the home screen: Chromium's own install
 * dialog behind "Add", or on iOS the two taps it takes. Put away once, it stays away. `inline` is the same card
 * inside the alerts sheet, where a browser without push points to it: there it shows whenever the site is not on the
 * home screen yet, and cannot be put away.
 */
export function InstallPrompt({ inline = false }: { inline?: boolean }) {
  const { layout } = useApp();
  const { visits, installDismissed } = useLocal();
  const offered = useInstallOffer();
  const [standalone] = useState(isStandalone);
  const [ios] = useState(() => isIos());
  const [inApp] = useState(() => isIosInApp());
  const id = useId();
  if (standalone) return null;
  // An app's own browser cannot add to the home screen: the card would ask for what cannot be done (the alerts sheet
  // still says how, from Safari).
  if (!inline && (!layout.phone || visits < 2 || installDismissed || inApp || (!offered && !ios))) return null;
  return (
    <section className={inline ? "inst inline" : "inst"} aria-labelledby={`${id}h`}>
      <span className="mark" aria-hidden="true">
        <Icon name="palace" />
      </span>
      <div>
        <h2 id={`${id}h`}>Add OTD Palace to your home screen</h2>
        {offered ? (
          <p>Today's best deal, one tap away.</p>
        ) : inApp ? (
          <p>Open this page in Safari, then tap Share, then Add to Home Screen.</p>
        ) : ios ? (
          <p>
            Tap <Icon name="share" />
            Share, then Add to Home Screen.
          </p>
        ) : (
          <p>Open your browser's menu, then Install or Add to Home Screen.</p>
        )}
      </div>
      {offered && (
        <button
          type="button"
          className="btn fill"
          onClick={async () => {
            const accepted = await promptInstall();
            track("install", accepted ? "accepted" : "dismissed");
            if (!accepted) local.dismissInstall();
          }}
        >
          Add
        </button>
      )}
      {!inline && (
        <button type="button" className="icb x" aria-label="Not now" onClick={() => {
          track("install", "not-now");
          local.dismissInstall();
        }}>
          <Icon name="x" />
        </button>
      )}
    </section>
  );
}
