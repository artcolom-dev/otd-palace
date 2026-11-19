// "Share my passes": a picture of what this device's passes pay, drawn in the browser from the plan it already holds.
// It names no account and carries no username: only the total, how many passes, the best three and the sports that
// pay most. Photos are this site's own (/img/players, from public league sources); a missing one is drawn as initials.
import { about } from "../content/passWords";
import type { HeldPass, Plan } from "./passes";
import { sportLabel } from "./words";

export interface CardPass {
  name: string;
  sport: string;
  playerId: number;
  year: number; // what it pays in the next 12 months
  tier: string;
  season: string;
}

export interface CardModel {
  who?: string; // a Real account's name when the card is its analysis; none for the visitor's own passes
  url?: string; // the analysis's link, added to the shared text
  total: number;
  passes: number;
  top: CardPass[]; // the three that pay most, maxed ones left out
  sports: { sport: string; total: number }[]; // the three that pay most
}

const tierName = (tier: string) => tier.charAt(0).toUpperCase() + tier.slice(1);

export function profileCardModel(plan: Plan, max = 3): CardModel {
  const top = plan.held
    .filter((h: HeldPass) => !h.spent && h.year > 0)
    .sort((a, b) => b.year - a.year)
    .slice(0, max)
    .map((h) => ({
      name: h.market.player_name,
      sport: h.market.sport,
      playerId: h.market.player_id,
      year: Math.round(h.year),
      tier: tierName(h.tier),
      season: h.market.season_label,
    }));
  const sports = Object.entries(plan.sports)
    .map(([key, s]) => ({ sport: s.sport ?? key, total: Math.round(s.total) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 3);
  return { total: Math.round(plan.total), passes: plan.held.length, top, sports };
}

export const cardFileName = () => "otd-palace-my-passes.png";

const W = 1200;
const H = 630;

function load(src: string, ms = 2500): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const done = (v: HTMLImageElement | null) => {
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => done(null), ms);
    img.onload = () => done(img);
    img.onerror = () => done(null);
    img.src = src;
  });
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/** Draws the card on a canvas (1200 x 630) and returns it as a PNG, or null when the browser cannot draw it. */
export async function renderProfileCard(model: CardModel): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const photos = await Promise.all(model.top.map((p) => load(`/img/players/${encodeURIComponent(p.sport)}/${p.playerId}`)));

  // The site's palette (tokens.css): the black ground, the two greys for text, the accent.
  const ink = "#d9d9d9";
  const muted = "#8a8e94";
  const accent = "#f5893a";
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, 14, H);
  ctx.textBaseline = "alphabetic";

  ctx.fillStyle = muted;
  ctx.font = "600 26px system-ui, sans-serif";
  ctx.fillText("OTD PALACE", 64, 76);
  ctx.fillStyle = ink;
  ctx.font = "500 34px system-ui, sans-serif";
  ctx.fillText(model.who ? `${model.who}'s passes pay about` : "My passes pay about", 64, 160);
  ctx.fillStyle = accent;
  ctx.font = "800 112px system-ui, sans-serif";
  ctx.fillText(about(model.total), 64, 268);
  ctx.fillStyle = muted;
  ctx.font = "500 30px system-ui, sans-serif";
  ctx.fillText(`Rax a year (estimate) · ${model.passes} ${model.passes === 1 ? "pass" : "passes"}`, 64, 314);

  model.top.forEach((p, i) => {
    const x = 64 + i * 376;
    const y = 372;
    ctx.fillStyle = "#151515";
    ctx.fillRect(x, y, 352, 190);
    const photo = photos[i];
    ctx.save();
    ctx.beginPath();
    ctx.arc(x + 66, y + 68, 44, 0, Math.PI * 2);
    ctx.clip();
    if (photo) ctx.drawImage(photo, x + 22, y + 24, 88, 88);
    else {
      ctx.fillStyle = "#2f3336";
      ctx.fillRect(x + 22, y + 24, 88, 88);
      ctx.fillStyle = ink;
      ctx.font = "700 32px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(initials(p.name), x + 66, y + 80);
      ctx.textAlign = "left";
    }
    ctx.restore();
    ctx.fillStyle = ink;
    ctx.font = "700 30px system-ui, sans-serif";
    ctx.fillText(p.name.length > 18 ? `${p.name.slice(0, 17)}…` : p.name, x + 128, y + 62);
    ctx.fillStyle = muted;
    ctx.font = "500 21px system-ui, sans-serif";
    ctx.fillText(`${sportLabel(p.sport)} ${p.season} · ${p.tier}`, x + 128, y + 96, 208);
    ctx.fillStyle = accent;
    ctx.font = "700 40px system-ui, sans-serif";
    ctx.fillText(`${about(p.year)} Rax`, x + 22, y + 158);
  });

  ctx.fillStyle = muted;
  ctx.font = "500 24px system-ui, sans-serif";
  ctx.fillText(typeof location === "undefined" ? "" : location.host, 64, 604);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}

export type CardShareResult = "shared" | "cancelled" | "downloaded" | "failed";

/** The share sheet with the picture as a file when the browser can, else the picture is downloaded. Never throws. */
export async function shareProfileCard(model: CardModel, png: Blob, nav: Navigator = navigator): Promise<CardShareResult> {
  const file = new File([png], cardFileName(), { type: "image/png" });
  const data: ShareData = {
    files: [file],
    title: model.who ? `${model.who}'s passes · OTD Palace` : "My passes · OTD Palace",
    text: `${model.who ? `${model.who}'s` : "My"} passes pay about ${about(model.total)} Rax a year (estimate).${model.url ? ` ${model.url}` : ""}`,
  };
  if (typeof nav.canShare === "function" && nav.canShare({ files: [file] })) {
    try {
      await nav.share(data);
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    }
  }
  try {
    const url = URL.createObjectURL(png);
    const link = document.createElement("a");
    link.href = url;
    link.download = cardFileName();
    link.click();
    URL.revokeObjectURL(url);
    return "downloaded";
  } catch {
    return "failed";
  }
}

/** The follow keys ("sport:player_id") of the players behind the passes that pay most, once each, at most `max`;
 * players only, as a team or a fighter has no player to follow. */
export function bestPlayersToFollow(plan: Plan, max = 20): string[] {
  const out: string[] = [];
  for (const h of [...plan.held].sort((a, b) => b.year - a.year)) {
    if (h.market.kind !== "player") continue;
    const key = `${h.market.sport}:${h.market.player_id}`;
    if (!out.includes(key)) out.push(key);
    if (out.length >= max) break;
  }
  return out;
}
