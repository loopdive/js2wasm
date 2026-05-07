// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #1314 — `__closure_N` call stack underflow (87 compile errors).
 *
 * Triggers when a lifted-arrow closure has an array binding pattern whose
 * element has a function-call default initializer (e.g. `([x = g()]) => …`).
 *
 * Root cause: `destructureParamArray` had two manual `fctx.body =` swaps
 * (the tuple-struct fast path and the externref-legacy buffer) that held
 * the outer body only as a JS local. The recursive emission inside the
 * swap calls `compileExpression(initializer)` which triggers
 * `ensureLateImport` for `__extern_length`/`__extern_get_idx`/etc.
 * `shiftLateImportIndices` walks `fctx.body` (the inner buffer) +
 * `fctx.savedBodies` (which doesn't include the JS-local outer buffer).
 * Calls already emitted into the outer buffer kept stale `funcIdx` and
 * pointed at whatever shifted into their slot (typically an extern import
 * with a different arity → "not enough arguments on the stack").
 *
 * Fix: replace the manual swaps with `pushBody` / `popBody` so the outer
 * buffer is registered in `fctx.savedBodies` for the duration of the
 * swap. Walker now visits all live buffers and shifts their funcIdx
 * references correctly.
 */
async function run(src: string): Promise<{ exports: Record<string, any> }> {
  const r = compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool) as any;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof imports.setExports === "function") imports.setExports(instance.exports);
  return { exports: instance.exports as Record<string, any> };
}

describe("#1314 — closure destructure with fn-call default validates", () => {
  it("simple repro: const f = ([x = g()]) => x", async () => {
    // Canonical minimum repro from the architect spec.
    await run(`
      function g(): number { return 7; }
      const f = ([x = g()]: any) => x;
      export function test(): number { return f([99]) as number; }
      export function testDefault(): number { return f([] as any) as number; }
    `);
  });

  it("var-binding arrow with fn-call default", async () => {
    await run(`
      function g() { return 1; }
      var f: any;
      f = ([a = g()]: any) => {};
      export function test(): number { f([1]); return 1; }
    `);
  });

  it("let-binding arrow with fn-call default", async () => {
    await run(`
      function g() { return 1; }
      let f: any;
      f = ([a = g()]: any) => {};
      export function test(): number { f([1]); return 1; }
    `);
  });

  it("trifecta: var f, nested elision, generator default", async () => {
    // The original tight repro from the senior-dev's diagnosis.
    await run(`
      function* g() {}
      var f: any;
      f = ([[,] = g()]: any) => {};
      export function test(): number { f([[]] as any); return 1; }
    `);
  });

  it("nested with named binding + fn-call default", async () => {
    await run(`
      function g(): any { return [42]; }
      var f: any;
      f = ([[a] = g()]: any) => {};
      export function test(): number { f([[1]] as any); return 1; }
    `);
  });

  it("multiple elements with fn-call defaults (stress: many late-import shifts)", async () => {
    await run(`
      function g(): number { return 1; }
      function h(): number { return 2; }
      const f = ([x = g(), y = h(), z = g()]: any) => x + y + z;
      export function test(): number { return f([10, 20, 30]) as number; }
    `);
  });

  it("async-fn default", async () => {
    await run(`
      async function g(): Promise<number> { return 1; }
      var f: any;
      f = ([a = g()]: any) => {};
      export function test(): number { f([1]); return 1; }
    `);
  });
});
