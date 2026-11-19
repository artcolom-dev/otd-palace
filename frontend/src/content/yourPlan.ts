// The words of "Your plan", in one place. The account types and their lines are in content/accountTypes.ts; the steps
// for a visitor who has not started, or just did, are the earn guide's own (content/earn.ts: Real's rules and the
// research notes, medium confidence and up). Nothing here is a claim the notes do not make: a General pays nothing
// On This Day, a Common or a Legendary is the best rung, a sale costs 10 % and a 10 Rax listing fee, MLB's labour deal
// ends 1 December 2026 with a lockout possible. English, short, plain: the reader may never have played.

export const PLAN_TITLE = "Your plan";
export const WHERE_TITLE = "Where are you with Real?";

export type ChoiceKey = "start" | "new" | "link";

export const CHOICES: readonly { key: ChoiceKey; title: string; sub: string }[] = [
  { key: "start", title: "I haven't started", sub: "No passes yet. Show me the first steps." },
  { key: "new", title: "I just started", sub: "I have a few passes. What now?" },
  { key: "link", title: "I have passes: link my account", sub: "Read my account and show my plan." },
];

/** What a pass is, for a reader who never played: one line under the first steps. */
export const WHAT_IS_A_PASS =
  "A pass pays you Rax, Real's currency, every day one of its player's games was played on that date. That is On This Day.";

/** Facts to keep in mind on the way up: passes before flips, offers, fees, and the MLB lockout. */
export const KEEP_IN_MIND: readonly string[] = [
  "Offers under the usual price are the cheapest way to build a pass: most are refused, so send many on many cards.",
  "Selling a card costs 10% plus a 10 Rax listing fee. Small flips rarely pay, so put your Rax in passes first.",
  "MLB's labour deal ends on 1 December 2026 and a lockout is possible. A 2027 MLB pass would wait; past-season MLB passes still pay.",
];

export const LINKED_NOTE_HAND = "Counted from the passes you added by hand. Link your account to read all of them.";
export const NO_MOVES = "Nothing that pays back fits right now. A bigger pass budget shows more.";
export const TOP_TYPE = "You are in the top group. What matters now is collecting every day.";
export const FIRST_PASS = (next: string) => `Your first paying pass makes you a ${next}.`;
