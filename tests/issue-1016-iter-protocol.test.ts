/**
 * Issue #1016 — Iterator protocol null access
 *
 * Tests that array destructuring params use the full iterator protocol
 * when called with custom iterables, and correctly implement the close protocol
 * (calling return() when pattern doesn't exhaust the iterator).
 */
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";
import { readFileSync } from "fs";
import { parseMeta, wrapTest } from "./test262-runner.js";

async function runTest262File(file: string): Promise<"PASS" | string> {
  const src = readFileSync(file, "utf-8");
  const meta = parseMeta(src);
  const { source: wrapped } = wrapTest(src, meta);
  let exports: Record<string, Function>;
  try {
    exports = await compileToWasm(wrapped);
  } catch (e: any) {
    return "COMPILE_ERROR: " + (e?.message ?? String(e)).slice(0, 300);
  }
  try {
    const testFn = exports["test"] as (() => unknown) | undefined;
    if (!testFn) return "MISSING_EXPORT_test";
    testFn();
    return "PASS";
  } catch (e: any) {
    return "RUNTIME_ERROR: " + (e?.message ?? String(e)).slice(0, 300);
  }
}

describe("Issue #1016 — Iterator protocol for array destructuring params", () => {
  it("iter-close: return() called when pattern does not exhaust iterator", async () => {
    const result = await runTest262File(
      "/workspace/test262/test/language/expressions/class/dstr/meth-ary-init-iter-close.js",
    );
    expect(result).toBe("PASS");
  });

  it("iter-no-close: return() NOT called when iterator is exhausted", async () => {
    const result = await runTest262File(
      "/workspace/test262/test/language/expressions/class/dstr/meth-ary-init-iter-no-close.js",
    );
    expect(result).toBe("PASS");
  });

  it("rest-obj-id: rest element with object binding works", async () => {
    const result = await runTest262File(
      "/workspace/test262/test/language/expressions/class/dstr/meth-ary-ptrn-rest-obj-id.js",
    );
    expect(result).toBe("PASS");
  });

  it("rest-ary-elision: rest element with array elision works", async () => {
    const result = await runTest262File(
      "/workspace/test262/test/language/expressions/class/dstr/meth-ary-ptrn-rest-ary-elision.js",
    );
    expect(result).toBe("PASS");
  });

  it("basic: simple [x] param from custom iterable", async () => {
    let result: string;
    try {
      const exports = await compileToWasm(`
        export function test(): number {
          class C {
            method([x]: Iterable<number>): number {
              return x;
            }
          }
          const iter = {
            [Symbol.iterator]() {
              let n = 0;
              return {
                next() { return n++ === 0 ? { value: 42, done: false } : { value: 0, done: true }; },
              };
            }
          };
          return new C().method(iter);
        }
      `);
      const val = (exports["test"] as () => number)();
      result = val === 42 ? "PASS" : "FAIL(" + val + ")";
    } catch (e: any) {
      result = "ERROR: " + String(e).slice(0, 200);
    }
    expect(result).toBe("PASS");
  });
});
