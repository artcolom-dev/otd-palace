import { Chg } from "./Chg";
import { type MouseEvent, useId, useLayoutEffect, useRef } from "react";
import { useApp } from "../AppContext";
import { explain } from "../content/glossary";
import type { Deal, GoneDeal } from "../data/types";
import type { useFreeze } from "../hooks/useFreeze";
import type { Tile } from "../hooks/useTopTiles";
import { cls } from "../lib/cls";
import { formatPct, formatRax } from "../lib/format";
import { DUR, EASE_OUT, play, prefersReducedMotion, stagger } from "../lib/motion";
import { toOpenUrl } from "../lib/openLink";
import {
  NO_PROFIT_TEXT,
  afterFeesText,
  noResaleProfit,
  perPointText,
  plural,
  rarityClass,
  ratingText,
  realEstimateText,
  recentSalesText,
  seasonLabel,
  sportLabel,
} from "../lib/words";
import { Clock } from "./Clock";
import { FallingTag } from "./FallingTag";
import { InjuryTag } from "./InjuryTag";
import { NoProfitTag } from "./NoProfitTag";
import { ResaleTag } from "./ResaleTag";
import { FollowStar } from "./FollowStar";
import { Icon } from "./Icon";
import { useOverlay } from "./Overlay";
import { type Paused, PausedNotice, usePaused } from "./Paused";
import { PlayerAvatar } from "./PlayerAvatar";
import { useOpenQr } from "./QrPopover";
import { ShareButton } from "./ShareButton";
import { OwnedTag } from "./OwnedTag";
import { useOwned } from "../hooks/useOwned";
import { RarityTag } from "./RarityTag";

const userAgent = () => (typeof navigator === "undefined" ? "" : navigator.userAgent);

/**
 * What the ⓘ on the best tile says: why it is a deal, then each number behind it with its plain explanation. Plain
 * values only: the sheet is drawn outside the tile.
 */
function WhyDeal({ deal, isNew, thinUnder }: { deal: Deal; isNew: boolean; thinUnder: number }) {
  const fmv = deal.ref_source === "fmv";
  const sales = plural(deal.ref_sample, "sale", "sales");
  const usual = formatRax(deal.reference);
  const thin = deal.reference < thinUnder;
  const target = deal.kind === "target";
  return (
    <>
      <p className="poptx">
        {fmv
          ? `Real's own estimate puts it near ${usual}, from ${sales} this week, and a player listed it, not Real.`
          : `${sales} this week put it near ${usual}, and a player listed it, not Real.`}
      </p>
      <dl className="gl whygl">
        <div>
          <dt>Usual price</dt>
          <dd>
            <b>{usual}</b> · {sales} · 7 days. {explain("usual", { n: deal.ref_sample, fmv })}
          </dd>
        </div>
        <div>
          <dt>{isNew ? "% cheaper" : "% under"}</dt>
          <dd>
            <b>{formatPct(deal.discount)}</b>
            {!isNew && ` · ${perPointText(deal.per_point)} per rating pt`}. {explain(isNew ? "cheaper" : "under")}
          </dd>
        </div>
        {noResaleProfit(deal) && (
          <div>
            <dt>No profit</dt>
            <dd>
              {NO_PROFIT_TEXT}. {explain("noProfit")}
            </dd>
          </div>
        )}
        {!isNew && (
          <div>
            <dt>After fees</dt>
            <dd>
              <b>{afterFeesText(deal.flip_margin)}</b> if resold at {usual}
              {thin && " · thin"}. {explain("fees")}
            </dd>
          </div>
        )}
        <div>
          <dt>{target ? "To start" : "Top bid"}</dt>
          <dd>{explain(target ? "start" : "bid")}</dd>
        </div>
        {recentSalesText(deal) && (
          <div>
            <dt>Latest sales</dt>
            <dd>{recentSalesText(deal)}</dd>
          </div>
        )}
        {realEstimateText(deal) && (
          <div>
            <dt>Real's estimate</dt>
            <dd>{realEstimateText(deal)}</dd>
          </div>
        )}
        {deal.falling && (
          <div>
            <dt>Falling</dt>
            <dd>{explain("falling")}</dd>
          </div>
        )}
        <div>
          <dt>Rating</dt>
          <dd>{explain("rating")}</dd>
        </div>
      </dl>
      <div className="poptx sharerow">
        <ShareButton deal={deal} />
      </div>
    </>
  );
}

/** One tile: rank 1 in full, ranks 2 and 3 short. The tile itself is no link; its buttons are. */
function TileCard({ tile, paused }: { tile: Tile; paused: Paused }) {
  const { prefs, snap, now, layout, openDeal, flash } = useApp();
  const overlay = useOverlay();
  const openQr = useOpenQr();
  const owned = useOwned();
  const d: Deal | GoneDeal = tile.row.item;
  const best = tile.rank === 1;
  const off = tile.away !== null;
  const isNew = prefs.level === "new";
  const target = d.kind === "target";
  const pos = tile.rank - 1;
  const pct = formatPct(d.discount);

  const onOpen = (e: MouseEvent<HTMLAnchorElement>) => {
    if (off) {
      e.preventDefault();
      return;
    }
    openDeal(d, "hero", pos);
  };
  const onAux = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 1) return;
    if (off) e.preventDefault(); // a deal that went away opens nowhere, a middle-click included
    else openDeal(d, "hero", pos); // a middle-click opens it in a new tab
  };
  const onQr = (e: MouseEvent<HTMLButtonElement>) => {
    if (!off) openQr(d, e, "hero", pos);
  };
  const why = (e: MouseEvent<HTMLButtonElement>) =>
    overlay.open({
      title: "Why it's a deal",
      anchor: e.currentTarget,
      body: () => <WhyDeal deal={d} isNew={isNew} thinUnder={snap.rules.after_fees_min_ref} />,
    });

  // Tiles 2 and 3 show what the list's row would, on the pill: an auction, or a usual price that rests on little.
  const marks = [
    !best && d.kind === "bid" && "auction",
    !best && (d.confidence !== "high" || d.reference < snap.rules.after_fees_min_ref) && "thin",
  ].filter((m): m is string => typeof m === "string");
  const pill = (
    <span className={cls("tpct", d.falling && "grey")} data-testid="tile-pct">
      <span aria-hidden="true">−{pct}</span>
      <span className="sr">
        {pct} {isNew ? "cheaper" : "under"}
      </span>
      {marks.length > 0 && (
        <span className="tmarks" data-testid="tile-marks">
          {marks.map((m) => (
            <span key={m} className="tmark">
              {m}
            </span>
          ))}
        </span>
      )}
    </span>
  );
  const awayId = useId();
  // A tile whose deal went away: its controls do nothing and are described by why.
  const offProps = off ? { "aria-disabled": true as const, "aria-describedby": awayId } : paused.actionProps;
  const awayLine = off && (
    <p className="taken-line" role="status" id={awayId}>
      <Icon name="timer" />
      <span>{best ? `${tile.away} · finding the next best deal` : tile.away}</span>
    </p>
  );
  const href = toOpenUrl(d.url, userAgent());

  return (
    <li
      className={cls(
        "tile", best ? "best" : "next", off && "taken", !off && flash?.listing === d.listing_id && "alerted",
      )}
      data-key={tile.row.key}
      {...paused.rootProps}
    >
      <span className="rank" role="img" aria-label={`Rank ${tile.rank}`}>
        {tile.rank}
      </span>
      {/* "Best now" is only true of the default sort: under another, rank 1 is the first of that order. */}
      {best && prefs.sort === "best" && <span className="ribbon">Best now</span>}
      <div className="ttop">
        <span className="tface" data-stale-dim>
          <PlayerAvatar
            sport={d.sport}
            playerId={d.player_id}
            name={d.player_name}
            rarity={rarityClass(d.rarity)}
            size={best ? (layout.phone ? 56 : 76) : layout.phone ? 40 : 56}
          />
        </span>
        <div className="tid" data-stale-quiet>
          <div className="tname">
            <h3 title={d.player_name}>{d.player_name}</h3>
            <FollowStar player={d} large={best && !layout.phone} />
          </div>
          {best ? (
            <p className="tmeta" data-testid="tile-meta">
              <span className="tml">
                {sportLabel(d.sport)} {seasonLabel(d.sport, d.season)} · {ratingText(d.rating)}
              </span>{" "}
              <span className="tml">
                <RarityTag rarity={d.rarity} />
                {prefs.budget !== null && (
                  <span className="tfit">
                    <span className="sep"> · </span>fits your {formatRax(prefs.budget)} max
                  </span>
                )}
              </span>
            </p>
          ) : (
            <p className="tmeta" data-testid="tile-meta">
              <span className="tml tmline">
                {sportLabel(d.sport)} {seasonLabel(d.sport, d.season)} · {d.rating.toFixed(1)}
              </span>
              <span className="tml">
                <RarityTag rarity={d.rarity} />
              </span>
            </p>
          )}
        </div>
      </div>
      <div className="tprice" data-stale-quiet data-testid="tile-price">
        <Chg value={d.price} />
        <span className="unit">
          {target ? "to start" : "top bid"}
          <span className="sr">{target ? " (the opening bid)" : " (the bid to beat)"}</span>
        </span>
        <s>
          {layout.phone ? "usual" : "usually sells for"} {formatRax(d.reference)}
        </s>
        {(best || !off) && (
          <span className="tpills">
            {pill}
            {/* On a phone the tag is a word, not a button too small to tap beside the ⓘ: the list does the same. */}
            {d.falling && <FallingTag inert={layout.phone} />}
            {noResaleProfit(d) && <NoProfitTag inert={layout.phone} />}
            {d.injury && <InjuryTag injury={d.injury} inert={layout.phone} />}
            {prefs.level !== "new" && <ResaleTag resale={d.resale} inert={layout.phone} />}
            <OwnedTag deal={d} owned={owned} />
            {best && (
              <button type="button" className="ib" aria-label="Explain why it's a deal" onClick={why}>
                <Icon name="info" />
              </button>
            )}
          </span>
        )}
      </div>
      {best ? (
        (awayLine || (
          <p className="tsay" data-testid="hero-how" data-stale-quiet>
            {target ? (
              <>
                Bid <b>{formatRax(d.price)}</b> to start the 10-min countdown.{" "}
              </>
            ) : (
              <>
                Top bid <b>{formatRax(d.price)}</b>: bid more before it ends.{" "}
              </>
            )}
            <span className="tclock">
              <Clock deal={d} now={now} sentence />
            </span>
          </p>
        ))
      ) : (
        awayLine
      )}
      {best && <PausedNotice {...paused} />}
      <div className="go">
        {best ? (
          <a
            className="btn fill"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            {...offProps}
            onClick={onOpen}
            onAuxClick={onAux}
          >
            Open in Real
            <Icon name="ext" />
          </a>
        ) : (
          <a
            className="btn ghost"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${d.player_name} in Real`}
            {...offProps}
            onClick={onOpen}
            onAuxClick={onAux}
          >
            Open
            <Icon name="ext" />
          </a>
        )}
        {best && !off && <ShareButton deal={d} iconOnly={!layout.phone} />}
        {!layout.phone &&
          (best ? (
            <button type="button" className="btn ghost qrl" {...offProps} onClick={onQr}>
              <Icon name="phone" />
              <span>Open on phone</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn ghost qrb"
              aria-label={`Open ${d.player_name} on your phone`}
              title="Open on your phone"
              {...offProps}
              onClick={onQr}
            >
              <Icon name="phone" />
            </button>
          ))}
      </div>
    </li>
  );
}

/**
 * The top of Today: the visitor's own top three deals as tiles, ranked 1 to 3 (the list under them goes on at 4).
 * Paused data (see Paused.tsx) marks every tile and describes every action by one notice, on the best tile. A deal
 * new to its place rises in, opacity and a short lift only, and not at all for a visitor who asks for less motion;
 * the tile a notification points at lights up and comes into view.
 */
export function TopDeals({ tiles, bind }: { tiles: Tile[]; bind: ReturnType<typeof useFreeze>["bind"] }) {
  const { layout, flash } = useApp();
  const paused = usePaused();
  const headId = useId();
  const listRef = useRef<HTMLOListElement>(null);

  const order = tiles.map((t) => t.row.key).join("|");
  const shown = useRef<string[] | null>(null);
  useLayoutEffect(() => {
    const before = shown.current;
    const keys = order.split("|");
    shown.current = keys;
    if (before === null) return;
    const els = listRef.current ? Array.from(listRef.current.children) : [];
    keys.forEach((key, i) => {
      if (before[i] === key) return;
      play(
        els[i],
        [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
        { duration: DUR.glide, easing: EASE_OUT, delay: stagger(i, 60), fill: "backwards" },
        null,
      );
    });
  }, [order]);

  const scrolledFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!flash) return;
    const target = `${flash.listing}:${flash.seq}`;
    if (scrolledFor.current === target) return;
    const i = tiles.findIndex((t) => t.away === null && t.row.item.listing_id === flash.listing);
    if (i < 0) return;
    scrolledFor.current = target;
    const el = listRef.current?.children[i];
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }
  });

  return (
    <section className={cls("tops", layout.phone && "phone")} aria-labelledby={headId} data-n={tiles.length} {...bind}>
      <h2 id={headId} className="sr">
        Best deals for you right now
      </h2>
      <ol ref={listRef} className="tiles">
        {tiles.map((tile) => (
          <TileCard key={tile.row.key} tile={tile} paused={paused} />
        ))}
      </ol>
    </section>
  );
}
