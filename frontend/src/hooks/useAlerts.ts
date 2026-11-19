import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AlertSettings, type OpenedDeal, local } from "../data/local";
import { type AlertRules, MAX_FOLLOWS, MAX_OPENED, permission, subscriptionState, syncRules } from "../lib/push";

/** The rules are handed to the server this long after the last change to them, once. */
export const SYNC_DEBOUNCE_MS = 1500;

/** What the server matches for this device: its alert settings, level, budget, follows and opened deals. */
export function alertRules(
  alerts: AlertSettings,
  level: string,
  budget: number | null,
  follows: readonly string[],
  opened: readonly OpenedDeal[],
  utcOffsetMin: number = -new Date().getTimezoneOffset(),
): AlertRules {
  return {
    level,
    budget,
    follows: follows.slice(-MAX_FOLLOWS), // the newest are last
    opened: [...new Set(opened.map((o) => o.listing_id))].slice(0, MAX_OPENED), // the newest are first
    categories: {
      deals: alerts.deals, last_call: alerts.lastCall, moves: alerts.moves, digest: alerts.digest, routine: alerts.routine,
    },
    digest_hour: alerts.digestHour,
    quiet: alerts.quiet,
    utc_offset_min: utcOffsetMin,
  };
}

/** The rules as they stand, rebuilt only when one of their parts changes. */
export function useAlertRules(
  alerts: AlertSettings,
  level: string,
  budget: number | null,
  follows: readonly string[],
  opened: readonly OpenedDeal[],
): AlertRules {
  // The offset moves with DST or travel while the page stays open: re-read it whenever the page comes back.
  const [offset, setOffset] = useState(() => -new Date().getTimezoneOffset());
  useEffect(() => {
    const refresh = () => setOffset(-new Date().getTimezoneOffset());
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return useMemo(
    () => alertRules(alerts, level, budget, follows, opened, offset),
    [alerts, level, budget, follows, opened, offset],
  );
}

/**
 * Keeps the server's copy of this device's rules in step, while alerts are on and the server offers them: on load
 * (the server may have lost the device) and a moment after any change to the settings, follows, level or budget. A
 * deal just opened goes at once, with keepalive, since its last call may be minutes away and the visitor is leaving
 * for Real; a change still waiting is sent the same way when the page is hidden or closed. A device the server says
 * is unsubscribed, a browser that lost its subscription, or alerts blocked since, turn the switch off; a subscription
 * made for an older server key (`publicKey` changed) turns it off and asks for alerts to be turned on again.
 */
export function useAlertSync(offered: boolean, on: boolean, rules: AlertRules, publicKey: string | null): void {
  const key = JSON.stringify(rules);
  const waiting = useRef<string | null>(null); // rules not sent yet
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const opened = useRef<number[] | null>(null); // the opened ids last seen

  const send = useCallback((json: string, keepalive: boolean) => {
    void syncRules(JSON.parse(json) as AlertRules, { keepalive }).then((result) => {
      if (result === "off") local.setAlerts({ on: false });
    });
  }, []);
  const stopTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  useEffect(() => {
    if (!offered || !on) return;
    if (permission() === "denied") {
      local.setAlerts({ on: false });
      return;
    }
    let live = true;
    void subscriptionState(publicKey).then((state) => {
      if (!live) return;
      if (state === "none") local.setAlerts({ on: false });
      else if (state === "stale") local.setAlerts({ on: false, renew: true });
    });
    return () => {
      live = false;
    };
    // Once per page: later changes are the sync's business.
  }, [offered]);

  useEffect(() => {
    const before = opened.current;
    opened.current = rules.opened;
    if (!offered || !on) {
      waiting.current = null;
      return;
    }
    if (before !== null && rules.opened.some((id) => !before.includes(id))) {
      waiting.current = null;
      send(key, true);
      return;
    }
    waiting.current = key;
    timer.current = setTimeout(() => {
      timer.current = null;
      const json = waiting.current;
      waiting.current = null;
      if (json !== null) send(json, false);
    }, SYNC_DEBOUNCE_MS);
    return stopTimer;
  }, [offered, on, key]);

  useEffect(() => {
    const flush = () => {
      const json = waiting.current;
      if (json === null) return;
      stopTimer();
      waiting.current = null;
      send(json, true);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [send]);
}
