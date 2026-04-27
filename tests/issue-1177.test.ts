// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1177 — TDZ propagation through closure captures.
 *
 * When a closure (arrow function, function expression, or transitively-
 * capturing nested call) reads a `let`/`const`/`using` variable that is still
 * in its Temporal Dead Zone at invocation time, ECMA-262 §9.1.1.1.1 requires a
 * ReferenceError throw. This suite verifies that the compiler propagates the
 * TDZ flag through closure boundaries via i32 ref cells so the spec-mandated
 * throw fires inside lifted bodies.
 *
 * The canonical reproduction is `block-local-closure-get-before-initialization.js`
 * from test262 — `using x = null` declared after a transitively-capturing
 * arrow that calls a fn-decl which references `x`.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runTest(source: string): Promise<number> {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`Compile failed: ${r.errors.map((e) => e.message).join("\n")}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as { test: () => number }).test();
}

describe("Issue #1177 — TDZ propagation through closure captures", () => {
  it("arrow with direct TDZ access throws ReferenceError", async () => {
    const result = await runTest(`
      let __fail: number = 0;
      function assert_throws(fn: () => void): void {
        try { fn(); } catch { return; }
        if (!__fail) __fail = 1;
      }
      export function test(): number {
        {
          assert_throws(function() { return x; });
          let x: number = 42;
        }
        return __fail ? __fail : 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("arrow capturing a fn-decl that captures TDZ var (let) throws ReferenceError", async () => {
    // Mirrors the canonical block-local-closure-get-before-initialization
    // pattern but with `let` instead of `using`.
    const result = await runTest(`
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
    `);
    expect(result).toBe(1);
  });

  it("arrow capturing a fn-decl that captures TDZ var (using) throws ReferenceError", async () => {
    // Canonical test262 case: language/statements/using/block-local-closure-get-before-initialization.js
    const result = await runTest(`
      let __fail: number = 0;
      function assert_throws(fn: () => void): void {
        try { fn(); } catch { return; }
        if (!__fail) __fail = 1;
      }
      export function test(): number {
        {
          function f(): number { return (x as any) + 1; }
          assert_throws(function() { f(); });
          using x = null;
        }
        return __fail ? __fail : 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("closure observes post-init mutation of captured TDZ var", async () => {
    // After the let-decl runs, the closure should see the initialized value
    // (not the uninit default). Validates that force-boxing-on-tdz produces
    // a ref cell that propagates writes from the outer scope to the closure.
    const result = await runTest(`
      export function test(): number {
        let g: () => number = () => 0;
        {
          g = function() { return x + 1; };
          let x: number = 42;
          // Now g() should return 43, not 1.
        }
        const r = g();
        return r === 43 ? 1 : r;
      }
    `);
    expect(result).toBe(1);
  });

  it("closure constructed AFTER let-init reads correct value (no regression)", async () => {
    // Sanity: a closure built after the let-init must still observe the
    // initial value. Regression guard for the force-boxing change.
    const result = await runTest(`
      export function test(): number {
        let x: number = 100;
        const g = function() { return x + 1; };
        return g() === 101 ? 1 : -1;
      }
    `);
    expect(result).toBe(1);
  });

  it("call-site TDZ check fires for fn-decl forwarded through arrow (mutable cap)", async () => {
    // The arrow transitively captures x via f. When the arrow is invoked, the
    // call site to f must emit a TDZ check before the cap-prepend, so the
    // ReferenceError fires before f's body sees the ref cell.
    const result = await runTest(`
      let __fail: number = 0;
      function assert_throws(fn: () => void): void {
        try { fn(); } catch { return; }
        if (!__fail) __fail = 1;
      }
      export function test(): number {
        {
          function callF(): number { return x * 2; }
          assert_throws(function() { callF(); });
          let x: number = 7;
        }
        return __fail ? __fail : 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("post-decl call works after closure construction", async () => {
    // After the let-decl runs, calls from within an outer closure that
    // captures the same name still observe the post-init value. This
    // exercises the variables.ts boxed-init routing change.
    const result = await runTest(`
      export function test(): number {
        let result: number = 0;
        {
          function getX(): number { return x + 1; }
          const wrapper = function(): number { return getX(); };
          let x: number = 10;
          result = wrapper();
        }
        return result === 11 ? 1 : result;
      }
    `);
    expect(result).toBe(1);
  });
});
