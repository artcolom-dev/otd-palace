import { afterEach, describe, expect, it } from "vitest";
import { STORAGE_KEY, firstTab, rememberedTab, tabFromAddress, tabFromHash, tabFromPath, tabPath } from "./tabHint";

afterEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/");
});

describe("tabHint", () => {
  it("reads the tab an old address names, old names included, and none for a broken or unknown one", () => {
    history.replaceState(null, "", "/#plan");
    expect(tabFromHash()).toBe("plan");
    history.replaceState(null, "", "/#OTD");
    expect(tabFromHash()).toBe("passes");
    history.replaceState(null, "", "/#market");
    expect(tabFromHash()).toBe("prices");
    history.replaceState(null, "", "/#%");
    expect(tabFromHash()).toBeNull();
    history.replaceState(null, "", "/#nope");
    expect(tabFromHash()).toBeNull();
  });

  it("gives each tab its own path, Today the bare address", () => {
    expect(tabPath("today")).toBe("/");
    expect(tabPath("deals")).toBe("/deals");
    expect(tabPath("prices")).toBe("/prices");
    expect(tabPath("passes")).toBe("/passes");
    expect(tabPath("plan")).toBe("/plan");
  });

  it("reads the tab a path names; the bare address and any other path name none", () => {
    expect(tabFromPath("/deals")).toBe("deals");
    expect(tabFromPath("/prices")).toBe("prices");
    expect(tabFromPath("/passes")).toBe("passes");
    expect(tabFromPath("/plan")).toBe("plan");
    for (const path of ["/", "/today", "/admin", "/deals/", "/Deals", "/market", "/d/101", ""]) {
      expect(tabFromPath(path), path).toBeNull();
    }
    history.replaceState(null, "", "/passes");
    expect(tabFromPath()).toBe("passes");
  });

  it("lets an old #tab link win over the path it was opened on", () => {
    history.replaceState(null, "", "/deals#plan");
    expect(tabFromAddress()).toBe("plan");
    history.replaceState(null, "", "/deals#how/fees");
    expect(tabFromAddress()).toBe("deals");
    history.replaceState(null, "", "/#account/someone");
    expect(tabFromAddress()).toBeNull();
  });

  it("falls back to the remembered tab, else Today", () => {
    expect(rememberedTab()).toBe("today");
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tab: "passes" }));
    expect(rememberedTab()).toBe("passes");
    expect(firstTab()).toBe("passes");
    history.replaceState(null, "", "/#plan");
    expect(firstTab()).toBe("plan");
    history.replaceState(null, "", "/prices");
    expect(firstTab()).toBe("prices");
    localStorage.setItem(STORAGE_KEY, "{broken");
    history.replaceState(null, "", "/");
    expect(firstTab()).toBe("today");
  });
});
