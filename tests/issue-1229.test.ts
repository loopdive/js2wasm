// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #1229 — eval / RegExp performance:
//
//   1. LRU cache in __extern_eval host shim (`src/runtime-eval.ts`):
//      same source → reuse compiled module + instance. Drops cold-compile
//      cost (~150ms) to single-instr-call cost (~10µs) for repeated evals.
//   2. Negative cache for parse failures: same bad source → throw cached
//      SyntaxError without re-running the parser.
//   3. Peephole rewrite in `src/codegen/expressions/calls.ts`:
//      `eval("/" + X + "/")` → `new RegExp(X)` — bypasses the eval pipeline
//      entirely for the test262 BMP-codepoint regex pattern.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { createEvalShim } from "../src/runtime-eval.js";

async function compileAndInstantiate(source: string): Promise<Record<string, Function>> {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, built);
  if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

describe("#1229 — eval / RegExp performance", () => {
  describe("Half 1: __extern_eval LRU cache", () => {
    it("caches compiled modules: 100 calls with same source ≪ 100× cold compile", () => {
      const evalShim = createEvalShim({});
      // Cold compile (~100-200ms)
      const cold0 = performance.now();
      evalShim("1 + 2", 0);
      const coldElapsed = performance.now() - cold0;

      // 100 cached calls — each should be sub-millisecond
      const warm0 = performance.now();
      for (let i = 0; i < 100; i++) evalShim("1 + 2", 0);
      const warmElapsed = performance.now() - warm0;

      // Sanity: cold compile should be substantially slower than 100 cached calls
      // (typically 1000x+, but allow 10x to be conservative across CI runners).
      expect(warmElapsed * 10).toBeLessThan(coldElapsed * 100);
      // Also a hard upper bound: 100 cached calls < 50ms on any reasonable runner.
      expect(warmElapsed).toBeLessThan(50);
    });

    it("returns the same value on each cached call", () => {
      const evalShim = createEvalShim({});
      const results = [];
      for (let i = 0; i < 10; i++) results.push(evalShim("3 + 4", 0));
      expect(results).toEqual([7, 7, 7, 7, 7, 7, 7, 7, 7, 7]);
    });

    it("different sources each get their own cache entry", () => {
      const evalShim = createEvalShim({});
      expect(evalShim("1 + 1", 0)).toBe(2);
      expect(evalShim("2 + 2", 0)).toBe(4);
      expect(evalShim("3 + 3", 0)).toBe(6);
      // Re-call the first — should still work via cache.
      expect(evalShim("1 + 1", 0)).toBe(2);
    });

    it("non-string input bypasses cache (per spec, returns input unchanged)", () => {
      const evalShim = createEvalShim({});
      expect(evalShim(42 as unknown as string, 0)).toBe(42);
      expect(evalShim(null as unknown as string, 0)).toBe(null);
      expect(evalShim(undefined as unknown as string, 0)).toBe(undefined);
    });
  });

  describe("Half 1b: __extern_eval negative cache", () => {
    it("caches SyntaxError for repeated parse failures", () => {
      const evalShim = createEvalShim({});
      // Source that the parser rejects (unbalanced brace).
      const badSrc = "function f() { return 1;";
      let firstError: Error | null = null;
      try {
        evalShim(badSrc, 0);
      } catch (e: unknown) {
        firstError = e as Error;
      }
      expect(firstError).toBeInstanceOf(SyntaxError);

      // Second call with same bad source — should also throw SyntaxError.
      // The negative cache throws the same instance back (cheap path).
      let secondError: Error | null = null;
      try {
        evalShim(badSrc, 0);
      } catch (e: unknown) {
        secondError = e as Error;
      }
      expect(secondError).toBeInstanceOf(SyntaxError);
      // The cached SyntaxError instance is reused, so identity holds.
      expect(secondError).toBe(firstError);
    });
  });

  describe('Half 3: eval("/" + X + "/") peephole rewrite', () => {
    // Compile-test that the peephole produces a RegExp when the AST shape
    // matches. Verified end-to-end via .source / .flags / .test() on the
    // returned object.

    it("produces a RegExp from `eval('/' + X + '/')` with literal X", async () => {
      const exports = await compileAndInstantiate(`
        export function makeRegex(): any {
          const x: string = "abc";
          return eval("/" + x + "/");
        }
        export function getSource(): any {
          const r: any = makeRegex();
          return r.source;
        }
      `);
      expect((exports.getSource as () => string)()).toBe("abc");
    });

    it("handles dynamic X (variable that varies)", async () => {
      const exports = await compileAndInstantiate(`
        export function makeRegex(s: string): any {
          return eval("/" + s + "/");
        }
        export function checkBoth(): any {
          const r1: any = makeRegex("foo");
          const r2: any = makeRegex("bar");
          return (r1.source === "foo" && r2.source === "bar") ? 1 : 0;
        }
      `);
      expect((exports.checkBoth as () => number)()).toBe(1);
    });

    it("non-matching shape (e.g. eval(literal) without slash fence) still works via fallback", async () => {
      // Plain eval of a numeric expression — peephole shouldn't fire,
      // standard eval pipeline takes over.
      const exports = await compileAndInstantiate(`
        export function plainEval(): any {
          return eval("3 + 4");
        }
      `);
      expect((exports.plainEval as () => number)()).toBe(7);
    });

    it("`eval('/x/' + flag)` (different shape) does NOT match the peephole", async () => {
      // The peephole only fires for the exact shape `'/' + X + '/'`.
      // A regex with flags should fall through to the eval pipeline.
      const exports = await compileAndInstantiate(`
        export function makeWithFlag(): any {
          const x: string = "abc";
          return eval("/" + x + "/" + "i");
        }
        export function getFlag(): any {
          const r: any = makeWithFlag();
          return r.flags;
        }
      `);
      expect((exports.getFlag as () => string)()).toBe("i");
    });
  });
});
