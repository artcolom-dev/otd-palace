import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDevice, renderApp, seedDevice } from "../test/app";
import { JOKIC, MURRAY, passSnapshot } from "../test/passScene";

const snap = () => passSnapshot();
const card = () => screen.getByRole("region", { name: "Right now" });

describe("Right now on Today", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => vi.useRealTimers());

  it("a visitor holding nothing sees it first, with the moves in order and the day's turnover", () => {
    renderApp({ snap: snap(), viewport: "phone", hash: "today" });
    const first = document.querySelector(".today .slot")!;
    expect(first.getAttribute("data-slot")).toBe("coach");
    const moves = within(card()).getByRole("list", { name: "Your best moves, in order" });
    expect(within(moves).getAllByRole("listitem").length).toBeGreaterThanOrEqual(2);
    expect(within(card()).getByText(/Real's day turns over at about 8:15 am/)).toBeInTheDocument();
    expect(within(card()).getByText(/Take your free pass in each sport that pays now/)).toBeInTheDocument();
    expect(within(card()).queryByRole("button", { name: "Show" })).toBeNull(); // not put away
  });

  it("is first on the desktop too, and says what On This Day and Rax are in one plain line", () => {
    renderApp({ snap: snap(), viewport: "desktop", hash: "today" });
    expect(document.querySelector(".today .lcol .slot")!.getAttribute("data-slot")).toBe("coach");
    expect(within(card()).getByText(/On This Day: a pass pays Rax again on the anniversaries of its player.s games/)).toBeInTheDocument();
  });

  it("explains Real's words of each move with an ⓘ, and offers the cheaper way to a pass", () => {
    renderApp({ snap: snap(), viewport: "phone", hash: "today" });
    expect(within(card()).getByRole("button", { name: "Explain general pass" })).toHaveAttribute("title", expect.stringContaining("pays nothing On This Day"));
    const tips = card().querySelectorAll(".rn-tip");
    expect([...tips].map((t) => t.textContent).join(" ")).toMatch(/Offers under the usual price are the cheapest way to those 10 rating/);
    expect([...tips].map((t) => t.textContent).join(" ")).toMatch(/Cheaper with offers: offer about 20% under the usual price on many of its cards\..*costs about [\d,]+ Rax, not [\d,]+\./);
    expect(within(card()).getAllByRole("button", { name: "Explain offer" }).length).toBeGreaterThan(0);
  });

  it("a small linked account (a Starter) sees it first too, and gets claim words for its sports", () => {
    seedDevice({
      passes: [{ key: JOKIC.key, tier: "common", from: "real" }],
      link: { username: "Shaedon", at: Date.now(), count: 1 },
    });
    renderApp({ snap: snap(), viewport: "phone", hash: "today" });
    expect(document.querySelector(".today .slot")!.getAttribute("data-slot")).toBe("coach");
    expect(within(card()).getByText(/Claim your NBA passes/)).toBeInTheDocument();
  });

  it("a bigger account has it put away with its day, one button opens it", () => {
    seedDevice({
      passes: [{ key: JOKIC.key, tier: "iconic", from: "real" }, { key: MURRAY.key, tier: "iconic", from: "real" }],
      link: { username: "Shaedon", at: Date.now(), count: 2 },
    });
    renderApp({ snap: snap(), viewport: "phone", hash: "today" });
    expect(document.querySelector('[data-slot="coach"] .rn')).toBeNull();
    const c = card();
    expect(c.getAttribute("data-tiny")).toBe("0");
    const toggle = within(c).getByRole("button", { name: "Show" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(c).queryByRole("list", { name: "Your best moves, in order" })).toBeNull();
    fireEvent.click(toggle);
    expect(within(c).getByRole("list", { name: "Your best moves, in order" })).toBeInTheDocument();
    expect(within(c).getByRole("button", { name: "Hide" })).toHaveAttribute("aria-expanded", "true");
  });
});
