// Alerts: the bell (phone top bar, desktop sidebar) and the sheet behind it. Everything is opt-in and per device;
// the browser's permission is asked only on a tap on "Turn on alerts".
import { type MouseEvent, type ReactNode, useId, useState } from "react";
import { useApp } from "../AppContext";
import { type AlertSettings, DEFAULT_ALERTS, local, useLocal } from "../data/local";
import { cls } from "../lib/cls";
import { haptics, useHapticsOn } from "../lib/haptics";
import { type Permission, permission, sendTest, subscribe, supported, unsubscribe } from "../lib/push";
import { useAccess } from "./Access";
import { BusyButton } from "./BusyButton";
import { Icon } from "./Icon";
import { InstallPrompt } from "./InstallPrompt";
import { type OverlayContentProps, useOverlay } from "./Overlay";

const HOURS = Array.from({ length: 24 }, (_, h) => h);

/** 0-23 as a clock hour in plain words: 12 AM, 9 AM, 12 PM, 11 PM. */
export function hourText(h: number): string {
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve} ${h < 12 ? "AM" : "PM"}`;
}

const isDefault = (a: AlertSettings) => JSON.stringify(a) === JSON.stringify(DEFAULT_ALERTS);

/** Whether `hour` falls in the quiet hours [from, until), which may wrap over midnight: as the server judges it. */
function inQuiet(hour: number, quiet: [number, number] | null): boolean {
  if (!quiet || quiet[0] === quiet[1]) return false;
  const [from, until] = quiet;
  return from < until ? hour >= from && hour < until : hour >= from || hour < until;
}

/** One setting that is on or off: the whole row is the switch, its title names it, its sentence describes it. */
function Toggle({ title, text, on, disabled, onChange }: {
  title: string;
  text: string;
  on: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={`${id}t`}
      aria-describedby={`${id}d`}
      className="al-row"
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span className="al-txt">
        <b id={`${id}t`}>{title}</b>
        <span id={`${id}d`}>{text}</span>
      </span>
      <span className="knob" aria-hidden="true" />
    </button>
  );
}

/**
 * "Vibration": the light tap under the finger (lib/haptics), on unless turned off here, on this device only. Drawn only
 * where the device can buzz (an Android phone, an iPhone on iOS 18 or later).
 */
export function HapticsToggle() {
  const on = useHapticsOn(haptics);
  if (!haptics.available()) return null;
  const stilled = haptics.stilled();
  return (
    <Toggle
      title="Vibration"
      text={
        stilled
          ? "Off while this phone asks for less motion (in its accessibility settings)."
          : "A light tap under your finger when you change tabs, star a player, flip a switch or open a deal."
      }
      on={on && !stilled}
      disabled={stilled}
      onChange={(next) => haptics.setEnabled(next)}
    />
  );
}

/** What this phone does on its own: today, vibration. */
function DeviceSection({ titleId }: { titleId: string }) {
  if (!haptics.available()) return null;
  return (
    <section className="al-sec" aria-labelledby={`${titleId}-device`}>
      <h3 id={`${titleId}-device`}>This phone</h3>
      <HapticsToggle />
    </section>
  );
}

function HourSelect({ label, visible, value, onChange }: {
  label: string;
  visible: string;
  value: number;
  onChange: (h: number) => void;
}) {
  const id = useId();
  return (
    <span className="al-sel">
      <label htmlFor={id}>{visible}</label>
      <select id={id} aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {HOURS.map((h) => (
          <option key={h} value={h}>
            {hourText(h)}
          </option>
        ))}
      </select>
    </span>
  );
}

function Blocked() {
  return (
    <div className="al-box">
      <b>Alerts are blocked for this site.</b>
      <p>
        To allow them, open this site's settings in your browser (the icon next to the address), set Notifications to
        Allow, then reload the page. On an iPhone: Settings, then Notifications, then OTD Palace.
      </p>
    </div>
  );
}

function Unsupported() {
  return (
    <div className="al-box">
      <b>Install OTD Palace to your home screen to get alerts</b>
      <p>This browser only shows alerts from sites added to the home screen. Then open it from there.</p>
      <InstallPrompt inline />
    </div>
  );
}

/** The sheet (phone) or the panel (desktop) of alert settings. */
export function AlertsSheet({ ctx }: { ctx: OverlayContentProps }) {
  const { snap, alertRules } = useApp();
  const { alerts, follows } = useLocal();
  const [perm, setPerm] = useState<Permission>(permission);
  const [working, setWorking] = useState<"on" | "off" | "test" | "forget" | null>(null);
  const busy = working !== null;
  const [note, setNote] = useState("");
  const canPush = supported();
  const link = snap.links.push;
  const checkS = link?.check_s ?? snap.rules.poll_s;
  const set = (patch: Partial<AlertSettings>) => local.setAlerts(patch);
  const anyCategory = alerts.deals || alerts.lastCall || alerts.moves || alerts.digest || alerts.routine;

  const run = async (what: NonNullable<typeof working>, work: () => Promise<void>) => {
    if (busy) return;
    setWorking(what);
    setNote("");
    try {
      await work();
    } finally {
      setWorking(null);
      setPerm(permission());
    }
  };

  const turnOn = () =>
    run("on", async () => {
      if (!link) return;
      const result = await subscribe(alertRules, link.public_key);
      if (result === "on") {
        set({ on: true, renew: false });
        setNote(anyCategory ? "Alerts are on." : "Alerts are on. Now pick what you want below.");
      } else if (result === "dismissed") {
        setNote("Your browser did not get an answer. Tap Turn on alerts to try again.");
      } else if (result === "error") {
        setNote("Alerts could not be turned on in this browser. Try again in a minute.");
      }
    });
  const turnOff = () =>
    run("off", async () => {
      const result = await unsubscribe();
      set({ on: false });
      setNote(
        result === "deleted" || result === "none"
          ? "Alerts are off. Your choices stay on this device."
          : "Alerts are off on this device. We could not reach our server, so it may take a little while to stop.",
      );
    });
  const forget = () =>
    run("forget", async () => {
      const result = await unsubscribe();
      local.resetAlerts();
      setNote(
        result === "deleted"
          ? "Your alert settings are deleted from this device and from our server."
          : result === "none"
            ? "Your alert settings are deleted from this device."
            : "We could not reach our server; your settings were removed from this device only.",
      );
    });
  const test = () =>
    run("test", async () => {
      const result = await sendTest(alertRules);
      if (result === "sent") setNote("Sent. It should show up in a few seconds.");
      else if (result === "limited") setNote("Too many tests right now. Try again later.");
      else if (result === "off") {
        set({ on: false });
        setNote("Alerts are off on this device. Turn them on again first.");
      } else setNote("The test could not be sent. Try again in a minute.");
    });

  let master: ReactNode;
  if (!canPush) master = <Unsupported />;
  else if (perm === "denied") master = <Blocked />;
  else if (alerts.on) {
    master = (
      <Toggle
        title="Alerts on this device"
        text="Turn them off any time; your choices stay."
        on
        disabled={busy}
        onChange={() => void turnOff()}
      />
    );
  } else {
    master = (
      <BusyButton type="button" className="btn fill al-on" busy={working === "on"} busyLabel="Turning on…" slowLabel="Still turning on…" disabled={busy && working !== "on"} onClick={() => void turnOn()}>
        <Icon name="bell" />
        Turn on alerts
      </BusyButton>
    );
  }

  const content = (
    <>
      <p className="al-lead">
        A notice on this device when a deal needs you, even with the site closed. No account, no e-mail.
      </p>
      {alerts.renew && !alerts.on && (
        <p className="al-hint">Alerts were switched off after an update on our side. Tap Turn on alerts to get them again.</p>
      )}
      <div className="al-master">{master}</div>
      <p className="al-msg" role="status">
        {note}
      </p>
      <section className="al-sec" aria-labelledby={`${ctx.titleId}-what`}>
        <h3 id={`${ctx.titleId}-what`}>What to send</h3>
        <Toggle
          title="New deals on players you follow"
          text="When a player you starred gets a new deal that fits your level and budget."
          on={alerts.deals}
          onChange={(deals) => set({ deals })}
        />
        <Toggle
          title="Last call"
          text="When a deal you opened in Real ends in under 3 minutes."
          on={alerts.lastCall}
          onChange={(lastCall) => set({ lastCall })}
        />
        <Toggle
          title="Big price moves"
          text="When prices of a player you follow go up or down 20% or more in a day."
          on={alerts.moves}
          onChange={(moves) => set({ moves })}
        />
        {(alerts.deals || alerts.moves) && follows.length === 0 && (
          <p className="al-hint">
            <Icon name="star" />
            Star a player to get these.
          </p>
        )}
        <Toggle
          title="Daily digest"
          text="Today's 3 best deals for you, once a day at the time you pick."
          on={alerts.digest}
          onChange={(digest) => set({ digest })}
        />
        <Toggle
          title="Daily routine reminder"
          text="Your daily checklist, once a day at the digest time."
          on={alerts.routine}
          onChange={(routine) => set({ routine })}
        />
        {(alerts.digest || alerts.routine) && (
          <div className="al-hours">
            <HourSelect label="Digest time" visible="At" value={alerts.digestHour} onChange={(digestHour) => set({ digestHour })} />
          </div>
        )}
        {(alerts.digest || alerts.routine) && inQuiet(alerts.digestHour, alerts.quiet) && (
          <p className="al-hint">
            {alerts.digest ? "The digest" : "The reminder"} will not be sent: it falls inside your quiet hours.
          </p>
        )}
        {anyCategory && !alerts.on && canPush && perm !== "denied" && (
          <p className="al-hint">Turn on alerts above to get these.</p>
        )}
      </section>
      <section className="al-sec" aria-labelledby={`${ctx.titleId}-quiet`}>
        <h3 id={`${ctx.titleId}-quiet`} className="sr">
          Quiet hours
        </h3>
        <Toggle
          title="Quiet at night"
          text="No alerts between these hours."
          on={alerts.quiet !== null}
          onChange={(quiet) => set({ quiet: quiet ? DEFAULT_ALERTS.quiet : null })}
        />
        {alerts.quiet && (
          <div className="al-hours">
            <HourSelect
              label="Quiet from"
              visible="From"
              value={alerts.quiet[0]}
              onChange={(h) => set({ quiet: [h, alerts.quiet?.[1] ?? 7] })}
            />
            <HourSelect
              label="Quiet until"
              visible="Until"
              value={alerts.quiet[1]}
              onChange={(h) => set({ quiet: [alerts.quiet?.[0] ?? 23, h] })}
            />
          </div>
        )}
      </section>
      {ctx.phone && <DeviceSection titleId={ctx.titleId} />}
      <div className="al-foot">
        <BusyButton
          type="button"
          className="btn ghost"
          busy={working === "test"}
          busyLabel="Sending…"
          disabled={!alerts.on || !anyCategory || (busy && working !== "test")}
          onClick={() => void test()}
        >
          Send a test notification
        </BusyButton>
        {alerts.on && !anyCategory && <p className="al-hint">Pick at least one alert above first.</p>}
        <p className="al-live">
          <span className="dot" aria-hidden="true" />
          Alerts are checked every {checkS}s on our server.
        </p>
        {(alerts.on || !isDefault(alerts)) && (
          <BusyButton type="button" className="lnk al-del" busy={working === "forget"} busyLabel="Deleting your alert settings…" disabled={busy && working !== "forget"} onClick={() => void forget()}>
            Turn off and delete my alert settings
          </BusyButton>
        )}
      </div>
    </>
  );

  if (ctx.phone) return <div className="alerts">{content}</div>;
  return (
    <div className="alerts">
      <div className="dwhd al-hd">
        <span className="al-mark" aria-hidden="true">
          <Icon name="bell" />
        </span>
        <div className="dwtitle">
          <h2 id={ctx.titleId}>Alerts</h2>
          <p className="meta">On this device only</p>
        </div>
      </div>
      <div className="dwbody">{content}</div>
    </div>
  );
}

/** The bell: an icon button in the phone's top bar, a labelled row in the desktop sidebar. Hidden while the server
 * sends no alerts. */
export function AlertsButton({ variant }: { variant: "phone" | "side" }) {
  const { snap, layout } = useApp();
  const { alerts } = useLocal();
  const overlay = useOverlay();
  if (!snap.links.push) return variant === "phone" ? <SettingsButton /> : null;
  const open = (e: MouseEvent<HTMLButtonElement>) =>
    overlay.open({
      title: "Alerts",
      anchor: e.currentTarget,
      layer: layout.phone ? undefined : "panel",
      body: (ctx) => <AlertsSheet ctx={ctx} />,
    });
  if (variant === "phone") {
    return (
      <button
        type="button"
        className={cls("icb", "bell", alerts.on && "on")}
        aria-label="Alerts"
        aria-haspopup="dialog"
        onClick={open}
      >
        <Icon name="bell" />
      </button>
    );
  }
  return (
    <button type="button" className={cls("side-alerts", alerts.on && "on")} aria-haspopup="dialog" onClick={open}>
      <Icon name="bell" />
      Alerts
      <span className="st">{alerts.on ? "On" : "Off"}</span>
    </button>
  );
}

/** Whether the phone's bar carries the Discord button (a visitor not signed in): it needs the room. */
function useDiscordInBar(): boolean {
  const { state } = useAccess();
  return state === "anon" || state === "out";
}

/** Opens the phone's own settings (vibration) in a sheet. */
function useOpenSettings() {
  const overlay = useOverlay();
  return (anchor: HTMLElement) =>
    overlay.open({
      title: "Settings",
      anchor,
      body: (ctx) => (
        <div className="alerts">
          <DeviceSection titleId={ctx.titleId} />
        </div>
      ),
    });
}

/**
 * In the bell's place on a phone while the server sends no alerts: the phone's own settings (vibration), in a sheet.
 * Nothing at all on a device that cannot buzz, nor while the bar carries the Discord button, which needs the room
 * (the footer has the way in then, `SettingsLink`).
 */
function SettingsButton() {
  const open = useOpenSettings();
  const discordInBar = useDiscordInBar();
  if (!haptics.available() || discordInBar) return null;
  return (
    <button type="button" className="icb bell" aria-label="Settings" aria-haspopup="dialog" onClick={(e) => open(e.currentTarget)}>
      <Icon name="tune" />
    </button>
  );
}

/** The footer's way to the phone's settings, where the bar has no bell and no Settings button (the Discord button's
 * room). */
export function SettingsLink({ className }: { className?: string }) {
  const { snap, layout } = useApp();
  const open = useOpenSettings();
  const discordInBar = useDiscordInBar();
  if (!layout.phone || !haptics.available() || snap.links.push || !discordInBar) return null;
  return (
    <button type="button" className={className} aria-haspopup="dialog" onClick={(e) => open(e.currentTarget)}>
      Vibration
    </button>
  );
}
