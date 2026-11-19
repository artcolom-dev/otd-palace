// Build-time only (vite.config.ts): the brotli copies of the fingerprinted scripts, style sheets and svgs. The server
// sends `<file>.br` to a browser that names br (every phone browser over https), gzip to the others: brotli at its
// best level is about 14 % smaller than gzip -9 on this site's code, and costs the server nothing per request.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompress, constants } from "node:zlib";

const PACKED = /^assets\/[^/]+\.(?:js|css|svg)$/;
const MIN_BYTES = 1024; // under this, the saving is less than the headers

/** Writes `<file>.br` beside each of `files` (paths relative to `dir`) worth it, compressing them in parallel (Node's
 * thread pool: the best level takes seconds on the site's code); resolves to the paths written. */
export async function writeBrotli(dir: string, files: readonly string[]): Promise<string[]> {
  const jobs = files
    .filter((file) => PACKED.test(file))
    .map(async (file) => {
      const body = readFileSync(join(dir, file));
      if (body.length < MIN_BYTES) return null;
      const packed = await new Promise<Uint8Array>((resolve, reject) =>
        brotliCompress(
          body,
          {
            params: {
              [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
              [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
              [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
            },
          },
          (error, result) => (error ? reject(error) : resolve(result)),
        ),
      );
      if (packed.length >= body.length) return null;
      writeFileSync(join(dir, `${file}.br`), packed);
      return `${file}.br`;
    });
  return (await Promise.all(jobs)).filter((file): file is string => file !== null);
}
