/**
 * Issue #862 — Empty error message failures: generator exception deferral
 *
 * Root cause: generators eagerly execute their body at creation time.
 * If the body throws, the exception escaped as an uncatchable
 * WebAssembly.Exception instead of being deferred to .next().
 *
 * Fix: wrap generator body in try/catch, store errors in buffer,
 * re-throw from .next() after yielded values are consumed.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

function compileAndRun(source: string): { success: boolean; result?: number; error?: string } {
  const compiled = compile(source, { fileName: "test.ts" });
  if (!compiled.success) return { success: false, error: compiled.errors[0]?.message };
  try {
    const imports = buildImports(compiled.imports, undefined, compiled.stringPool);
    const mod = new WebAssembly.Module(compiled.binary);
    const inst = new WebAssembly.Instance(mod, imports);
    const ret = (inst.exports as any).test();
    return { success: true, result: ret };
  } catch (e: any) {
    return { success: false, error: `${e.constructor.name}: ${e.message}` };
  }
}

describe("Issue #862: generator exception deferral", () => {
  it("generator throw is deferred to .next() and catchable", () => {
    const r = compileAndRun(`
      export function test(): number {
        function* gen(): Generator<number> { throw new Error("boom"); }
        const iter = gen();
        let caught = 0;
        try { iter.next(); } catch (e) { caught = 1; }
        return caught;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("generator yield-then-throw defers error after yields", () => {
    const r = compileAndRun(`
      export function test(): number {
        function* gen(): Generator<number> { yield 1; throw new Error("boom"); }
        const iter = gen();
        const v1 = iter.next();
        let caught = 0;
        try { iter.next(); } catch (e) { caught = 1; }
        return caught;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("normal generator still works", () => {
    const r = compileAndRun(`
      export function test(): number {
        function* gen(): Generator<number> { yield 42; yield 99; }
        const iter = gen();
        const v1 = iter.next();
        const v2 = iter.next();
        const v3 = iter.next();
        return 1;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("gen() creation does not throw (deferred to .next())", () => {
    const r = compileAndRun(`
      export function test(): number {
        function* gen(): Generator<number> { throw new Error("boom"); }
        let threw = 0;
        try { const iter = gen(); } catch (e) { threw = 1; }
        return threw === 0 ? 1 : 0;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });
});
