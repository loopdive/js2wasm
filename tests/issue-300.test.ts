/**
 * Issue #300: Object to primitive conversion
 *
 * Tests that objects with valueOf/toString methods are properly coerced
 * to primitives in numeric, comparison, and string contexts.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "./equivalence/helpers.js";

async function compileAndRun(source: string): Promise<{ success: boolean; result?: number; error?: string }> {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success || result.errors.some(e => e.severity === "error")) {
    return { success: false, error: "compile: " + result.errors.filter(e => e.severity === "error").map(e => e.message).join("; ") };
  }
  const valid = WebAssembly.validate(result.binary);
  if (!valid) {
    return { success: false, error: "invalid wasm binary" };
  }
  try {
    const imports = buildImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const testFn = (instance.exports as any).test;
    const r = testFn();
    return { success: true, result: r };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

describe("Issue #300: Object to primitive conversion", () => {
  it("object with valueOf in numeric context (arithmetic)", async () => {
    const r = await compileAndRun(`
      class Obj {
        value: number;
        constructor(v: number) { this.value = v; }
        valueOf(): number { return this.value; }
      }
      export function test(): number {
        const a = new Obj(10);
        const b = new Obj(5);
        const sum = (a as any) + (b as any);
        if (sum !== 15) return 0;
        return 1;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("object with valueOf in comparison context", async () => {
    const r = await compileAndRun(`
      class Obj {
        value: number;
        constructor(v: number) { this.value = v; }
        valueOf(): number { return this.value; }
      }
      export function test(): number {
        const a = new Obj(10);
        const b = new Obj(5);
        if (!((a as any) > (b as any))) return 0;
        if ((a as any) < (b as any)) return 0;
        if (!((a as any) >= (b as any))) return 0;
        return 1;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("object with valueOf returning number used in subtraction", async () => {
    const r = await compileAndRun(`
      class Counter {
        count: number;
        constructor(c: number) { this.count = c; }
        valueOf(): number { return this.count; }
      }
      export function test(): number {
        const c = new Counter(42);
        const result = (c as any) - 2;
        if (result !== 40) return 0;
        return 1;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("object with valueOf in multiplication", async () => {
    const r = await compileAndRun(`
      class Num {
        n: number;
        constructor(v: number) { this.n = v; }
        valueOf(): number { return this.n; }
      }
      export function test(): number {
        const x = new Num(7);
        const result = (x as any) * 3;
        if (result !== 21) return 0;
        return 1;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("object without valueOf in numeric context gives NaN", async () => {
    const r = await compileAndRun(`
      class Plain {
        x: number;
        constructor(v: number) { this.x = v; }
      }
      export function test(): number {
        const p = new Plain(5);
        const result = (p as any) + 1;
        // NaN + 1 = NaN, NaN !== NaN
        if (result === result) return 0;
        return 1;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("object with both valueOf and toString - valueOf used in numeric context", async () => {
    const r = await compileAndRun(`
      class Dual {
        n: number;
        constructor(v: number) { this.n = v; }
        valueOf(): number { return this.n; }
        toString(): string { return "hello"; }
      }
      export function test(): number {
        const d = new Dual(99);
        const result = (d as any) + 1;
        if (result !== 100) return 0;
        return 1;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("struct ref to f64 coercion via valueOf compiles and validates", async () => {
    // Simpler test: just check that the compilation and validation succeed
    const r = await compileAndRun(`
      class Box {
        val: number;
        constructor(v: number) { this.val = v; }
        valueOf(): number { return this.val; }
      }
      export function test(): number {
        const b = new Box(3);
        // Use valueOf in a numeric context
        return (b as any) + 0;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(3);
  });
});
