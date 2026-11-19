import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFreeze } from "./useFreeze";

function List() {
  const { frozen, bind } = useFreeze();
  return (
    <ul data-testid="list" data-frozen={String(frozen)} {...bind}>
      <li>row</li>
    </ul>
  );
}

const list = () => screen.getByTestId("list");
const frozen = () => list().dataset.frozen === "true";

describe("useFreeze: the list holds still while the visitor is busy with it", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("freezes under a mouse and thaws when it leaves", () => {
    render(<List />);
    expect(frozen()).toBe(false);
    fireEvent.pointerEnter(list(), { pointerType: "mouse" });
    expect(frozen()).toBe(true);
    fireEvent.pointerLeave(list(), { pointerType: "mouse" });
    expect(frozen()).toBe(false);
  });

  it("freezes for a finger on the list, not for the pointer a touch fakes", () => {
    render(<List />);
    fireEvent.pointerEnter(list(), { pointerType: "touch" });
    expect(frozen()).toBe(false);
    fireEvent.touchStart(list());
    expect(frozen()).toBe(true);
    fireEvent.touchEnd(list());
    expect(frozen()).toBe(false);
    fireEvent.touchStart(list());
    fireEvent.touchCancel(list());
    expect(frozen()).toBe(false);
  });

  it("freezes on a scroll and thaws 1.5 s after the last one", () => {
    render(<List />);
    fireEvent.scroll(window);
    expect(frozen()).toBe(true);
    act(() => vi.advanceTimersByTime(1000));
    fireEvent.scroll(window); // a second scroll starts the wait again
    act(() => vi.advanceTimersByTime(1400));
    expect(frozen()).toBe(true);
    act(() => vi.advanceTimersByTime(100));
    expect(frozen()).toBe(false);
  });
});
