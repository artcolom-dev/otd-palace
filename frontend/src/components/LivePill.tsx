import { useApp } from "../AppContext";
import { cls } from "../lib/cls";
import { formatRax } from "../lib/format";
import type { Snapshot } from "../data/types";

/** Bids heard in the last 10 minutes across the sports whose live bid stream is up; 0 without one. */
export function bidsLast10(snap: Pick<Snapshot, "bidding">): number {
  return Object.values(snap.bidding ?? {}).reduce((n, s) => n + (s.bids_10m > 0 ? s.bids_10m : 0), 0);
}

/**
 * How fresh the data is. The full line ("Live · updated 3s ago · 12 deals open · 3 taken in 10 min") sits in
 * the desktop top bar; a phone gets the short pill ("Live · 3s ago"; with three buttons in the bar, the dot and "Live"). The age shown is the larger of the data's two ages, never a
 * claim about the server. With the live feed's bid stream it also says how many bids were placed in the last 10
 * minutes on the sports it hears. A count of zero taken is not shown: it may only mean the server just restarted. Sample
 * data reads "Demo", never "Live". Paused data says the same words in both: "Paused · prices may have changed".
 */
export function LivePill({ compact = false }: { compact?: boolean }) {
  const { status, updatedAgoS, openCount, snap } = useApp();
  const live = status === "live";
  const demo = snap.rules.demo === true;
  const word = demo ? "Demo" : "Live";
  // The breathing dot means live market data: sample data keeps a still one.
  const dot = <span className={cls("dot", live && !demo && "on")} aria-hidden="true" />;
  const paused = (
    <>
      <b>Paused</b> · prices may have changed
    </>
  );

  if (compact) {
    return (
      <span className={cls("live", !live && "paused")} data-testid="live-pill">
        {dot}
        <span className="lw">
          {live ? (
            <>
              <b>{word}</b>
              {/* Its own span: a bar that also holds the bell has no room for it, and leaves it to screen readers. */}
              <span className="ago"> · {updatedAgoS ?? 0}s ago</span>
            </>
          ) : (
            paused
          )}
        </span>
      </span>
    );
  }

  return (
    <p className={cls("trust", !live && "paused")} data-testid="live-line">
      {dot}
      {live ? (
        <>
          <b>{word}</b> · updated {updatedAgoS ?? 0}s ago · <b>{formatRax(openCount)}</b>{" "}
          {openCount === 1 ? "deal" : "deals"} open
          {snap.taken_10m > 0 && (
            <>
              {" "}
              · <b>{formatRax(snap.taken_10m)}</b> taken in 10 min
            </>
          )}
          {bidsLast10(snap) > 0 && (
            <>
              {" "}
              · <b>{formatRax(bidsLast10(snap))}</b> bids in 10 min
            </>
          )}
        </>
      ) : (
        paused
      )}
    </p>
  );
}
