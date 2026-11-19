import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noteBuild, pageBuild, resetFreshBuild } from "./freshBuild";

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("freshBuild", () => {
  beforeEach(() => {
    resetFreshBuild();
    setHidden(false);
  });
  afterEach(() => {
    document.head.innerHTML = "";
    setHidden(false);
  });

  it("reads this page's build from its entry script", () => {
    expect(pageBuild()).toBeNull();
    document.head.innerHTML = '<script type="module" src="/assets/index-Ab12_c-D.js"></script>';
    expect(pageBuild()).toBe("index-Ab12_c-D.js");
  });

  it("waits until the page is hidden, then reloads once for that build", () => {
    const reload = vi.fn();
    const env = { doc: document, own: "index-old.js", reload };
    noteBuild("index-new.js", env);
    noteBuild("index-new.js", env); // the next polls say it again
    expect(reload).not.toHaveBeenCalled();
    setHidden(true);
    expect(reload).toHaveBeenCalledTimes(1);
    noteBuild("index-new.js", env); // a page that came back still old (a cache): no loop
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads at once when the page is hidden already", () => {
    const reload = vi.fn();
    setHidden(true);
    noteBuild("index-new.js", { doc: document, own: "index-old.js", reload });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does nothing on the same build, without a build, or without its own (the dev server)", () => {
    const reload = vi.fn();
    setHidden(true);
    noteBuild("index-same.js", { doc: document, own: "index-same.js", reload });
    noteBuild(null, { doc: document, own: "index-old.js", reload });
    noteBuild("index-new.js", { doc: document, own: null, reload });
    expect(reload).not.toHaveBeenCalled();
  });
});
