import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { writeBrotli } from "./brotli";

function built(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), "brotli-"));
  mkdirSync(join(dir, "assets"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

describe("the brotli copies the build writes beside its assets", () => {
  it("writes <file>.br for each script, style sheet and svg under assets/, the same bytes once decoded", async () => {
    const script = "export const market = 'palace';\n".repeat(400);
    const style = ".row { color: var(--color-text); }\n".repeat(400);
    const svg = "<svg xmlns='http://www.w3.org/2000/svg'>" + "<path d='M13 26 32 14l19 12'/>".repeat(80) + "</svg>";
    const dir = built({ "assets/index-abc.js": script, "assets/index-def.css": style, "assets/mark-1a2.svg": svg });
    const written = await writeBrotli(dir, ["assets/index-abc.js", "assets/index-def.css", "assets/mark-1a2.svg"]);
    expect(written.sort()).toEqual(["assets/index-abc.js.br", "assets/index-def.css.br", "assets/mark-1a2.svg.br"]);
    for (const [name, body] of [["index-abc.js", script], ["index-def.css", style], ["mark-1a2.svg", svg]] as const) {
      const packed = readFileSync(join(dir, "assets", `${name}.br`));
      expect(brotliDecompressSync(packed).toString()).toBe(body);
      expect(packed.length).toBeLessThan(body.length / 10);
    }
  });

  it("leaves out fonts and images (already compressed), files outside assets/, and files too small to gain", async () => {
    const dir = built({
      "assets/font-abc.woff2": Buffer.alloc(4096, 7),
      "assets/tiny-abc.js": "export{};",
      "index.html": "<!doctype html>" + "<p>palace</p>".repeat(400),
    });
    expect(await writeBrotli(dir, ["assets/font-abc.woff2", "assets/tiny-abc.js", "index.html"])).toEqual([]);
    expect(existsSync(join(dir, "assets", "font-abc.woff2.br"))).toBe(false);
    expect(existsSync(join(dir, "index.html.br"))).toBe(false);
  });
});
