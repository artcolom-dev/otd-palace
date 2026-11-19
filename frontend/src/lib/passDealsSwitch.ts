/**
 * Whether "Pass deals" shows at all (advisor/rules.py PASS_DEALS_ON, kept equal by tests/test_copy_parity.py). Off since
 * 2026-11-18: a pass's usual rate rests on one rating bucket picked by whichever card ends first, and the shelf holds
 * auctions' opening prices, so "for less than usual" could not be trusted. The maths now reads the feed's build rate
 * and the live auctions' firm pays (lib/passDeals.ts); it stays off until the feed sends them and they are checked live.
 */
export const PASS_DEALS_ON = false;
/** The switch the block reads: PASS_DEALS_ON on the site; tests turn it on to check the block itself. */
export const passDealsSwitch = { on: PASS_DEALS_ON };
