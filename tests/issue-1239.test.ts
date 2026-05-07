// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1239 — Object literals with get/set accessor declarations must compile
// to a JS host object (via __new_plain_object + __defineProperty_accessor)
// rather than a wasmGC struct. Pre-fix, the compiler routed every literal
// through `compileObjectLiteralForStruct`, registered an i32/f64 field for
// each accessor key, and silently dropped the body. At runtime, V8 read
// `Get(o, "x")` via the externref bridge and got the field's default
// value (0/null/undefined) — the getter body never ran.
//
// Fix path: detect GetAccessorDeclaration / SetAccessorDeclaration in
// `compileObjectLiteral`, route through `compileObjectLiteralWithAccessors`
// (literals.ts), and force-tag the receiving variable as externref via
// `ctx.externrefAccessorVars` so all subsequent accesses go through the
// host path that honours the accessor descriptor.
//
// Hoisting: the let/const TDZ pre-pass at index.ts:hoistLetConstWithTdz
// also consults the initializer to pick the right local wasm type
// up-front, so the hoisted slot stays in sync with what
// compileObjectLiteralWithAccessors will emit.

import { describe, it, expect } from "vitest";

import { compileAndInstantiate } from "../src/runtime.js";

async function runTest(src: string): Promise<unknown> {
  const exports = await compileAndInstantiate(src);
  return (exports as Record<string, () => unknown>).test?.();
}

describe("#1239 — object-literal accessor declarations", () => {
  it("getter body fires on property read", async () => {
    const got = await runTest(`
      export function test(): number {
        const o = {
          get v(): number { return 42; },
        };
        return (o as any).v;
      }
    `);
    expect(got).toBe(42);
  });

  it("getter that throws unwinds correctly (acceptance criterion 1)", async () => {
    const got = await runTest(`
      class StopErr extends Error {}
      export function test(): string {
        const o = {
          get x(): number { throw new StopErr(); },
        };
        try {
          const _ = (o as any).x;
          return "no-throw";
        } catch (e) {
          return "threw";
        }
      }
    `);
    expect(got).toBe("threw");
  });

  it("paired get/set on the same name — write triggers setter, read triggers getter", async () => {
    const got = await runTest(`
      export function test(): number {
        const o: any = {
          _v: 0,
          get v(): number { return this._v; },
          set v(x: number) { this._v = x * 2; },
        };
        o.v = 5;
        return o.v;
      }
    `);
    expect(got).toBe(10);
  });

  it("multiple value props + accessors interleaved — source order preserved", async () => {
    const got = await runTest(`
      export function test(): number {
        const o: any = {
          a: 1,
          get b(): number { return 100; },
          c: 3,
        };
        return o.a + o.b + o.c;
      }
    `);
    expect(got).toBe(104);
  });

  it("string-literal accessor key", async () => {
    const got = await runTest(`
      export function test(): string {
        const o: any = {
          get "name"(): string { return "alice"; },
        };
        return o.name;
      }
    `);
    expect(got).toBe("alice");
  });

  it("getter captures outer-scope variable", async () => {
    const got = await runTest(`
      export function test(): number {
        const x = 99;
        const o: any = {
          get v(): number { return x; },
        };
        return o.v;
      }
    `);
    expect(got).toBe(99);
  });

  // Mutable-outer-scope capture from inside an accessor body lands on the
  // same `__make_*_callback` immutable-snapshot path that #859 is fixing for
  // forEach callbacks. The setter runs and reads `captured` correctly via
  // the snapshot, but the writeback to the outer slot is dropped. Re-enable
  // once #859 ships.
  it.skip("setter captures outer-scope variable (mutable) — deferred to #859", async () => {
    const got = await runTest(`
      export function test(): number {
        let captured = 0;
        const o: any = {
          set v(n: number) { captured = n + 1; },
        };
        o.v = 41;
        return captured;
      }
    `);
    expect(got).toBe(42);
  });

  it("getter-only descriptor — write is a no-op (no setter present)", async () => {
    const got = await runTest(`
      export function test(): number {
        const o: any = {
          get v(): number { return 7; },
        };
        try { o.v = 42; } catch (e) { /* strict mode would throw, sloppy mode silent */ }
        return o.v;
      }
    `);
    expect(got).toBe(7);
  });

  it("Object.getOwnPropertyDescriptor reports the right shape", async () => {
    // Note: js2wasm's `boolean`-typed wasm exports return i32 (1 for true,
    // 0 for false); JS sees that as the integer 1, not literal `true`.
    const got = await runTest(`
      export function test(): boolean {
        const o = {
          get x(): number { return 1; },
        };
        const desc: any = Object.getOwnPropertyDescriptor(o, "x");
        return desc != null
          && typeof desc.get === "function"
          && desc.enumerable === true
          && desc.configurable === true;
      }
    `);
    expect(got).toBe(1);
  });
});
