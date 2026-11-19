// What the phone says about its link and its battery, for the snapshot's polling: fewer requests while it saves data
// (Save-Data, a 2G link) or runs low on battery away from a charger, none while it knows it has no network.

/** The device, as the polling reads it. */
export interface Thrift {
  /** True while the browser asks to save data (Save-Data on, or a 2G link) or the battery is at 20 % or less and not
   *  charging. iOS says none of this (no Save-Data, no battery API): there it is always false. */
  saving: () => boolean;
  /** True only when the browser knows it has no network (`navigator.onLine` false). A true onLine proves nothing (a
   *  Wi-Fi with no internet), so only false is trusted. */
  offline: () => boolean;
  /** Calls `onChange` whenever `saving` may have changed; returns what stops it. */
  watch: (onChange: () => void) => () => void;
}

export const LOW_BATTERY = 0.2;

interface ConnectionInfo {
  saveData?: boolean;
  effectiveType?: string;
  addEventListener?: (type: "change", listener: () => void) => void;
  removeEventListener?: (type: "change", listener: () => void) => void;
}

interface BatteryInfo {
  level: number;
  charging: boolean;
  addEventListener: (type: "levelchange" | "chargingchange", listener: () => void) => void;
  removeEventListener: (type: "levelchange" | "chargingchange", listener: () => void) => void;
}

type DeviceNavigator = Navigator & { connection?: ConnectionInfo; getBattery?: () => Promise<BatteryInfo> };

/** The phone this page runs on. */
export function deviceThrift(nav: Navigator | undefined = typeof navigator === "undefined" ? undefined : navigator): Thrift {
  const device = nav as DeviceNavigator | undefined;
  let battery: BatteryInfo | null = null; // known once getBattery answers (Chrome on Android)
  return {
    saving: () => {
      const connection = device?.connection;
      if (connection?.saveData === true) return true;
      if (connection?.effectiveType === "slow-2g" || connection?.effectiveType === "2g") return true;
      return battery !== null && !battery.charging && battery.level <= LOW_BATTERY;
    },
    offline: () => device?.onLine === false,
    watch: (onChange) => {
      let stopped = false;
      let watched: BatteryInfo | null = null;
      const connection = device?.connection;
      connection?.addEventListener?.("change", onChange);
      if (typeof device?.getBattery === "function") {
        device.getBattery().then(
          (found) => {
            if (stopped || !found) return;
            battery = watched = found;
            found.addEventListener("levelchange", onChange);
            found.addEventListener("chargingchange", onChange);
            onChange();
          },
          () => undefined, // refused (a permissions policy): the battery says nothing
        );
      }
      return () => {
        stopped = true;
        connection?.removeEventListener?.("change", onChange);
        watched?.removeEventListener("levelchange", onChange);
        watched?.removeEventListener("chargingchange", onChange);
      };
    },
  };
}
