// "Share": the deal's public page through the share sheet where the browser has one, else copied as a link. When the
// link cannot be copied either, it is shown to be copied by hand.
import { useEffect, useRef, useState } from "react";
import type { Deal } from "../data/types";
import { track } from "../lib/activity";
import { cls } from "../lib/cls";
import { shareDeal } from "../lib/share";
import { Icon } from "./Icon";

const COPIED_MS = 2500;

export function ShareButton({
  deal,
  className,
  label = "Share",
  iconOnly = false,
}: {
  deal: Pick<Deal, "listing_id" | "player_name" | "price" | "kind" | "discount">;
  className?: string;
  label?: string;
  /** The words stay for screen readers: a narrow tile has room for the icon only. */
  iconOnly?: boolean;
}) {
  const [state, setState] = useState<{ result: "copied" | "failed"; url: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onClick = async () => {
    track("share", "deal");
    const out = await shareDeal(deal);
    clearTimeout(timer.current);
    if (out.result === "copied" || out.result === "failed") {
      setState({ result: out.result, url: out.url });
      if (out.result === "copied") timer.current = setTimeout(() => setState(null), COPIED_MS);
    } else {
      setState(null);
    }
  };

  const copied = state?.result === "copied";
  return (
    <>
      <button type="button" className={cls("btn ghost share", iconOnly && "iconly", copied && "done", className)} title={iconOnly ? label : undefined} onClick={onClick}>
        <Icon name={copied ? "check" : "share"} />
        <span className={iconOnly ? "sr" : undefined}>{copied ? "Link copied" : label}</span>
      </button>
      <span className="sr" aria-live="polite">
        {copied ? "Link copied" : ""}
      </span>
      {state?.result === "failed" && (
        <label className="sharelink">
          <span>Copy this link</span>
          <input readOnly name="share-link" aria-label="Link to share" value={state.url} onFocus={(e) => e.currentTarget.select()} />
        </label>
      )}
    </>
  );
}
