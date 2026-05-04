// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1169p slice 13 — IR Phase 4: String + Array prototype methods/properties.
//
// Speculative-start scope (this PR):
//   - `arr.length` (vec receiver, property access) — proof-of-concept lowering
//
// Out of scope for this PR — selector accepts shape, lowerer throws clean
// fallback so the function reverts to the legacy path:
//   - String prototype methods: `.slice()`, `.charAt()`, `.indexOf()`,
//     `.includes()`, `.split()`, `.trim()`, `.toUpperCase()`, etc.
//   - Array prototype methods: `.push()`, `.pop()`, `.indexOf()`, `.slice()`,
//     `.map()`, `.filter()`, `.reduce()`, etc.
//
// Tests use the #1181 bridge pattern: an IR-claimed function takes a vec
// param while a separate legacy `builder()` constructs the array (since
// `ArrayLiteralExpression` is not yet IR-lowered — see #1169o).

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { planIrCompilation } from "../src/ir/select.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

interface InstantiateResult {
  instance: WebAssembly.Instance;
  exports: Record<string, unknown>;
}

async function compileAndInstantiate(source: string, experimentalIR: boolean): Promise<InstantiateResult> {
  const r = compile(source, { experimentalIR });
  if (!r.success) {
    throw new Error(`compile failed (${experimentalIR ? "IR" : "legacy"}): ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, {
    env: built.env,
    string_constants: built.string_constants,
  });
  return { instance, exports: instance.exports as Record<string, unknown> };
}

function selectionFor(source: string): Set<string> {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  const sel = planIrCompilation(sf, { experimentalIR: true });
  return new Set(sel.funcs);
}

describe("#1169p — IR Phase 4 Slice 13: String + Array prototype methods", () => {
  // ---------------------------------------------------------------------------
  // arr.length on a vec receiver (vec param via #1181 bridge pattern)
  // ---------------------------------------------------------------------------
  describe("arr.length on a vec parameter (bridge pattern)", () => {
    const source = `
      export function builder(): number[] { return [10, 20, 30, 40]; }
      export function lenOf(arr: number[]): number {
        return arr.length;
      }
    `;

    it("IR selector claims lenOf", () => {
      const sel = selectionFor(source);
      expect(sel.has("lenOf"), `expected 'lenOf' claimed; got: ${[...sel].join(", ")}`).toBe(true);
    });

    it("IR-compiled and legacy-compiled produce the same length", async () => {
      const legacy = await compileAndInstantiate(source, false);
      const ir = await compileAndInstantiate(source, true);
      const arrLegacy = (legacy.exports.builder as () => unknown)();
      const arrIr = (ir.exports.builder as () => unknown)();
      const legacyLen = (legacy.exports.lenOf as (a: unknown) => number)(arrLegacy);
      const irLen = (ir.exports.lenOf as (a: unknown) => number)(arrIr);
      expect(legacyLen).toBe(4);
      expect(irLen).toBe(4);
    });
  });

  describe("arr.length composed with arithmetic", () => {
    const source = `
      export function builder(): number[] { return [1, 2, 3]; }
      export function lenPlusOne(arr: number[]): number {
        return arr.length + 1;
      }
    `;

    it("IR selector claims lenPlusOne", () => {
      const sel = selectionFor(source);
      expect(sel.has("lenPlusOne")).toBe(true);
    });

    it("matches between IR and legacy", async () => {
      const legacy = await compileAndInstantiate(source, false);
      const ir = await compileAndInstantiate(source, true);
      const a1 = (legacy.exports.builder as () => unknown)();
      const a2 = (ir.exports.builder as () => unknown)();
      expect((legacy.exports.lenPlusOne as (a: unknown) => number)(a1)).toBe(4);
      expect((ir.exports.lenPlusOne as (a: unknown) => number)(a2)).toBe(4);
    });
  });

  describe("arr.length used in comparison", () => {
    const source = `
      export function builder(): number[] { return [1, 2]; }
      export function isNonEmpty(xs: number[]): number {
        if (xs.length > 0) return 1;
        return 0;
      }
    `;

    it("IR selector claims isNonEmpty", () => {
      const sel = selectionFor(source);
      expect(sel.has("isNonEmpty")).toBe(true);
    });

    it("matches between IR and legacy", async () => {
      const legacy = await compileAndInstantiate(source, false);
      const ir = await compileAndInstantiate(source, true);
      const a1 = (legacy.exports.builder as () => unknown)();
      const a2 = (ir.exports.builder as () => unknown)();
      expect((legacy.exports.isNonEmpty as (a: unknown) => number)(a1)).toBe(1);
      expect((ir.exports.isNonEmpty as (a: unknown) => number)(a2)).toBe(1);
    });
  });

  describe("arr.length on two vec parameters", () => {
    const source = `
      export function builder1(): number[] { return [1, 2, 3]; }
      export function builder2(): number[] { return [10, 20]; }
      export function sumLen(a: number[], b: number[]): number {
        return a.length + b.length;
      }
    `;

    it("IR selector claims sumLen", () => {
      const sel = selectionFor(source);
      expect(sel.has("sumLen")).toBe(true);
    });

    it("matches between IR and legacy", async () => {
      const legacy = await compileAndInstantiate(source, false);
      const ir = await compileAndInstantiate(source, true);
      const a1 = (legacy.exports.builder1 as () => unknown)();
      const b1 = (legacy.exports.builder2 as () => unknown)();
      const a2 = (ir.exports.builder1 as () => unknown)();
      const b2 = (ir.exports.builder2 as () => unknown)();
      expect((legacy.exports.sumLen as (a: unknown, b: unknown) => number)(a1, b1)).toBe(5);
      expect((ir.exports.sumLen as (a: unknown, b: unknown) => number)(a2, b2)).toBe(5);
    });
  });

  // ---------------------------------------------------------------------------
  // Negative tests — selector accepts shape, lowerer throws clean fallback.
  // These should keep working via legacy.
  // ---------------------------------------------------------------------------
  describe("non-length array property is fallback (still works via legacy)", () => {
    const source = `
      export function builder(): number[] { return [1, 2, 3]; }
      export function takeFirst(arr: number[]): number {
        return arr[0];
      }
    `;

    it("compiles + runs identically under both modes", async () => {
      const legacy = await compileAndInstantiate(source, false);
      const ir = await compileAndInstantiate(source, true);
      const a1 = (legacy.exports.builder as () => unknown)();
      const a2 = (ir.exports.builder as () => unknown)();
      expect((legacy.exports.takeFirst as (a: unknown) => number)(a1)).toBe(1);
      expect((ir.exports.takeFirst as (a: unknown) => number)(a2)).toBe(1);
    });
  });
});
