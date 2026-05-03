// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1304 — typeof on externref-wrapped JS function returns "object" instead
// of "function". Surfaced in lodash Tier 2 calling negate(predicate) from JS.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

interface RunResult {
  exports: Record<string, Function>;
}

async function run(src: string): Promise<RunResult> {
  const result = compile(src, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`compile failed:\n${result.errors.map((e) => `  L${e.line}:${e.column} ${e.message}`).join("\n")}`);
  }
  const importResult = buildImports(result.imports as never, undefined, result.stringPool);
  const inst = await WebAssembly.instantiate(result.binary, importResult as never);
  if (typeof (importResult as { setExports?: Function }).setExports === "function") {
    (importResult as { setExports: Function }).setExports(inst.instance.exports);
  }
  return { exports: inst.instance.exports as Record<string, Function> };
}

describe("#1304 typeof on externref-wrapped function", () => {
  /**
   * Canonical repro: JS passes a function into Wasm, and the compiled
   * `typeof` operation classifies that externref. lodash's `negate`
   * does this exact `typeof predicate != 'function'` guard.
   */
  it("typeof === 'function' on a JS function passed as externref", async () => {
    const { exports } = await run(`
      export function checkFn(p: any): number {
        if (typeof p === "function") return 1;
        return 0;
      }
    `);
    // pass a real JS function
    expect(exports.checkFn!((n: number) => n + 1)).toBe(1);
  });

  /**
   * Negated form — `typeof p != 'function'` should be FALSE for a JS
   * function (matches the lodash idiom that triggered the bug).
   */
  it("typeof !== 'function' is false for a JS function", async () => {
    const { exports } = await run(`
      export function isNotFn(p: any): number {
        return typeof p !== "function" ? 1 : 0;
      }
    `);
    expect(exports.isNotFn!((n: number) => n + 1)).toBe(0);
  });

  /**
   * Plain object should still classify as "object" — guard against
   * over-broad fix.
   */
  it("typeof === 'object' on a plain object", async () => {
    const { exports } = await run(`
      export function checkObj(p: any): number {
        if (typeof p === "object") return 1;
        return 0;
      }
    `);
    expect(exports.checkObj!({ a: 1 })).toBe(1);
    expect(exports.checkObj!((x: number) => x)).toBe(0); // function is not "object"
  });

  /**
   * Number should still classify as "number".
   */
  it("typeof === 'number' on a JS number", async () => {
    const { exports } = await run(`
      export function checkNum(p: any): number {
        if (typeof p === "number") return 1;
        return 0;
      }
    `);
    expect(exports.checkNum!(42)).toBe(1);
    expect(exports.checkNum!((x: number) => x)).toBe(0);
  });

  /**
   * Reproduces the lodash `negate` constant-folding bug: TypeScript
   * infers `predicate`'s type as the global `Function` interface (from
   * usage like `predicate.call(this, ...)`). Before the fix,
   * `staticTypeofForType` returned `"object"` for `Function`-typed
   * values, so the guard `if (typeof predicate != 'function') throw ...`
   * folded to an unconditional throw at compile time. The fix maps the
   * `Function` symbol to `"function"` so the guard short-circuits the
   * way idiomatic JS code expects.
   */
  it("Function-typed param doesn't fold typeof guard to always-throw (lodash negate idiom)", async () => {
    const { exports } = await run(`
      // Mirror lodash negate: param used as a callable, no annotation.
      export function negate(predicate: Function): number {
        if (typeof predicate !== "function") {
          // Throwing would fire the start-function trap if folded incorrectly.
          throw new TypeError("Expected a function");
        }
        return 42;
      }
    `);
    // If the compile-time fold was wrong, this would throw at runtime
    // (the WAT would have an i32.const 1 + throw before any runtime
    // typeof check). Passing means the guard correctly classifies the
    // JS function as "function".
    expect(exports.negate!((n: number) => n + 1)).toBe(42);
  });
});
