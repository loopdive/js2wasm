/**
 * Tests for #955: Eliminate redundant ref.test + ref.cast pairs
 *
 * When a struct access compiles with objType already being (ref_null T) matching
 * the target struct type, the compiler should use direct struct.get instead of
 * the anyref dispatch path (ref.test + ref.cast + if/else).
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<number | string | null> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(r.errors[0]?.message ?? "compile error");
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as any).test() as number | string | null;
}

function countPairs(wat: string): number {
  // Count ref.test (ref N) ... ref.cast (ref N) pairs (same pattern as analyze-wat-patterns.ts)
  const pattern = /ref\.test \(ref (\d+)\)[\s\S]*?ref\.cast \(ref \1\)/g;
  return (wat.match(pattern) ?? []).length;
}

describe("#955 ref.test+ref.cast elimination", () => {
  it("basic struct field access produces correct result", async () => {
    const src = `
      class Point { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }
      export function test(): number { const p = new Point(1, 2); return p.x + p.y; }
    `;
    expect(await run(src)).toBe(3);
  });

  it("struct field access with typed variable has no ref.test+ref.cast in user code", () => {
    const src = `
      class Point { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }
      export function test(): number { const p = new Point(1, 2); return p.x + p.y; }
    `;
    const r = compile(src, { fileName: "test.ts" });
    if (!r.success) throw new Error(r.errors[0]?.message ?? "compile error");
    // The WAT should NOT have ref.test+ref.cast in the $test function
    // (the $__sget_* getter functions still need ref.test+ref.cast for JS interop)
    const testFuncWat = r.wat!.match(/\(func \$test[\s\S]*?(?=\(func |\)$)/)?.[0] ?? "";
    expect(testFuncWat).not.toMatch(/ref\.test/);
    expect(testFuncWat).not.toMatch(/ref\.cast/);
  });

  it("multiple field accesses all optimized", async () => {
    const src = `
      class Rect { x: number; y: number; w: number; h: number;
        constructor(x: number, y: number, w: number, h: number) {
          this.x = x; this.y = y; this.w = w; this.h = h;
        }
      }
      export function test(): number {
        const r = new Rect(1, 2, 3, 4);
        return r.x + r.y + r.w + r.h;
      }
    `;
    expect(await run(src)).toBe(10);
  });

  it("null access throws TypeError", async () => {
    const src = `
      class Foo { val: number; constructor(v: number) { this.val = v; } }
      export function test(): number {
        try {
          const f: Foo | null = null;
          return (f as any).val;
        } catch (e) {
          return -1;
        }
      }
    `;
    expect(await run(src)).toBe(-1);
  });

  it("nested class field access works", async () => {
    const src = `
      class Inner { v: number; constructor(v: number) { this.v = v; } }
      class Outer { inner: Inner; constructor(i: Inner) { this.inner = i; } }
      export function test(): number {
        const o = new Outer(new Inner(42));
        return o.inner.v;
      }
    `;
    expect(await run(src)).toBe(42);
  });
});
