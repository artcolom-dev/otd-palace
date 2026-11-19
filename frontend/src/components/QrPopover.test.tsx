import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QrCode } from "./QrPopover";

describe("QrCode", () => {
  it("draws the code once the generator has loaded, in a frame that was already there", async () => {
    const { container, rerender } = render(<QrCode url="https://www.realapp.com/a" />);
    expect(container.querySelector(".qrwrap")).not.toBeNull(); // the frame holds its size before the code arrives
    const first = await screen.findByRole("img", { name: "QR code for this auction" });
    const before = first.querySelector("path")!.getAttribute("d");
    expect(before).toMatch(/^M\d+ \d+h1v1h-1z/);
    rerender(<QrCode url="https://www.realapp.com/b" />);
    await screen.findByRole("img", { name: "QR code for this auction" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.querySelector("path")!.getAttribute("d")).not.toBe(before); // another auction, another code
  });
});
