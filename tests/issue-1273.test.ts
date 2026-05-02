// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #1273 — instanceof across compilation boundaries.
//
// Investigation finding (2026-05-02): the issue's claim that
// `f instanceof Foo` "either returns false always or throws" is
// **stale**. Smoke-testing on origin/main shows all three acceptance
// criteria already pass:
//
//   1. `class Foo {}; new Foo() instanceof Foo` → true ✓
//   2. `class Bar extends Foo {}; new Bar() instanceof Foo` → true ✓
//   3. `{} instanceof Foo` → false ✓
//
// The compiler appears to use struct-tag / ref.test-style dispatch
// for instanceof on compiled classes. Same approach the issue spec
// proposes.
//
// This file locks in the working behavior. Treats #1273 as test-only
// fix similar to #1250, #1271, #1272, #1275, #1276.

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

describe("Issue #1273 — instanceof across compilation boundaries", () => {
  // Acceptance 1: same-class instanceof
  it("instanceof returns true for an instance of its class", async () => {
    const src = `
      class Foo { x: number = 0; }
      export function test(): number {
        const f = new Foo();
        return f instanceof Foo ? 1 : 0;
      }
    `;
    expect(await runTest(src)).toBe(1);
  });

  // Acceptance 2: inheritance
  it("instanceof returns true for a subclass instance against the parent", async () => {
    const src = `
      class Foo { x: number = 0; }
      class Bar extends Foo { y: number = 0; }
      export function test(): number {
        const b = new Bar();
        return b instanceof Foo ? 1 : 0;
      }
    `;
    expect(await runTest(src)).toBe(1);
  });

  // Acceptance 3: non-class object
  it("instanceof returns false for a plain object", async () => {
    const src = `
      class Foo { x: number = 0; }
      export function test(): number {
        const o: any = { x: 1 };
        return o instanceof Foo ? 1 : 0;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  // Sanity: same-instance check after multiple object creations
  it("instanceof returns true on a fresh instance of its own class", async () => {
    const src = `
      class Bar { y: number = 0; }
      export function test(): number {
        const b = new Bar();
        return b instanceof Bar ? 1 : 0;
      }
    `;
    expect(await runTest(src)).toBe(1);
  });

  // Sanity: unrelated class returns false
  it("instanceof returns false for an instance of an unrelated class", async () => {
    const src = `
      class Foo { x: number = 0; }
      class Baz { z: number = 0; }
      export function test(): number {
        const baz = new Baz();
        return baz instanceof Foo ? 1 : 0;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  // Multi-level inheritance (Bar extends Foo, Baz extends Bar)
  it("multi-level inheritance: deep subclass instance is instance of root parent", async () => {
    const src = `
      class A { a: number = 0; }
      class B extends A { b: number = 0; }
      class C extends B { c: number = 0; }
      export function test(): number {
        const c = new C();
        return c instanceof A ? 1 : 0;
      }
    `;
    expect(await runTest(src)).toBe(1);
  });

  // Reverse direction: parent instance is NOT instance of subclass
  it("parent instance is NOT instance of subclass", async () => {
    const src = `
      class Foo { x: number = 0; }
      class Bar extends Foo { y: number = 0; }
      export function test(): number {
        const f = new Foo();
        return f instanceof Bar ? 1 : 0;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });
});
