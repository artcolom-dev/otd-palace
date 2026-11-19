/**
 * Whether a price move's row on Prices draws its curve (advisor/rules.py PRICE_CURVE_ON, kept equal by
 * tests/test_copy_parity.py). Off, the server sends no curve and the page draws none: Prices is what it was before.
 */
export const PRICE_CURVE_ON = true;
/** The switch the page reads: PRICE_CURVE_ON on the site; tests turn it off to check Prices without the curve. */
export const priceCurveSwitch = { on: PRICE_CURVE_ON };
/** How far back a curve goes, in days (advisor/rules.py PRICE_CURVE_DAYS): an older point is not the server's. */
export const PRICE_CURVE_DAYS = 30;
/** A curve is drawn from this many points, today's included (advisor/rules.py PRICE_CURVE_MIN_POINTS). */
export const PRICE_CURVE_MIN_POINTS = 3;
