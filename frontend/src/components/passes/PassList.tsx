// "Best passes": the ranked list with its sport tabs, season and build filters, sort and what the filters hide; a
// table on desktop, rows on a phone. Each row opens its pass.
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useApp } from "../../AppContext";
import {
  about,
  big,
  budgetText,
  hiddenText,
  metaText,
  monthShortWord,
  monthsText,
  monthsWords,
  paybackWord,
  spanText,
  tierName,
  titleText,
  x1,
  paysLaterText,
  THIN_LINE,
  buildToMeta,
  outLead,
  outWhy,
} from "../../content/passWords";
import {
  PASS_SORTS,
  type PassListState,
  type PassRow,
  type PassSeason,
  type PassSort,
  passSports,
  saleFor,
} from "../../data/passList";
import { buildToSwitch, buildToTier } from "../../lib/buildToSwitch";
import { cls } from "../../lib/cls";
import { formatRax } from "../../lib/format";
import { rovingIndex } from "../../lib/keys";
import { DUR, EASE_OUT, flipFrom, measureTops, play, stagger } from "../../lib/motion";
import { buildRate } from "../../lib/passRates";
import { dayOf, monthsToLimit, paysLater } from "../../lib/passes";
import { sportLabel } from "../../lib/words";
import type { PassUi } from "../../views/passState";
import { EmptyState, type EmptyAction } from "../EmptyState";
import { Icon } from "../Icon";
import { InfoTip } from "../InfoTip";
import { useOverlay } from "../Overlay";
import { BuildToStrip } from "./BuildToStrip";
import { PassGlossary } from "./Panels";
import { useOpenPass } from "./PassCard";
import { PassFace, PassTags, Rarity, useRarity } from "./bits";

type SetUi = (patch: Partial<PassUi>) => void;

const SEASONS: [PassSeason, string, string][] = [
  ["all", "All seasons", "All"],
  ["past", "Past", "Past"],
  ["current", "Current", "Current"],
];

/**
 * "All", then each sport with passes and how many rows it holds; a sport with none under these filters is left out
 * unless it is the one chosen. "All" carries no number: the list holds at most the best few of each sport, so its
 * total says nothing about the budget. One tab stop, the arrows move along.
 */
function SportTabs({ counts, ui, setUi }: { counts: PassListState["counts"]; ui: PassUi; setUi: SetUi }) {
  const { snap, layout } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const tabs = [
    { key: "all", label: "All" },
    ...passSports(snap)
      .filter((s) => (counts[s] ?? 0) > 0 || ui.sport === s)
      .map((s) => ({ key: s, label: sportLabel(s) })),
  ];
  const current = Math.max(0, tabs.findIndex((t) => t.key === ui.sport));
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = tabs.findIndex((t) => t.key === (e.target as HTMLElement).dataset.sport);
    const i = rovingIndex(e.key, from < 0 ? current : from, tabs.length, "horizontal");
    if (i === null) return;
    e.preventDefault();
    setUi({ sport: tabs[i]!.key });
    ref.current?.querySelector<HTMLElement>(`[data-sport="${tabs[i]!.key}"]`)?.focus();
  };
  return (
    <div ref={ref} className={layout.phone ? "chips" : "tabs"} role="tablist" aria-label="Filter by sport" onKeyDown={onKeyDown}>
      {tabs.map((t, i) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          data-sport={t.key}
          aria-selected={ui.sport === t.key}
          tabIndex={i === current ? 0 : -1}
          onClick={() => setUi({ sport: t.key })}
        >
          {t.label}
          {t.key !== "all" && <span>{formatRax(counts[t.key] ?? 0)}</span>}
        </button>
      ))}
    </div>
  );
}

/** "Sort Best return ▾": a menu on desktop, a sheet of choices on a phone. */
function SortButton({ ui, setUi }: { ui: PassUi; setUi: SetUi }) {
  const { layout } = useApp();
  const overlay = useOverlay();
  const keys = Object.keys(PASS_SORTS) as PassSort[];
  return (
    <button
      type="button"
      className={layout.phone ? "sortbtn sort" : "sortbtn"}
      aria-haspopup={layout.phone ? "dialog" : "menu"}
      onClick={(e) =>
        overlay.open({
          title: "Sort passes",
          anchor: e.currentTarget,
          size: "narrow",
          body: ({ titleId, close, phone }) => (
            <div
              className={phone ? "opts" : "menu"}
              role={phone ? "radiogroup" : "menu"}
              aria-labelledby={titleId}
              onKeyDown={(ev) => {
                if (phone) return;
                const items = Array.from(ev.currentTarget.querySelectorAll<HTMLElement>("[role=menuitemradio]"));
                const i = rovingIndex(ev.key, items.indexOf(ev.target as HTMLElement), items.length, "vertical");
                if (i === null) return;
                ev.preventDefault();
                items[i]?.focus();
              }}
            >
              {keys.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={phone ? "opt" : undefined}
                  role={phone ? "radio" : "menuitemradio"}
                  aria-checked={ui.sort === key}
                  tabIndex={phone || ui.sort === key ? undefined : -1}
                  data-autofocus={ui.sort === key ? "" : undefined}
                  onClick={() => {
                    setUi({ sort: key });
                    close();
                  }}
                >
                  {PASS_SORTS[key]}
                  <Icon name="check" />
                </button>
              ))}
            </div>
          ),
        })
      }
    >
      <span>Sort</span>
      <b>{PASS_SORTS[ui.sort]}</b>
      <Icon name="chev" />
    </button>
  );
}

/** A filter that is on or off, drawn as a check box. */
function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="tgl" aria-pressed={on} onClick={onClick}>
      <span className="bx">
        <Icon name="check" />
      </span>
      {children}
    </button>
  );
}

function SeasonGroup({ ui, setUi }: { ui: PassUi; setUi: SetUi }) {
  const { layout } = useApp();
  return (
    <div className="mini" role="group" aria-label="Season">
      {SEASONS.map(([key, desk, phone]) => (
        <button key={key} type="button" aria-pressed={ui.season === key} onClick={() => setUi({ season: key })}>
          <span>{layout.phone ? phone : desk}</span>
        </button>
      ))}
    </div>
  );
}

const sub = (row: PassRow, plain: boolean, today: string) => {
  const { market: m, rung: r } = row;
  if (!plain) return metaText(m).replace(" · team", "");
  const pb = paybackWord(r, today);
  return pb ? `About ${about(r.year_rax)} Rax a year · pays back by end of ${pb}` : "Never pays back at today's prices.";
};

/** One pass in the desktop table: its columns by level. */
/** What the visitor holds of a row's pass: theirs at this rung or higher, or the lower rung its price lifts from. */
function OwnLine({ row, as: Tag }: { row: PassRow; as: "small" | "span" }) {
  if (!row.owned && !row.held) return null;
  return (
    <Tag className={Tag === "span" ? "ln own" : "own"}>
      {row.owned ? `You own this at ${tierName(row.owned)}` : `You hold ${tierName(row.held!)}: the price is the lift`}
    </Tag>
  );
}

/**
 * Build to (lib/buildToSwitch.ts, while on): a pass priced on a thin rate says it is less certain; a pass set apart at
 * the rarity says why. Nothing while the switch is off.
 */
function BuildLines({ row, as: Tag }: { row: PassRow; as: "small" | "span" }) {
  const { snap, prefs } = useApp();
  if (!buildToSwitch.on) return null;
  const thin = !row.owned && row.rung.cost !== null && buildRate(row.market).thin;
  const line = Tag === "span" ? "ln " : "";
  return (
    <>
      {row.why && (
        <Tag className={`${line}outwhy`}>{outWhy(row.why, prefs.passBudget, snap.rules.otd.payback_horizon_years)}</Tag>
      )}
      {thin && <Tag className={`${line}lesscertain`}>{THIN_LINE}</Tag>}
    </>
  );
}

function DeskRow({ row, open }: { row: PassRow; open: (row: PassRow, el: HTMLElement) => void }) {
  const { snap, prefs } = useApp();
  const rar = useRarity();
  const { market: m, rung: r, kind } = row;
  const level = prefs.level;
  const rules = snap.rules.otd;
  const today = dayOf(snap.otd.as_of);
  const sale = level === "pro" && r.cost !== null ? saleFor(m, r, rules) : null;
  const ttl = level === "regular" && r.limit !== null && !r.limit_estimated ? monthsToLimit(m, r, rules, today) : null;
  const pb = paybackWord(r, today);
  const later = paysLater(m, rules, today);
  return (
    <div className={cls("grid", "tr", kind === "never" && "never")} role="row" data-key={m.key}>
      <div className="c-pl" role="cell">
        <button
          type="button"
          className="rl"
          aria-label={`Open the ${titleText(m)} pass`}
          onClick={(e) => open(row, e.currentTarget)}
        />
        <PassFace market={m} rarity={rar(m.kind, r.tier)} />
        <div className="pltx">
          <span className="nm">
            <span className="nmt">{m.player_name}</span>
            {level === "new" && <PassTags market={m} rung={r} />}
          </span>
          <small>{sub(row, level === "new" && kind === "row", today)}</small>
          {later && <small className="later">{paysLaterText(later)}</small>}
          <OwnLine row={row} as="small" />
          <BuildLines row={row} as="small" />
        </div>
      </div>
      <span role="cell">
        <Rarity kind={m.kind} tier={r.tier} />
      </span>
      {r.cost === null ? (
        <div className="cell" role="cell">
          <b className="dim">—</b>
          <small>unknown</small>
        </div>
      ) : (
        <div className="cell" role="cell">
          <b>{about(r.cost)}</b>
          <small>{r.route === "mint" ? "mint" : `${big(r.rating_to_add)} rating`}</small>
        </div>
      )}
      {level === "pro" &&
        (sale === null ? (
          <div className="cell" role="cell">
            <b className="dim">—</b>
          </div>
        ) : (
          <div className="cell" role="cell">
            <b>{r.route === "mint" ? "—" : big(sale.on_sale_cost)}</b>
            <small>
              {r.route === "mint"
                ? "no cards"
                : sale.enough
                  ? `all ${big(r.rating_to_add)}`
                  : `${big(sale.on_sale_rating)} of ${big(r.rating_to_add)}`}
              {r.route !== "mint" && sale.firm === false ? " · opening" : ""}
            </small>
          </div>
        ))}
      {level !== "new" && (
        <div className="cell" role="cell">
          <b>{about(r.year_rax)}</b>
          <small>
            {r.projected
              ? "projection"
              : level === "pro"
                ? `${r.per_game_day === null ? "—" : formatRax(Math.round(r.per_game_day))}/game day`
                : m.game_days === null
                  ? "game days unknown"
                  : `${Math.round(m.game_days)} game days`}
          </small>
        </div>
      )}
      {kind === "never" ? (
        <div className="cell" role="cell">
          <b className="neg">Never</b>
          <small>limit &lt; cost</small>
        </div>
      ) : r.pays_back === null ? (
        <div className="cell" role="cell">
          <b className="dim">—</b>
          <small>unknown</small>
        </div>
      ) : !pb || r.payback_months === null || !r.payback_month ? (
        <div className="cell" role="cell">
          <b className="neg">Never</b>
          <small>at today's prices</small>
        </div>
      ) : level === "new" ? (
        <div className="cell" role="cell">
          <b>{pb}</b>
          <small>in {monthsWords(r.payback_months)}</small>
        </div>
      ) : (
        <div className="cell" role="cell">
          <b>{monthsText(r.payback_months)} mo</b>
          <small>{monthShortWord(r.payback_month, today)}</small>
        </div>
      )}
      {level !== "new" &&
        (r.limit === null ? (
          <div className="cell" role="cell">
            <b>none</b>
            <small>{rules.no_limit_horizon_years} yr count</small>
          </div>
        ) : r.limit === 0 ? (
          <div className="cell" role="cell">
            <b>—</b>
            <small>live only</small>
          </div>
        ) : (
          <div className="cell" role="cell">
            <b>{big(r.limit)}</b>
            <small>{r.limit_estimated ? "estimated" : ttl !== null ? `in ${spanText(ttl)}` : ""}</small>
          </div>
        ))}
      {level === "pro" && (
        <span className="r c-ltc" role="cell">
          {r.lifetime_per_rax === null ? <span className="dim">—</span> : <b>{x1(r.lifetime_per_rax)}×</b>}
        </span>
      )}
      <span className="chev" role="cell">
        <Icon name="chev" />
      </span>
    </div>
  );
}

/** One pass on a phone: name, rarity and sport, cost and pay, and when it pays back on the right. */
function PhoneRow({ row, open }: { row: PassRow; open: (row: PassRow, el: HTMLElement) => void }) {
  const { snap, prefs } = useApp();
  const rar = useRarity();
  const { market: m, rung: r, kind } = row;
  const level = prefs.level;
  const rules = snap.rules.otd;
  const today = dayOf(snap.otd.as_of);
  const pb = paybackWord(r, today);
  const later = paysLater(m, rules, today);
  const sale = level === "pro" && r.cost !== null && r.route !== "mint" ? saleFor(m, r, rules) : null;
  const limit =
    r.limit === null ? "no limit" : r.limit === 0 ? "live games only" : `limit ${big(r.limit)}${r.limit_estimated ? " (est.)" : ""}`;
  return (
    <li className={cls("prow", "pass", kind === "never" && "never")} data-key={m.key}>
      <button
        type="button"
        className="rl"
        aria-label={`Open the ${titleText(m)} pass, ${tierName(r.tier)}`}
        onClick={(e) => open(row, e.currentTarget)}
      />
      <PassFace market={m} rarity={rar(m.kind, r.tier)} />
      <span className="nm">
        <span className="nmt">{m.player_name}</span>
        <PassTags market={m} rung={r} />
      </span>
      <span className="ln">
        {/* The season stays whole ("NBA 2024-25"): a narrow phone breaks the line before it, never at its hyphen. */}
        <Rarity
          kind={m.kind}
          tier={r.tier}
          suffix={
            <>
              {" · "}
              <span className="season">
                {sportLabel(m.sport)} {m.season_label}
              </span>
              {m.kind === "team" ? " · team" : ""}
            </>
          }
        />
      </span>
      <span className="ln">
        {r.cost === null ? (
          <>price unknown · about {about(r.year_rax)} a year</>
        ) : (
          <>
            {level === "new" ? "about " : ""}
            <b>{about(r.cost)}</b> to build · <b>{about(r.year_rax)}</b>
            {"\u00a0a\u00a0year" /* a narrow phone wraps "12,400 a year" whole */}
            {r.projected && level !== "new" ? " (projection)" : ""}
          </>
        )}
      </span>
      {later && <span className="ln later">{paysLaterText(later)}</span>}
      <OwnLine row={row} as="span" />
      <BuildLines row={row} as="span" />
      {level !== "new" && (
        <span className="ln">
          {limit}
          {r.lifetime_per_rax !== null && level === "pro" ? ` · ${x1(r.lifetime_per_rax)}×` : ""}
          {sale ? ` · ${sale.firm === false ? "auctions open at" : "on sale"} ${big(sale.on_sale_cost)}` : ""}
        </span>
      )}
      <span className="pc">
        {kind === "never" || r.pays_back === false ? (
          <>
            <b className="neg">Never</b>
            <small>pays back</small>
          </>
        ) : r.pays_back === null || !pb || r.payback_months === null || !r.payback_month ? (
          <>
            <b className="dim">—</b>
            <small>pays back</small>
          </>
        ) : level === "new" ? (
          <>
            <small>pays back by end of</small>
            <b>{pb}</b>
          </>
        ) : (
          <>
            <b>{monthsText(r.payback_months)} mo</b>
            <small>{monthShortWord(r.payback_month, today)}</small>
          </>
        )}
      </span>
    </li>
  );
}

/** A header of a group of rows in the table: never-paying passes, team passes. */
function Group({ icon, title, note, term }: { icon: "warn" | "team"; title: string; note: string; term: "never" | "team" }) {
  const { layout } = useApp();
  if (layout.phone) {
    return (
      <div className="tgroup">
        <Icon name={icon} />
        {title}
        <small>· {note}</small>
        <InfoTip term={term} />
      </div>
    );
  }
  return (
    <div className="tgroup" role="row">
      <span className="tgc" role="cell">
        <Icon name={icon} />
        {title}
        <small>· {note}</small>
        <InfoTip term={term} />
      </span>
    </div>
  );
}

/** Rows that moved slide to their new places (FLIP) when the filters change; new ones fade up. */
function useListMotion(keys: string) {
  const ref = useRef<HTMLDivElement & HTMLUListElement>(null);
  const tops = useRef<Map<string, number> | null>(null);
  const last = useRef(keys);
  const rows = () => Array.from(ref.current?.querySelectorAll<HTMLElement>("[data-key]") ?? []);
  if (last.current !== keys && ref.current) tops.current = measureTops(rows(), (el) => el.dataset.key ?? "");
  useLayoutEffect(() => {
    if (last.current === keys) return;
    last.current = keys;
    const before = tops.current;
    tops.current = null;
    if (!before) return;
    const els = rows();
    flipFrom(before, els, (el) => el.dataset.key ?? "");
    let n = 0;
    for (const el of els) {
      if (before.has(el.dataset.key ?? "")) continue;
      play(el, [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], {
        duration: DUR.slow,
        easing: EASE_OUT,
        delay: stagger(n++, 24),
        fill: "backwards",
      });
    }
  }, [keys]);
  return ref;
}

/** Why the list is empty, most specific reason first, with the change that would fill it. */
function useEmptyReason(state: PassListState, ui: PassUi, setUi: SetUi): { message: ReactNode; actions: EmptyAction[] } {
  const { snap, prefs, setPrefs, setLevel, query, setQuery } = useApp();
  if (query && !snap.otd.markets.some((m) => m.player_name.toLowerCase().includes(query.trim().toLowerCase()))) {
    return { message: <b>No pass for “{query}” in today's list.</b>, actions: [{ label: "Clear search", run: () => setQuery("") }] };
  }
  if (state.hidden.notSoon) {
    return {
      message: (
        <>
          <b>None of these has enough rating on sale today.</b> Time to gather the rest needs live sales data.
        </>
      ),
      actions: [{ label: "Show them anyway", run: () => setUi({ soon: false }) }],
    };
  }
  if (state.hidden.slow) {
    const n = state.hidden.slow;
    return {
      message: (
        <>
          <b>
            {n} pass{n > 1 ? "es take" : " takes"} more than a year to pay back:
          </b>{" "}
          New hides {n > 1 ? "them" : "it"}.
        </>
      ),
      actions: [{ label: "Switch to Regular", run: () => setLevel("regular") }],
    };
  }
  const tier = buildToTier(prefs.buildTo);
  if (tier && state.out?.length) {
    return {
      message: <b>No pass here pays back at {tierName(tier)}.</b>,
      actions: [{ label: "Best for each", run: () => setPrefs({ buildTo: null }) }],
    };
  }
  if (state.hidden.over) {
    const presets = snap.rules.otd.budget_presets;
    const next = presets.find((p) => p === null || (prefs.passBudget !== null && p > prefs.passBudget));
    return {
      message: <b>Nothing here pays back within {budgetText(prefs.passBudget)}.</b>,
      actions:
        next === undefined
          ? []
          : [{ label: next === null ? "Show any budget" : `Show up to ${big(next)}`, run: () => setPrefs({ passBudget: next }) }],
    };
  }
  return {
    message: <b>No pass in this sport and season right now.</b>,
    actions: ui.sport === "all" && ui.season === "all" ? [] : [{ label: "Show every pass", run: () => setUi({ sport: "all", season: "all" }) }],
  };
}

/** A phone shows this many passes, then this many more at each tap: 90 rows were a scroll of 8,000 px that hid
 * everything under them. */
export const PHONE_PASS_PAGE = 20;

/** How many of the phone list's passes are shown, back to one page whenever the sport, season, filter or sort changes. */
function usePhonePage(ui: PassUi, tier: string | null): [shown: number, more: () => void] {
  const key = `${ui.sport}|${ui.season}|${ui.soon}|${ui.sort}|${tier ?? ""}`;
  const [page, setPage] = useState({ key, shown: PHONE_PASS_PAGE });
  const shown = page.key === key ? page.shown : PHONE_PASS_PAGE;
  return [shown, () => setPage({ key, shown: shown + PHONE_PASS_PAGE })];
}

export function PassListSection({ state, ui, setUi }: { state: PassListState; ui: PassUi; setUi: SetUi }) {
  const { snap, prefs, layout } = useApp();
  const overlay = useOverlay();
  const openPass = useOpenPass();
  const open = (row: PassRow, el: HTMLElement) => openPass(row.market, row.rung.tier, el);
  const all = [...state.rows, ...(ui.showAll ? state.never : []), ...state.teams];
  const motion = useListMotion(all.map((r) => r.market.key).join("|"));
  const hidden = hiddenText(state.hidden, ui.showAll);
  const empty = useEmptyReason(state, ui, setUi);
  const level = prefs.level;
  const tier = buildToTier(prefs.buildTo);
  const [shown, showMore] = usePhonePage(ui, tier);
  // A fixed id, not useId: the page keeps the ids it had before Build to (one list per page).
  const outId = "passes-out";
  const [outOpen, setOutOpen] = useState<string | null>(null); // the tier whose set-apart passes are shown
  const out = tier ? (state.out ?? []) : [];
  const showOut = tier !== null && outOpen === tier;
  const phoneRef = useRef<HTMLElement>(null);
  const focusFrom = useRef<number | null>(null);
  // After "Show more", the focus goes to the first pass it revealed: the button may be gone, and that is where to read on.
  useLayoutEffect(() => {
    const from = focusFrom.current;
    focusFrom.current = null;
    if (from === null) return;
    phoneRef.current?.querySelectorAll<HTMLElement>(".plist.best > li > .rl")[from]?.focus();
  }, [shown]);

  if (layout.phone) {
    const left = state.rows.length - shown;
    return (
      <section ref={phoneRef} className="psec passes" aria-labelledby="passes-h">
        <div className="sh">
          <h2 id="passes-h">Best passes</h2>
          {!tier && <SortButton ui={ui} setUi={setUi} />}
        </div>
        <p className="dmeta">
          <b>{formatRax(state.rows.length)}</b> {state.rows.length === 1 ? "pass" : "passes"} ·{" "}
          {tier ? buildToMeta(snap.rules.otd.top, tier) : <>the {snap.rules.otd.top} best per sport, soonest paid back first</>}
        </p>
        <SportTabs counts={state.counts} ui={ui} setUi={setUi} />
        {buildToSwitch.on && <BuildToStrip />}
        <div className="frow">
          <SeasonGroup ui={ui} setUi={setUi} />
          <Toggle on={ui.soon} onClick={() => setUi({ soon: !ui.soon })}>
            Can be built within 3 weeks
          </Toggle>
        </div>
        <ul ref={motion} className="plist best" aria-label="Best passes">
          {state.rows.slice(0, shown).map((row) => (
            <PhoneRow key={row.market.key} row={row} open={open} />
          ))}
        </ul>
        {left > 0 && (
          <div className="pmore">
            <button
              type="button"
              className="btn"
              onClick={() => {
                focusFrom.current = shown;
                showMore();
              }}
            >
              {left > PHONE_PASS_PAGE ? (
                <>
                  Show {formatRax(PHONE_PASS_PAGE)} more
                  <small>{formatRax(left)} left</small>
                </>
              ) : (
                `Show the last ${formatRax(left)}`
              )}
            </button>
          </div>
        )}
        {state.rows.length === 0 && <EmptyState message={empty.message} actions={empty.actions} />}
        {tier && out.length > 0 && (
          <>
            <div className="hidrow outrow">
              <p>{outLead(out.length, tier)}</p>
              <button
                type="button"
                className="lnk plain"
                aria-expanded={showOut}
                aria-controls={outId}
                onClick={() => setOutOpen(showOut ? null : tier)}
              >
                {showOut ? "Hide them" : `Show ${formatRax(out.length)} more`}
              </button>
            </div>
            {showOut && (
              <ul id={outId} className="plist" aria-label={`Not at ${tierName(tier)}`}>
                {out.map((row) => (
                  <PhoneRow key={row.market.key} row={row} open={open} />
                ))}
              </ul>
            )}
          </>
        )}
        {ui.showAll && state.never.length > 0 && (
          <>
            <Group icon="warn" title="Never pays back" note="its lifetime limit is less than its cost" term="never" />
            <ul className="plist" aria-label="Never pays back">
              {state.never.map((row) => (
                <PhoneRow key={row.market.key} row={row} open={open} />
              ))}
            </ul>
          </>
        )}
        {(hidden || state.never.length > 0) && (
          <div className="hidrow">
            <p>{hidden}</p>
            {state.never.length > 0 && (
              <button type="button" className="lnk plain" aria-pressed={ui.showAll} onClick={() => setUi({ showAll: !ui.showAll })}>
                Show all
              </button>
            )}
          </div>
        )}
        {state.teams.length > 0 && (
          <>
            <Group icon="team" title="Team passes" note="team pass rating price unknown" term="team" />
            <ul className="plist" aria-label="Team passes">
              {state.teams.map((row) => (
                <PhoneRow key={row.market.key} row={row} open={open} />
              ))}
            </ul>
          </>
        )}
      </section>
    );
  }

  const head = (label: string, className: string, sortKey?: PassSort, ascending = false) => {
    if (!sortKey || tier) {
      return (
        <span className={className} role="columnheader">
          {label}
        </span>
      );
    }
    const on = ui.sort === sortKey;
    return (
      <span className={className} role="columnheader" aria-sort={on ? (ascending ? "ascending" : "descending") : "none"}>
        <button type="button" className={cls("hs", on && "on")} onClick={() => setUi({ sort: sortKey })}>
          {label}
          {on && <Icon name={ascending ? "sortup" : "sortdn"} />}
        </button>
      </span>
    );
  };

  return (
    <section className="deals passes" aria-labelledby="passes-h">
      <div className="dhead">
        <h2 id="passes-h">Best passes</h2>
        <SportTabs counts={state.counts} ui={ui} setUi={setUi} />
        {!tier && <SortButton ui={ui} setUi={setUi} />}
      </div>
      {buildToSwitch.on && <BuildToStrip />}
      <div className="frow">
        <SeasonGroup ui={ui} setUi={setUi} />
        <Toggle on={ui.soon} onClick={() => setUi({ soon: !ui.soon })}>
          Can be built within 3 weeks
        </Toggle>
        <InfoTip term="soon" />
        <span className="sp1" />
        {hidden && <span className="hid">{hidden}</span>}
        {!tier && (
          <Toggle on={ui.showAll} onClick={() => setUi({ showAll: !ui.showAll })}>
            Show all
          </Toggle>
        )}
      </div>
      <div ref={motion} className={cls("tbl", "ptbl", `lvl-${level}`)} role="table" aria-label="Best passes">
        <div className="grid thead" role="row">
          {head("Player", "c-pl")}
          {head(tier ? "Rarity" : "Best rarity", "")}
          {head("Cost", "r", "cheap", true)}
          {level === "pro" && head("On sale now", "r")}
          {level !== "new" && head("Rax a year", "r", "year")}
          {head("Pays back", "r", "soon", true)}
          {level !== "new" && head("Limit", "r")}
          {level === "pro" && head("Limit ÷ cost", "r c-ltc")}
          <span role="columnheader">
            <span className="sr">Open</span>
          </span>
        </div>
        <div role="rowgroup">
          {state.rows.map((row) => (
            <DeskRow key={row.market.key} row={row} open={open} />
          ))}
        </div>
        {tier && out.length > 0 && (
          <div role="rowgroup" id={outId} aria-label={`Not at ${tierName(tier)}`}>
            <div className="tgroup outrow" role="row">
              <span className="tgc" role="cell">
                <Icon name="warn" />
                {outLead(out.length, tier)}
                <button
                  type="button"
                  className="lnk plain"
                  aria-expanded={showOut}
                  aria-controls={outId}
                  onClick={() => setOutOpen(showOut ? null : tier)}
                >
                  {showOut ? "Hide them" : `Show ${formatRax(out.length)} more`}
                </button>
              </span>
            </div>
            {showOut && out.map((row) => <DeskRow key={row.market.key} row={row} open={open} />)}
          </div>
        )}
        {ui.showAll && state.never.length > 0 && (
          <div role="rowgroup">
            <Group icon="warn" title="Never pays back" note="its lifetime limit is less than its cost" term="never" />
            {state.never.map((row) => (
              <DeskRow key={row.market.key} row={row} open={open} />
            ))}
          </div>
        )}
        {state.teams.length > 0 && (
          <div role="rowgroup">
            <Group icon="team" title="Team passes" note="team pass rating price unknown" term="team" />
            {state.teams.map((row) => (
              <DeskRow key={row.market.key} row={row} open={open} />
            ))}
          </div>
        )}
      </div>
      {state.rows.length === 0 && <EmptyState message={empty.message} actions={empty.actions} />}
      <div className="tfoot">
        <p>
          Rax a year counts each pass on its own. Real pays 2 passes per sport a day, so My passes shows what one adds to
          yours. Costs use the typical price per rating point.
        </p>
        <button
          type="button"
          className="lnk"
          onClick={(e) =>
            overlay.open({
              title: "What the words mean",
              anchor: e.currentTarget,
              size: "wide",
              body: () => <PassGlossary level={level} />,
            })
          }
        >
          <Icon name="info" />
          What the words mean
        </button>
      </div>
    </section>
  );
}
