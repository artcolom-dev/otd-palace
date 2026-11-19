/**
 * Whether a deal says, to a member at the Pro level, what accepted offers on cards like it went for
 * (lib/dealOffer.ts; advisor/rules.py OFFER_HINT_ON, kept equal by tests/test_copy_parity.py). Off, every deal row
 * reads exactly as before the hint.
 */
export const OFFER_HINT_ON = true;
/** The switch the rows read: OFFER_HINT_ON on the site; tests turn it off to check the rows without the hint. */
export const offerHintSwitch = { on: OFFER_HINT_ON };
