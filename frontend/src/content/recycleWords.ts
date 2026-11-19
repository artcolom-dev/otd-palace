// How the screens say Recycle (lib/recycle.ts): the passes done paying, what their cards would sell for and what to do
// instead. Every figure is an estimate and is said as one; nothing is promised.
// Listing cards and offers need Real Pro (Real's docs: "Pro accounts and other very active accounts can list"), said
// wherever a selling route shows; buying needs none, so a lift needs none.
// Quick Sell needs no Real Pro: Real pays at once, about 1 Rax a rating point (rules.quicksell_per_point, measured), about
// an eighth of what cards sell for. Said as instant and Pro-free but far below a sale, and never as the advice while a
// lift reopens the pass (lib/recycle.ts quickAdvice).
import type { LevelKey } from "../data/prefs";
import { formatRax } from "../lib/format";
import { type DeadPass, type RecycleDealLine, type RecyclePlan, type Reopen, shownLift } from "../lib/recycle";
import { about, aboutN, spanText, tierName, titleText } from "./passWords";

export const RECYCLE_TITLE = "Passes done paying";
/** The one fact behind every selling route. */
export const PRO_TO_LIST = "Listing cards for sale in Real needs Real Pro (Real also lets some very active accounts list).";
export const PRO_BOX = "I have Real Pro";
/** Under the box: what the site assumes, and why. */
export const PRO_ASSUMED = "We can't see Real Pro on an account, so we go by this box.";
export const NO_PRO_NEEDED = "No Real Pro needed.";
/** In a full pass's row, when the line under it says why and shows the lift that reopens it: one short word, so the
 * pass's name keeps its width in the narrow side column (as the Deals rows say "your full … pass"). */
export const FULL_MARK = "full";

/** Quick Sell against a sale, as measured (advisor/rules.py QUICKSELL_MARKET_SHARE, 0.13; tests/test_copy_parity.py). */
export const QUICK_PART = "about an eighth";
const QUICK_BELOW = `${QUICK_PART} of what cards usually sell for`;
/** What listing would bring, beside a Quick Sell: the measured share makes "several times more" firm. No figure: ours
 * would rest on the pass's usual rate per point, which can be several times off today. */
const LISTED_MORE = "several times more";

const passes = (n: number) => `${formatRax(n)} pass${n === 1 ? "" : "es"}`;

/** Why a pass is done paying, in a line. */
export function whyText(d: DeadPass, level: LevelKey): string {
  if (d.why === "full") {
    if (level === "new" || d.cap === null) return "It has earned its limit, so Real stopped its On This Day pay.";
    return `Earned ${formatRax(Math.round(d.earned))} of its ${formatRax(d.cap)} limit, live pay included.`;
  }
  if (d.why === "maxed") return "You marked it maxed: it pays nothing more.";
  if (level === "new") return "Your other passes take its sport's daily claims, so it hardly ever pays.";
  return `Wins few claims: about ${about(d.gets)} a year now (estimate).`;
}

/** How the lift is bought: the deal, the cards on sale now when cheaper, or the typical price. */
function liftHow(l: Reopen): string {
  if (l.deal) return `with one card on the Deals list (${formatRax(l.deal.price)} Rax)`;
  if (l.shelf !== null && l.shelf < l.cost) return `for about ${about(l.shelf)} Rax of cards on sale now`;
  return `for about ${about(l.cost)} Rax`;
}

/** The lift that reopens a full pass. `earned`: all the pass has earned against its limit. */
export function liftText(l: Reopen, earned: number, level: LevelKey): string {
  const to = tierName(l.tier);
  const short = l.affordable === false ? " More than the balance you typed." : "";
  if (level === "pro") {
    const room =
      l.reopens === null || l.limit === null
        ? `${to} has no limit`
        : `limit ${formatRax(l.limit)} − ${formatRax(Math.round(earned))} earned = ${formatRax(l.reopens)}`;
    const back = l.payback_months === null ? "" : ` · back in ${spanText(l.payback_months)}`;
    return `Lift to ${to}: +${formatRax(aboutN(l.rating_to_add))} rating ≈ ${about(l.best)} Rax · ${room} · +${about(l.extra_year)} a year${back}.${short}`;
  }
  if (level === "new") {
    const more = l.reopens === null ? "with no limit" : `up to about ${about(l.reopens)} more`;
    return `Lift it to ${to} ${liftHow(l)} and it pays again, ${more}. ${NO_PRO_NEEDED}${short}`;
  }
  const room = l.reopens === null ? "no limit after it" : `reopens about ${about(l.reopens)} of limit`;
  return `Lift to ${to} ${liftHow(l)}: ${room}, adds about ${about(l.extra_year)} a year (estimate). ${NO_PRO_NEEDED}${short}`;
}

/** What the pass's cards would sell for. Null without a price. */
export function sellText(d: DeadPass, level: LevelKey): string | null {
  const v = d.value;
  if (!v) return null;
  const thin = v.thin ? " Few recent trades: a rough price." : "";
  const cut = `Real's ${Math.round(v.fee * 100)}%`;
  if (level === "pro") {
    return `Sell: ${formatRax(Math.round(v.rating))} rating × ${v.rate.toFixed(1)} = ${formatRax(Math.round(v.gross))}, less ${cut} ≈ ${about(v.net)} Rax, before ${formatRax(v.listing_fee)} Rax a listed card.${thin}`;
  }
  if (level === "new") return `Its cards would sell for about ${about(v.net)} Rax (estimate).${thin}`;
  return `Its cards: about ${about(v.net)} Rax if sold, after ${cut} (estimate).${thin}`;
}

/**
 * What Real's Quick Sell would pay for a done pass's cards, for a visitor without Real Pro, worded by its advice
 * (lib/recycle.ts quickAdvice). `liftShown`: the line above shows the lift. Null without a Quick Sell figure.
 */
export function quickText(d: DeadPass, level: LevelKey, liftShown: boolean): string | null {
  const q = d.quick;
  if (!q) return null;
  const rax = `about ${about(q.rax)} Rax`;
  const formula = `${formatRax(Math.round(q.rating))} rating × ${q.per_point} ≈ ${about(q.rax)} Rax`;
  if (q.advice === "keep") {
    if (level === "new") return `Keep it: it still pays a little, more in a year than its cards would bring by Quick Sell (${rax}).`;
    return `Keep it: about ${about(d.gets)} a year (estimate) still beats a Quick Sell of its cards (${rax}).`;
  }
  if (q.advice === "lift") {
    if (!liftShown && d.lift) {
      return `Quick Sell would bring only ${rax} for its cards. Before you sell: a lift to ${tierName(d.lift.tier)} for about ${about(d.lift.best)} Rax would make it pay again, and selling the cards ends that.`;
    }
    if (level === "pro") return `Quick Sell: ${formula}, and it ends the lift; a lifted pass's cards can still be sold later.`;
    if (level === "new") return `Quick Sell would bring only ${rax}, and it ends the lift. Lift first: you keep the cards.`;
    return `Quick Sell instead: only ${rax}, and it ends the lift.`;
  }
  const listed = q.listed !== null && q.listed > 0 ? q.listed : null;
  if (level === "pro") {
    const head = `Quick Sell: ${formula} now, no Real Pro needed; ${QUICK_BELOW}.`;
    return listed === null ? head : `${head} Listed with Real Pro, they usually bring ${LISTED_MORE}.`;
  }
  if (level === "new") {
    const vs = listed === null ? "" : ` Listed with Real Pro, they might bring ${LISTED_MORE}.`;
    return `Quick Sell its cards now for ${rax}: instant, and no Real Pro needed. But it pays far less, ${QUICK_BELOW}.${vs}`;
  }
  const vs = listed === null ? "" : `: listed with Real Pro, they might bring ${LISTED_MORE}`;
  return `Quick Sell: ${rax} for its cards, at once, no Real Pro needed (about ${q.per_point} Rax a rating point). That is ${QUICK_BELOW}${vs}.`;
}

/** With Real Pro, one note under the summary: Quick Sell exists and pays far less. Null without the rule. */
export function quickNote(plan: RecyclePlan): string | null {
  const pt = plan.quickPerPoint;
  if (pt === null) return null;
  return `Real's Quick Sell is instant and needs no Real Pro, but it pays about ${pt} Rax a rating point, ${QUICK_BELOW}: listing usually brings more.`;
}

/** Where that Rax could go: the pass it builds, or that it is not enough yet. */
export function targetText(d: DeadPass): string | null {
  if (!d.value) return null;
  const t = d.target;
  if (!t) return "Not enough on its own for a pass that pays back.";
  return `Enough for ${titleText(t.market)} at ${tierName(t.rung.tier)} (about ${about(t.rung.cost)} Rax), which pays about ${about(t.rung.year_rax)} a year.`;
}

/** The line on top of the list. */
export function summaryText(plan: RecyclePlan): string {
  const n = plan.dead.length;
  const head = `${passes(n)} ${n === 1 ? "is" : "are"} done paying.`;
  const lifts = plan.dead.filter((d) => shownLift(d, plan.pro) !== null).length; // the lifts the lines below show
  const liftLine = lifts > 0 ? ` A lift reopens ${lifts === n ? (n === 1 ? "it" : "them") : `${formatRax(lifts)} of them`}. ${NO_PRO_NEEDED}` : "";
  if (!plan.pro) {
    const q = plan.quick;
    const whose = q.passes === n ? `${n === 1 ? "its" : "their"} cards` : `the cards of ${passes(q.passes)}`;
    const quick = q.passes > 0 && q.rax > 0 ? ` Quick Sell would bring about ${about(q.rax)} Rax for ${whose} now, with no Real Pro, but that is ${QUICK_BELOW}.` : "";
    const sell =
      quick && q.listed !== null && q.listed > 0
        ? ` With Real Pro, listing them might bring ${LISTED_MORE}.`
        : plan.sellable > 0
          ? ` With Real Pro, ${n === 1 ? "its" : "their"} cards could also be sold for a pass that pays.`
          : "";
    return `${head}${liftLine}${quick}${sell}`;
  }
  if (plan.value <= 0) return `${head}${liftLine}`;
  const worth = `${n === 1 ? "Its" : "Their"} cards would sell for about ${about(plan.value)} Rax (estimate).`;
  const route = plan.route;
  if (route && route.picks.length > 0) {
    const first = route.picks[0]!;
    const k = route.picks.length - 1;
    const more = k > 0 ? ` and ${formatRax(k)} more` : "";
    const which = k > 0 ? "which together should pay" : "which should pay";
    return `${head} ${worth} Sold, that could build ${titleText(first.market)} at ${tierName(first.rung.tier)}${more}, ${which} about ${about(route.year)} Rax a year.${liftLine}`;
  }
  const cheapest = route?.cheapest ?? null;
  const short = cheapest !== null && cheapest > plan.value ? `: the cheapest costs about ${about(cheapest)}` : "";
  return `${head} ${worth} Not enough yet for a pass that pays back${short}.${liftLine}`;
}

/** A deal row's line (lib/recycle.ts recycleForDeal). */
export function recycleDealText(line: RecycleDealLine, level: LevelKey): string {
  const to = tierName(line.tier);
  if (level === "new") return `This card makes your full ${line.title} pass pay again (it lifts it to ${to}).`;
  const room = line.reopens === null ? "no limit after it" : `reopens about ${about(line.reopens)} of limit`;
  return `Lifts your full ${line.title} pass to ${to}: ${room}.`;
}
