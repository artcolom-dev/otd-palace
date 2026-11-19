import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeal } from "../test/fixtures";
import { shareDeal, shareUrl } from "./share";

const deal = makeDeal({ listing_id: 4521, player_name: "Nikola Jokić", price: 150, reference: 228, discount: 0.342 });

afterEach(() => vi.restoreAllMocks());

describe("shareUrl", () => {
  it("is the deal's public page on this site", () => {
    expect(shareUrl(4521, "https://palace.example")).toBe("https://palace.example/d/4521");
  });
});

describe("shareDeal", () => {
  it("uses the share sheet when the browser has one", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn();
    const out = await shareDeal(deal, { share, clipboard: { writeText } } as unknown as Navigator, "https://p.example");
    expect(out).toEqual({ result: "shared", url: "https://p.example/d/4521" });
    expect(share).toHaveBeenCalledWith({
      title: "Nikola Jokić · OTD Palace",
      text: "Nikola Jokić: 150 Rax to start, 34% under the usual price.",
      url: "https://p.example/d/4521",
    });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("says bid for an auction", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    await shareDeal({ ...deal, kind: "bid" }, { share } as unknown as Navigator, "https://p.example");
    expect(share.mock.calls[0]?.[0].text).toContain("top bid");
  });

  it("is a quiet no when the visitor closes the share sheet", async () => {
    const share = vi.fn().mockRejectedValue(new DOMException("closed", "AbortError"));
    const writeText = vi.fn();
    const out = await shareDeal(deal, { share, clipboard: { writeText } } as unknown as Navigator, "https://p.example");
    expect(out.result).toBe("cancelled");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("copies the link when there is no share sheet", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const out = await shareDeal(deal, { clipboard: { writeText } } as unknown as Navigator, "https://p.example");
    expect(out).toEqual({ result: "copied", url: "https://p.example/d/4521" });
    expect(writeText).toHaveBeenCalledWith("https://p.example/d/4521");
  });

  it("copies the link when the share sheet breaks for another reason", async () => {
    const share = vi.fn().mockRejectedValue(new TypeError("no"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    const out = await shareDeal(deal, { share, clipboard: { writeText } } as unknown as Navigator, "https://p.example");
    expect(out.result).toBe("copied");
  });

  it("hands the link back to be copied by hand when nothing can copy it", async () => {
    expect((await shareDeal(deal, {} as Navigator, "https://p.example")).result).toBe("failed");
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const out = await shareDeal(deal, { clipboard: { writeText } } as unknown as Navigator, "https://p.example");
    expect(out).toEqual({ result: "failed", url: "https://p.example/d/4521" });
  });
});
