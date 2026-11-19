// The Node APIs the build helpers and their tests use (there is no @types/node here; see also src/test/node.d.ts).
interface NodeBytes extends Uint8Array {
  toString(encoding?: "utf-8"): string;
}

declare const Buffer: {
  alloc(size: number, fill?: number): NodeBytes;
};
type Buffer = NodeBytes;

declare module "node:fs" {
  export function readFileSync(path: string): NodeBytes;
  export function writeFileSync(path: string, data: string | Uint8Array): void;
  export function mkdirSync(path: string): void;
  export function mkdtempSync(prefix: string): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:zlib" {
  export const constants: {
    BROTLI_PARAM_MODE: number;
    BROTLI_MODE_TEXT: number;
    BROTLI_PARAM_QUALITY: number;
    BROTLI_MAX_QUALITY: number;
    BROTLI_PARAM_SIZE_HINT: number;
  };
  export function brotliCompress(
    data: Uint8Array,
    options: { params?: Record<number, number> },
    callback: (error: Error | null, result: NodeBytes) => void,
  ): void;
  export function brotliDecompressSync(data: Uint8Array): NodeBytes;
}
