// "You opened… got one?": the deals opened in Real from this device, asked about once the visitor is back.
import { useEffect, useId, useState } from "react";
import { useApp } from "../AppContext";
import { local, useLocal } from "../data/local";
import { recentOpens } from "../data/returns";
import { formatRax } from "../lib/format";
import { plural, rarityClass } from "../lib/words";
import { Icon } from "./Icon";
import { PlayerAvatar } from "./PlayerAvatar";
import { Twins } from "./Twins";

const DONE_MS = 2600; // a "Nice, you saved…" line stays this long

/** "6 m ago", "just now". */
function agoText(at: number, now: number): string {
  const m = Math.floor((now - at) / 60_000);
  return m < 1 ? "just now" : `${m} m ago`;
}

/**
 * Back from Real after opening deals: "You opened 2 deals — got one?". Each has "Got it", which adds what it saved
 * to the device's total (once per listing); "Not this time" puts the question away. Atop the rail, or above the hero.
 */
export function OpenedStrip() {
  const { now, returnedAt, snap } = useApp();
  const device = useLocal();
  const id = useId();
  const [done, setDone] = useState<{ key: string; name: string; amount: number }[]>([]);
  const asks = recentOpens(device.opened, now, returnedAt, device.openedDismissedAt, device.got);

  useEffect(() => {
    if (done.length === 0) return;
    const t = setTimeout(() => setDone((d) => d.slice(1)), DONE_MS);
    return () => clearTimeout(t);
  }, [done]);

  if (asks.length === 0 && done.length === 0) return null;
  return (
    <section className="opened" aria-labelledby={`${id}h`}>
      <h2 id={`${id}h`}>
        {asks.length > 0 ? `You opened ${plural(asks.length, "deal", "deals")} — got one?` : "Added to your total"}
      </h2>
      <ul>
        {done.map((d) => (
          <li key={`done:${d.key}`} className="op done">
            <Icon name="check" />
            <span role="status">
              <b>Nice, you saved {formatRax(d.amount)} Rax</b>
              <small>{d.name} · added to your total</small>
            </span>
          </li>
        ))}
        {asks.map((o) => (
          <li key={o.key} className="op">
            <PlayerAvatar sport={o.sport} playerId={o.player_id} name={o.player_name} rarity={rarityClass(o.rarity)} size={28} />
            <span>
              <b>{o.player_name}</b>
              <small>
                {formatRax(o.price)} {o.kind === "target" ? "to start" : "top bid"} · {agoText(o.at, now)}
              </small>
            </span>
            <button
              type="button"
              className="got"
              aria-label={`Got it: ${o.player_name}`}
              onClick={() => {
                const amount = local.markGot(o);
                if (amount !== null) setDone((d) => [...d, { key: o.key, name: o.player_name, amount }]);
              }}
            >
              Got it
            </button>
            {/* An opened deal that has ended is never a dead end: deals like it. */}
            {!snap.deals.some((d) => d.listing_id === o.listing_id && Date.parse(d.ends_at) > now) && (
              <div className="tw-row">
                <Twins subject={o} />
              </div>
            )}
          </li>
        ))}
      </ul>
      {asks.length > 0 && (
        <div className="opfoot">
          <p>Got one? We add what you saved (usual price − price) to your total.</p>
          <button type="button" className="lnk" onClick={() => local.dismissOpened(now)}>
            Not this time
          </button>
        </div>
      )}
    </section>
  );
}
