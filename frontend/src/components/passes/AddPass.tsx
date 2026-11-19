// "Add a pass you own", in three steps: the player (or team), the season, then how far it is built (a rarity or the
// exact rating its cards add up to) and whether the app says it is maxed. Kept on this device only.
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import { useApp } from "../../AppContext";
import { seasonText, tierName, titleText } from "../../content/passWords";
import { local } from "../../data/local";
import type { PassMarket } from "../../data/types";
import { servedMarkets } from "../../lib/dealPass";
import { rovingIndex } from "../../lib/keys";
import { tierAt } from "../../lib/passes";
import { foldName, sportLabel } from "../../lib/words";
import { Icon } from "../Icon";
import { type OverlaySpec, useOverlay } from "../Overlay";
import { PassFace, Swatch } from "./bits";
import { setPassUi } from "../../views/passState";

const FLOW = "add-pass";
const MAX_RESULTS = 7;

interface Who {
  name: string;
  markets: PassMarket[]; // newest season first
}

/** The players and teams whose name holds what was typed, each with its seasons. */
function find(markets: readonly PassMarket[], query: string): Who[] {
  const q = foldName(query.trim());
  const groups = new Map<string, Who>();
  for (const m of markets) {
    if (q && !foldName(m.player_name).includes(q)) continue;
    const id = `${m.sport}:${m.kind}:${m.player_id}`;
    const group = groups.get(id) ?? { name: m.player_name, markets: [] };
    group.markets.push(m);
    groups.set(id, group);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, markets: [...g.markets].sort((a, b) => b.season - a.season) }))
    .slice(0, MAX_RESULTS);
}

/** Focuses the step's first control when it appears (a new step replaces the last one in the same overlay). */
function useStepFocus() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
  }, []);
  return ref;
}

/** Opens the flow: at its first step, or (from a pass's card) straight at "how far is it built?". */
export function useAddPass() {
  const overlay = useOverlay();
  const { snap, layout } = useApp();
  return (anchor: HTMLElement | null, key?: string) => {
    const steps = {
      find: (): OverlaySpec => ({
        title: "Add a pass you own",
        anchor,
        size: "wide",
        flow: FLOW,
        body: () => <Find onPick={(who) => overlay.open(steps.season(who))} />,
      }),
      season: (who: Who): OverlaySpec => ({
        title: `${who.name}: which season?`,
        anchor,
        size: "wide",
        flow: FLOW,
        body: () => (
          <Season who={who} onBack={() => overlay.open(steps.find())} onPick={(m) => overlay.open(steps.built(m, who))} />
        ),
      }),
      built: (market: PassMarket, who: Who | null): OverlaySpec => ({
        title: `${titleText(market)}: how far is it built?`,
        anchor,
        size: "wide",
        flow: FLOW,
        body: () => (
          <Built
            market={market}
            onBack={() => overlay.open(who ? steps.season(who) : steps.find())}
            onDone={(added) => {
              overlay.closeAll();
              setPassUi({ mineOpen: true, flash: added, ...(layout.phone ? { view: "mine" } : {}) });
            }}
          />
        ),
      }),
    };
    const market = key ? servedMarkets(snap.otd).find((m) => m.key === key) : undefined;
    overlay.open(market ? steps.built(market, null) : steps.find());
  };
}

function Find({ onPick }: { onPick: (who: Who) => void }) {
  const { snap } = useApp();
  const [q, setQ] = useState("");
  const ref = useStepFocus();
  const found = find(servedMarkets(snap.otd), q); // this season's passes too: a pass owned is matched, never suggested
  return (
    <div ref={ref} className="addp">
      <label className="fld">
        <Icon name="search" />
        <input
          type="search"
          aria-label="Player or team" name="add-pass-search"
          placeholder="Player or team"
          autoComplete="off"
          data-autofocus=""
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </label>
      <div className="menu picks">
        {found.length ? (
          found.map((who) => (
            <button key={who.markets[0]!.key} type="button" onClick={() => onPick(who)}>
              <PassFace market={who.markets[0]!} rarity="ring" size={28} />
              <span>
                {who.name}{" "}
                <small>
                  {sportLabel(who.markets[0]!.sport)}
                  {who.markets[0]!.kind === "team" ? " team" : ""} · {who.markets.length} season
                  {who.markets.length > 1 ? "s" : ""}
                </small>
              </span>
              <Icon name="arrow" />
            </button>
          ))
        ) : (
          <p className="poptx">No player called “{q}” in today's data.</p>
        )}
      </div>
      <p className="steps">Step 1 of 3 · kept on this device only</p>
    </div>
  );
}

function Season({ who, onBack, onPick }: { who: Who; onBack: () => void; onPick: (m: PassMarket) => void }) {
  const ref = useStepFocus();
  return (
    <div ref={ref} className="addp">
      <button type="button" className="lnk back" onClick={onBack}>
        <Icon name="back" />
        Back
      </button>
      <div className="menu picks">
        {who.markets.map((m, i) => (
          <button key={m.key} type="button" data-autofocus={i === 0 ? "" : undefined} onClick={() => onPick(m)}>
            <span>
              {m.season_label} <small>{seasonText(m)}</small>
            </span>
            <Icon name="arrow" />
          </button>
        ))}
      </div>
      <p className="steps">Step 2 of 3</p>
    </div>
  );
}

function Built({ market, onBack, onDone }: { market: PassMarket; onBack: () => void; onDone: (key: string) => void }) {
  const { snap } = useApp();
  const rules = snap.rules.otd;
  const ladder = rules.ladders[market.kind] ?? [];
  const had = local.get().passes.find((h) => h.key === market.key);
  const [mode, setMode] = useState<"tier" | "rating">(had?.rating !== undefined ? "rating" : "tier");
  const [tier, setTier] = useState<string | null>(had?.tier ?? null);
  const [rating, setRating] = useState(had?.rating !== undefined ? String(had.rating) : "");
  const [spent, setSpent] = useState(had?.spent === true);
  const ref = useStepFocus();
  const n = Number.parseInt(rating, 10);
  const reached = Number.isFinite(n) && n >= 0 ? tierAt(market.kind, n, rules).tier : null;
  const ok = mode === "tier" ? tier !== null : reached !== null;

  const commit = () => {
    if (!ok) return;
    local.addPass({
      key: market.key,
      ...(mode === "tier" ? { tier: tier! } : { rating: n }),
      ...(spent ? { spent: true } : {}),
    });
    onDone(market.key);
  };
  const onTierKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = ladder.findIndex(([t]) => t === (tier ?? ladder[0]?.[0]));
    const i = rovingIndex(e.key, at, ladder.length);
    if (i === null) return;
    e.preventDefault();
    const next = ladder[i]![0];
    setTier(next);
    e.currentTarget.querySelector<HTMLElement>(`[data-tier="${next}"]`)?.focus();
  };
  const focusTier = tier ?? ladder[0]?.[0];

  return (
    <div ref={ref} className="addp">
      <button type="button" className="lnk back" onClick={onBack}>
        <Icon name="back" />
        Back
      </button>
      <div className="mini full" role="group" aria-label="Rarity or exact rating">
        <button type="button" aria-pressed={mode === "tier"} onClick={() => setMode("tier")}>
          <span>Rarity</span>
        </button>
        <button type="button" aria-pressed={mode === "rating"} onClick={() => setMode("rating")}>
          <span>Exact rating</span>
        </button>
      </div>
      {mode === "tier" ? (
        <div className="tiers" role="radiogroup" aria-label="Rarity" onKeyDown={onTierKey}>
          {ladder.map(([t]) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={tier === t}
              tabIndex={t === focusTier ? 0 : -1}
              data-tier={t}
              data-autofocus={t === focusTier ? "" : undefined}
              onClick={() => setTier(t)}
            >
              <Swatch kind={market.kind} tier={t} />
              {tierName(t)}
            </button>
          ))}
        </div>
      ) : (
        <div className="rate-in">
          <input
            type="number"
            min={0}
            inputMode="numeric"
            placeholder="212"
            aria-label="Rating on this pass" name="add-pass-rating"
            data-autofocus=""
            value={rating}
            onChange={(e) => setRating(e.target.value)}
          />
          <span aria-live="polite">
            {reached ? (
              <>
                = <Swatch kind={market.kind} tier={reached} /> <b>{tierName(reached)}</b>
              </>
            ) : (
              "rating on this pass"
            )}
          </span>
        </div>
      )}
      <button type="button" className="chk" role="checkbox" aria-checked={spent} onClick={() => setSpent(!spent)}>
        <span className="bx">
          <Icon name="check" />
        </span>
        The app says it's maxed (pays nothing)
      </button>
      <button type="button" className="btn fill" aria-disabled={!ok} onClick={commit}>
        {had ? "Update my pass" : "Add to my passes"}
      </button>
      <p className="steps">Step 3 of 3 · kept on this device only</p>
    </div>
  );
}
