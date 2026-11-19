// "Link your Real account", everywhere a visitor looks first: a button in the desktop top bar, an icon in the phone's
// header, a card on Today and the top of My passes. One action: a username is read, its analysis shows, and its passes
// become the visitor's own for all advice at once (passes/AccountAnalysis, `link`). Once linked, the same places show
// "Linked: @name · 57 passes · updated 3 min ago" with Refresh and Unlink. "Look up someone else" stays, small: the
// read-only analysis of a friend's or a rival's account, which never touches the visitor's passes.
// A member of our Discord also keeps the link on the server (LinkSync), so it follows them to any device.
import { Said } from "./Said";
import { type FormEvent, useContext, useEffect, useId, useRef, useState } from "react";
import { useApp } from "../AppContext";
import { local, useLocal } from "../data/local";
import { USERNAME, accountFromHash } from "../lib/accountPasses";
import { track } from "../lib/activity";
import { readInlinedMe } from "../lib/gate";
import { canLink, fetchForLink, fetchMemberLink, saveLinkSettings, tryUnlinkOnServer, unlinkCount, unlinkFailure, updatedWords } from "../lib/link";
import { formatRax } from "../lib/format";
import { haptic } from "../lib/haptics";
import { BusyButton } from "./BusyButton";
import { DeleteData } from "./DeleteData";
import { DiscordPerks } from "./DiscordPerks";
import { Icon } from "./Icon";
import { MemberContext } from "./MemberLine";
import { useOverlay } from "./Overlay";
import { useOpenAccount } from "./passes/AccountAnalysis";

/** The username field and its button: links the account, or (`lookup`) opens its read-only analysis. */
export function AccountForm({ autoFocus = false, lookup = false, onDone }: { autoFocus?: boolean; lookup?: boolean; onDone?: () => void }) {
  const openAccount = useOpenAccount();
  const id = useId();
  const [name, setName] = useState("");
  const ok = USERNAME.test(name.trim());
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!ok) return;
    track(lookup ? "lookup" : "link", name.trim().replace(/^@/, ""));
    openAccount(name.trim().replace(/^@/, ""), e.currentTarget, { link: !lookup });
    onDone?.();
  };
  return (
    <form className="accf" onSubmit={submit}>
      <label className="sr" htmlFor={`${id}i`}>
        {lookup ? "Someone else's Real username" : "Your Real username"}
      </label>
      <div className="impr">
        <input
          id={`${id}i`}
          name={lookup ? "lookup-username" : "real-username"}
          value={name}
          placeholder={lookup ? "Their Real username" : "Your Real username"}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={31}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- opened on purpose by the visitor
          autoFocus={autoFocus}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className={lookup ? "btn" : "btn fill"} disabled={!ok}>
          {lookup ? "Look up" : "Link"}
        </button>
      </div>
    </form>
  );
}

const PITCH = "Type your Real username. Your passes are read from your public profile, so the tips here skip what you already own.";

/** "Linked: @name · 57 passes · updated 3 min ago", with Refresh and Unlink. `onSaid` tells what an unlink did
 * (the chip itself is gone by then). A member's link is forgotten on the server first: if the server does not answer,
 * nothing changes and they are told, so the next visit cannot link them back. */
export function LinkChip({ onSaid }: { onSaid: (words: string) => void }) {
  const { link } = useLocal();
  const { now } = useApp();
  const named = useContext(MemberContext);
  // A page served to a member whose name /api/me has not given yet (or could not): the server still holds their link,
  // so Unlink goes to it all the same, and never says "Unlinked" for a device-only change.
  const member = named ?? (readInlinedMe()?.member ? { fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) } : null);
  const openAccount = useOpenAccount();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  if (!link) return null;
  const unlink = async () => {
    if (busy) return;
    if (member) {
      setBusy(true);
      setFailed("");
      const outcome = await tryUnlinkOnServer(member);
      setBusy(false);
      if (outcome !== "ok") {
        const words = unlinkFailure(outcome);
        haptic("warning");
        setFailed(words);
        onSaid(words);
        return;
      }
    }
    local.unlink();
    haptic("success");
    onSaid("Unlinked. Your passes from Real left this site.");
  };
  return (
    <div className="lchip" data-testid="link-chip">
      <p className="lchip-t">
        <Icon name="check" />
        <span>
          Linked: <b>@{link.username}</b> · {formatRax(link.count)} pass{link.count === 1 ? "" : "es"} ·{" "}
          {updatedWords(link.at, now)}
        </span>
      </p>
      {failed && (
        <p className="lchip-err" role="alert">
          {failed}
        </p>
      )}
      <div className="lchip-b">
        <button type="button" className="lnk box" onClick={(e) => openAccount(link.username, e.currentTarget, { link: true })}>
          Refresh
        </button>
        <BusyButton type="button" className="lnk box" busy={busy} busyLabel="Unlinking…" slowLabel="Still unlinking…" onClick={() => void unlink()}>
          {failed ? "Try again" : "Unlink"}
        </BusyButton>
      </div>
    </div>
  );
}

/** "Look up someone else": a small link that opens the read-only lookup's field. */
export function LookupOther() {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="lookup">
      <button type="button" className="lnk plain" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        Look up someone else
        <Icon name="chev" className={open ? "up" : undefined} />
      </button>
      {open && (
        <div id={id}>
          <AccountForm lookup autoFocus />
          <p className="impn">A friend's or a rival's passes, read only. Nothing is saved.</p>
        </div>
      )}
    </div>
  );
}

/** The link's state and actions: the chip once linked, else the field; then the lookup and a member's perks. */
export function LinkBox({ autoFocus = false, onDone }: { autoFocus?: boolean; onDone?: () => void }) {
  const { link } = useLocal();
  const [said, setSaid] = useState("");
  return (
    <div className="lbox">
      {said && <Said text={said} />}
      {link ? (
        <LinkChip onSaid={setSaid} />
      ) : (
        <>
          <AccountForm autoFocus={autoFocus} onDone={onDone} />
          <p className="impn">Only the name is sent. Unlink any time.</p>
        </>
      )}
      <LookupOther />
      <DiscordPerks />
      <DeleteData />
    </div>
  );
}

/** Today's card: the feature said plainly, with the field (or the link's state) right there. */
export function AccountCard() {
  const { snap, layout } = useApp();
  const { link } = useLocal();
  if (!canLink(snap)) return null;
  return (
    <section className={layout.phone ? "pnl acccard" : "panel acccard"} aria-labelledby="acccard-h">
      <div className="ph">
        <h2 id="acccard-h">
          <Icon name="user" />
          {link ? "Your Real account" : "Link your Real account"}
        </h2>
      </div>
      {!link && <p className="pnote">{PITCH}</p>}
      <LinkBox />
    </section>
  );
}

/** The desktop top bar's and the phone header's way in: a small sheet with the field, or the link's state. */
export function AccountButton({ variant }: { variant: "bar" | "phone" }) {
  const { snap } = useApp();
  const { link } = useLocal();
  const overlay = useOverlay();
  if (!canLink(snap)) return null;
  const title = link ? "Your Real account" : "Link your Real account";
  const open = (anchor: HTMLElement) =>
    overlay.open({
      title,
      anchor,
      size: "narrow",
      body: () => (
        <div className="accsheet">
          {!link && <p className="pnote">{PITCH}</p>}
          <LinkBox autoFocus />
        </div>
      ),
    });
  return variant === "bar" ? (
    <button type="button" className="lnk box accbtn" onClick={(e) => open(e.currentTarget)}>
      <Icon name={link ? "check" : "user"} />
      {link ? `@${link.username}` : "Link your Real account"}
    </button>
  ) : (
    <button type="button" className="icb accbtn" aria-label={link ? `Your Real account, @${link.username}` : title} onClick={(e) => open(e.currentTarget)}>
      <Icon name="user" />
    </button>
  );
}

/** Opens an account's read-only analysis for an address that names one (#account/<name>), at load and when it changes. */
export function AccountFromAddress() {
  const { snap } = useApp();
  const openAccount = useOpenAccount();
  const openRef = useRef(openAccount);
  openRef.current = openAccount;
  const live = canLink(snap);
  useEffect(() => {
    if (!live) return;
    const check = () => {
      const name = accountFromHash(location.hash);
      if (name) openRef.current(name, null);
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, [live]);
  return null;
}

/**
 * A member's link follows them: at load, the server's link (if any) is read; a device linked to another account, or
 * to none, takes the server's (read again quietly); a device linked while the server keeps none gives the server its
 * own, unless the member unlinked since that device linked (then the device unlinks too). The players they follow go
 * to the server when they change, for their personal deal pings. Nothing for anyone else.
 */
export function LinkSync() {
  const { snap } = useApp();
  const member = useContext(MemberContext);
  const { follows, link } = useLocal();
  const live = canLink(snap);
  // What the server holds of the players followed: what this device had when the server answered (the link sends
  // them too); null until then, and nothing is sent before.
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (!member || !live) return;
    let on = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const began = unlinkCount();
    void (async () => {
      const server = await fetchMemberLink(member.fetchImpl);
      if (!on || server === null) return;
      sent.current = local.get().follows.join(",");
      const device = local.get().link;
      if (!server.link) {
        if (!device) return;
        if (server.unlinked_at !== null && device.at + (server.skew_ms ?? 0) <= server.unlinked_at * 1000) {
          local.unlink(); // unlinked on another device after this one linked
          return;
        }
      } else if (device && device.username.toLowerCase() === server.link.username.toLowerCase()) {
        return;
      }
      const want = server.link?.username ?? device!.username;
      // A refused or failed read (too many asks from this address, the server busy) is tried again a little later,
      // a few times: otherwise a device would show "Link your Real account" while the server holds the link.
      for (let tries = 0; ; tries += 1) {
        const answer = await fetchForLink(want, member);
        if (!on || unlinkCount() !== began) return; // unlinked meanwhile: stay unlinked
        if (answer.status === "ok") {
          local.link(answer.username ?? want, answer.passes, answer.markets, new Set(snap.otd.markets.map((m) => m.key)));
          return;
        }
        if ((answer.status !== "busy" && answer.status !== "offline") || tries >= LINK_SYNC_RETRY_MS.length || local.get().link) return;
        await new Promise<void>((done) => {
          retry = setTimeout(done, LINK_SYNC_RETRY_MS[tries]);
        });
        if (!on) return;
      }
    })();
    return () => {
      on = false;
      clearTimeout(retry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per member and page load
  }, [member, live]);
  // The players followed, a few seconds after they change (a burst of stars is one request).
  const followKey = follows.join(",");
  useEffect(() => {
    if (!member || !link || sent.current === null || sent.current === followKey) return;
    const timer = setTimeout(() => {
      sent.current = followKey;
      void saveLinkSettings(member, { follows: followKey ? followKey.split(",") : [] });
    }, FOLLOWS_SYNC_MS);
    return () => clearTimeout(timer);
  }, [member, link, followKey]);
  return null;
}

/** How long LinkSync waits before reading the server's link again after a refused or failed read, try by try. */
export const LINK_SYNC_RETRY_MS = [20_000, 60_000, 180_000] as const;

/** How long after a change of the players followed they go to the server. */
export const FOLLOWS_SYNC_MS = 3000;
