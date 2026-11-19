import { type ComponentType, createElement, lazy } from "react";

type Module<P> = { default: ComponentType<P> };

export interface LazyView<P> {
  View: ComponentType<P>;
  /** Fetches the view's code ahead of the first visit. A failed fetch is forgotten, so it can be tried again. */
  preload: () => Promise<void>;
  /** After a failed load: the next render of `View` imports the code anew. Does nothing otherwise. */
  reset: () => void;
}

/**
 * A view whose code is split from the first bundle: React.lazy, with two differences.
 * - Once its code is in (preloaded, or already shown once) the view renders at once instead of suspending for a
 *   frame: React reads a thenable that settles inside `then` as already resolved.
 * - A failed load (offline, or a deploy replaced the hashed files) is not final. React.lazy keeps a rejection for
 *   good, so `reset` swaps in a fresh lazy component and the next render imports the code anew, with no page
 *   reload. It is not swapped on the rejection itself: React draws the view once more right after it, and that draw
 *   must throw, for the error boundary to show its Try again (a fresh import there would loop on a dead network).
 */
export function lazyView<P extends object>(load: () => Promise<ComponentType<P>>): LazyView<P> {
  let loaded: Module<P> | null = null;
  let pending: Promise<Module<P>> | null = null;
  let failed = false;
  const ready = (module: Module<P>) =>
    ({ status: "fulfilled", value: module, then: (onFulfilled: (m: Module<P>) => void) => onFulfilled(module) }) as unknown as Promise<Module<P>>;
  const fetchCode = (): Promise<Module<P>> =>
    (pending ??= load().then(
      (component) => (loaded = { default: component }),
      (error: unknown) => {
        pending = null;
        failed = true;
        throw error;
      },
    ));
  const fresh = () => lazy(() => (loaded ? ready(loaded) : fetchCode()));
  let current = fresh();
  function View(props: P) {
    return createElement(current, props);
  }
  const reset = () => {
    if (!failed) return;
    failed = false;
    current = fresh();
  };
  return { View, preload: () => fetchCode().then(() => undefined), reset };
}
