// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #1281 — IR support for optional chaining (`obj?.prop`, `fn?.()`).
//
// The IR lowerer used to throw on every `?.` token, forcing the entire
// containing function back onto the legacy codegen path. This commit adds
// a narrow IR-side fix: when the receiver/callee's TypeScript type has
// already been narrowed to non-nullable, the `?.` is redundant safety
// syntax and the IR lowers it like a regular `.` access. Genuinely
// nullable receivers (`T | null | undefined`, `any`, `unknown`) still
// throw to the legacy path, where the existing `compileOptional*`
// helpers emit the null-guarded `if/else` block.
//
// This is the minimum viable IR support — it eliminates the IR-fallback
// for typed code that uses `?.` defensively (a common pattern in TS
// codebases) without introducing new IR control-flow primitives. Full
// short-circuit IR support for nullable receivers is a separate
// follow-up that requires basic-block branching in the lowerer.

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

describe("Issue #1281 — IR optional chaining", () => {
  // ── Non-nullable receivers: IR strips `?.` to `.` ────────────────────
  it("?.prop on non-null typed object returns the value", async () => {
    const src = `
      export function test(): number {
        const obj: { x: number } = { x: 42 };
        return obj?.x;
      }
    `;
    expect(await runTest(src)).toBe(42);
  });

  it("?.method() on non-null typed receiver invokes method", async () => {
    const src = `
      class Box {
        v: number = 0;
        get(): number { return this.v; }
      }
      export function test(): number {
        const b = new Box();
        b.v = 7;
        return b?.get();
      }
    `;
    expect(await runTest(src)).toBe(7);
  });

  it("nested non-null receiver: regular .x then ?.y short-circuits the inner ?.", async () => {
    // The IR strips the leaf `?.y` because `a.b` is non-null typed.
    // Chained `a?.b?.c` is intentionally not covered here — the inner
    // `a?.b` types its result as `T | undefined` even when `a.b` is
    // non-null, which propagates to the outer `?.c` and forces legacy
    // fallback. That chain falls under the open follow-up for full IR
    // short-circuit support; out of scope for this slice.
    const src = `
      export function test(): number {
        const a: { b: { c: number } } = { b: { c: 99 } };
        return a.b?.c;
      }
    `;
    expect(await runTest(src)).toBe(99);
  });

  // ── Nullable receivers: legacy fallback still works ──────────────────
  it("?.prop on null any-typed object returns null/undefined-ish", async () => {
    const src = `
      export function test(): number {
        const obj: any = null;
        const r = obj?.x;
        // Coerce to numeric — null/undefined → 0 in numeric context
        return (r == null) ? 0 : 1;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  it("?.prop on real any-typed object returns the value", async () => {
    const src = `
      export function test(): number {
        const obj: any = { x: 42 };
        const r: any = obj?.x;
        return (r == null) ? 0 : 1;
      }
    `;
    expect(await runTest(src)).toBe(1);
  });

  it("class instance ?.method on non-null receiver works in IR-eligible func", async () => {
    const src = `
      class Counter {
        n: number = 0;
        bump(): number { this.n++; return this.n; }
      }
      export function test(): number {
        const c = new Counter();
        c?.bump();
        c?.bump();
        return c?.bump();
      }
    `;
    expect(await runTest(src)).toBe(3);
  });

  // ── Mixed: non-null then explicit nullable ──────────────────────────
  it("non-null path falls through to regular dispatch", async () => {
    const src = `
      class Pt {
        x: number;
        y: number;
        constructor(a: number, b: number) { this.x = a; this.y = b; }
      }
      export function test(): number {
        const p = new Pt(3, 4);
        return p?.x + p?.y;
      }
    `;
    expect(await runTest(src)).toBe(7);
  });

  // ── Regression guard: regular `.prop` still works ────────────────────
  it("regression: regular property access still works", async () => {
    const src = `
      export function test(): number {
        const obj: { x: number } = { x: 7 };
        return obj.x;
      }
    `;
    expect(await runTest(src)).toBe(7);
  });
});
