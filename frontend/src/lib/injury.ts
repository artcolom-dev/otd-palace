// What ESPN says about a hurt player, in plain English: a short label for the tag and one line for the details.
// A note is only ever what ESPN wrote: no part and no day when it gave none, and no note is not "healthy".
import type { Injury, InjuryStatus } from "../data/types";

const LABEL: Record<InjuryStatus, string> = {
  out: "Out",
  suspended: "Suspended",
  doubtful: "Doubtful",
  questionable: "Questionable",
  day: "Day-to-day",
};

/** "2026-11-18" as "Nov 18", whatever this device's time zone; null for anything that is not a real day. */
export function backDay(day: string | null | undefined): string | null {
  const parts = typeof day === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
  if (!parts) return null;
  const [year, month, date] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const at = new Date(Date.UTC(year, month - 1, date));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== date) return null;
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export interface InjuryWords {
  label: string;
  line: string;
  /** `hurt`: most likely misses the next game. `maybe`: may well play. */
  tone: "hurt" | "maybe";
}

/**
 * The words for a note, or null when it is not one we understand (an unknown status, no note, not an object). The
 * server only sends the five statuses above, but a page that crashes on a sixth is worse than one that shows no tag.
 */
export function injuryWords(injury: Injury | null | undefined): InjuryWords | null {
  const status = typeof injury === "object" && injury !== null ? injury.status : undefined;
  if (typeof status !== "string" || !Object.hasOwn(LABEL, status) || injury == null) return null;
  const label = LABEL[status];
  const part = typeof injury.part === "string" ? injury.part.trim().toLowerCase() : "";
  const day = backDay(injury.back);
  const line = [label, part, day === null ? "" : `back about ${day}`].filter((word) => word !== "").join(" · ");
  return { label, line, tone: isBenched(injury) ? "hurt" : "maybe" };
}

/** Whether the player most likely misses the next game: out, suspended or doubtful. No note, or one we cannot read, is not benched. */
export function isBenched(injury: Injury | null | undefined): boolean {
  const status = typeof injury === "object" && injury !== null ? injury.status : undefined;
  return status === "out" || status === "suspended" || status === "doubtful";
}
