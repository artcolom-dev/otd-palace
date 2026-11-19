import qrcode from "qrcode-generator";

const QUIET = 4; // modules of blank margin a scanner needs around the code

/**
 * A QR code for `text` as one SVG path, one 1×1 square per dark module, drawn in a `size`×`size` grid, and the view
 * box that frames it with its quiet zone. It is plain markup (no image, no data: URL), so it passes a strict
 * Content-Security-Policy.
 */
export function qrPath(text: string): { size: number; d: string; viewBox: string } {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  let d = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (qr.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`;
  }
  return { size, d, viewBox: `${-QUIET} ${-QUIET} ${size + 2 * QUIET} ${size + 2 * QUIET}` };
}
