import type { ReactNode } from "react";
import { Chg } from "./Chg";
import { useApp } from "../AppContext";
import { goneReasonText, isGone } from "../data/deals";
import type { SortKey } from "../data/prefs";
import type { Deal, GoneDeal } from "../data/types";
import type { useFreeze } from "../hooks/useFreeze";
import type { StableRow } from "../hooks/useStableList";
import { cls } from "../lib/cls";
import { formatPct, formatRax } from "../lib/format";
import { toOpenUrl } from "../lib/openLink";
import { lookAlikes } from "../lib/lookAlike";
import { afterFeesText, noResaleProfit, perPointText, rarityClass, ratingText, sportLabel, seasonLabel } from "../lib/words";
import { BuyChip } from "./BuyChip";
import { Clock } from "./Clock";
import { FallingTag } from "./FallingTag";
import { NoProfitTag } from "./NoProfitTag";
import { InjuryTag } from "./InjuryTag";
import { ResaleTag } from "./ResaleTag";
import { FollowStar } from "./FollowStar";
import { Icon } from "./Icon";
import { PausedDescription, usePaused } from "./Paused";
import { PlayerAvatar } from "./PlayerAvatar";
import { useOpenQr } from "./QrPopover";
import { Twins } from "./Twins";
import { useOwned } from "../hooks/useOwned";
import { OwnedTag } from "./OwnedTag";
import { RarityTag } from "./RarityTag";
import { DealPassLine, usePassIndex } from "./DealPassLine";

export type DealRow = StableRow<Deal | GoneDeal>;

export interface DealRowsProps {
  label: string;
  rows: DealRow[];
  stale: boolean;
  bind: ReturnType<typeof useFreeze>["bind"];
  bodyRef: (el: HTMLElement | null) => void;
  /** The rank of the first live row (Today's list under the top three starts at 4); none: no ranks shown. */
  rankFrom?: number;
}

const userAgent = () => (typeof navigator === "undefined" ? "" : navigator.userAgent);

/** Why a row is dimmed: its gone reason, or for a row held still while the list is frozen, what the clock says. */
export function dimReason(row: DealRow, now: number): string | null {
  if (isGone(row.item)) return goneReasonText(row.item.reason);
  if (row.held) return Date.parse(row.item.ends_at) <= now ? "Ended" : "No longer a deal";
  return null;
}

/** Each row's rank, counting only the live rows from `from`; a dimmed row (gone, or held) has none. */
export function rowRanks(rows: DealRow[], now: number, from: number | undefined): (number | null)[] {
  let next = from ?? 0;
  return rows.map((row) => (from === undefined || dimReason(row, now) ? null : next++));
}

/** A row's rank as a small neutral circle before the face; an empty one keeps a dimmed row in line. */
export function RankDot({ rank }: { rank: number | null }) {
  if (rank === null) return <span className="rk" aria-hidden="true" />;
  return (
    <span className="rk" role="img" aria-label={`Rank ${rank}`}>
      {rank}
    </span>
  );
}

function SortHeader({ label, sortKey, ascending, className }: {
  label: string;
  sortKey?: SortKey;
  ascending?: boolean;
  className: string;
}) {
  const { prefs, setPrefs } = useApp();
  if (!sortKey) {
    return (
      <span className={className} role="columnheader">
        {label}
      </span>
    );
  }
  const on = prefs.sort === sortKey;
  return (
    <span className={className} role="columnheader" aria-sort={on ? (ascending ? "ascending" : "descending") : "none"}>
      <button type="button" className={cls("hs", on && "on")} onClick={() => setPrefs({ sort: sortKey })}>
        {label}
        {on && <Icon name={ascending ? "sortup" : "sortdn"} />}
      </button>
    </span>
  );
}

/** The deals as a table (desktop): the columns grow with the level, every row has Open and a QR code. */
export function DealTable({ label, rows, stale, bind, bodyRef, rankFrom }: DealRowsProps) {
  const { prefs, now, opened, openDeal, snap, flash } = useApp();
  const openQr = useOpenQr();
  const full = prefs.level !== "new";
  const owned = useOwned();
  const passes = usePassIndex();
  const ranks = rowRanks(rows, now, rankFrom);
  const alike = lookAlikes(rows.map((r) => r.item)); // two cards that read the same show their mint numbers
  const paused = usePaused(); // paused rows keep their links, each described as paused
  const pos = (i: number) => (rankFrom ?? 1) - 1 + i; // a click counts at the row's rank: under Today's tiles, from 4

  const head = (
    <div className="grid thead" role="row">
      <SortHeader label="Player" className="c-pl" />
      <SortHeader label="Price" className="r c-price" sortKey="cheapest" ascending />
      {full && <SortHeader label="Per rating pt" className="r c-ppt" />}
      <SortHeader label="Usual" className="r c-usual" />
      <SortHeader label={full ? "Under" : "Cheaper"} className="r c-pct" sortKey="under" />
      <SortHeader label="Clock" className="r c-clock" sortKey={full ? "ending" : "newest"} ascending={full} />
      {full && <SortHeader label="Bids" className="r c-bids" />}
      {full && <SortHeader label="After fees" className="r c-af" sortKey="best" />}
      <span className="r c-act" role="columnheader">
        <span className="sr">Open</span>
      </span>
    </div>
  );

  return (
    <>
    <PausedDescription {...paused} />
    <div
      className={cls("tbl", `lvl-${prefs.level}`, stale && "stale", rankFrom !== undefined && "ranked")}
      role="table"
      aria-label={label}
      {...bind}
    >
      <div role="rowgroup">{head}</div>
      <div className="tbody" role="rowgroup" ref={bodyRef}>
        {rows.map((row, i) => {
          const d = row.item;
          const reason = dimReason(row, now);
          const thin = d.reference < snap.rules.after_fees_min_ref;
          const wasOpened = opened.has(d.listing_id);
          let tail: ReactNode;
          if (reason) {
            tail = (
              <span className="reason" role="cell">
                <Icon name="timer" />
                <span>{reason}</span>
              </span>
            );
          } else {
            tail = (
              <>
                <span className="r c-clock" role="cell">
                  <Clock deal={d} now={now} />
                </span>
                {full && (
                  <span className="r c-bids" role="cell">
                    {d.num_bids}
                  </span>
                )}
                {full && (
                  <div className="cell c-af" role="cell">
                    <b className={cls("v-af", thin && "thin", d.flip_margin < 0 && "loss")} data-testid="after-fees">
                      {afterFeesText(d.flip_margin)}
                    </b>
                    {thin && <small>thin</small>}
                  </div>
                )}
              </>
            );
          }
          return (
            <div
              key={row.key}
              role="row"
              data-key={row.key}
              className={cls(
                "grid", "tr", reason && "gone", row.isNew && "arrived",
                !reason && flash?.listing === d.listing_id && "alerted",
              )}
            >
              <div className="c-pl" role="cell">
                {rankFrom !== undefined && <RankDot rank={ranks[i] ?? null} />}
                <PlayerAvatar sport={d.sport} playerId={d.player_id} name={d.player_name} rarity={rarityClass(d.rarity)} />
                <div className="pltx">
                  <span className="nm">
                    <span className="nmt" data-testid="player" title={d.player_name}>
                      {d.player_name}
                    </span>
                    <FollowStar player={d} />
                    {row.isNew && <span className="new flash">new</span>}
                    {/* In the wide player cell: the % column is too narrow for it. */}
                    {noResaleProfit(d) && <NoProfitTag />}
                  </span>
                  <small>
                    {ratingText(d.rating)} · <RarityTag rarity={d.rarity} />
                    {(prefs.level === "pro" || alike.has(d.listing_id)) && d.mint !== null && ` #${formatRax(d.mint)}`} · {sportLabel(d.sport)}{" "}
                    {seasonLabel(d.sport, d.season)}
                  </small>
                  {!reason && <DealPassLine deal={d} index={passes} owned={owned} as="cell" />}
                </div>
              </div>
              <div className="cell c-price" role="cell">
                <Chg value={d.price} />
                <BuyChip kind={d.kind} />
              </div>
              {full && (
                <span className="r c-ppt" role="cell">
                  {perPointText(d.per_point)}
                </span>
              )}
              <div className="cell c-usual" role="cell">
                <b>{formatRax(d.reference)}</b>
                <small>
                  {formatRax(d.ref_sample)} {d.ref_sample === 1 ? "sale" : "sales"}
                </small>
              </div>
              <div className="cell c-pct" role="cell">
                <b className={cls("pct", d.falling && "grey")} data-testid="pct">
                  {formatPct(d.discount)}
                </b>
                {d.falling && <FallingTag />}
                {d.injury && <InjuryTag injury={d.injury} />}
                <OwnedTag deal={d} owned={owned} />
                {full && <ResaleTag resale={d.resale} />}
              </div>
              {tail}
              <div className="c-act" role="cell">
                {!reason && (
                  <>
                    <a
                      className={cls("open", wasOpened && "done")}
                      href={toOpenUrl(d.url, userAgent())}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`${wasOpened ? "Opened" : "Open"} ${d.player_name} in Real`}
                      {...paused.actionProps}
                      onClick={() => openDeal(d, "deals", pos(i))}
                      onAuxClick={(e) => {
                        if (e.button === 1) openDeal(d, "deals", pos(i)); // a middle-click opens it in a new tab
                      }}
                    >
                      {wasOpened ? "Opened" : "Open"}
                      {!wasOpened && <Icon name="ext" />}
                    </a>
                    <button
                      type="button"
                      className="qr"
                      aria-label={`Open ${d.player_name} on your phone`}
                      title="Open on your phone"
                      {...paused.actionProps}
                      onClick={(e) => openQr(d, e, "deals", pos(i))}
                    >
                      <Icon name="phone" />
                    </button>
                  </>
                )}
              </div>
              {reason && (
                <div className="c-tw" role="cell">
                  <Twins subject={d} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
    </>
  );
}
