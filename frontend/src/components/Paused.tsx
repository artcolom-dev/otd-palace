// The paused contract every best-deal block follows, whatever its layout: read the status through usePaused, spread
// `rootProps` on the block's root (data-stale turns on the shared look in paused.css), show <PausedNotice> where
// the block says when to act, and spread `actionProps` on its actions, which stay usable and are described by the
// notice. In paused.css, text keeps tokens of at least 4.5:1 and nothing fades with opacity: what carries
// data-stale-dim (the drawn cards) turns grey.
import { useId } from "react";
import { useApp } from "../AppContext";
import { Icon } from "./Icon";

export interface Paused {
  paused: boolean;
  noticeId: string;
  rootProps: { "data-stale"?: "" };
  actionProps: { "aria-describedby"?: string };
}

/** Whether the data is paused (stale), and the props a hero spreads to say so. */
export function usePaused(): Paused {
  const { status } = useApp();
  const noticeId = useId();
  const paused = status === "stale";
  return {
    paused,
    noticeId,
    rootProps: paused ? { "data-stale": "" } : {},
    actionProps: paused ? { "aria-describedby": noticeId } : {},
  };
}

/**
 * "Paused · prices may have changed", while paused; nothing otherwise. The live pills say the same words. A page
 * says it out loud once (the top tiles' notice); another notice on the same page passes `quiet`.
 */
export function PausedNotice({
  paused,
  noticeId,
  className,
  quiet = false,
}: Pick<Paused, "paused" | "noticeId"> & { className?: string; quiet?: boolean }) {
  if (!paused) return null;
  return (
    <p id={noticeId} className={className ? `paused-note ${className}` : "paused-note"} role={quiet ? undefined : "status"}>
      <Icon name="pause" />
      <span>
        <b>Paused</b> · prices may have changed
      </span>
    </p>
  );
}

/** The same words for screen readers only, for actions whose block shows no notice (the deal rows' Open links). */
export function PausedDescription({ paused, noticeId }: Pick<Paused, "paused" | "noticeId">) {
  if (!paused) return null;
  return (
    <span id={noticeId} className="sr">
      Paused · prices may have changed
    </span>
  );
}
