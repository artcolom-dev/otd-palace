// The Node APIs the tests use (there is no @types/node here): reading the golden vectors the Python engine is
// checked against, from the repository.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf-8"): string;
  export function existsSync(path: string): boolean;
}

declare module "node:process" {
  export function cwd(): string;
}

declare module "node:vm" {
  export function runInNewContext(code: string, context: object, options?: { filename?: string }): unknown;
}

// The time zone a test sets to check the device's calendar day across clock changes.
declare const process: { env: Record<string, string | undefined> };
