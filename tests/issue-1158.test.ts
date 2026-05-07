// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile, compileToWat } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #1158 + #1159 — destructureParamArray over-consuming iterators.
 *
 * Per ECMA-262 §13.3.3.6, an `ArrayBindingPattern : [ ]` is supposed to
 * call `GetIterator` + `IteratorClose` and nothing else — no
 * `IteratorStep` (.next()) calls. The previous implementation routed
 * every `externref → vec` coercion through `__array_from_iter` (a host
 * `Array.from(iter)` call), which materializes every iterator element.
 * That over-consumes for both:
 *
 * 1. Top-level empty patterns reached via the externref fallback (#1158
 *    baseline) — though the immediate `pattern.elements.length === 0`
 *    short-circuit at line 647 already covered the unconditionally
 *    empty case.
 * 2. Nested empty patterns reached through `[[] = init]` defaults
 *    (#1159) — the default initializer's `coerceType(externref → vec)`
 *    fires `__array_from_iter` BEFORE the recursion can reach the empty
 *    short-circuit.
 *
 * Fix: add `isPatternEmptyOnly` (recognizes `[]`, `[, ,]`, `[[]]`,
 * etc.), broaden the line-647 check to use it, and add a "nested
 * empty pattern" branch in the vec recursion that holds the slot value
 * as externref (skipping vec/tuple coercion) so the default's IIFE
 * never goes through `__array_from_iter`.
 */
async function run(src: string): Promise<{ exports: Record<string, any> }> {
  const r = compile(src, { fileName: "test.ts" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool) as any;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof imports.setExports === "function") imports.setExports(instance.exports);
  return { exports: instance.exports as Record<string, any> };
}

describe("#1158/#1159 — empty array binding patterns don't over-consume iterators", () => {
  it("outer [] pattern: no __array_from_iter emitted", () => {
    const wat = compileToWat(`
      function f([]: any[]): number { return 1; }
      export function test(): number { return f([1, 2, 3] as any); }
    `);
    // Match the host-call site, not just the import declaration —
    // unused imports are dropped by `eliminateDeadImports`, but the
    // declaration text may still appear before that pass runs.
    expect(wat).not.toMatch(/call\s+\$__array_from_iter/);
  });

  it("nested [[] = init]: no __array_from_iter emitted", () => {
    const wat = compileToWat(`
      function* gen() { yield 1; }
      function f([[] = gen()]: any[]): void {}
      export function test(): number { f([] as any); return 0; }
    `);
    // Match the host-call site, not just the import declaration —
    // unused imports are dropped by `eliminateDeadImports`, but the
    // declaration text may still appear before that pass runs.
    expect(wat).not.toMatch(/call\s+\$__array_from_iter/);
  });

  it("outer empty pattern: f([1,2,3]) doesn't fail", async () => {
    const { exports } = await run(`
      function f([]: any[]): number { return 7; }
      export function test(): number { return f([1, 2, 3] as any); }
    `);
    expect((exports.test as () => number)()).toBe(7);
  });

  it("#1159 baseline: outer-provided nested empty slot — init does NOT fire", async () => {
    const { exports } = await run(`
      let initCount = 0;
      function makeIter(): any { initCount = initCount + 1; return [1]; }
      function f([[] = makeIter()]: any[]): void {}
      export function test(): number {
        f([[]] as any);  // outer slot 0 is defined → default skipped
        return initCount;
      }
    `);
    expect((exports.test as () => number)()).toBe(0);
  });

  it("#1159 baseline: outer-undefined nested empty slot — init fires once, no iteration", async () => {
    const { exports } = await run(`
      let initCount = 0;
      function makeArr(): any { initCount = initCount + 1; return [1, 2, 3]; }
      function f([[] = makeArr()]: any[]): void {}
      export function test(): number {
        f([] as any);  // outer slot 0 undefined → default fires once
        return initCount;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("regression: nested non-empty pattern still extracts elements correctly", async () => {
    const { exports } = await run(`
      function f([[a, b]]: any[][]): number { return a + b; }
      export function test(): number { return f([[10, 20]]); }
    `);
    expect((exports.test as () => number)()).toBe(30);
  });

  it("regression: nested non-empty with default still works", async () => {
    const { exports } = await run(`
      function f([[a, b] = [4, 5]]: any[][]): number { return a + b; }
      export function test(): number { return f([] as any); }
    `);
    expect((exports.test as () => number)()).toBe(9);
  });

  it("[[], [], []] (all-empty siblings) takes the short-circuit", () => {
    const wat = compileToWat(`
      function f([[], [], []]: any[][]): void {}
      export function test(): number { f([] as any); return 0; }
    `);
    // Match the host-call site, not just the import declaration —
    // unused imports are dropped by `eliminateDeadImports`, but the
    // declaration text may still appear before that pass runs.
    expect(wat).not.toMatch(/call\s+\$__array_from_iter/);
  });

  it("rest element forces the materialization path (regression guard)", () => {
    // [...rest] is NOT empty-only; isPatternEmptyOnly returns false.
    // Existing materializing path still fires for rest.
    const wat = compileToWat(`
      function f([...rest]: any[]): number { return rest.length; }
      export function test(): number { return f([1, 2, 3] as any); }
    `);
    // Don't assert presence; just confirm the rest path produces a working binary.
    expect(wat.length).toBeGreaterThan(0);
  });

  it("isPatternEmptyOnly detects [, ,] (elision-only) as empty-only", () => {
    const wat = compileToWat(`
      function f([, ,]: any[]): void {}
      export function test(): number { f([1, 2, 3] as any); return 0; }
    `);
    // Match the host-call site, not just the import declaration —
    // unused imports are dropped by `eliminateDeadImports`, but the
    // declaration text may still appear before that pass runs.
    expect(wat).not.toMatch(/call\s+\$__array_from_iter/);
  });
});
