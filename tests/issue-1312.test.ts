// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1312 — recursive function passed as a parameter (compose pattern) failed
// with "TypeError: Cannot access property on null or undefined" in the inner
// recursive call.
//
// Root cause: nested function declarations were registered in `funcMap` AFTER
// their body finished compiling. References to the function inside its own
// body (e.g. `function next() { return call(next); }`) reached the funcMap
// lookup in `compileIdentifier`, missed (because the entry didn't exist yet),
// and fell through to the graceful `ref.null.extern` fallback. The compiled
// wasm then called `call(ref.null extern)`, which null-derefed.
//
// In the captures-having branch, even after pre-registering, the closure
// materialization at `emitFuncRefAsClosure` would try to source captures via
// `cap.outerLocalIdx` — a local index in the OUTER (declaring) scope. From
// inside the lifted function's own body that index points to a different
// local, producing garbage / null captures.
//
// Fix (src/codegen/statements/nested-declarations.ts +
// src/codegen/closures.ts):
// 1. Pre-register `funcMap` and `nestedFuncCaptures` BEFORE compiling the
//    nested function's body, by reserving a placeholder `mod.functions[]`
//    entry up-front and filling in `body`/`locals` after the compile.
// 2. In `emitFuncRefAsClosure`, when materializing a self-reference (i.e.
//    `fctx.name === funcName`), source captures from the lifted fn's own
//    leading params (indices `[0..numCaptures-1]` for value captures and
//    `[numCaptures..]` for TDZ-flag boxes) instead of `cap.outerLocalIdx`.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

interface RunResult {
  exports: Record<string, Function>;
}

async function run(source: string): Promise<RunResult> {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed:\n${r.errors.map((e) => `  L${e.line}:${e.column} ${e.message}`).join("\n")}`);
  }
  new WebAssembly.Module(r.binary);
  const imports: any = buildImports(r.imports as never, undefined, r.stringPool);
  const inst = await WebAssembly.instantiate(r.binary, imports);
  if (typeof imports.setExports === "function") imports.setExports(inst.instance.exports);
  return { exports: inst.instance.exports as Record<string, Function> };
}

describe("#1312 — recursive nested fn passed-as-param self-references its own closure", () => {
  /**
   * Tier 5c-shaped sync compose. `next` captures `i` (mutable ref-cell),
   * recursively passes itself through `mw(c, next)`. The middleware
   * receives `next` and calls it again. Each call advances `i` and the
   * pipeline terminates at `i >= length`. Output is constructed by
   * string concatenation across the recursion levels.
   */
  it("sync compose with two arrow middlewares produces ordered output", async () => {
    const { exports } = await run(`
      class Context {
        path: string;
        constructor(p: string) { this.path = p; }
      }
      type N = () => string;
      type Mw = (c: Context, n: N) => string;

      function compose(mws: Mw[]): (c: Context) => string {
        return (c: Context) => {
          let i = 0;
          function next(): string {
            const idx = i;
            i = i + 1;
            if (idx >= mws.length) return "end";
            const mw = mws[idx];
            return mw(c, next);
          }
          return next();
        };
      }

      export function test(): string {
        const mws: Mw[] = [
          (c, n) => "[A]" + n(),
          (c, n) => "[B]" + n(),
        ];
        return compose(mws)(new Context("/x"));
      }
    `);
    expect(exports.test!()).toBe("[A][B]end");
  });

  /**
   * Async version of the same compose pattern. Each middleware awaits
   * `next()` so the recursion threads through Promise resolution.
   */
  it("async compose with two arrow middlewares produces ordered output", async () => {
    const { exports } = await run(`
      class Context {
        path: string;
        constructor(p: string) { this.path = p; }
      }
      type N = () => Promise<string>;
      type Mw = (c: Context, n: N) => Promise<string>;

      function compose(mws: Mw[]): (c: Context) => Promise<string> {
        return async (c: Context) => {
          let i = 0;
          async function next(): Promise<string> {
            const idx = i;
            i = i + 1;
            if (idx >= mws.length) return "end";
            const mw = mws[idx];
            return await mw(c, next);
          }
          return await next();
        };
      }

      export async function test(): Promise<string> {
        const mws: Mw[] = [
          async (c, n) => "[A]" + await n(),
          async (c, n) => "[B]" + await n(),
        ];
        return await compose(mws)(new Context("/x"));
      }
    `);
    const v = await exports.test!();
    expect(v).toBe("[A][B]end");
  });

  /**
   * Minimal async self-recursion that DOES NOT pass `next` as a parameter
   * (named recursion via direct call). This already worked pre-fix and
   * must keep working.
   */
  it("regression guard: direct named async recursion still works", async () => {
    const { exports } = await run(`
      async function f(n: number): Promise<number> {
        if (n <= 0) return 0;
        return n + await f(n - 1);
      }
      export async function test(): Promise<number> {
        return await f(3);
      }
    `);
    const v = await exports.test!();
    expect(v).toBe(6);
  });

  /**
   * Inner recursive function with mutable ref-cell capture, passed as
   * parameter to a sibling function that calls it. This is the synchronous
   * sibling of the compose pattern; before #1312 it returned 0 because
   * the recursion's closure had a stale (zero-initialised) ref-cell
   * instead of the live outer one.
   */
  it("sync inner recursion via param with mutable ref-cell capture", async () => {
    const { exports } = await run(`
      type N = () => number;
      function call(fn: N): number {
        return fn();
      }
      export function test(): number {
        let counter = 3;
        function next(): number {
          counter = counter - 1;
          if (counter < 0) return 0;
          return 1 + call(next);
        }
        return next();
      }
    `);
    // counter: 3 → 2 → 1 → 0 → -1; recurses 3 times before base case
    // returns 1 + 1 + 1 + 0 = 3
    expect(exports.test!()).toBe(3);
  });

  /**
   * Same shape as the previous case but async (the headline #1312
   * reproducer minus the middleware indirection). Verifies the bug isn't
   * reintroduced via the async lowering.
   */
  it("async inner recursion via param with mutable ref-cell capture", async () => {
    const { exports } = await run(`
      type N = () => Promise<number>;
      async function call(fn: N): Promise<number> {
        return await fn();
      }
      export async function test(): Promise<number> {
        let counter = 3;
        async function next(): Promise<number> {
          counter = counter - 1;
          if (counter < 0) return 0;
          return 1 + await call(next);
        }
        return await next();
      }
    `);
    const v = await exports.test!();
    expect(v).toBe(3);
  });
});
