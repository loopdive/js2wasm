// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #1271 — for...in / Object.keys enumeration over compiled objects.
//
// Investigation finding (2026-05-02): the issue claim that for-in "throws a
// compile error or silently skips all keys" is **stale**. The compiler
// already emits `__for_in_keys`/`__for_in_len`/`__for_in_get` host imports
// (compileForInStatement at loops.ts:3020) and emits a `__struct_field_names`
// export that the JS host runtime uses to enumerate WasmGC struct keys.
// `Object.keys` is compile-time-inlined for known struct shapes
// (compileObjectKeysOrValues at object-ops.ts:2051).
//
// What's required for it to work: the JS host MUST call
// `imports.setExports(instance.exports)` after instantiation so the runtime
// `__for_in_keys` helper can dispatch through `__struct_field_names`. This
// is documented in the runtime contract but easy to miss.
//
// All 4 documented patterns work on main:
//   - `for (const k in {x:1, y:2})` iterates 2 times ✓
//   - `for (const k in anyTyped)` iterates over enumerable props ✓
//   - `Object.keys(o).length` returns the right count ✓
//   - `for (const k in o)` body sees correct key strings ✓
//
// This file locks in the working behavior. Treats #1271 as test-only fix
// similar to #1250, #1275, #1276.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runTest(source: string): Promise<number> {
  const r = compile(source, { fileName: "test.ts", skipSemanticDiagnostics: true, allowJs: true });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  // CRITICAL: provide exports back to runtime so __struct_field_names can
  // dispatch through __for_in_keys for WasmGC struct enumeration.
  if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => number }).test();
}

describe("Issue #1271 — for...in / Object.keys enumeration", () => {
  it("for...in over object literal iterates each key once", async () => {
    const src = `
      export function test(): number {
        const o = { x: 1, y: 2 };
        let n: number = 0;
        for (const k in o) n = n + 1;
        return n;
      }
    `;
    expect(await runTest(src)).toBe(2);
  });

  it("for...in over any-typed object iterates all keys", async () => {
    const src = `
      export function test(): number {
        const o: any = { x: 1, y: 2, z: 3 };
        let n: number = 0;
        for (const k in o) n = n + 1;
        return n;
      }
    `;
    expect(await runTest(src)).toBe(3);
  });

  it("Object.keys returns correct length", async () => {
    const src = `
      export function test(): number {
        const o = { x: 1, y: 2, z: 3 };
        return Object.keys(o).length;
      }
    `;
    expect(await runTest(src)).toBe(3);
  });

  it("for...in body sees correct key strings", async () => {
    const src = `
      export function test(): number {
        const o = { a: 1, b: 2, c: 3 };
        let total: number = 0;
        for (const k in o) {
          if (k === "a") total = total + 1;
          if (k === "b") total = total + 10;
          if (k === "c") total = total + 100;
        }
        return total;
      }
    `;
    expect(await runTest(src)).toBe(111);
  });

  it("for...in over empty object iterates zero times", async () => {
    const src = `
      export function test(): number {
        const o = {} as any;
        let n: number = 0;
        for (const k in o) n = n + 1;
        return n;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  it("for...in with break terminates early", async () => {
    const src = `
      export function test(): number {
        const o = { a: 1, b: 2, c: 3, d: 4 };
        let n: number = 0;
        for (const k in o) {
          if (n === 2) break;
          n = n + 1;
        }
        return n;
      }
    `;
    expect(await runTest(src)).toBe(2);
  });

  it("Object.keys on object literal returns string array (length check)", async () => {
    const src = `
      export function test(): number {
        const o = { p: 0, q: 0 };
        const keys = Object.keys(o);
        if (keys.length !== 2) return -1;
        return keys.length;
      }
    `;
    expect(await runTest(src)).toBe(2);
  });

  it("nested object for...in only iterates top-level keys", async () => {
    const src = `
      export function test(): number {
        const o = { x: { a: 1, b: 2 }, y: 3 };
        let n: number = 0;
        for (const k in o) n = n + 1;
        return n;
      }
    `;
    expect(await runTest(src)).toBe(2);
  });
});
