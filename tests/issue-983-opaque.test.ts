import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CompilerPool } from "../scripts/compiler-pool.js";
import { wrapTest } from "./test262-runner.js";

const TEST262_ROOT = join(import.meta.dirname ?? ".", "..", "test262");

const CASES = [
  "test/built-ins/Array/prototype/splice/set_length_no_args.js",
  "test/built-ins/Array/prototype/pop/clamps-to-integer-limit.js",
  "test/built-ins/Array/prototype/pop/length-near-integer-limit.js",
  "test/built-ins/Array/prototype/push/clamps-to-integer-limit.js",
  "test/built-ins/Array/prototype/push/length-near-integer-limit.js",
  "test/built-ins/Array/prototype/splice/clamps-length-to-integer-limit.js",
  "test/built-ins/Array/prototype/splice/create-non-array.js",
  "test/built-ins/Array/prototype/splice/length-and-deleteCount-exceeding-integer-limit.js",
  "test/built-ins/Array/prototype/splice/length-exceeding-integer-limit-shrink-array.js",
  "test/built-ins/Array/prototype/splice/length-near-integer-limit-grow-array.js",
  "test/built-ins/Array/prototype/unshift/clamps-to-integer-limit.js",
  "test/built-ins/Object/assign/Override.js",
];

describe("#983 opaque wasmGC → host", () => {
  let pool: CompilerPool;

  beforeAll(() => {
    pool = new CompilerPool(1, "unified");
  }, 30_000);

  afterAll(() => {
    pool?.shutdown();
  });

  for (const rel of CASES) {
    it(
      rel,
      async () => {
        const abs = join(TEST262_ROOT, rel);
        const source = readFileSync(abs, "utf8");
        const { source: wrapped } = wrapTest(source);
        const result = await pool.runTest(wrapped, { label: rel });
        if (result.status !== "pass") {
          console.error(`[${rel}] status=${result.status} error=${result.error}`);
        }
        expect(result.status).toBe("pass");
      },
      60_000,
    );
  }
});
