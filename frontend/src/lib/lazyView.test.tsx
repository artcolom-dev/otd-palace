import { act, fireEvent, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";
import appSource from "../App.tsx?raw";
import { ErrorBoundary } from "../views/Crash";
import { lazyView } from "./lazyView";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const Hello = ({ who }: { who: string }) => <p>Hello {who}</p>;

describe("lazyView", () => {
  it("shows the fallback until the view's code has come, then the view", async () => {
    const code = deferred<typeof Hello>();
    const { View } = lazyView(() => code.promise);
    render(
      <Suspense fallback={<p>Loading</p>}>
        <View who="you" />
      </Suspense>,
    );
    expect(screen.getByText("Loading")).toBeInTheDocument();
    await act(async () => code.resolve(Hello));
    expect(screen.getByText("Hello you")).toBeInTheDocument();
  });

  it("renders at once, without the fallback, once preloaded", async () => {
    let loads = 0;
    const { View, preload } = lazyView(async () => {
      loads += 1;
      return Hello;
    });
    await preload();
    await preload();
    render(
      <Suspense fallback={<p>Loading</p>}>
        <View who="again" />
      </Suspense>,
    );
    expect(screen.queryByText("Loading")).toBeNull();
    expect(screen.getByText("Hello again")).toBeInTheDocument();
    expect(loads).toBe(1);
  });

  it("can be asked again after a failed load", async () => {
    let fail = true;
    const { preload } = lazyView(async () => {
      if (fail) throw new Error("chunk missing");
      return Hello;
    });
    await expect(preload()).rejects.toThrow("chunk missing");
    fail = false;
    await expect(preload()).resolves.toBeUndefined();
  });

  it("loads the code again when the view is shown again after a failed load, with no page reload", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined); // React reports the error it caught
    let fail = true;
    let loads = 0;
    const { View, reset } = lazyView(async () => {
      loads += 1;
      if (fail) throw new TypeError("Failed to fetch dynamically imported module");
      return Hello;
    });
    const tryAgain = (retry: () => void) => {
      reset();
      retry();
    };
    render(
      <ErrorBoundary fallback={(retry) => <button onClick={() => tryAgain(retry)}>Try again</button>}>
        <Suspense fallback={<p>Loading</p>}>
          <View who="back" />
        </Suspense>
      </ErrorBoundary>,
    );
    await act(async () => undefined);
    const again = screen.getByRole("button", { name: "Try again" });
    expect(loads).toBe(1); // the failure stays put until asked: no loop of fetches on a dead network
    fail = false;
    fireEvent.click(again);
    await act(async () => undefined);
    expect(screen.getByText("Hello back")).toBeInTheDocument();
    expect(loads).toBe(2);
    vi.restoreAllMocks();
  });

  it("is how the app loads Prices and Passes: neither is in the first bundle", () => {
    expect(appSource).not.toMatch(/from "\.\/views\/(PricesView|PassesView)"/);
  });
});
