import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QrCode } from "./QrPopover";

const qr = vi.hoisted(() => ({ fail: true }));
vi.mock("../lib/qr", async (importOriginal) => {
  if (qr.fail) throw new Error("offline");
  return importOriginal();
});

describe("QrCode while its drawing code is on its way", () => {
  it("shows a shimmering place in the frame, then says it failed and offers another try", async () => {
    const { container } = render(<QrCode url="https://www.realapp.com/a" />);
    expect(container.querySelector(".qrwrap .sk.qr-wait")).not.toBeNull();
    expect(screen.getByRole("img", { name: "Drawing the QR code" })).toBeInTheDocument();
    expect(await screen.findByText("Couldn't draw the code.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Couldn't draw the code.")).toBeInTheDocument();
  });
});
