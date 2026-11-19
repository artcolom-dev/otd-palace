// The passes this device holds: how full each sport's 2 claims a day are, the list itself, and what they pay
// together. Device-only: the passes are never sent anywhere (an import sends only the username it looks up).
import { type ReactNode, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../AppContext";
import { rarityLabel } from "../../content/real";
import { FULL_MARK } from "../../content/recycleWords";
import {
  IDLE_MARK,
  about,
  emptySportsLine,
  mateLines,
  noRoomWords,
  sportFillLine,
  spentWords,
  titleText,
} from "../../content/passWords";
import { local, useLocal } from "../../data/local";
import { passSports } from "../../data/passList";
import { useRealPro, useRecyclePlan } from "../../hooks/useRecycle";
import { cls } from "../../lib/cls";
import { formatRax } from "../../lib/format";
import { DUR, EASE_OUT, play } from "../../lib/motion";
import { type HeldPass, type Plan, type SportPlan, idlePasses } from "../../lib/passes";
import { shownLift } from "../../lib/recycle";
import { sportLabel } from "../../lib/words";
import { setPassUi, usePassPlan } from "../../views/passState";
import { Icon } from "../Icon";
import { InfoTip } from "../InfoTip";
import { MemberContext } from "../MemberLine";
import { Meter } from "../Meter";
import { ProfileLink } from "../ProfileCard";
import { useAddPass } from "./AddPass";
import { FollowMyBest } from "./FollowMyBest";
import { ImportPasses } from "./ImportPasses";
import { ShareMyPasses } from "./ShareMyPasses";
import { RecycleLine, RecycleSummary } from "./Recycle";
import { PassFace } from "./bits";

const passesWord = (n: number) => `${formatRax(n)} pass${n === 1 ? "" : "es"}`;

/** Where the passes live: on this device, or with a member's Discord once linked (they follow them anywhere). */
function useWhere(): string {
  const member = useContext(MemberContext);
  const { link } = useLocal();
  return member && link ? "Linked to your Discord" : "On this device only";
}

/** The total's element: when the figure changes it rolls in from below and glows in the accent for a moment (a fade
 * alone with reduced motion). The text is always the true figure. */
function useRollIn(value: number) {
  const ref = useRef<HTMLElement>(null);
  const last = useRef(value);
  const [hot, setHot] = useState(false);
  useEffect(() => {
    if (last.current === value) return;
    last.current = value;
    play(ref.current, [{ opacity: 0, transform: "translateY(40%)" }, { opacity: 1, transform: "none" }], {
      duration: DUR.glide,
      easing: EASE_OUT,
    });
    setHot(true);
    const cool = window.setTimeout(() => setHot(false), 1100);
    return () => window.clearTimeout(cool);
  }, [value]);
  return [ref, hot] as const;
}

/** "Your passes pay about 25,000 Rax a year": the sidebar's line on desktop, the top of My passes on a phone. */
export function PassTotal({ className, children }: { className: string; children?: ReactNode }) {
  const { plan } = usePassPlan();
  const { passes } = useLocal();
  const total = Math.round(plan.total);
  const [ref, hot] = useRollIn(total);
  const n = passes.length;
  return (
    <section className={className} aria-label="What your passes pay">
      <p>Your passes pay about</p>
      <strong ref={ref} className={cls(hot && "hot")} data-testid="passes-total">
        {about(total)}
      </strong>
      <small>{n ? `Rax a year · estimate · ${passesWord(n)} on this device` : "Add the passes you own to see this"}</small>
      {children}
    </section>
  );
}

/** One sport's fill bar: the share of its claims the passes held win, through the CSSOM. */
function FillBar({ fill, label }: { fill: number; label: string }) {
  return <Meter className="fillb" value={fill} label={label} tone="quiet" size="s" />;
}

export function SportBlock({ x }: { x: SportPlan }) {
  const { snap, prefs } = useApp();
  const rules = snap.rules.otd;
  const pct = Math.round(x.fill * 100);
  const name = sportLabel(x.sport);
  const mates = mateLines(x.mates);
  return (
    <div className="spb" data-sport={x.sport}>
      <div className="sph">
        <b>{name}</b>
        <span>{passesWord(x.n)}</span>
        {prefs.level !== "new" && <span className="pc">{pct}% of claims</span>}
      </div>
      <FillBar fill={x.fill} label={`${pct}% of ${name} claims used`} />
      <p>{sportFillLine(x.sport, x.n, x.fill, rules.full_at)}</p>
      {mates.lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {mates.more > 0 && (
        <p className="mmore">
          and {mates.more} more {mates.more === 1 ? "group" : "groups"} of teammates on the same days
        </p>
      )}
      {prefs.level === "pro" && (
        <p className="math">
          {rules.claims_per_sport_day} claims × <span>{formatRax(x.claim_days)}</span> game days ={" "}
          <span>{formatRax(x.slots)}</span> a year · your passes pay on <span>{formatRax(x.pay_days)}</span> days between
          them · <span>{formatRax(x.used)}</span> get claimed
        </p>
      )}
    </div>
  );
}

/** How full each sport is, then the sports with passes and none held. */
function SportBlocks({ plan }: { plan: Plan }) {
  const { snap } = useApp();
  const { passes } = useLocal();
  const order = passSports(snap);
  const held = order.filter((s) => plan.sports[s]);
  const empty = order.filter((s) => !plan.sports[s] && snap.otd.markets.some((m) => m.sport === s && m.kind !== "team"));
  if (!passes.length) {
    return (
      <div className="spb">
        <p>
          <b>No passes on this device yet.</b> Add the ones you own to see how full each sport is.
        </p>
      </div>
    );
  }
  return (
    <>
      {held.map((s) => (
        <SportBlock key={s} x={plan.sports[s]!} />
      ))}
      {empty.length > 0 && (
        <div className="spb empty-s">
          <p>{emptySportsLine(empty, snap.rules.otd.claims_per_sport_day)}</p>
        </div>
      )}
    </>
  );
}

/** "Epic · 212 rating", or the rarity alone; its sub-level as Real writes it ("Legendary 3") when the link brought it. */
const heldText = (p: HeldPass) => {
  const rung = rarityLabel(p.tier, p.holding.label);
  return p.holding.rating !== undefined ? `${rung} · ${formatRax(p.holding.rating)} rating` : rung;
};

/** The rows a held list shows at first, and adds at each "Show more": a big account holds thousands. */
export const HELD_PAGE = 60;

/** The passes held, one row each with what it pays inside its sport, and a button to remove it. */
function HeldList({ plan, flash }: { plan: Plan; flash: string | null }) {
  const { snap, notify } = useApp();
  const { passes } = useLocal();
  const ref = useRef<HTMLUListElement>(null);
  const [shown, setShown] = useState(HELD_PAGE);
  const [pinned, setPinned] = useState<readonly string[]>([]); // passes added during this visit, shown wherever they sit
  const remove = (key: string, title: string) => {
    const removed = local.removePass(key);
    if (removed) notify({ text: `Removed ${title}`, undo: () => local.restorePass(removed) });
  };
  const rar = (p: HeldPass) => `rar-${Math.max(0, (snap.rules.otd.ladders[p.market.kind] ?? []).findIndex(([t]) => t === p.tier))}`;
  const known = new Set(plan.held.map((p) => p.market.key));
  const lost = passes.filter((h) => !known.has(h.key));
  const idle = useMemo(() => new Set(idlePasses(plan).map((x) => x.pass.market.key)), [plan]);
  const recycle = useRecyclePlan();
  const pro = useRealPro();
  const dead = useMemo(() => new Map(recycle.dead.map((d) => [d.key, d])), [recycle]);
  const rows = plan.held.length + lost.length;
  // The first `shown` rows, and the passes just added wherever they sit (at the end, mostly): adding one pass to a
  // 2,000-pass list shows that one, not the 1,940 before it.
  const extra = new Set(flash === null ? pinned : [...pinned, flash]);
  const visible = (key: string, i: number) => i < shown || extra.has(key);
  const heldRows = plan.held.filter((p, i) => visible(p.market.key, i));
  const lostRows = lost.filter((h, i) => visible(h.key, plan.held.length + i));
  const left = rows - heldRows.length - lostRows.length;
  useLayoutEffect(() => {
    if (!flash) return;
    if (!pinned.includes(flash)) setPinned([...pinned, flash]); // stays shown once the mark is gone
    const el = ref.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(flash)}"]`);
    play(
      el,
      [
        { opacity: 0, transform: "scale(0.94)" },
        { opacity: 1, transform: "scale(1.02)", offset: 0.6 },
        { opacity: 1, transform: "none" },
      ],
      { duration: DUR.glide, easing: EASE_OUT },
    );
    el?.classList.add("flashring");
    setPassUi({ flash: null });
  }, [flash]);
  return (
    <>
      <ul ref={ref} className="mlist">
        {heldRows.map((p) => {
          const v = plan.sports[p.market.sport]?.per[p.market.key] ?? 0;
          const title = titleText(p.market);
          const done = dead.get(p.market.key);
          const full = !p.spent && p.limit === 0 && v <= 0;
          // Its line says why it is full and what to do: the lift, or (without Real Pro) Quick Sell when no lift is shown.
          const reopens = full && done !== undefined && (shownLift(done, pro) !== null || (!pro && done.quick !== null));
          return (
            <li key={p.market.key} className={cls("mp", p.spent && "spent")} data-key={p.market.key}>
              <PassFace market={p.market} rarity={rar(p)} size={28} />
              <div>
                <b>{title}</b>
                <small>
                  {heldText(p)}
                  {p.spent ? spentWords(p.tier).tag : ""}
                </small>
                {idle.has(p.market.key) && <small className="idle">{IDLE_MARK}</small>}
              </div>
              <span className={cls("yr", full && !reopens && "room")}>
                {p.spent ? (
                  spentWords(p.tier).pay
                ) : full ? (
                  reopens ? FULL_MARK : noRoomWords(p.cap)
                ) : (
                  <>
                    <b>{about(v)}</b> a year
                  </>
                )}
              </span>
              <button type="button" className="rm" aria-label={`Remove ${title}`} onClick={() => remove(p.market.key, title)}>
                <Icon name="x" />
              </button>
              {done && <RecycleLine d={done} />}
            </li>
          );
        })}
        {lostRows.map((h) => (
          <li key={h.key} className="mp spent" data-key={h.key}>
            <span className="pav s28 ring tint-6" aria-hidden="true" />
            <div>
              <b>A pass not in today's data</b>
              <small>{h.key}</small>
            </div>
            <span className="yr">unknown</span>
            <button type="button" className="rm" aria-label={`Remove ${h.key}`} onClick={() => remove(h.key, "a pass not in today's data")}>
              <Icon name="x" />
            </button>
          </li>
        ))}
      </ul>
      {left > 0 && (
        <div className="mfoot">
          <button type="button" className="lnk" onClick={() => setShown(shown + HELD_PAGE)}>
            Show {formatRax(Math.min(HELD_PAGE, left))} more of {formatRax(rows)}
            <Icon name="chev" />
          </button>
        </div>
      )}
    </>
  );
}

/** Desktop: the right column's "My passes" panel. */
export function MyPassesPanel({ open, flash }: { open: boolean; flash: string | null }) {
  const { plan } = usePassPlan();
  const { passes } = useLocal();
  const addPass = useAddPass();
  const n = passes.length;
  const where = useWhere();
  return (
    <section className="panel mine" aria-labelledby="mine-h">
      <div className="ph">
        <div className="pht">
          <h2 id="mine-h">My passes</h2>
          <InfoTip term="myPasses" />
        </div>
        <button type="button" className="lnk box" aria-label="Add a pass you own" onClick={(e) => addPass(e.currentTarget)}>
          <Icon name="plus" />
          Add
        </button>
      </div>
      <div className="devline">
        <p className="pnote">{n ? `${where} · ${passesWord(n)}` : where}</p>
        <ProfileLink />
      </div>
      <ImportPasses />
      <FollowMyBest />
      <ShareMyPasses />
      <div className="spl">
        <SportBlocks plan={plan} />
      </div>
      <RecycleSummary />
      {n > 0 && open && <HeldList plan={plan} flash={flash} />}
      {n > 0 && (
        <div className="mfoot">
          <button type="button" className="lnk" aria-expanded={open} onClick={() => setPassUi({ mineOpen: !open })}>
            {open ? "Hide" : "Show"} my {passesWord(n)}
            <Icon name="chev" className={open ? "up" : undefined} />
          </button>
        </div>
      )}
    </section>
  );
}

/** Phone: My passes as its own view: the total, how full each sport is, the list. */
export function MyPassesView({ flash }: { flash: string | null }) {
  const { plan } = usePassPlan();
  const { passes } = useLocal();
  const addPass = useAddPass();
  const where = useWhere();
  return (
    <>
      <PassTotal className="sum">
        <button type="button" className="btn fill" onClick={(e) => addPass(e.currentTarget)}>
          <Icon name="plus" />
          Add a pass you own
        </button>
      </PassTotal>
      <div className="devline">
        <p className="pnote">{where}</p>
        <ProfileLink />
      </div>
      <ImportPasses />
      <FollowMyBest />
      <ShareMyPasses />
      <section className="pnl" aria-labelledby="fill-h">
        <div className="sh">
          <h2 id="fill-h">How full each sport is</h2>
          <InfoTip term="myPasses" />
        </div>
        <SportBlocks plan={plan} />
      </section>
      <RecycleSummary className="pnl" />
      {passes.length > 0 && (
        <section className="pnl" aria-labelledby="held-h">
          <h2 id="held-h">On this device</h2>
          <HeldList plan={plan} flash={flash} />
        </section>
      )}
    </>
  );
}
