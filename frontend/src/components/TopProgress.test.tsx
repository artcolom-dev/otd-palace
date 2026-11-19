import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgress } from "../lib/progress";
import { TopProgress, startNavigation, useProgress, useReconnecting } from "./TopProgress";

const make = () => createProgress({ delayMs: 180, minShowMs: 400, doneMs: 250, longMs: 8000, reducedMotion: () => false });
const barEl = () => document.querySelector(".tprog") as HTMLElement;

function Wait({ bar, on }: { bar: ReturnType<typeof make>; on: boolean }) {
  useProgress(on, bar);
  return null;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("TopProgress", () => {
  it("is hidden from screen readers, takes no room, and shows only after the delay", () => {
    const bar = make();
    const { rerender } = render(
      <>
        <TopProgress bar={bar} />
        <Wait bar={bar} on={false} />
      </>,
    );
    expect(barEl()).toHaveAttribute("aria-hidden", "true");
    expect(barEl().dataset.phase).toBe("idle");
    rerender(
      <>
        <TopProgress bar={bar} />
        <Wait bar={bar} on />
      </>,
    );
    act(() => void vi.advanceTimersByTime(100));
    expect(barEl().dataset.phase).toBe("idle");
    act(() => void vi.advanceTimersByTime(100));
    expect(barEl().dataset.phase).toBe("running");
  });

  it("draws its value as a transform of the inner line (no layout, no inline style string)", () => {
    const bar = make();
    render(
      <>
        <TopProgress bar={bar} />
        <Wait bar={bar} on />
      </>,
    );
    act(() => void vi.advanceTimersByTime(200));
    const line = barEl().firstElementChild as HTMLElement;
    expect(line.style.transform).toMatch(/^scaleX\(0\.\d+\)$/);
  });

  it("a wait held by a component ends when the component lets go, and the bar completes", () => {
    const bar = make();
    function Toggle() {
      const [on, setOn] = useState(true);
      useProgress(on, bar);
      return (
        <button type="button" onClick={() => setOn(false)}>
          stop
        </button>
      );
    }
    render(
      <>
        <TopProgress bar={bar} />
        <Toggle />
      </>,
    );
    act(() => void vi.advanceTimersByTime(1000));
    fireEvent.click(screen.getByText("stop"));
    expect(barEl().dataset.phase).toBe("done");
    act(() => void vi.advanceTimersByTime(250));
    expect(barEl().dataset.phase).toBe("idle");
  });

  it("says a long wait politely, and only a long one", () => {
    const bar = make();
    render(
      <>
        <TopProgress bar={bar} />
        <Wait bar={bar} on />
      </>,
    );
    const status = screen.getByRole("status");
    act(() => void vi.advanceTimersByTime(3000));
    expect(status).toHaveTextContent("");
    act(() => void vi.advanceTimersByTime(5000));
    expect(status).toHaveTextContent(/Still loading/);
  });

  it("runs when a link leaves this page for another one of the site (the Discord sign-in), not for a tab's hash", () => {
    const bar = make();
    render(
      <>
        <TopProgress bar={bar} />
        <a href="/auth/discord?next=%2F">Continue with Discord</a>
        <a href="#deals">Deals</a>
        <a href="https://example.com/x" target="_blank" rel="noreferrer">
          Elsewhere
        </a>
      </>,
    );
    const stay = (e: Event) => e.preventDefault(); // jsdom cannot navigate: stopped after the bar's listener saw it
    window.addEventListener("click", stay);
    try {
      fireEvent.click(screen.getByText("Deals"));
      fireEvent.click(screen.getByText("Elsewhere"));
      act(() => void vi.advanceTimersByTime(500));
      expect(barEl().dataset.phase).toBe("idle");
      fireEvent.click(screen.getByText("Continue with Discord"));
      act(() => void vi.advanceTimersByTime(200));
      expect(barEl().dataset.phase).toBe("running");
    } finally {
      window.removeEventListener("click", stay);
    }
  });

  it("does not run for a click the page handled itself", () => {
    const bar = make();
    render(
      <>
        <TopProgress bar={bar} />
        <a href="/privacy" onClick={(e) => e.preventDefault()}>
          Privacy
        </a>
      </>,
    );
    fireEvent.click(screen.getByText("Privacy"));
    act(() => void vi.advanceTimersByTime(500));
    expect(barEl().dataset.phase).toBe("idle");
  });

  it("does not run for a link opened in a new tab with a modifier key", () => {
    const bar = make();
    render(
      <>
        <TopProgress bar={bar} />
        <a href="/privacy">Privacy</a>
      </>,
    );
    const stay = (e: Event) => e.preventDefault();
    window.addEventListener("click", stay);
    fireEvent.click(screen.getByText("Privacy"), { metaKey: true });
    window.removeEventListener("click", stay);
    act(() => void vi.advanceTimersByTime(500));
    expect(barEl().dataset.phase).toBe("idle");
  });
});

describe("startNavigation", () => {
  it("holds the bar until the page is hidden (another app took over) or a long time passed", () => {
    const bar = make();
    render(<TopProgress bar={bar} />);
    act(() => startNavigation(bar));
    act(() => void vi.advanceTimersByTime(1000));
    expect(barEl().dataset.phase).toBe("running");
    act(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(barEl().dataset.phase).toBe("done");
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    act(() => startNavigation(bar));
    act(() => void vi.advanceTimersByTime(25_000));
    expect(["done", "idle"]).toContain(barEl().dataset.phase);
  });

  it("a page brought back from the browser's cache (back) starts with no bar", () => {
    const bar = make();
    render(<TopProgress bar={bar} />);
    act(() => startNavigation(bar));
    act(() => void vi.advanceTimersByTime(500));
    act(() => {
      const shown = new Event("pageshow") as PageTransitionEvent;
      Object.defineProperty(shown, "persisted", { value: true });
      window.dispatchEvent(shown);
    });
    expect(barEl().dataset.phase).toBe("idle");
  });
});

describe("useReconnecting", () => {
  function Probe({ status }: { status: "live" | "stale" | "loading" }) {
    return <i data-testid="r">{String(useReconnecting(status))}</i>;
  }

  it("is true from the network coming back while the data is paused until it is live again", () => {
    const { rerender } = render(<Probe status="stale" />);
    expect(screen.getByTestId("r")).toHaveTextContent("false");
    act(() => void window.dispatchEvent(new Event("online")));
    expect(screen.getByTestId("r")).toHaveTextContent("true");
    rerender(<Probe status="live" />);
    expect(screen.getByTestId("r")).toHaveTextContent("false");
  });

  it("gives up after a while rather than run for ever", () => {
    render(<Probe status="stale" />);
    act(() => void window.dispatchEvent(new Event("online")));
    act(() => void vi.advanceTimersByTime(15_000));
    expect(screen.getByTestId("r")).toHaveTextContent("false");
  });

  it("means nothing while the data is live", () => {
    render(<Probe status="live" />);
    act(() => void window.dispatchEvent(new Event("online")));
    expect(screen.getByTestId("r")).toHaveTextContent("false");
  });
});
