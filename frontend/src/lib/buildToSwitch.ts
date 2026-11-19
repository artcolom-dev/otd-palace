import { RARITIES } from "../content/real";
import { isBuildTo } from "../data/prefs";

/**
 * Whether the Passes tab offers "Build to" a rarity (advisor/rules.py BUILD_TO_ON, kept equal by
 * tests/test_copy_parity.py). Off, the tab is byte for byte what it was before the mode (views/PassesView.off.test.tsx).
 * It stays off until the feed's build rates cover most passes and the mode is checked live.
 */
export const BUILD_TO_ON = false;
/** The switch the tab reads: BUILD_TO_ON on the site; tests turn it on to check the mode itself. */
export const buildToSwitch = { on: BUILD_TO_ON };

/** The tier a list is built to: the device's choice (prefs.buildTo, Common 1 to Iconic 7) while the switch is on;
 * null for Best for each, and always null while it is off. */
export function buildToTier(buildTo: unknown): string | null {
  return buildToSwitch.on && isBuildTo(buildTo) ? RARITIES[buildTo]!.key : null;
}
