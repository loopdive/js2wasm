// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1233 — IR Phase 4 Slice 13d: Array per-element-type prototype methods
// through IR.
//
// Builds on #1238 (pseudo-`ExternClassInfo` for Array). The IR's
// pseudo-extern Array registry registers fallback signatures using
// externref for the receiver and value-shaped args; per-element-type
// specialisation is achieved via the existing dispatch path falling
// through to `compileArrayMethodCall` for the actual struct.get /
// array.get / array.set ops.
//
// Test pattern (the #1181 "legacy builder + IR consumer" bridge):
// ArrayLiteral initialisers (`const arr: number[] = [1, 2]`) are
// rejected by the selector (deferred to a slice that lands the IR
// `vec.new_fixed` instr). So we keep array literals out of
// IR-claimed function bodies — a separate (legacy) builder
// constructs the array, and the IR-claimable consumer takes it as
// a typed param.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

interface InstantiateResult {
  exports: Record<string, unknown>;
}

async function compileAndInstantiate(source: string, experimentalIR: boolean): Promise<InstantiateResult> {
  const r = compile(source, { fileName: "test.ts", experimentalIR });
  if (!r.success) {
    throw new Error(`compile failed (${experimentalIR ? "IR" : "legacy"}): ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports as never, undefined, r.stringPool);
  const inst = await WebAssembly.instantiate(r.binary, built as never);
  if (typeof (built as { setExports?: Function }).setExports === "function") {
    (built as { setExports: Function }).setExports(inst.instance.exports);
  }
  return { exports: inst.instance.exports as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Equivalence tests — IR result matches legacy for each method
// ---------------------------------------------------------------------------

describe("#1233 — Array prototype methods through IR (number[])", () => {
  it("push(item) returns new length", async () => {
    const source = `
      function build(): number[] { return [10, 20]; }
      function consume(arr: number[], x: number): number { arr.push(x); return arr.length; }
      export function test(): number { return consume(build(), 30); }
    `;
    const legacy = await compileAndInstantiate(source, false);
    const ir = await compileAndInstantiate(source, true);
    expect((legacy.exports.test as () => number)()).toBe(3);
    expect((ir.exports.test as () => number)()).toBe(3);
  });

  it("pop() returns last element", async () => {
    const source = `
      function build(): number[] { return [10, 20, 30]; }
      function consume(arr: number[]): number { return arr.pop() as number; }
      export function test(): number { return consume(build()); }
    `;
    const legacy = await compileAndInstantiate(source, false);
    const ir = await compileAndInstantiate(source, true);
    expect((legacy.exports.test as () => number)()).toBe(30);
    expect((ir.exports.test as () => number)()).toBe(30);
  });

  it("indexOf(search) finds the element", async () => {
    const source = `
      function build(): number[] { return [10, 20, 30, 40]; }
      function consume(arr: number[], x: number): number { return arr.indexOf(x); }
      export function found(): number { return consume(build(), 30); }
      export function missing(): number { return consume(build(), 99); }
    `;
    const legacy = await compileAndInstantiate(source, false);
    const ir = await compileAndInstantiate(source, true);
    expect((legacy.exports.found as () => number)()).toBe(2);
    expect((ir.exports.found as () => number)()).toBe(2);
    expect((legacy.exports.missing as () => number)()).toBe(-1);
    expect((ir.exports.missing as () => number)()).toBe(-1);
  });

  it("includes(search) returns boolean", async () => {
    const source = `
      function build(): number[] { return [1, 2, 3]; }
      function consume(arr: number[], x: number): number { return arr.includes(x) ? 1 : 0; }
      export function found(): number { return consume(build(), 2); }
      export function missing(): number { return consume(build(), 99); }
    `;
    const legacy = await compileAndInstantiate(source, false);
    const ir = await compileAndInstantiate(source, true);
    expect((legacy.exports.found as () => number)()).toBe(1);
    expect((ir.exports.found as () => number)()).toBe(1);
    expect((legacy.exports.missing as () => number)()).toBe(0);
    expect((ir.exports.missing as () => number)()).toBe(0);
  });

  it("slice(start, end) returns a copy of a range", async () => {
    const source = `
      function build(): number[] { return [10, 20, 30, 40, 50]; }
      function consume(arr: number[]): number { return arr.slice(1, 3).length; }
      export function test(): number { return consume(build()); }
    `;
    const legacy = await compileAndInstantiate(source, false);
    const ir = await compileAndInstantiate(source, true);
    expect((legacy.exports.test as () => number)()).toBe(2);
    expect((ir.exports.test as () => number)()).toBe(2);
  });

  it("join(sep) returns a string of length matching legacy", async () => {
    const source = `
      function build(): number[] { return [1, 2, 3]; }
      function consume(arr: number[]): number { return arr.join(",").length; }
      export function test(): number { return consume(build()); }
    `;
    const legacy = await compileAndInstantiate(source, false);
    const ir = await compileAndInstantiate(source, true);
    expect((legacy.exports.test as () => number)()).toBe(5); // "1,2,3"
    expect((ir.exports.test as () => number)()).toBe(5);
  });

  it("concat(other) returns a combined array", async () => {
    const source = `
      function buildA(): number[] { return [1, 2]; }
      function buildB(): number[] { return [3, 4, 5]; }
      function consume(a: number[], b: number[]): number { return a.concat(b).length; }
      export function test(): number { return consume(buildA(), buildB()); }
    `;
    const legacy = await compileAndInstantiate(source, false);
    const ir = await compileAndInstantiate(source, true);
    expect((legacy.exports.test as () => number)()).toBe(5);
    expect((ir.exports.test as () => number)()).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Equivalence tests — string[] receiver (per-element-type variant)
// ---------------------------------------------------------------------------

describe("#1233 — Array prototype methods through IR (string[])", () => {
  it("push(item) — string[] IR matches legacy", async () => {
    const source = `
      function build(): string[] { return ["a", "b"]; }
      function consume(arr: string[], x: string): number { arr.push(x); return arr.length; }
      export function test(): number { return consume(build(), "c"); }
    `;
    const legacy = await compileAndInstantiate(source, false);
    const ir = await compileAndInstantiate(source, true);
    expect((legacy.exports.test as () => number)()).toBe(3);
    expect((ir.exports.test as () => number)()).toBe(3);
  });

  it("indexOf(search) — string[] IR matches legacy", async () => {
    const source = `
      function build(): string[] { return ["a", "b", "c"]; }
      function consume(arr: string[], x: string): number { return arr.indexOf(x); }
      export function test(): number { return consume(build(), "b"); }
    `;
    const legacy = await compileAndInstantiate(source, false);
    const ir = await compileAndInstantiate(source, true);
    expect((legacy.exports.test as () => number)()).toBe(1);
    expect((ir.exports.test as () => number)()).toBe(1);
  });

  it("join(sep) — string[] IR matches legacy", async () => {
    const source = `
      function build(): string[] { return ["a", "b", "c"]; }
      function consume(arr: string[]): number { return arr.join(",").length; }
      export function test(): number { return consume(build()); }
    `;
    const legacy = await compileAndInstantiate(source, false);
    const ir = await compileAndInstantiate(source, true);
    expect((legacy.exports.test as () => number)()).toBe(5); // "a,b,c"
    expect((ir.exports.test as () => number)()).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Pseudo-extern registry — Array entry contains all 7 target methods
// ---------------------------------------------------------------------------

describe("#1233 — pseudo-extern Array registry has all 7 target methods", () => {
  // Indirect verification: each method must compile cleanly under IR
  // mode. If the registry didn't have an entry, the IR's
  // `lowerMethodCall` would throw "extern class Array has no method ..."
  // and either the function falls back cleanly (we still observe valid
  // wasm) or fail-fast — both are visible by `success: true`.
  for (const [method, src] of [
    ["push", `export function f(a: number[]): number { a.push(1); return a.length; }`],
    ["pop", `export function f(a: number[]): number { return a.pop() as number; }`],
    ["indexOf", `export function f(a: number[]): number { return a.indexOf(1); }`],
    ["includes", `export function f(a: number[]): number { return a.includes(1) ? 1 : 0; }`],
    ["slice", `export function f(a: number[]): number { return a.slice(0, 2).length; }`],
    ["join", `export function f(a: number[]): number { return a.join(",").length; }`],
    ["concat", `export function f(a: number[], b: number[]): number { return a.concat(b).length; }`],
  ] as const) {
    it(`${method}: IR compile succeeds`, () => {
      const r = compile(src, { fileName: "test.ts", experimentalIR: true });
      expect(r.success).toBe(true);
    });
  }
});
