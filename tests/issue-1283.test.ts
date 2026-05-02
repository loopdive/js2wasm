// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #1283 — WeakMap host-import dispatch type-mismatch on
// `set` / `get` / `has` / `delete` for any-typed receivers.
//
// Carved off from #1242. WeakSet works on main today; WeakMap failed at
// instantiation with wasm validation type errors for every documented
// pattern. Root cause: `tryExternClassMethodOnAny` in
// `src/codegen/expressions/calls-closures.ts` iterated `ctx.externClasses`
// in insertion order and picked the *first* extern class that registered
// a method with the same name. For an `any`-typed receiver calling `.set`,
// the dispatch routinely matched `Uint8ClampedArray_set` (signature
// `(externref, externref, f64)`) before `WeakMap_set`
// (`(externref, externref, externref) → externref`). The dispatch loop
// always emits `externref` hints for every arg, so the resulting wasm
// failed validation when the registered signature contained an `f64`
// param.
//
// Fix: filter candidates to only extern-class methods whose signature is
// fully externref-typed (or void-result). Mixed-type signatures (e.g.
// TypedArray.set's `f64` offset) fall through to the generic
// `__extern_method_call` host-side dispatch, which uses the real receiver
// class at runtime.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runTest(source: string): Promise<unknown> {
  const r = compile(source, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    allowJs: true,
  });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => unknown }).test();
}

describe("Issue #1283 — WeakMap host-import dispatch", () => {
  // ── CASE A: set/get with primitive value ──────────────────────────
  it("CASE A: set + get returns the stored primitive", async () => {
    const src = `
      export function test(): number {
        const wm: any = new WeakMap();
        const k: any = { id: 1 };
        wm.set(k, 42);
        return wm.get(k);
      }
    `;
    expect(await runTest(src)).toBe(42);
  });

  // ── CASE B: set + has ──────────────────────────────────────────────
  it("CASE B: set + has returns true for the stored key", async () => {
    const src = `
      export function test(): number {
        const wm: any = new WeakMap();
        const k: any = { id: 1 };
        wm.set(k, 99);
        return wm.has(k) ? 1 : 0;
      }
    `;
    expect(await runTest(src)).toBe(1);
  });

  // ── CASE C: cycle-detect (lodash cloneDeep style) ──────────────────
  it("CASE C: self-referential cycle-detection set + has", async () => {
    const src = `
      export function test(): number {
        const seen: any = new WeakMap();
        const a: any = { id: 1 };
        seen.set(a, a);
        return seen.has(a) ? 1 : 0;
      }
    `;
    expect(await runTest(src)).toBe(1);
  });

  // ── CASE D: memoize style (lodash memoize) ─────────────────────────
  it("CASE D: memoize returns the same cached result on repeat calls", async () => {
    const src = `
      const cache: any = new WeakMap();
      function memo(arg: any): any {
        if (cache.has(arg)) return cache.get(arg);
        const result = { value: 42 };
        cache.set(arg, result);
        return result;
      }
      export function test(): number {
        const k: any = { id: 1 };
        const r1: any = memo(k);
        const r2: any = memo(k);
        return r1 === r2 ? 1 : 0;
      }
    `;
    expect(await runTest(src)).toBe(1);
  });

  // ── delete removes the entry ───────────────────────────────────────
  it("delete removes the entry so subsequent has() returns false", async () => {
    const src = `
      export function test(): number {
        const wm: any = new WeakMap();
        const k: any = { id: 1 };
        wm.set(k, 1);
        wm.delete(k);
        return wm.has(k) ? 1 : 0;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  // ── empty WeakMap.has returns false ────────────────────────────────
  it("has() on a fresh WeakMap returns false", async () => {
    const src = `
      export function test(): number {
        const wm: any = new WeakMap();
        const k: any = { id: 1 };
        return wm.has(k) ? 99 : 0;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  // ── distinct keys are independent ──────────────────────────────────
  it("two distinct keys map independently", async () => {
    const src = `
      export function test(): number {
        const wm: any = new WeakMap();
        const a: any = { id: 1 };
        const b: any = { id: 2 };
        wm.set(a, 10);
        wm.set(b, 20);
        return wm.get(a) + wm.get(b);
      }
    `;
    expect(await runTest(src)).toBe(30);
  });

  // ── Regression guard: WeakSet must keep working ────────────────────
  it("regression guard: WeakSet add+has still works", async () => {
    const src = `
      export function test(): number {
        const ws: any = new WeakSet();
        const v: any = { id: 1 };
        ws.add(v);
        return ws.has(v) ? 1 : 0;
      }
    `;
    expect(await runTest(src)).toBe(1);
  });

  // ── Regression guard: Map any-typed get/set still works ────────────
  it("regression guard: Map<any> set+get still works", async () => {
    const src = `
      export function test(): number {
        const m: any = new Map();
        const k: any = { id: 1 };
        m.set(k, 42);
        return m.get(k);
      }
    `;
    expect(await runTest(src)).toBe(42);
  });
});
