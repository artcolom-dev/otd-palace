import { Chg } from "./Chg";
import { useId } from "react";
import { useApp } from "../AppContext";
import { cls } from "../lib/cls";
import { formatPct, formatRax } from "../lib/format";
import { toOpenUrl } from "../lib/openLink";
import { lookAlikes } from "../lib/lookAlike";
import { NO_PROFIT_TEXT, afterFeesText, noResaleProfit, perPointText, plural, rarityClass, ratingText, sportLabel, seasonLabel } from "../lib/words";
import { BuyChip } from "./BuyChip";
import { Clock } from "./Clock";
import { type DealRowsProps, RankDot, dimReason, rowRanks } from "./DealTable";
import { FallingTag } from "./FallingTag";
import { InjuryTag } from "./InjuryTag";
import { ResaleTag } from "./ResaleTag";
import { FollowStar } from "./FollowStar";
import { Icon } from "./Icon";
import { PausedDescription, usePaused } from "./Paused";
import { PlayerAvatar } from "./PlayerAvatar";
import { Twins } from "./Twins";
import { useOwned } from "../hooks/useOwned";
import { OwnedTag } from "./OwnedTag";
import { RarityTag } from "./RarityTag";
import { DealPassLine, usePassIndex } from "./DealPassLine";

const userAgent = () => (typeof navigator === "undefined" ? "" : navigator.userAgent);

/**
 * The deals as rows on a phone: each whole row is the link to its auction, marked ↗. The link is named by the
 * row's own name and price (and "Opened"), which are then hidden from the reading order so nothing is read twice;
 * the rest of the row is read once, as text.
 */
export function DealList({ label, rows, stale, bind, bodyRef, rankFrom }: DealRowsProps) {
  const { prefs, now, opened, openDeal, snap, flash } = useApp();
  const uid = useId();
  const full = prefs.level !== "new";
  const owned = useOwned();
  const passes = usePassIndex();
  const word = full ? "under" : "cheaper";
  const ranks = rowRanks(rows, now, rankFrom);
  const alike = lookAlikes(rows.map((r) => r.item)); // two cards that read the same show their mint numbers
  const paused = usePaused(); // paused rows keep their links, each described as paused
  const pos = (i: number) => (rankFrom ?? 1) - 1 + i; // a click counts at the row's rank: under Today's tiles, from 4

  return (
    <>
      <PausedDescription {...paused} />
      <ul
      ref={bodyRef}
      className={cls("list", stale && "stale", rankFrom !== undefined && "ranked")}
      aria-label={label}
      {...bind}
    >
      {rows.map((row, i) => {
        const d = row.item;
        const reason = dimReason(row, now);
        const thin = d.reference < snap.rules.after_fees_min_ref;
        const wasOpened = opened.has(d.listing_id);
        const id = `${uid}${row.key}`;
        const labelledBy = [`${id}-n`, `${id}-p`, `${id}-k`, ...(wasOpened ? [`${id}-o`] : [])].join(" ");
        return (
          <li
            key={row.key}
            data-key={row.key}
            className={cls(
              "prow", full && "lv4", reason && "gone", row.isNew && "arrived",
              !reason && flash?.listing === d.listing_id && "alerted",
            )}
          >
            {!reason && (
              <a
                className="rl"
                href={toOpenUrl(d.url, userAgent())}
                target="_blank"
                rel="noopener noreferrer"
                aria-labelledby={labelledBy}
                {...paused.actionProps}
                onClick={() => openDeal(d, "deals", pos(i))}
                onAuxClick={(e) => {
                  if (e.button === 1) openDeal(d, "deals", pos(i)); // a middle-click opens it in a new tab
                }}
              />
            )}
            {rankFrom !== undefined && <RankDot rank={ranks[i] ?? null} />}
            <PlayerAvatar sport={d.sport} playerId={d.player_id} name={d.player_name} rarity={rarityClass(d.rarity)} />
            <span className="nm">
              <span className="nmt" id={`${id}-n`} data-testid="player" aria-hidden={reason ? undefined : true}>
                {d.player_name}
              </span>
              <FollowStar player={d} />
              {row.isNew && <span className="new flash">new</span>}
            </span>
            <span className="money" aria-hidden={reason ? undefined : true}>
              <Chg value={d.price} id={`${id}-p`} />
              <BuyChip kind={d.kind} inert id={`${id}-k`} />
            </span>
            <span className="ln">
              {ratingText(d.rating)} · {prefs.level !== "pro" && (
                <>
                  <RarityTag rarity={d.rarity} />
                  {" · "}
                </>
              )}
              {alike.has(d.listing_id) && d.mint !== null && `#${formatRax(d.mint)} · `}usual{"\u00a0" /* "usual 86" wraps whole */}
              <b>{formatRax(d.reference)}</b>
              {prefs.level === "pro" && ` · ${plural(d.ref_sample, "sale", "sales")}`}
            </span>
            {full && (
              <span className="ln">
                {perPointText(d.per_point)} per rating pt · after fees{" "}
                <b className={cls(thin && "thin", d.flip_margin < 0 && "loss")} data-testid="after-fees">
                  {afterFeesText(d.flip_margin)}
                </b>
                {thin && <span className="thinl"> thin</span>}
              </span>
            )}
            {!reason && noResaleProfit(d) && <span className="ln noprofit-l">{NO_PROFIT_TEXT}</span>}
            {!reason && <DealPassLine deal={d} index={passes} owned={owned} />}
            {reason ? (
              <span className="ln reason">
                <Icon name="timer" />
                {reason}
              </span>
            ) : (
              <span className="ln clk">
                {sportLabel(d.sport)} {seasonLabel(d.sport, d.season)} · <Clock deal={d} now={now} />
                {full && d.kind === "bid" && ` · ${d.num_bids} ${d.num_bids === 1 ? "bid" : "bids"}`}
                {wasOpened && (
                  <span className="optag" id={`${id}-o`} aria-hidden="true">
                    Opened
                  </span>
                )}
              </span>
            )}
            <span className="pc">
              <b className={cls("pct", d.falling && "grey")} data-testid="pct">
                {formatPct(d.discount)}
              </b>
              <small>{word}</small>
              {d.falling && <FallingTag inert />}
              {d.injury && <InjuryTag injury={d.injury} inert />}
              <OwnedTag deal={d} owned={owned} />
              {full && <ResaleTag resale={d.resale} inert />}
              {!reason && <Icon name="ext" />}
            </span>
            {reason && (
              <div className="tw-row">
                <Twins subject={d} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
    </>
  );
}
