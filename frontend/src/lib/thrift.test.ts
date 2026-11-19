import { describe, expect, it, vi } from "vitest";
import { deviceThrift } from "./thrift";

class Target {
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, fn: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string) {
    this.listeners.get(type)?.forEach((fn) => fn());
  }
  count() {
    return [...this.listeners.values()].reduce((n, set) => n + set.size, 0);
  }
}

const nav = (extra: object) => ({ onLine: true, ...extra }) as unknown as Navigator;

describe("deviceThrift", () => {
  it("saves while Save-Data is on or the link is 2G, and says when that changes", () => {
    const connection = Object.assign(new Target(), { saveData: false, effectiveType: "4g" });
    const thrift = deviceThrift(nav({ connection }));
    const changed = vi.fn();
    const stop = thrift.watch(changed);
    expect(thrift.saving()).toBe(false);
    connection.saveData = true;
    connection.fire("change");
    expect(changed).toHaveBeenCalledTimes(1);
    expect(thrift.saving()).toBe(true);
    connection.saveData = false;
    for (const slow of ["2g", "slow-2g"]) {
      connection.effectiveType = slow;
      expect(thrift.saving()).toBe(true);
    }
    connection.effectiveType = "3g";
    expect(thrift.saving()).toBe(false);
    stop();
    expect(connection.count()).toBe(0);
  });

  it("saves on a battery at 20 % or less that is not charging, once the browser has told", async () => {
    const battery = Object.assign(new Target(), { level: 0.5, charging: false });
    const thrift = deviceThrift(nav({ getBattery: () => Promise.resolve(battery) }));
    const changed = vi.fn();
    const stop = thrift.watch(changed);
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(1); // told once the battery is known
    expect(thrift.saving()).toBe(false);
    battery.level = 0.2;
    battery.fire("levelchange");
    expect(thrift.saving()).toBe(true);
    battery.charging = true;
    battery.fire("chargingchange");
    expect(thrift.saving()).toBe(false);
    expect(changed).toHaveBeenCalledTimes(3);
    stop();
    expect(battery.count()).toBe(0);
  });

  it("says nothing where the browser has neither (iOS), or refuses the battery", async () => {
    const plain = deviceThrift(nav({}));
    expect(plain.saving()).toBe(false);
    plain.watch(() => undefined)();
    const refused = deviceThrift(nav({ getBattery: () => Promise.reject(new Error("not allowed")) }));
    const changed = vi.fn();
    refused.watch(changed);
    await Promise.resolve();
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
    expect(refused.saving()).toBe(false);
  });

  it("does not start listening to a battery that answers after it was stopped", async () => {
    const battery = Object.assign(new Target(), { level: 0.1, charging: false });
    let answer: (b: typeof battery) => void = () => undefined;
    const thrift = deviceThrift(nav({ getBattery: () => new Promise((resolve) => (answer = resolve)) }));
    const changed = vi.fn();
    thrift.watch(changed)();
    answer(battery);
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
    expect(battery.count()).toBe(0);
  });

  it("is offline only when the browser says onLine is false", () => {
    expect(deviceThrift(nav({ onLine: false })).offline()).toBe(true);
    expect(deviceThrift(nav({ onLine: true })).offline()).toBe(false);
    expect(deviceThrift(undefined).offline()).toBe(false);
  });
});
