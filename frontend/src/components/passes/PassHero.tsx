// The top pick: the pass that pays its cost back soonest from today (a season months away waits for its months),
// among those the filters keep and this device does not hold yet (as "Your next Rax" does). Its drawn card fans out with the rarity below and above it; a new pick deals in.
import { type MouseEvent, useLayoutEffect, useRef } from "react";
import { useApp } from "../../AppContext";
import { LIVE_ONLY, about, big, budgetText, metaText, multText, paybackWord, paysLaterText, spanText, tierName, x1 } from "../../content/passWords";
import { type PassRow, saleFor } from "../../data/passList";
import { formatRax } from "../../lib/format";
import { DUR, EASE_OUT, play, stagger } from "../../lib/motion";
import { dayOf, monthBars, monthsToLimit, paysLater } from "../../lib/passes";
import { sportLabel } from "../../lib/words";
import { Icon } from "../Icon";
import { InfoTip } from "../InfoTip";
import { PassFan, PassTags, Swatch } from "./bits";
import { useOpenPass } from "./PassCard";

/** Deals the fan in when the pick changes (not on first paint): the cards slide in from the right and settle. */
function useDealIn(key: string) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef(key);
  useLayoutEffect(() => {
    if (last.current === key) return;
    last.current = key;
    ref.current?.querySelectorAll<HTMLElement>(".card").forEach((card, i) => {
      const settle = card.classList.contains("l") ? "rotate(-9deg)" : card.classList.contains("rt") ? "rotate(9deg)" : "none";
      play(
        card,
        [
          { transform: "translate(110px, 34px) rotate(16deg) scale(0.9)", opacity: 0 },
          { transform: settle, opacity: 1 },
        ],
        { duration: DUR.enter, easing: EASE_OUT, delay: stagger(i, 70), fill: "backwards" },
        [{ opacity: 0 }, { opacity: 1 }],
      );
    });
    const text = ref.current?.querySelector(".htext, .htx");
    play(text, [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], {
      duration: DUR.glide,
      easing: EASE_OUT,
      delay: DUR.fast,
      fill: "backwards",
    });
  }, [key]);
  return ref;
}

export function PassHero({
  top,
  sport,
  allHeld = false,
  buildTo = null,
}: {
  top: PassRow | null;
  sport: string;
  allHeld?: boolean;
  buildTo?: string | null; // the tier the list is built to (lib/buildToSwitch.ts); null for Best for each
}) {
  const { snap, prefs, layout, showCards } = useApp();
  const openPass = useOpenPass();
  const ref = useDealIn(top ? `${top.market.key}:${top.rung.tier}` : "");
  if (!top) {
    return (
      <section className="hero none passhero" aria-label="Top pick for your budget">
        <div className="nohero">
          <h2>{allHeld ? "You already hold every pass listed here." : "No pass fits these filters."}</h2>
          <p>Try a bigger budget, another sport or both seasons.</p>
        </div>
      </section>
    );
  }
  const { market: m, rung: r } = top;
  const rules = snap.rules.otd;
  const today = dayOf(snap.otd.as_of);
  const budget = prefs.passBudget;
  const level = prefs.level;
  const pb = paybackWord(r, today);
  const ttl = monthsToLimit(m, r, rules, today);
  const quiet = monthBars(m, r, rules, today).quiet;
  const later = paysLater(m, rules, today);
  const laterLine = later && <p className="when later">{paysLaterText(later)}</p>;
  const sale = saleFor(m, r, rules);
  const fit = budget !== null && <span className="fit">fits your {big(budget)} max</span>;
  const limitWords =
    r.limit === null
      ? "no limit at this rarity"
      : r.limit === 0
        ? LIVE_ONLY
        : `stops after ${r.limit_estimated ? "about " : ""}${big(r.limit)} in total${ttl !== null ? `, in about ${spanText(ttl)}` : ""}`;
  const when = layout.phone ? limitWords : `${limitWords.charAt(0).toUpperCase()}${limitWords.slice(1)}${quiet ? ` · ${quiet}` : ""}`;
  const see = (e: MouseEvent<HTMLElement>) => openPass(m, r.tier, e.currentTarget);
  const name = (
    <div className="hname">
      <h2>{m.player_name}</h2>
    </div>
  );
  const meta = (
    <p className="meta">
      <span>{metaText(m)}</span>
      {!layout.phone && <span aria-hidden="true">·</span>}
      <span className="rar">
        <Swatch kind={m.kind} tier={r.tier} />
        <b>{tierName(r.tier)} pass</b>
      </span>
      <PassTags market={m} rung={r} />
      {!layout.phone && fit}
    </p>
  );
  const how = (
    <p className="how">
      <Icon name="coins" />
      <span>
        <span className="hl">
          Pays about <b>{about(r.year_rax)}</b> Rax a year
        </span>
        <span className="hsep"> · </span>
        <span className="hl">
          pays back by end of <b>{pb}</b>
        </span>
      </span>
      {!layout.phone && <InfoTip term="payback" />}
    </p>
  );
  const facts =
    level === "new" ? (
      <div className="facts two">
        <div>
          <p>
            <b>{about(r.cost ?? 0)}</b>to build
            <InfoTip term="buildCost" />
          </p>
          <small>{layout.phone ? `${tierName(r.tier)} pass` : `${tierName(r.tier)} pass, about ${big(r.rating_to_add)} rating`}</small>
        </div>
        <div>
          <p>
            <b>{about(r.year_rax)}</b>Rax a year
            <InfoTip term="passYear" />
          </p>
          <small>
            if it's your only {sportLabel(m.sport)} pass{layout.phone ? "" : " that day"}
          </small>
        </div>
      </div>
    ) : (
      <div className="facts">
        <div>
          <p>
            <b>{about(r.cost ?? 0)}</b>to build
            <InfoTip term="buildCost" />
          </p>
          <small>
            {r.route === "mint"
              ? "the mint alone"
              : layout.phone
                ? `${big(r.rating_to_add)} rating`
                : `${sale.firm === false ? "auctions open at" : "on sale now:"} ${big(sale.on_sale_cost)}${sale.enough ? "" : " for part"}`}
          </small>
        </div>
        <div>
          <p>
            <b>{r.per_game_day === null ? "—" : formatRax(Math.round(r.per_game_day))}</b>per game day
            <InfoTip term="perGameDay" />
          </p>
          <small>
            {m.game_days === null ? "game days unknown" : `on ~${Math.round(m.game_days)} game days${layout.phone ? "" : " a year"}`}
          </small>
        </div>
        <div>
          <p>
            <b>{r.lifetime_per_rax === null ? "—" : `${x1(r.lifetime_per_rax)}×`}</b>limit ÷ cost
            <InfoTip term="limitCost" />
          </p>
          <small>{layout.phone ? "per Rax" : "Rax it can pay per Rax"}</small>
        </div>
      </div>
    );

  if (layout.phone) {
    return (
      <section ref={ref} className="hero phone passhero" aria-label="Top pick for your budget">
        <div className="hero-top">
          <div className="htx">
            {name}
            {meta}
            {fit}
          </div>
          <div className="hcard" aria-hidden="true">
            <PassFan market={m} rung={r} single />
          </div>
        </div>
        {how}
        <p className="when">{when}</p>
        {laterLine}
        {facts}
        <button type="button" className="btn fill" aria-label={`See the pass: ${m.player_name} ${m.season_label}`} onClick={see}>
          See the pass
          <Icon name="arrow" />
        </button>
      </section>
    );
  }

  return (
    <section ref={ref} className="hero passhero" aria-label="Top pick for your budget">
      <div className="htext">
        {name}
        {meta}
        {how}
        <p className="when">{when}</p>
        {laterLine}
        {facts}
        <p className="why">
          <b>Why it's the top pick:</b> we list the {rules.top} best passes of{" "}
          {sport === "all" ? "each sport" : sportLabel(sport)}
          {buildTo ? ` built to ${tierName(buildTo)}` : ""}. Of those you don't hold yet
          {budget === null ? "" : ` that fit ${budgetText(budget)}`},{" "}
          {buildTo
            ? "it pays the most Rax a year for each Rax it costs."
            : "it pays its cost back soonest from today, counting only the months its season pays in."}
        </p>
        <div className="btns">
          <button type="button" className="btn fill" onClick={see}>
            See the pass
            <Icon name="arrow" />
          </button>
          {m.kind !== "team" && (
            <button
              type="button"
              className="btn ghost"
              onClick={() =>
                showCards({ sport: m.sport, player_id: m.player_id, season: m.season, label: `${m.player_name} ${m.season_label}` })
              }
            >
              <Icon name="cards" />
              See these cards
            </button>
          )}
        </div>
      </div>
      <figure className="art">
        <PassFan market={m} rung={r} />
        <figcaption>
          {tierName(r.tier)}: {multText(r.mult)} pay per game day
        </figcaption>
      </figure>
    </section>
  );
}

