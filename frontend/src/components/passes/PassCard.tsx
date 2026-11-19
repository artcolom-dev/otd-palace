// One pass, opened: a drawer from the right on desktop, a tall sheet on a phone. What it pays and costs in plain
// sentences, when it pays month by month, which rarity is worth it, how to build it, and what is good to know.
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useApp } from "../../AppContext";
import {
  LIVE_ONLY,
  about,
  big,
  budgetText,
  metaText,
  monthShortWord,
  monthsText,
  paybackWord,
  spanText,
  tierName,
  titleText,
  x1,
} from "../../content/passWords";
import { useLocal } from "../../data/local";
import { saleFor, shownRung, teammatesOf } from "../../data/passList";
import type { OtdRules, PassMarket, PassRung } from "../../data/types";
import { useCssVar } from "../../hooks/useCssVar";
import { cls } from "../../lib/cls";
import { formatRax } from "../../lib/format";
import { offerHint, offerWords } from "../../lib/offers";
import { type BuildRate, buildRate } from "../../lib/passRates";
import { DUR, EASE_OUT, play, stagger } from "../../lib/motion";
import { breaksEvenAtBest, dayOf, monthBars, monthName, monthShort, monthsToLimit, recommendedRung } from "../../lib/passes";
import { shortName, sportLabel } from "../../lib/words";
import { Icon } from "../Icon";
import { InfoTip, TermButton } from "../InfoTip";
import { type OverlayContentProps, useOverlay } from "../Overlay";
import { useAddPass } from "./AddPass";
import { PassArtCard, PassTags, Swatch, useRarity } from "./bits";

/** Opens a pass at a rarity (its shown rung when none is given): the drawer, or the sheet on a phone. */
export function useOpenPass() {
  const overlay = useOverlay();
  return (market: PassMarket, tier: string | null, anchor: HTMLElement | null) =>
    overlay.open({
      title: titleText(market),
      anchor,
      layer: "panel",
      body: (ctx) => <PassCard key={`${market.key}:${tier ?? ""}`} market={market} tier={tier} ctx={ctx} />,
    });
}

// A rung whose whole life pays back about what it costs (1.0 a Rax, as served to 2 decimals): the engine says it never
// pays back, and the card says why in plain words instead of "never".
const isBreakEven = (r: PassRung) =>
  r.pays_back !== null && r.lifetime_per_rax !== null && breaksEvenAtBest(r) && r.lifetime_per_rax >= 0.995;

function PassCard({ market, tier, ctx }: { market: PassMarket; tier: string | null; ctx: OverlayContentProps }) {
  const { snap, prefs, showCards } = useApp();
  const { passes } = useLocal();
  const overlay = useOverlay();
  const addPass = useAddPass();
  const rules = snap.rules.otd;
  const budget = prefs.passBudget;
  const level = prefs.level;
  const best = market.kind === "team" ? null : recommendedRung(market.rungs, budget);
  const shown = shownRung(market, budget).rung;
  const [sel, setSel] = useState<string | undefined>(tier ?? best?.tier ?? shown?.tier ?? market.rungs[0]?.tier);
  const rung = market.rungs.find((r) => r.tier === sel) ?? market.rungs[0];
  const held = passes.some((h) => h.key === market.key);

  const title = (
    <span id={ctx.titleId} className="sr">
      {titleText(market)}, {rung ? `${tierName(rung.tier)} pass` : "pass"}
    </span>
  );
  if (!rung) {
    return (
      <>
        <div className="dwhd">
          <div>
            {title}
            <h2>{market.player_name}</h2>
            <p className="meta">{metaText(market)}</p>
          </div>
        </div>
        <div className="dwbody">
          <p className="dsec">No rarity of this pass can be priced yet.</p>
        </div>
      </>
    );
  }

  const seeCards = () => {
    overlay.closeAll();
    showCards({ sport: market.sport, player_id: market.player_id, season: market.season, label: titleText(market) });
  };

  return (
    <>
      <div className="dwhd">
        <div className="pcard" aria-hidden="true">
          <PassArtCard market={market} tier={[rung.tier, rung.rating, rung.mult]} spot="p" />
        </div>
        <div className="dwtitle">
          {title}
          <h2>{market.player_name}</h2>
          <p className="meta">
            <span>{metaText(market)}</span>
            <PassTags market={market} rung={rung} />
          </p>
        </div>
      </div>
      <div className="dwbody">
        <Honest market={market} rung={rung} best={best} />
        <section className="dsec">
          <h3>
            <Icon name="cal" />
            When it pays
          </h3>
          <MonthStrip market={market} rung={rung} />
        </section>
        <section className="dsec">
          <h3>
            <Icon name="layers" />
            Which rarity is worth it
            <InfoTip term="bestForBudget" />
          </h3>
          <Ladder market={market} best={best} sel={rung.tier} onSelect={setSel} level={level} shownTier={(best ?? shown)?.tier} />
        </section>
        <section className="dsec">
          <h3>
            <Icon name="cards" />
            Build it
            <InfoTip term="onSale" />
          </h3>
          <Build market={market} rung={rung} pro={level === "pro"} />
        </section>
        <section className="dsec">
          <h3>
            <Icon name="book" />
            Good to know
          </h3>
          <ul className="notes">
            {notesFor(market, rung, snap.otd.markets, rules)
              .slice(0, level === "new" ? 3 : undefined)
              .map((note, i) => (
                <li key={i}>{note}</li>
              ))}
          </ul>
        </section>
      </div>
      <div className="dwft">
        <button type="button" className="btn ghost" onClick={(e) => addPass(e.currentTarget, market.key)}>
          <Icon name={held ? "check" : "plus"} />
          {held ? "In my passes · edit" : "I own this pass"}
        </button>
        {market.kind !== "team" && (
          <button type="button" className="btn fill" onClick={seeCards}>
            See these cards
            <Icon name="arrow" />
          </button>
        )}
      </div>
    </>
  );
}

/** The rarity in a chip, and the plain sentences: what it pays, what it costs, when it stops. */
function Honest({ market, rung, best }: { market: PassMarket; rung: PassRung; best: PassRung | null }) {
  const { snap, prefs } = useApp();
  const rules = snap.rules.otd;
  const today = dayOf(snap.otd.as_of);
  const budget = prefs.passBudget;
  const pb = paybackWord(rung, today);
  const ttl = monthsToLimit(market, rung, rules, today);
  const note =
    rung === best
      ? `Most Rax back for ${budgetText(budget)}`
      : budget !== null && rung.cost !== null && rung.cost > budget
        ? "Over your budget"
        : "";
  // A General's limit of 0 is not a lifetime limit: it pays its live games, outside any limit.
  const neverByLimit = rung.pays_back === false && !!rung.limit && rung.cost !== null && rung.limit < rung.cost;
  return (
    <section className="dsec">
      <div className="dtop">
        <span className="rchip">
          <Swatch kind={market.kind} tier={rung.tier} />
          {tierName(rung.tier)} pass
        </span>
        {note && <span className="bestnote">{note}</span>}
      </div>
      <div className="honest">
        {rung.pays_back === false && !isBreakEven(rung) && (
          <p className="neg">
            <Icon name="warn" />
            <span>
              {neverByLimit ? (
                <>
                  <b className="neg">Never pays back:</b> its lifetime limit ({rung.limit_estimated ? "about " : ""}
                  {big(rung.limit!)}) is less than its cost (about {about(rung.cost!)}).
                </>
              ) : (
                <>
                  <b className="neg">Never pays back</b> within {rules.payback_horizon_years} years at today's prices.
                </>
              )}
            </span>
          </p>
        )}
        {isBreakEven(rung) && (
          <p className="neg">
            <Icon name="warn" />
            <span>
              <b className="neg">Breaks even at best:</b> over its whole life it pays back about what it costs.
            </span>
          </p>
        )}
        <p>
          <Icon name="coins" />
          <span>
            Pays about <b>{about(rung.year_rax)}</b> Rax a year
            {market.game_days !== null && (
              <>
                , on ~<span>{Math.round(market.game_days)}</span> game days
                {rung.per_game_day !== null && (
                  <>
                    {" "}
                    (about <b>{formatRax(Math.round(rung.per_game_day))}</b> per game day)
                  </>
                )}
              </>
            )}
            {rung.projected ? " (projection)" : ""}
          </span>
        </p>
        <p>
          <Icon name="deals" />
          <span>
            {rung.cost === null ? (
              <>
                Cost: <b>unknown</b>. Team rating has no traded price yet; it needs <b>{big(rung.rating_to_add)}</b>{" "}
                rating{market.mint_cost !== null && <> plus the {big(market.mint_cost)} it costs to make</>}.
              </>
            ) : (
              <>
                Costs about <b>{about(rung.cost)}</b> to build
                {pb ? (
                  <>
                    {" "}
                    · pays back by end of <b>{pb}</b>
                  </>
                ) : rung.pays_back === false ? (
                  " · never pays back"
                ) : null}
              </>
            )}
          </span>
        </p>
        <p>
          <Icon name="flag" />
          <span>
            {rung.limit === null ? (
              <>No limit at this rarity: we count it over {rules.no_limit_horizon_years} years.</>
            ) : rung.limit === 0 ? (
              <>General {LIVE_ONLY}.</>
            ) : (
              <>
                Stops paying after {rung.limit_estimated ? "about " : ""}
                <b>{big(rung.limit)}</b> in total{ttl !== null ? ` (in about ${spanText(ttl)})` : ""}
                {rung.limit_estimated && (
                  <>
                    {" · "}
                    <TermButton term="estimate" className="tg">
                      estimated
                    </TermButton>
                  </>
                )}
              </>
            )}
          </span>
        </p>
      </div>
      {rung.projected && (
        <p className="live-note">
          Rax a year is a projection: {Math.round(market.season_progress * 100)}% of the season is played.
        </p>
      )}
    </section>
  );
}

/** One month's bar: its height (a share of the tallest) through the CSSOM. */
function MonthBar({ h }: { h: number }) {
  const ref = useCssVar<HTMLElement>("--h", h.toFixed(4));
  return <i ref={ref} data-h={h.toFixed(4)} />;
}

/** The next 12 months as bars, the payback month marked; they grow the first time, then glide between rarities. */
function MonthStrip({ market, rung }: { market: PassMarket; rung: PassRung }) {
  const { snap } = useApp();
  const rar = useRarity();
  const today = dayOf(snap.otd.as_of);
  const bars = monthBars(market, rung, snap.rules.otd, today);
  const max = Math.max(...bars.pay, 1e-9);
  const ref = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    // The bars rise from the baseline to their own height (read from the element: the sheet may not be laid out yet).
    ref.current?.querySelectorAll<HTMLElement>("i[data-h]").forEach((bar, i) => {
      play(bar, [{ transform: "scaleY(0)" }, { transform: `scaleY(${bar.dataset.h})` }], {
        duration: DUR.enter,
        easing: EASE_OUT,
        delay: DUR.fast / 2 + stagger(i, 34),
        fill: "backwards",
      });
    });
  }, []);

  const pb = paybackWord(rung, today);
  const parts: ReactNode[] = [];
  if (bars.first_pay) parts.push(`starts paying in ${bars.first_pay}`);
  if (bars.quiet) parts.push(bars.quiet);
  if (bars.limit_index !== null) parts.push(`stops at its limit in ${monthName(bars.months[bars.limit_index]!)}`);
  const rest = parts.length ? parts.reduce<ReactNode[]>((acc, p, i) => (i ? [...acc, " · ", p] : [p]), []) : null;
  return (
    <>
      <ol ref={ref} className={cls("mstrip", rar(market.kind, rung.tier))} aria-label="Pay by month, next 12 months">
        {bars.pay.map((v, i) => (
          <li key={i} className={cls("mb", i === bars.payback_index && "pb", bars.limit_index !== null && i > bars.limit_index && "after")}>
            <span className="sr">
              {monthName(bars.months[i]!)}: about {about(v)} Rax
            </span>
            <MonthBar h={v / max} />
            <em aria-hidden="true">{monthShort(bars.months[i]!).charAt(0)}</em>
          </li>
        ))}
      </ol>
      <p className="scap">
        <span className="key" aria-hidden="true" />
        {pb ? (
          <>
            Pays back by end of <b>{pb}</b> (estimate)
            {rest && <> · {rest}</>}
          </>
        ) : (
          <>
            {rung.pays_back === false ? "Never pays back" : "Payback unknown"}
            {rest && <> · {rest}</>} (estimate)
          </>
        )}
      </p>
    </>
  );
}

/** "Which rarity is worth it": every rarity's cost, pay, limit and payback; the recommended one marked. */
function Ladder({
  market,
  best,
  sel,
  onSelect,
  level,
  shownTier,
}: {
  market: PassMarket;
  best: PassRung | null;
  sel: string;
  onSelect: (tier: string) => void;
  level: string;
  shownTier: string | undefined;
}) {
  const { snap, prefs, layout } = useApp();
  const rules = snap.rules.otd;
  const today = dayOf(snap.otd.as_of);
  const budget = prefs.passBudget;
  const [all, setAll] = useState(false);
  const pro = level === "pro";
  const phone = layout.phone;
  const rows = level === "new" && !all ? market.rungs.filter((r) => r.tier === shownTier || r.tier === sel) : market.rungs;
  const weak = new Set(market.weak);
  const anyPays = recommendedRung(market.rungs) !== null;
  const caption =
    market.kind === "team"
      ? "Team rating has no traded price yet, so no rarity can be ranked by what it costs"
      : best
        ? `Highlighted: most Rax back for ${budgetText(budget)}`
        : anyPays
          ? `None pays back within ${budgetText(budget)}`
          : "None of these pays back at today's prices";

  const weakRung = level !== "new" ? market.rungs.find((r) => weak.has(r.tier)) : undefined;
  const wi = weakRung ? market.rungs.indexOf(weakRung) : -1;
  const below = market.rungs[wi - 1];
  const above = market.rungs[wi + 1];

  const pays = (r: PassRung) =>
    r.pays_back === null ? (
      <span className="dim">unknown</span>
    ) : r.pays_back && r.payback_months !== null && r.payback_month ? (
      <>
        <span>{monthsText(r.payback_months)} mo</span>
        <small>{monthShortWord(r.payback_month, today)}</small>
      </>
    ) : (
      <span className="neg">Never</span>
    );
  const cost = (r: PassRung) =>
    r.cost === null ? (
      <span className="dim">unknown</span>
    ) : (
      <>
        <span>{about(r.cost)}</span>
        {r.route === "mint" && <small>mint</small>}
      </>
    );
  const limit = (r: PassRung) =>
    r.limit === null ? (
      <>
        <span>none</span>
        <small>{rules.no_limit_horizon_years} yr count</small>
      </>
    ) : r.limit === 0 ? (
      <>
        <span>—</span>
        <small>live only</small>
      </>
    ) : (
      <>
        <span>{big(r.limit)}</span>
        {r.limit_estimated && <small>estimated</small>}
      </>
    );

  return (
    <>
      <p className="lcap">
        <i aria-hidden="true" />
        {caption}
      </p>
      <div className={cls("ladder", pro && "pro", phone && "ph")} role="table" aria-label="Rarities of this pass">
        {!phone && (
          <div className="lr lh" role="row">
            <span role="columnheader">Rarity</span>
            {pro && (
              <span className="r" role="columnheader">
                Rating to add
              </span>
            )}
            <span className="r" role="columnheader">
              Cost
            </span>
            <span className="r" role="columnheader">
              Rax a year
            </span>
            <span className="r" role="columnheader">
              Limit
            </span>
            {pro && (
              <span className="r" role="columnheader">
                Limit ÷ cost
              </span>
            )}
            <span className="r" role="columnheader">
              Pays back
            </span>
          </div>
        )}
        {rows.map((r) => {
          const isBest = r === best;
          const over = budget !== null && r.cost !== null && r.cost > budget;
          const on = r.tier === sel;
          const label =
            `Show the ${tierName(r.tier)} pass` +
            (isBest ? ", most Rax back for your budget" : "") +
            (weak.has(r.tier) ? ", weak step" : "") +
            (isBreakEven(r) ? ", breaks even at best" : "");
          return (
            <div key={r.tier} className={cls("lr", isBest && "best", over && "over", on && "sel")} role="row">
              <span className="lt" role="cell">
                <button type="button" className="rsel" aria-pressed={on} aria-label={label} onClick={() => onSelect(r.tier)} />
                <Icon name="check" className="ck" />
                <Swatch kind={market.kind} tier={r.tier} />
                <span>
                  <b>{tierName(r.tier)}</b>
                  {weak.has(r.tier) &&
                    (phone ? (
                      <span className="tg warn">Weak step</span>
                    ) : (
                      <TermButton term="weak" className="tg warn">
                        Weak step
                      </TermButton>
                    ))}
                  {isBreakEven(r) && <small className="ob">Breaks even at best</small>}
                  {r.route === "mint" && !isBreakEven(r) && r.pays_back && <small className="ob">cheapest entry</small>}
                  {over && <small className="ob">over budget</small>}
                </span>
              </span>
              {phone ? (
                <>
                  <span className="v" role="cell">
                    {cost(r)}
                  </span>
                  <span className="v" role="cell">
                    {pays(r)}
                  </span>
                  <span className="sub" role="cell">
                    {pro && <>+{big(r.rating_to_add)} rating · </>}
                    {about(r.year_rax)} a year{r.projected ? " (projection)" : ""} ·{" "}
                    {r.limit === null
                      ? `no limit (${rules.no_limit_horizon_years} yr count)`
                      : r.limit === 0
                        ? "live games only"
                        : `limit ${big(r.limit)}${r.limit_estimated ? " est." : ""}`}
                    {pro && r.lifetime_per_rax !== null && <> · {x1(r.lifetime_per_rax)}×</>}
                  </span>
                </>
              ) : (
                <>
                  {pro && (
                    <span className="r" role="cell">
                      <span>{big(r.rating_to_add)}</span>
                    </span>
                  )}
                  <span className="r" role="cell">
                    {cost(r)}
                  </span>
                  <span className="r" role="cell">
                    <span>{about(r.year_rax)}</span>
                    {r.projected && <small>projection</small>}
                  </span>
                  <span className="r" role="cell">
                    {limit(r)}
                  </span>
                  {pro && (
                    <span className="r" role="cell">
                      {r.lifetime_per_rax === null ? <span className="dim">—</span> : <span>{x1(r.lifetime_per_rax)}×</span>}
                    </span>
                  )}
                  <span className="r" role="cell">
                    {pays(r)}
                  </span>
                </>
              )}
            </div>
          );
        })}
      </div>
      {weakRung && below && above && (
        <p className="lnote">
          <Icon name="warn" />
          <span>
            <b>Weak step:</b> {tierName(weakRung.tier)} costs much more than {tierName(below.tier)} for little more pay.
            Stay at {tierName(below.tier)} or go to {tierName(above.tier)}.
          </span>
        </p>
      )}
      {level === "new" && market.rungs.length > 1 && (
        <button type="button" className="lnk box more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "Show the best only" : "See all rarities"}
          <Icon name="chev" className={all ? "up" : undefined} />
        </button>
      )}
    </>
  );
}

/** Where the typical price comes from, in a few words: the feed's build cell ("common 5-7 cards, 11 sales"), the
 * traded rate flagged thin when the feed found no cell with enough sales, or the traded rate as before. */
function rateSource(build: BuildRate): string {
  const sales = `${formatRax(build.sales)} ${build.sales === 1 ? "sale" : "sales"}`;
  if (build.rarity !== null && build.bucket !== null) return `${build.rarity} ${build.bucket}-rated cards, ${sales}`;
  if (build.thin) return `${sales}${build.bucket ? ` of ${build.bucket}-rated cards` : ""}; too few of any one rarity: less certain`;
  return sales;
}

/** "Build it": the mint alone, the cards on sale now toward the rating, and (Pro) the typical price behind the cost. */
function Build({ market, rung, pro }: { market: PassMarket; rung: PassRung; pro: boolean }) {
  const { snap, prefs } = useApp();
  const rules = snap.rules.otd;
  // Offers: the same rarity for less, if enough are accepted (lib/offers.ts). Never for the mint alone.
  const offer = offerHint(market, rung, rules, dayOf(snap.otd.as_of));
  if (rung.route === "mint") {
    return (
      <p className="bl">
        <Icon name="cards" />
        <span>Mint the pass for {big(rung.cost ?? market.mint_cost ?? 0)} Rax in the app: no cards needed.</span>
      </p>
    );
  }
  if (rung.cost === null) {
    return (
      <p className="bl">
        <Icon name="team" />
        <span>
          Team rating has no traded price, so there is nothing to price here yet. It needs <b>{big(rung.rating_to_add)}</b> rating.
        </span>
      </p>
    );
  }
  const sale = saleFor(market, rung, rules);
  const build = buildRate(market);
  return (
    <>
      <p className="bl">
        <Icon name="cards" />
        {sale.on_sale_rating > 0 ? (
          <span>
            On sale now:{" "}
            {sale.enough ? (
              <>
                <b>all</b> <b>{big(rung.rating_to_add)}</b>
              </>
            ) : (
              <>
                <b>{big(sale.on_sale_rating)}</b> of <b>{big(rung.rating_to_add)}</b>
              </>
            )}{" "}
            rating for <b>{big(sale.on_sale_cost)}</b> Rax (cheapest first)
            {sale.firm === false && "; auctions opening at that: bids can take them higher"}
          </span>
        ) : (
          <span>Nothing is on sale for it right now; its cost uses the typical price of its cards.</span>
        )}
      </p>
      {rung.route === "mint+cards" && market.mint_cost !== null && (
        <p className="bl sub">
          <Icon name="plus" />
          <span>Plus {big(market.mint_cost)} to make the pass in the app.</span>
        </p>
      )}
      {offer && (offer.saved >= 1 || offer.measured?.vs === "above") && (
        <p className="bl offer" data-testid="pass-offer">
          <Icon name="prices" />
          <span>
            {offerWords(offer, rung, prefs.level)}
            <InfoTip term="offer" />
          </span>
        </p>
      )}
      {pro && (
        <>
          <p className="bl sub">
            <Icon name="prices" />
            <span>
              {build.rate === null ? (
                "No traded price per rating point yet."
              ) : (
                <>
                  Typical price: <b>{x1(build.rate)}</b> Rax per rating point ({rateSource(build)}) → about <b>{about(rung.cost)}</b>
                  {market.mint_cost !== null && rung.route === "mint+cards" ? ` with the ${big(market.mint_cost)} to make the pass` : ""}.
                </>
              )}
            </span>
          </p>
          {sale.ignored > 0 && (
            <p className="bl sub">
              <Icon name="x" />
              <span>
                {sale.ignored} listing{sale.ignored > 1 ? "s" : ""} ignored: asking over {rules.ignore_ask_above}× the typical
                price.
              </span>
            </p>
          )}
          <p className="bl sub">
            <Icon name="info" />
            <span>Not counting resale: the cards keep a market value after the limit is reached.</span>
          </p>
        </>
      )}
    </>
  );
}

/** "Good to know": the season, an estimated limit, a team pass, teammates, boosters, second-hand, rarity. */
function notesFor(market: PassMarket, rung: PassRung, markets: readonly PassMarket[], rules: OtdRules): string[] {
  const out: string[] = [];
  out.push(
    market.season_state === "current"
      ? "Season in progress: its live games pay now; the games already played pay again on their anniversaries."
      : "Past season: pays on the anniversaries of its game days; its figures are final.",
  );
  if (rung.limit_estimated && rung.limit !== null) {
    out.push(
      `Real doesn't state a limit for ${sportLabel(market.sport)} passes; ${big(rung.limit)} is ${rules.player_limit_per_mult} × the multiplier, an estimate.`,
    );
  }
  if (market.kind === "team") out.push("Team passes need far more rating than a player pass, and team rating has no traded price yet.");
  const mates = teammatesOf(market, markets);
  if (mates.length) {
    out.push(
      `${shortName(market.player_name)} and ${mates.map((m) => shortName(m.player_name)).join(" and ")} play on the same days: holding both fills the same ${rules.claims_per_sport_day} claims.`,
    );
  }
  out.push("Boosters don't change what a pass pays on anniversaries.");
  if (market.season_state === "past") {
    out.push("A whole pass bought second-hand may have used part of its limit; the app doesn't say how much.");
  }
  out.push("Rarity raises pay per game day, not how long the pass lasts.");
  return out;
}
