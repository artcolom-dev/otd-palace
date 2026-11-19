import qrcode from "qrcode-generator";
import { describe, expect, it } from "vitest";
import { qrPath } from "./qr";

describe("qrPath", () => {
  it("draws a scannable QR code as one SVG path of dark modules", () => {
    const url = "https://www.realapp.com/MEtvFkFvDr8";
    const { size, d, viewBox } = qrPath(url);
    const reference = qrcode(0, "M");
    reference.addData(url);
    reference.make();
    expect(size).toBe(reference.getModuleCount());
    const dark: string[] = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (reference.isDark(y, x)) dark.push(`M${x} ${y}h1v1h-1z`);
    expect(d).toBe(dark.join(""));
    expect(d.startsWith("M0 0h1v1h-1z")).toBe(true); // the top-left finder pattern
    expect(viewBox).toBe(`-4 -4 ${size + 8} ${size + 8}`); // the quiet zone scanners need: four modules all round
  });
});
