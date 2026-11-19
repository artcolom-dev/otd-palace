// "Selling a card?": the visitor picks a player, a season and a rating band from the usual prices the site serves, and
// gets a list price: what cards listed at about the usual price sold at, how it sells at a higher one, and what the
// seller keeps after Real's share and the listing fee. The figures are typical, measured on past sales, never a promise.
import { useId, useMemo, useState } from "react";
import { useApp } from "../AppContext";
import { formatRax } from "../lib/format";
import { chanceWords, type SellBar, sellAdvice, usualPrices } from "../lib/sell";
import { plural, sportLabel } from "../lib/words";
import { Icon } from "./Icon";
import { Meter } from "./Meter";
import { useOverlay } from "./Overlay";
import { PausedNotice, usePaused } from "./Paused";

/** Fewer sales than this behind a usual price and it is a rough guide (the engine's own bar for a sure reference). */
const THIN_SALES = 5;

const SOURCE: Record<"sales" | "today" | "fmv", (n: number) => string> = {
  sales: (n) => `middle price of ${plural(n, "sale", "sales")} in the last 7 days`,
  today: (n) => `middle price of ${plural(n, "sale", "sales")} in the last 24 hours`,
  fmv: (n) => `Real's own estimate, from ${plural(n, "sale", "sales")}`,
};

function Bar({ bar }: { bar: SellBar }) {
  return (
    <li className="sb">
      <span className="sbl">
        {formatRax(bar.price)} Rax{" "}
        <small>
          {bar.multiple}× usual · you keep {formatRax(bar.afterFees)}
        </small>
      </span>
      <Meter className="sbt" value={bar.chance} size="s" />
      <span className="sbv">{chanceWords(bar.chance)}</span>
    </li>
  );
}

/** The three pickers and what they find. */
export function SellHelper() {
  const { snap } = useApp();
  const paused = usePaused();
  const ids = [useId(), useId(), useId()] as const;
  const prices = useMemo(() => usualPrices(snap), [snap]);
  const [who, setWho] = useState("");
  const [season, setSeason] = useState(0);
  const [bucket, setBucket] = useState("");

  const players = useMemo(() => {
    const seen = new Map<string, { name: string; sport: string }>();
    for (const p of prices) seen.set(`${p.sport}:${p.player_id}`, { name: p.player_name, sport: p.sport });
    return [...seen.entries()];
  }, [prices]);
  const ofPlayer = prices.filter((p) => `${p.sport}:${p.player_id}` === who);
  const seasons = [...new Set(ofPlayer.map((p) => p.season))];
  const bands = ofPlayer.filter((p) => p.season === season);
  const picked = bands.find((p) => p.bucket === bucket) ?? null;
  const curve = snap.rules.sell_curve ?? [];
  const advice = picked ? sellAdvice(picked.usual, curve, snap.rules.fee, snap.rules.listing_fee) : null;

  const pickPlayer = (key: string) => {
    const first = prices.find((p) => `${p.sport}:${p.player_id}` === key);
    setWho(key);
    setSeason(first?.season ?? 0);
    setBucket(first?.bucket ?? "");
  };
  const pickSeason = (value: number) => {
    setSeason(value);
    setBucket(ofPlayer.find((p) => p.season === value)?.bucket ?? "");
  };

  if (prices.length === 0) return <p className="bbhint">No usual prices to show yet. Check again in a few minutes.</p>;
  const first = curve[0];
  const last = curve[curve.length - 1];
  return (
    <div className="sell">
      <p className="bbhint">Pick the card from the usual prices we track.</p>
      <div className="sellform">
        <label htmlFor={ids[0]}>
          <span>Player</span>
          <select id={ids[0]} value={who} onChange={(e) => pickPlayer(e.target.value)}>
            <option value="" disabled>
              Pick a player
            </option>
            {players.map(([key, p]) => (
              <option key={key} value={key}>
                {p.name} ({sportLabel(p.sport)})
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={ids[1]}>
          <span>Season</span>
          <select id={ids[1]} value={season} disabled={who === ""} onChange={(e) => pickSeason(Number(e.target.value))}>
            {who === "" && <option value={0}>—</option>}
            {seasons.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={ids[2]}>
          <span>Rating</span>
          <select id={ids[2]} value={bucket} disabled={who === ""} onChange={(e) => setBucket(e.target.value)}>
            {who === "" && <option value="">—</option>}
            {bands.map((p) => (
              <option key={p.bucket} value={p.bucket}>
                {p.band}
              </option>
            ))}
          </select>
        </label>
      </div>
      {picked && advice && first && last && (
        <div className="sellres" data-testid="sell-result">
          <PausedNotice {...paused} quiet />
          <p className="sellsay">
            List at <b>{formatRax(advice.list)}</b> Rax. Cards listed at {first[0]}× the usual price or less sold{" "}
            {chanceWords(first[1])} times; at {last[0]}×, only {chanceWords(last[1])}.
          </p>
          <dl className="selfacts">
            <div>
              <dt>Usual price</dt>
              <dd>
                <b>{formatRax(picked.usual)}</b> Rax <small>{SOURCE[picked.source](picked.sample)}</small>
                {picked.sample < THIN_SALES && <small className="thin"> Few sales behind it: a rough guide.</small>}
              </dd>
            </div>
            <div>
              <dt>You keep</dt>
              <dd>
                <b>{formatRax(advice.afterFees)}</b> Rax{" "}
                <small>
                  after Real's {Math.round(snap.rules.fee * 100)}% and the {formatRax(snap.rules.listing_fee)} Rax listing fee
                </small>
              </dd>
            </div>
          </dl>
          <ul className="sellbars" aria-label="How often a card sells at each price">
            {advice.bars.map((bar) => (
              <Bar key={bar.multiple} bar={bar} />
            ))}
          </ul>
          <p className="sellnote">Typical, not a promise: measured on past sales.</p>
        </div>
      )}
    </div>
  );
}

/** The way in: a button that opens the helper as a sheet; nothing while the snapshot carries no figures to base it on. */
export function SellButton({ className = "lnk box" }: { className?: string }) {
  const overlay = useOverlay();
  const { snap } = useApp();
  if (!snap.rules.sell_curve?.length) return null;
  return (
    <button
      type="button"
      className={className}
      onClick={(e) => overlay.open({ title: "Selling a card?", anchor: e.currentTarget, size: "wide", body: () => <SellHelper /> })}
    >
      <Icon name="deals" />
      Selling a card?
    </button>
  );
}
