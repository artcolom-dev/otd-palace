import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ALERTS, type AlertSettings, local } from "../data/local";
import * as push from "../lib/push";
import { freshDevice, renderApp, seedDevice } from "../test/app";
import { sceneSnapshot } from "../test/scene";

vi.mock("../lib/push", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/push")>()),
  supported: vi.fn(() => true),
  permission: vi.fn(() => "default"),
  subscribe: vi.fn(async () => "on"),
  syncRules: vi.fn(async () => "ok"),
  unsubscribe: vi.fn(async () => "deleted"),
  sendTest: vi.fn(async () => "sent"),
  subscriptionState: vi.fn(async () => "current"),
}));
vi.mock("../lib/track", () => ({ trackOut: vi.fn() }));

const mocked = vi.mocked(push);
const PUSH = { public_key: "BKey", check_s: 10 };
const withPush = () => sceneSnapshot({ links: { community: null, push: PUSH } });
const on = (patch: Partial<AlertSettings> = {}) => seedDevice({ alerts: { ...DEFAULT_ALERTS, on: true, ...patch } });

const bell = () => screen.getByRole("button", { name: /^Alerts/ });
const sheet = () => screen.getByRole("dialog", { name: "Alerts" });
const inSheet = () => within(sheet());
const toggle = (name: RegExp) => inSheet().getByRole("switch", { name });
const tap = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};

describe("alerts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
    mocked.supported.mockReturnValue(true);
    mocked.permission.mockReturnValue("default");
    mocked.subscribe.mockResolvedValue("on");
    mocked.syncRules.mockResolvedValue("ok");
    mocked.sendTest.mockResolvedValue("sent");
    mocked.subscriptionState.mockResolvedValue("current");
    mocked.unsubscribe.mockResolvedValue("deleted");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("offers no bell while the server sends no alerts", () => {
    renderApp({ snap: sceneSnapshot() });
    expect(screen.queryByRole("button", { name: /^Alerts/ })).toBeNull();
  });

  it("phone: the bell in the top bar opens the sheet; nothing is asked on load", async () => {
    const { advance } = renderApp({ snap: withPush() });
    await advance(3000);
    expect(within(screen.getByRole("banner")).getByRole("button", { name: "Alerts" })).toBeInTheDocument();
    fireEvent.click(bell());
    expect(inSheet().getByRole("button", { name: "Turn on alerts" })).toBeInTheDocument();
    expect(inSheet().getByText("Alerts are checked every 10s on our server.")).toBeInTheDocument();
    const switches = inSheet().getAllByRole("switch");
    expect(switches.map((s) => [s.textContent, s.getAttribute("aria-checked")])).toEqual([
      ["New deals on players you followWhen a player you starred gets a new deal that fits your level and budget.", "false"],
      ["Last callWhen a deal you opened in Real ends in under 3 minutes.", "false"],
      ["Big price movesWhen prices of a player you follow go up or down 20% or more in a day.", "false"],
      ["Daily digestToday's 3 best deals for you, once a day at the time you pick.", "false"],
      ["Daily routine reminderYour daily checklist, once a day at the digest time.", "false"],
      ["Quiet at nightNo alerts between these hours.", "true"],
    ]);
    expect(mocked.subscribe).not.toHaveBeenCalled();
    expect(mocked.syncRules).not.toHaveBeenCalled();
  });

  it("asks for permission only on a tap on Turn on alerts, then shows the switch on", async () => {
    renderApp({ snap: withPush() });
    fireEvent.click(bell());
    fireEvent.click(toggle(/^Last call/));
    await tap(inSheet().getByRole("button", { name: "Turn on alerts" }));
    expect(mocked.subscribe).toHaveBeenCalledTimes(1);
    const [rules, key] = mocked.subscribe.mock.calls[0]!;
    expect(key).toBe("BKey");
    expect(rules).toEqual({
      level: "new", budget: 200, follows: [], opened: [],
      categories: { deals: false, last_call: true, moves: false, digest: false, routine: false },
      digest_hour: 9, quiet: [23, 7], utc_offset_min: -new Date().getTimezoneOffset(),
    });
    expect(toggle(/^Alerts on this device/)).toHaveAttribute("aria-checked", "true");
    expect(local.get().alerts.on).toBe(true);
    expect(inSheet().getByRole("status")).toHaveTextContent("Alerts are on.");
  });

  it("a prompt put away, or a browser that fails, leaves alerts off and says so", async () => {
    mocked.subscribe.mockResolvedValueOnce("dismissed").mockResolvedValueOnce("error");
    renderApp({ snap: withPush() });
    fireEvent.click(bell());
    await tap(inSheet().getByRole("button", { name: "Turn on alerts" }));
    expect(inSheet().getByRole("status")).toHaveTextContent("Your browser did not get an answer.");
    await tap(inSheet().getByRole("button", { name: "Turn on alerts" }));
    expect(inSheet().getByRole("status")).toHaveTextContent("Alerts could not be turned on in this browser.");
    expect(local.get().alerts.on).toBe(false);
  });

  it("syncs the rules once, a moment after the last change: settings, follows and level", async () => {
    on();
    const { advance } = renderApp({ snap: withPush() });
    await advance(2000); // the sync on load, in case the server lost this device
    expect(mocked.syncRules).toHaveBeenCalledTimes(1);
    mocked.syncRules.mockClear();
    fireEvent.click(bell());
    fireEvent.click(toggle(/^Last call/));
    fireEvent.click(toggle(/^Big price moves/));
    await advance(500);
    expect(mocked.syncRules).not.toHaveBeenCalled();
    await advance(1500);
    expect(mocked.syncRules).toHaveBeenCalledTimes(1);
    expect(mocked.syncRules.mock.calls[0]![0].categories).toEqual({ deals: false, last_call: true, moves: true, digest: false, routine: false });
    act(() => void local.toggleFollow("nba:22"));
    await advance(2000);
    expect(mocked.syncRules).toHaveBeenCalledTimes(2);
    expect(mocked.syncRules.mock.calls[1]![0].follows).toEqual(["nba:22"]);
  });

  it("nothing is synced while alerts are off", async () => {
    const { advance } = renderApp({ snap: withPush() });
    fireEvent.click(bell());
    fireEvent.click(toggle(/^Daily digest/));
    await advance(3000);
    expect(mocked.syncRules).not.toHaveBeenCalled();
    expect(inSheet().getByText("Turn on alerts above to get these.")).toBeInTheDocument();
  });

  it("a device the server unsubscribed shows the switch off", async () => {
    on();
    mocked.syncRules.mockResolvedValue("off");
    const { advance } = renderApp({ snap: withPush() });
    await advance(2000);
    expect(local.get().alerts.on).toBe(false);
    fireEvent.click(bell());
    expect(inSheet().getByRole("button", { name: "Turn on alerts" })).toBeInTheDocument();
  });

  it("a browser that lost its subscription shows the switch off", async () => {
    on();
    mocked.subscriptionState.mockResolvedValue("none");
    const { advance } = renderApp({ snap: withPush() });
    await advance(100);
    expect(local.get().alerts.on).toBe(false);
  });

  it("permission denied: says how to allow alerts again", () => {
    mocked.permission.mockReturnValue("denied");
    renderApp({ snap: withPush() });
    fireEvent.click(bell());
    expect(inSheet().getByText("Alerts are blocked for this site.")).toBeInTheDocument();
    expect(inSheet().getByText(/set Notifications to Allow/)).toBeInTheDocument();
    expect(inSheet().queryByRole("button", { name: "Turn on alerts" })).toBeNull();
  });

  it("no push here (iOS Safari outside the home screen): points to installing", () => {
    mocked.supported.mockReturnValue(false);
    mocked.permission.mockReturnValue("unsupported");
    renderApp({ snap: withPush() });
    fireEvent.click(bell());
    expect(inSheet().getByText("Install OTD Palace to your home screen to get alerts")).toBeInTheDocument();
    expect(inSheet().getByRole("heading", { name: "Add OTD Palace to your home screen" })).toBeInTheDocument();
    expect(inSheet().queryByRole("button", { name: "Turn on alerts" })).toBeNull();
  });

  it("sends a test and says how it went", async () => {
    on({ deals: true });
    renderApp({ snap: withPush() });
    fireEvent.click(bell());
    const test = inSheet().getByRole("button", { name: "Send a test notification" });
    await tap(test);
    expect(mocked.sendTest).toHaveBeenCalledTimes(1);
    expect(inSheet().getByRole("status")).toHaveTextContent("Sent. It should show up in a few seconds.");
    mocked.sendTest.mockResolvedValue("limited");
    await tap(test);
    expect(inSheet().getByRole("status")).toHaveTextContent("Too many tests right now. Try again later.");
  });

  it("the test waits until alerts are on, with at least one alert picked (the server keeps nothing otherwise)", () => {
    on();
    renderApp({ snap: withPush() });
    fireEvent.click(bell());
    expect(inSheet().getByRole("button", { name: "Send a test notification" })).toBeDisabled();
    expect(inSheet().getByText("Pick at least one alert above first.")).toBeInTheDocument();
    fireEvent.click(toggle(/^Last call/));
    expect(inSheet().getByRole("button", { name: "Send a test notification" })).toBeEnabled();
  });

  it("says when the digest falls inside the quiet hours", () => {
    renderApp({ snap: withPush() });
    fireEvent.click(bell());
    fireEvent.click(toggle(/^Daily digest/));
    const hint = "The digest will not be sent: it falls inside your quiet hours.";
    expect(inSheet().queryByText(hint)).toBeNull(); // 9 AM, quiet 11 PM to 7 AM
    fireEvent.change(inSheet().getByRole("combobox", { name: "Digest time" }), { target: { value: "6" } });
    expect(inSheet().getByText(hint)).toBeInTheDocument();
    fireEvent.click(toggle(/^Quiet at night/));
    expect(inSheet().queryByText(hint)).toBeNull();
  });

  it("after a change of server keys, asks to turn alerts on again", async () => {
    seedDevice({ alerts: { ...DEFAULT_ALERTS, deals: true, renew: true } });
    renderApp({ snap: withPush() });
    fireEvent.click(bell());
    expect(inSheet().getByText(/Alerts were switched off after an update on our side/)).toBeInTheDocument();
    await tap(inSheet().getByRole("button", { name: "Turn on alerts" }));
    expect(local.get().alerts).toMatchObject({ on: true, renew: false });
    expect(inSheet().queryByText(/Alerts were switched off after an update on our side/)).toBeNull();
  });

  it("has a reminder for the daily checklist, off by default, synced as one more category and sent at the digest hour", async () => {
    const { advance } = renderApp({ snap: withPush() });
    on();
    fireEvent.click(bell());
    expect(toggle(/^Daily routine reminder/)).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle(/^Daily routine reminder/));
    expect(local.get().alerts.routine).toBe(true);
    await advance(2000);
    expect(mocked.syncRules.mock.calls.at(-1)![0].categories).toMatchObject({ routine: true, digest: false });
    expect(inSheet().getByText("At")).toBeInTheDocument(); // the hour it comes at is the digest's, picked here
    expect(JSON.stringify(mocked.syncRules.mock.calls.at(-1)![0])).not.toMatch(/tick|streak|routine_day/);
  });

  it("picks the digest time and the quiet hours", () => {
    renderApp({ snap: withPush() });
    fireEvent.click(bell());
    fireEvent.click(toggle(/^Daily digest/));
    fireEvent.change(inSheet().getByRole("combobox", { name: "Digest time" }), { target: { value: "7" } });
    fireEvent.change(inSheet().getByRole("combobox", { name: "Quiet from" }), { target: { value: "22" } });
    fireEvent.change(inSheet().getByRole("combobox", { name: "Quiet until" }), { target: { value: "6" } });
    expect(local.get().alerts).toMatchObject({ digest: true, digestHour: 7, quiet: [22, 6] });
    fireEvent.click(toggle(/^Quiet at night/));
    expect(local.get().alerts.quiet).toBeNull();
    expect(inSheet().queryByRole("combobox", { name: "Quiet from" })).toBeNull();
  });

  it("turn off keeps the choices; turn off and delete forgets them", async () => {
    on({ deals: true, digestHour: 7 });
    renderApp({ snap: withPush() });
    fireEvent.click(bell());
    await tap(toggle(/^Alerts on this device/));
    expect(mocked.unsubscribe).toHaveBeenCalledTimes(1);
    expect(local.get().alerts).toMatchObject({ on: false, deals: true, digestHour: 7 });
    await tap(inSheet().getByRole("button", { name: "Turn off and delete my alert settings" }));
    expect(mocked.unsubscribe).toHaveBeenCalledTimes(2);
    expect(local.get().alerts).toEqual(DEFAULT_ALERTS);
    expect(inSheet().getByRole("status")).toHaveTextContent(
      "Your alert settings are deleted from this device and from our server.",
    );
  });

  it("deleting says so honestly when our server could not be reached", async () => {
    on({ deals: true });
    mocked.unsubscribe.mockResolvedValue("device");
    renderApp({ snap: withPush() });
    fireEvent.click(bell());
    await tap(inSheet().getByRole("button", { name: "Turn off and delete my alert settings" }));
    expect(local.get().alerts).toEqual(DEFAULT_ALERTS);
    expect(inSheet().getByRole("status")).toHaveTextContent(
      "We could not reach our server; your settings were removed from this device only.",
    );
    expect(inSheet().getByRole("status")).not.toHaveTextContent("from our server.");
  });

  it("desktop: the bell sits in the sidebar and opens a panel", () => {
    on();
    renderApp({ snap: withPush(), viewport: "desktop" });
    const side = screen.getByRole("complementary", { name: "Menu and filters" });
    fireEvent.click(within(side).getByRole("button", { name: /^Alerts/ }));
    expect(sheet()).toBeInTheDocument();
    expect(toggle(/^Alerts on this device/)).toHaveAttribute("aria-checked", "true");
  });
});
