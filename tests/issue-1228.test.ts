// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #1228 — IR selector widening: accept `void` return + `any` params.
//
// The corpus measurement from #1169q showed 0% IR claim rate on test262
// because the selector rejected `any` parameters and `void` returns — both
// extremely common in the test262 harness wrapper (`assert_sameValue(a: any,
// b: any): void`, etc.). This test exercises both extensions:
//
//   - `any` params lower to externref. The IR's `resolvePositionType` returns
//     `irVal({ kind: "externref" })` for AnyKeyword. Operations on externref
//     that the IR can't lower (e.g. `===`) throw cleanly so the function
//     falls back to legacy without producing invalid Wasm.
//   - `void` returns lower to zero Wasm result types. The IrFunctionBuilder
//     is constructed with `[]` results; the lowerer accepts bare `return;`
//     and ExpressionStatement tails, synthesizing the implicit empty-values
//     terminator.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { planIrCompilation } from "../src/ir/index.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {} as const;

async function compileAndInstantiate(source: string): Promise<Record<string, Function>> {
  const r = compile(source, { experimentalIR: true });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, {
    env: built.env,
    string_constants: built.string_constants,
  });
  if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

function selectionFor(source: string): Set<string> {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  const sel = planIrCompilation(sf, { experimentalIR: true });
  return new Set(sel.funcs);
}

describe("#1228 — IR selector widening: void / any", () => {
  describe("selector accepts new shapes", () => {
    it("any-param function is claimed", () => {
      const claimed = selectionFor(`
        export function takesAny(x: any): number { return 1; }
      `);
      expect(claimed.has("takesAny")).toBe(true);
    });

    it("void-return function is claimed (tail = ExpressionStatement)", () => {
      const claimed = selectionFor(`
        export function returnsVoid(x: number): void { x + 1; }
      `);
      expect(claimed.has("returnsVoid")).toBe(true);
    });

    it("void-return function is claimed (tail = bare return)", () => {
      const claimed = selectionFor(`
        export function earlyReturn(x: number): void { if (x < 0) { return; } x + 1; }
      `);
      expect(claimed.has("earlyReturn")).toBe(true);
    });

    it("any-param + void-return function is claimed", () => {
      // Body must use Phase-1 statement shapes; bare identifier ExpressionStatements
      // are not Phase-1 (only CallExpression / property-assignment are).
      const claimed = selectionFor(`
        function noop(x: any): number { return 1; }
        export function helper(x: any, y: any): void { noop(x); noop(y); }
      `);
      expect(claimed.has("helper")).toBe(true);
      expect(claimed.has("noop")).toBe(true);
    });

    it("call-graph closure keeps a typed kernel + void wrapper together", () => {
      const claimed = selectionFor(`
        function noop(x: number): number { return x; }
        export function callsNoop(x: number): void { noop(x); }
      `);
      expect(claimed.has("noop")).toBe(true);
      expect(claimed.has("callsNoop")).toBe(true);
    });
  });

  describe("end-to-end execution through IR", () => {
    it("void function with mutable closure-over-global works", async () => {
      const exports = await compileAndInstantiate(`
        let counter: number = 0;
        export function bump(n: number): void { counter = counter + n; }
        export function run(): number { bump(10); bump(5); return counter; }
      `);
      expect((exports.run as () => number)()).toBe(15);
    });

    it("any param identity round-trips a number", async () => {
      const exports = await compileAndInstantiate(`
        export function pass(x: any): any { return x; }
        export function getN(): number { return 42; }
      `);
      expect((exports.getN as () => number)()).toBe(42);
      // pass() takes/returns externref. Calling with a JS value round-trips.
      expect((exports.pass as (x: unknown) => unknown)("hello")).toBe("hello");
    });

    it("void function with bare early return + tail expression", async () => {
      const exports = await compileAndInstantiate(`
        let x: number = 0;
        export function maybeBump(n: number): void {
          if (n < 0) { return; }
          x = x + n;
        }
        export function run(): number { maybeBump(-1); maybeBump(5); maybeBump(3); return x; }
      `);
      expect((exports.run as () => number)()).toBe(8);
    });

    it("graceful fallback: `===` on externref operands compiles via legacy, runs correctly", async () => {
      // The IR throws a clean fallback error when it sees `===` on
      // externref operands; the function falls back to legacy and the
      // overall compile produces valid Wasm.
      const exports = await compileAndInstantiate(`
        function isSame(a: any, b: any): number {
          if (a === b) { return 1; }
          return 0;
        }
        export function run(): number {
          return isSame(1, 1);
        }
      `);
      expect((exports.run as () => number)()).toBe(1);
    });
  });
});
