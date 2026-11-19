// The site tells the server a linked member's yearly figure (what their passes can pay On This Day a year), so their
// Discord account-type role follows it (advisor/discord_perks.py). Cosmetic only: the figure is this browser's own
// say-so, so nothing but a role and a line of text ever reads it. It is sent seldom: after a pause, and only when it
// moved by 5 % or more from what the server holds.

/** The server keeps whole numbers from 0 to this (advisor/account_types.py YEAR_MAX). */
export const YEAR_MAX = 50_000_000;
export const REPORT_MIN_CHANGE = 0.05;
export const REPORT_AFTER_MS = 2500; // let the figure settle (the passes are read in turns) before it is sent

/** Whether `year` is worth telling the server that holds `held` (null: it holds none yet). */
export function worthReporting(held: number | null, year: number): boolean {
  if (!Number.isFinite(year) || year < 0 || year > YEAR_MAX) return false;
  const next = Math.round(year);
  if (held === null) return true;
  if (held === next) return false;
  if (held === 0) return next > 0;
  return Math.abs(next - held) / held >= REPORT_MIN_CHANGE - 1e-12;
}
