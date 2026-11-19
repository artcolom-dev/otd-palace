// "12-month plan": a year of adding the best pass the Rax in hand can reach, month by month (lib/snowball.ts), as a
// line of what the passes owned could pay a year and a small drawn chart (no library). Today's prices, an estimate.
// Behind "Show as a table": the plan's first steps in plain words, and the table for anyone who cannot see the chart.
import { useDeferredValue, useId, useMemo } from "react";
import { useApp } from "../../AppContext";
import { about, tierName, titleText } from "../../content/passWords";
import { useLocal } from "../../data/local";
import { useHeldMarkets } from "../../hooks/useHeldMarkets";
import { parseBudget } from "../../data/prefs";
import { useBalance } from "../../hooks/useBalance";
import { cls } from "../../lib/cls";
import { formatRax } from "../../lib/format";
import { dayOf } from "../../lib/passes";
import { type Snowball as Plan, type SnowballPoint, snowball } from "../../lib/snowball";

const W = 320;
const H = 160;
const PAD = { l: 48, r: 12, t: 26, b: 36 };
const STEPS_SHOWN = 5;

/** A round number at or above `max`: 1, 2 or 5 times a power of ten. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}

/** The chart's path: a step line, since a pass starts paying the month it is added. */
export function chartPath(series: readonly SnowballPoint[], top: number): string {
  const x = (m: number) => PAD.l + ((W - PAD.l - PAD.r) * m) / 12;
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / top);
  let d = `M${x(0).toFixed(1)} ${y(series[0]?.year ?? 0).toFixed(1)}`;
  for (let i = 1; i < series.length; i++) {
    const p = series[i]!;
    d += ` H${x(p.month).toFixed(1)} V${y(p.year).toFixed(1)}`;
  }
  return d;
}

function Chart({ plan, label }: { plan: Plan; label: string }) {
  const top = niceMax(Math.max(...plan.series.map((p) => p.year)));
  const x = (m: number) => PAD.l + ((W - PAD.l - PAD.r) * m) / 12;
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / top);
  const area = `${chartPath(plan.series, top)} V${y(0)} H${x(0)} Z`;
  return (
    <svg className="snw-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} focusable="false">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line className="snw-grid" x1={PAD.l} x2={W - PAD.r} y1={y(top * f)} y2={y(top * f)} />
          <text className="snw-tick" x={PAD.l - 6} y={y(top * f) + 4} textAnchor="end">
            {formatRax(top * f)}
          </text>
        </g>
      ))}
      <path className="snw-area" d={area} />
      <path className="snw-line" d={chartPath(plan.series, top)} />
      {plan.steps.map((s, i) => (
        <circle key={i} className="snw-dot" cx={x(s.after)} cy={y(plan.series[s.after]?.year ?? 0)} r="3.5">
          <title>{`${s.after === 0 ? "Now" : `Month ${s.after}`}: add ${titleText(s.market)} ${tierName(s.tier)}`}</title>
        </circle>
      ))}
      {[0, 3, 6, 9, 12].map((m) => (
        <text key={m} className="snw-tick" x={x(m)} y={H - PAD.b + 15} textAnchor="middle">
          {m === 0 ? "Now" : m}
        </text>
      ))}
      <text className="snw-axis" x={(PAD.l + W - PAD.r) / 2} y={H - 4} textAnchor="middle">
        Months from now
      </text>
      <text className="snw-axis" x={0} y={10} textAnchor="start">
        Rax a year
      </text>
    </svg>
  );
}

const when = (after: number) => (after === 0 ? "Now" : `Month ${after}`);

export function SnowballCard() {
  const { snap, prefs, layout } = useApp();
  const { passes } = useLocal();
  const held = useHeldMarkets();
  const id = useId();
  const { text, balance, onChange } = useBalance();
  const typed = useDeferredValue(balance);
  const plan = useMemo(
    () =>
      snowball({
        balance: typed ?? 0,
        holdings: passes,
        markets: held,
        rules: snap.rules.otd,
        sports: snap.otd.sports,
        today: dayOf(snap.otd.as_of),
      }),
    [held, snap.otd.as_of, snap.otd.sports, snap.rules.otd, passes, typed],
  );
  const visible = prefs.level !== "new" || passes.length > 0;
  if (!visible || snap.otd.markets.length === 0) return null;
  const empty = plan.steps.length === 0 && plan.start === 0;
  const label = `Rax a year the passes pay over the next 12 months: ${about(plan.start)} now, about ${about(plan.end)} at the end (estimate)`;
  return (
    <section className={cls(layout.phone ? "pnl" : "panel", "snw")} aria-labelledby={`${id}h`}>
      <div className="ph">
        <h2 id={`${id}h`}>12-month plan</h2>
      </div>
      <p className="pnote">Add the best pass your Rax can reach, each month</p>
      <label className="bbf snw-field" htmlFor={`${id}b`}>
        <input
          id={`${id}b`}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          placeholder="840"
          aria-label="Rax you have now"
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
        <span aria-hidden="true">Rax now</span>
      </label>
      {text.trim() !== "" && parseBudget(text) === null && <p className="bbhint">Type a whole number of Rax, like 840.</p>}
      {empty ? (
        <p className="bbhint">
          {balance === null ? "Type the Rax you have to see a plan." : "That is not enough for a pass that pays back yet."}
        </p>
      ) : (
        <div className="snw-res">
          <p className="bbsay" data-testid="snowball-say">
            In 12 months your passes could pay about <b>{about(plan.end)}</b> Rax a year, up from {about(plan.start)} now
            (estimate).
          </p>
          <Chart plan={plan} label={label} />
          {/* The month-by-month steps sit behind the table's disclosure: on this page "Your next Rax" (or the cheapest way
              to start) already says what to add now, and a screen says it once. */}
          <details className="snw-tab">
            <summary>Show as a table</summary>
            {plan.steps.length > 0 && (
              <ol className="snw-steps" aria-label="Steps">
                {plan.steps.slice(0, STEPS_SHOWN).map((s, i) => (
                  <li key={i}>
                    <b>{when(s.after)}:</b> add {titleText(s.market)} {tierName(s.tier)} for {about(s.cost)}, adds about{" "}
                    {about(s.gain)} a year
                  </li>
                ))}
                {plan.steps.length > STEPS_SHOWN && (
                  <li className="snw-more">and {plan.steps.length - STEPS_SHOWN} more steps (see the table)</li>
                )}
              </ol>
            )}
            <table>
              <caption className="sr">The plan month by month</caption>
              <thead>
                <tr>
                  <th scope="col">Month</th>
                  <th scope="col">Passes pay a year</th>
                  <th scope="col">Rax in hand</th>
                </tr>
              </thead>
              <tbody>
                {plan.series.map((p) => (
                  <tr key={p.month}>
                    <th scope="row">{p.month === 0 ? "Now" : p.month}</th>
                    <td>{about(p.year)}</td>
                    <td>{about(p.cash)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      )}
      <p className="nrx-foot">
        Uses today's prices, no price changes. An estimate, not a promise: it is one simple order, not the only one.
      </p>
    </section>
  );
}
