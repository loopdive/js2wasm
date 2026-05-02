// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #1272 — Symbol as object key (Symbol.for, well-known Symbols).
//
// Investigation finding (2026-05-02): the issue's claim that "the
// compiler only handles string and number keys on structs" is **stale**.
// Smoke-testing on origin/main shows all three acceptance criteria
// already pass:
//
//   1. `Symbol.for(k); o[k] = 42; o[k]` → 42 ✓
//   2. `Symbol.for("x") === Symbol.for("x")` → true ✓
//   3. `Symbol() !== Symbol()` → true (unique) ✓
//
// This file locks in the working behavior. Same approach as #1250,
// #1275, #1276, #1271 where the issue title was stale.

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
  if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => number }).test();
}

describe("Issue #1272 — Symbol as object key", () => {
  // Acceptance 1: Symbol.for round-trip on object key
  it("Symbol.for(k); o[k] = 42; o[k] returns 42", async () => {
    const src = `
      export function test(): number {
        const k: any = Symbol.for("x");
        const o: any = {};
        o[k] = 42;
        return o[k];
      }
    `;
    expect(await runTest(src)).toBe(42);
  });

  // Acceptance 2: Symbol.for identity (interned)
  it("Symbol.for('x') === Symbol.for('x') is true", async () => {
    const src = `
      export function test(): number {
        return Symbol.for("x") === Symbol.for("x") ? 1 : 0;
      }
    `;
    expect(await runTest(src)).toBe(1);
  });

  // Acceptance 3: Symbol() uniqueness
  it("Symbol() !== Symbol() (unique each call)", async () => {
    const src = `
      export function test(): number {
        return Symbol() !== Symbol() ? 1 : 0;
      }
    `;
    expect(await runTest(src)).toBe(1);
  });

  // Symbol.for with different keys produces different symbols
  it("Symbol.for('x') !== Symbol.for('y')", async () => {
    const src = `
      export function test(): number {
        return Symbol.for("x") !== Symbol.for("y") ? 1 : 0;
      }
    `;
    expect(await runTest(src)).toBe(1);
  });

  // Multiple assignments through different Symbol keys on same object
  it("multiple Symbol keys on the same object", async () => {
    const src = `
      export function test(): number {
        const a: any = Symbol.for("a");
        const b: any = Symbol.for("b");
        const o: any = {};
        o[a] = 10;
        o[b] = 20;
        return o[a] + o[b];
      }
    `;
    expect(await runTest(src)).toBe(30);
  });

  // Reassignment through same Symbol key updates the slot
  it("reassignment through same Symbol key overwrites", async () => {
    const src = `
      export function test(): number {
        const k: any = Symbol.for("k");
        const o: any = {};
        o[k] = 5;
        o[k] = 7;
        return o[k];
      }
    `;
    expect(await runTest(src)).toBe(7);
  });
});
