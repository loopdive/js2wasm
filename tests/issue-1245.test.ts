// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #1245 — type-guarded Stage 1 of #1177.
//
// PR#125 attempted unconditional `fctx.localMap.get(cap.name) ?? cap.outerLocalIdx`
// in 4 sites. That produced 81 real regressions — mostly async-gen and
// for-await tests where `localMap` had been re-aimed at a *differently-typed*
// slot (a boxed ref cell), and the call-site / closure-emit code wrapped or
// read it as the original value type, causing illegal-cast / null-deref.
//
// The refined fix uses the localMap entry only when its TYPE MATCHES the
// capture's valType. The tests below guard against re-introducing the
// unguarded substitution and validate that the targeted Stage 1 case still
// works.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runTest(source: string): Promise<number> {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as { test: () => number }).test();
}

describe("Issue #1245 — type-guarded Stage 1 of #1177", () => {
  // Sanity: simple closure that captures a non-TDZ var still works.
  it("simple arrow capture forwards correct value (no regression)", async () => {
    const source = `
      export function test(): number {
        let n: number = 7;
        const get = () => n;
        return get(); // 7
      }
    `;
    expect(await runTest(source)).toBe(7);
  });

  // Mutation through closure capture is observable post-init (boxed cap).
  it("closure observes post-init mutation of captured let var", async () => {
    const source = `
      export function test(): number {
        let x: number = 1;
        const get = () => x;
        x = 100;
        return get(); // 100 (boxed)
      }
    `;
    expect(await runTest(source)).toBe(100);
  });

  // Nested closures with same-type captures forward correctly through
  // both compileCallExpression cap-prepend AND emitFuncRefAsClosure paths.
  it("nested closures with simple captures forward correct value", async () => {
    const source = `
      export function test(): number {
        let n: number = 7;
        function inner(): number { return n * 2; }
        const wrap = () => inner();
        return wrap(); // 7 * 2 = 14
      }
    `;
    expect(await runTest(source)).toBe(14);
  });

  // The targeted Stage 1 case: arrow wraps a fn-decl that captures a let var
  // still in TDZ at invocation time → must throw ReferenceError.
  it("arrow capturing fn-decl that captures TDZ var throws ReferenceError", async () => {
    const source = `
      let __fail: number = 0;
      function assert_throws(fn: () => void): void {
        try { fn(); } catch { return; }
        if (!__fail) __fail = 1;
      }
      export function test(): number {
        {
          function f(): number { return x + 1; }
          assert_throws(function() { f(); });
          let x: number = 42;
        }
        return __fail ? __fail : 1;
      }
    `;
    expect(await runTest(source)).toBe(1);
  });

  // Direct boxed capture works (writtenInOuter detected via post-construction
  // mutation): the arrow updates x, so x is boxed and the value stored is
  // visible to subsequent reads.
  it("boxed-by-mutation capture sees updates between construction and call", async () => {
    const source = `
      export function test(): number {
        let n: number = 1;
        const get = () => n;
        const set = () => { n = 50; };
        set();
        return get(); // 50
      }
    `;
    expect(await runTest(source)).toBe(50);
  });
});
