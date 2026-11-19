import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BusyButton } from "./BusyButton";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function Harness({ work = () => new Promise<void>(() => undefined), slow }: { work?: () => Promise<void>; slow?: string }) {
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState(0);
  return (
    <>
      <BusyButton
        type="button"
        className="lnk box"
        busy={busy}
        busyLabel="Unlinking…"
        slowLabel={slow}
        onClick={() => {
          setRuns((n) => n + 1);
          setBusy(true);
          void work().finally(() => setBusy(false));
        }}
      >
        Unlink
      </BusyButton>
      <span data-testid="runs">{runs}</span>
    </>
  );
}

describe("BusyButton", () => {
  it("reads as its label while idle, with no busy state", () => {
    render(<Harness />);
    const b = screen.getByRole("button", { name: "Unlink" });
    expect(b).not.toHaveAttribute("aria-busy");
    expect(b).not.toHaveAttribute("aria-disabled");
  });

  it("says it is working, is marked busy and refuses a second tap, yet keeps the focus", () => {
    render(<Harness />);
    const b = screen.getByRole("button", { name: "Unlink" });
    b.focus();
    fireEvent.click(b);
    fireEvent.click(b);
    fireEvent.click(b);
    expect(screen.getByTestId("runs")).toHaveTextContent("1");
    const busy = screen.getByRole("button", { name: "Unlinking…" });
    expect(busy).toBe(b);
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(busy).not.toBeDisabled(); // a disabled button would drop the focus
    expect(document.activeElement).toBe(busy);
  });

  it("keeps both words in the button, stacked, so its width does not change while it works", () => {
    render(<Harness />);
    const b = screen.getByRole("button", { name: "Unlink" });
    fireEvent.click(b);
    const labels = b.querySelectorAll(".bsy-l");
    expect([...labels].map((l) => l.textContent)).toEqual(["Unlink", "Unlinking…"]);
    expect(labels[0]).toHaveAttribute("aria-hidden", "true");
    expect(labels[1]).not.toHaveAttribute("aria-hidden");
    expect(b.querySelector(".bsy-bar")).toHaveAttribute("aria-hidden", "true");
  });

  it("goes back to its label when the work is over, success or failure", async () => {
    let finish: () => void = () => undefined;
    render(<Harness work={() => new Promise<void>((r) => (finish = r))} />);
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    expect(screen.getByRole("button", { name: "Unlinking…" })).toBeInTheDocument();
    await act(async () => finish());
    expect(screen.getByRole("button", { name: "Unlink" })).not.toHaveAttribute("aria-busy");
  });

  it("says, politely and only after a long wait, that it is still at it", () => {
    render(<Harness slow="Still unlinking…" />);
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    act(() => void vi.advanceTimersByTime(7000));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Unlinking…" })).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(1000));
    expect(screen.getByRole("status")).toHaveTextContent(/taking longer/);
    expect(screen.getByRole("button", { name: "Still unlinking…" })).toBeInTheDocument();
  });

  it("passes a plain disabled through (nothing to do yet), apart from busy", () => {
    render(
      <BusyButton type="button" busy={false} busyLabel="Linking…" disabled>
        Link
      </BusyButton>,
    );
    expect(screen.getByRole("button", { name: "Link" })).toBeDisabled();
  });
});
