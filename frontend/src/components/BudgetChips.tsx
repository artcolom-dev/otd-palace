import { useId } from "react";
import { useApp } from "../AppContext";
import { visibleDeals } from "../data/deals";
import { formatRax } from "../lib/format";
import { onRadioKeys, radioStop } from "../lib/keys";
import { plural } from "../lib/words";
import { Icon } from "./Icon";
import { useOverlay } from "./Overlay";

/** "≤200"; null is any price. */
export const budgetLabel = (budget: number | null, any = "Any") => (budget === null ? any : `≤${formatRax(budget)}`);

/** The budgets in one tap, from the served presets: a segmented row in the sidebar. */
export function BudgetChips() {
  const { snap, prefs, setPrefs } = useApp();
  const labelId = useId();
  return (
    <>
      <span className="lbl" id={labelId}>
        Max price per card<span>Rax</span>
      </span>
      <div className="seg four" role="group" aria-labelledby={labelId}>
        {snap.rules.budget_presets.map((preset) => (
          <button
            key={preset ?? "any"}
            type="button"
            aria-pressed={prefs.budget === preset}
            onClick={() => setPrefs({ budget: preset })}
          >
            {budgetLabel(preset)}
          </button>
        ))}
      </div>
    </>
  );
}

/** On a phone: one chip that opens the budgets as a sheet, each with how many deals it would show. */
export function BudgetChip() {
  const { snap, prefs, setPrefs, follows, now } = useApp();
  const overlay = useOverlay();
  return (
    <button
      type="button"
      className="chip"
      aria-haspopup="dialog"
      onClick={(e) =>
        overlay.open({
          title: "Max price per card",
          anchor: e.currentTarget,
          body: ({ close }) => (
            <div className="opts" role="radiogroup" aria-label="Max price per card" onKeyDown={onRadioKeys}>
              {snap.rules.budget_presets.map((preset, i) => {
                const n = visibleDeals(snap, { ...prefs, budget: preset, sport: "all", rarity: null }, follows, now).length;
                return (
                  <button
                    key={preset ?? "any"}
                    type="button"
                    className="opt"
                    role="radio"
                    aria-checked={prefs.budget === preset}
                    tabIndex={radioStop(snap.rules.budget_presets.indexOf(prefs.budget), i)}
                    onClick={() => {
                      setPrefs({ budget: preset });
                      close();
                    }}
                  >
                    <span>
                      {budgetLabel(preset, "Any price")}
                      <small>{plural(n, "deal", "deals")} at your level</small>
                    </span>
                    <Icon name="check" />
                  </button>
                );
              })}
            </div>
          ),
        })
      }
    >
      Max <b>{budgetLabel(prefs.budget)}</b>
      <Icon name="chev" />
    </button>
  );
}

/** The Passes tab's budget: the most to spend on one pass, in one tap (≤1,000 / ≤5,000 / ≤20,000 / Any). */
export function PassBudgetChips() {
  const { snap, prefs, setPrefs } = useApp();
  const labelId = useId();
  return (
    <>
      <span className="lbl" id={labelId}>
        Max to spend per pass<span>Rax</span>
      </span>
      <div className="seg four pseg" role="group" aria-labelledby={labelId}>
        {snap.rules.otd.budget_presets.map((preset) => (
          <button
            key={preset ?? "any"}
            type="button"
            aria-pressed={prefs.passBudget === preset}
            onClick={() => setPrefs({ passBudget: preset })}
          >
            {budgetLabel(preset)}
          </button>
        ))}
      </div>
    </>
  );
}

/** On a phone, on the Passes tab: one chip that opens the pass budgets as a sheet. */
export function PassBudgetChip() {
  const { snap, prefs, setPrefs } = useApp();
  const overlay = useOverlay();
  return (
    <button
      type="button"
      className="chip"
      aria-haspopup="dialog"
      onClick={(e) =>
        overlay.open({
          title: "Max to spend per pass",
          anchor: e.currentTarget,
          body: ({ close }) => (
            <div className="opts" role="radiogroup" aria-label="Max to spend per pass" onKeyDown={onRadioKeys}>
              {snap.rules.otd.budget_presets.map((preset, i) => (
                <button
                  key={preset ?? "any"}
                  type="button"
                  className="opt"
                  role="radio"
                  aria-checked={prefs.passBudget === preset}
                  tabIndex={radioStop(snap.rules.otd.budget_presets.indexOf(prefs.passBudget), i)}
                  onClick={() => {
                    setPrefs({ passBudget: preset });
                    close();
                  }}
                >
                  <span>{budgetLabel(preset, "Any budget")}</span>
                  <Icon name="check" />
                </button>
              ))}
            </div>
          ),
        })
      }
    >
      Max <b>{budgetLabel(prefs.passBudget)}</b>
      <Icon name="chev" />
    </button>
  );
}
