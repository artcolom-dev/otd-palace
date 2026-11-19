// "Build to" on Passes (lib/buildToSwitch.ts): the deals' rarity chips (RarityChips), "Best for each" first, then Real's
// rarities from Common to Iconic in Real's colours. A pick prices every pass at that rarity (data/passList.ts
// buildToList) and is kept with the other prefs on this device. A visitor gets it too, over the free passes: every
// figure it shows is a rung the free snapshot already carries for them.
import { useApp } from "../../AppContext";
import { BUILD_TO_BEST } from "../../content/passWords";
import { RARITIES } from "../../content/real";
import { isBuildTo } from "../../data/prefs";
import { track } from "../../lib/activity";
import { RarityChips, type RarityChip } from "../RarityStrip";

const CHIPS: readonly RarityChip[] = [
  { key: null, name: BUILD_TO_BEST, label: BUILD_TO_BEST },
  ...RARITIES.slice(1).map((r, i) => ({ key: i + 1, name: r.name, label: r.name })),
];

export function BuildToStrip() {
  const { prefs, setPrefs } = useApp();
  const picked = isBuildTo(prefs.buildTo) ? prefs.buildTo : null;
  return (
    <div className="rstrip bstrip">
      <span className="rlead" aria-hidden="true">
        Build to
      </span>
      <RarityChips
        label="Build to"
        chips={CHIPS}
        picked={picked}
        onChoose={(key) => {
          track("filter", key === null ? "buildto-best" : `buildto-${RARITIES[key]!.key}`);
          setPrefs({ buildTo: key });
        }}
      />
    </div>
  );
}
