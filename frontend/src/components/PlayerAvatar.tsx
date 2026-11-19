// A player's face: their photo, which our own server fetches from public league sources and serves from
// /img/players/, or their initials on a tint when there is none. Never a data: image, never a style attribute:
// every size and colour is a class.
import { useContext, useEffect, useState } from "react";
import { AppContext } from "../AppContext";
import { cls } from "../lib/cls";
import { initials } from "../lib/words";

/** Where our server serves a player's photo (a 404 when it has none). */
export function photoUrl(sport: string, playerId: number): string {
  return `/img/players/${encodeURIComponent(sport)}/${playerId}`;
}

/**
 * Our address for this face, or null when there is none to ask for: `photo` false, or a sport the server says it has
 * no photos for (`rules.photo_sports`; every sport while it does not say, or outside the app).
 */
function usePhotoUrl(sport: string, playerId: number, photo: boolean): string | null {
  const sports = useContext(AppContext)?.snap.rules.photo_sports;
  return photo && (!sports || sports.includes(sport)) ? photoUrl(sport, playerId) : null;
}

const TINTS = 8;

/**
 * The tint behind a face (`tint-0` … `tint-7`). Real's data names no team colours, so the team's id picks one when
 * it is known, else the player's own id: the same tint on every visit, teammates alike.
 */
export function tintClass(id: number): string {
  return `tint-${Number.isFinite(id) ? Math.abs(Math.trunc(id)) % TINTS : 0}`;
}

// The photos that failed on this page: a row drawn again goes straight to initials, without asking twice.
const failed = new Set<string>();
// The ones asked for a second time already. A server just started may not have built its name lists yet and answers
// "none" for a face it will have a minute later, so a missing face is asked for once more, once, and never in a loop.
const retried = new Set<string>();

/** How long after a missing photo it is asked for once more. */
export const PHOTO_RETRY_MS = 20_000;

/** Forget the failed photos (for tests). */
export function resetPhotos() {
  failed.clear();
  retried.clear();
}

/** How long a page's first photos wait: the view's own text and code come first, the faces right after. */
export const PHOTO_START_MS = 600;
let photosOpen = false;
const sleeping = new Set<() => void>();
let wake: ReturnType<typeof setTimeout> | undefined;

/** False for the first moments of a page, then true for good: a face asked for at once would take the line from the code. */
function usePhotosOpen(): boolean {
  const [open, setOpen] = useState(photosOpen);
  useEffect(() => {
    if (photosOpen) return;
    const wakeMe = () => setOpen(true);
    sleeping.add(wakeMe);
    wake ??= setTimeout(() => {
      photosOpen = true;
      sleeping.forEach((f) => f());
      sleeping.clear();
    }, PHOTO_START_MS);
    return () => void sleeping.delete(wakeMe);
  }, []);
  return open;
}

/** Forget that the page has settled (for tests). */
export function resetPhotoStart(open = false) {
  photosOpen = open;
  sleeping.clear();
  if (wake !== undefined) clearTimeout(wake);
  wake = undefined;
}

/** Whether to show the photo at `url` (null: none to show), and what its img calls when it fails to load. */
function usePhoto(url: string | null): [show: boolean, fail: () => void, src: boolean] {
  const [bad, setBad] = useState<string | null>(null);
  const [, redraw] = useState(0);
  const show = url !== null && bad !== url && !failed.has(url);
  const fail = () => {
    if (url === null) return;
    failed.add(url);
    setBad(url);
  };
  useEffect(() => {
    if (url === null || show || retried.has(url)) return;
    const timer = setTimeout(() => {
      if (!retried.has(url)) {
        retried.add(url); // the one retry: if it fails too, the initials stay
        failed.delete(url);
      }
      setBad(null);
      redraw((n) => n + 1);
    }, PHOTO_RETRY_MS);
    return () => clearTimeout(timer);
  }, [url, show]);
  return [show, fail, usePhotosOpen()];
}

export type AvatarSize = 28 | 32 | 40 | 56 | 76;

export interface PlayerAvatarProps {
  sport: string;
  playerId: number;
  name: string;
  /** The rarity class (`rar-N`) whose colour rings the face; without one the ring is a plain line. */
  rarity?: string;
  /** The team's id, when known: it picks the tint (else the player's id does). */
  teamId?: number | null;
  /** False: initials only, nothing asked (a team pass, whose id is a team's). */
  photo?: boolean;
  size?: AvatarSize;
  /** The name is written next to the face (the default): the face says nothing more. Else it carries the name. */
  labelled?: boolean;
  className?: string;
}

/** A round face in a thin rarity ring: the photo, or the initials on the tint. Fixed size, so a row keeps its height. */
export function PlayerAvatar({
  sport,
  playerId,
  name,
  rarity,
  teamId = null,
  photo = true,
  size = 32,
  labelled = true,
  className,
}: PlayerAvatarProps) {
  const url = usePhotoUrl(sport, playerId, photo);
  const [show, fail, open] = usePhoto(url);
  const frame = cls("pav", `s${size}`, rarity ?? "ring", tintClass(teamId ?? playerId), !show && "ini", className);
  if (show && url !== null) {
    return (
      <span className={frame} data-testid="avatar">
        <img src={open ? url : undefined} alt={labelled ? "" : name} width={size} height={size} loading="lazy" decoding="async" onError={fail} />
      </span>
    );
  }
  return labelled ? (
    <span className={frame} data-testid="avatar" aria-hidden="true">
      {initials(name)}
    </span>
  ) : (
    <span className={frame} data-testid="avatar" role="img" aria-label={name}>
      {initials(name)}
    </span>
  );
}

/**
 * The face on one of our drawn cards: the photo inside the card's rarity frame, else the monogram the card has
 * always carried (`mono`, the initials by default). The cards are pictures beside the name, so it says nothing.
 */
export function CardFace({ sport, playerId, name, photo = true, mono }: {
  sport: string;
  playerId: number;
  name: string;
  photo?: boolean;
  mono?: string;
}) {
  const url = usePhotoUrl(sport, playerId, photo);
  const [show, fail, open] = usePhoto(url);
  if (show && url !== null) {
    return (
      <div className="jn face">
        <img src={open ? url : undefined} alt="" width={112} height={112} loading="lazy" decoding="async" onError={fail} />
      </div>
    );
  }
  const text = mono ?? initials(name);
  return <div className={cls("jn", text.length > 2 && "sm")}>{text}</div>;
}
