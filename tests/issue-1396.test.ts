import { describe, it, expect } from "vitest";
import { compile } from "./src/index.js";
import { buildImports } from "./src/runtime.js";

describe("#1396 — for-of/dstr defaults fire on OOB extern-array reads (Task #50)", () => {
  async function runTest(src: string): Promise<{ pass: boolean; ret?: unknown; error?: string }> {
    const result = compile(src, { skipSemanticDiagnostics: true });
    if (!result.success) return { pass: false, error: result.error };
    const importObj = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, importObj as any);
    if (typeof (importObj as any).setExports === "function") {
      (importObj as any).setExports(instance.exports);
    }
    try {
      const ret = (instance.exports as any).test();
      return { pass: ret === 1, ret };
    } catch (e: any) {
      return { pass: false, error: String(e) };
    }
  }

  it("for-of any[][]: const [x = 23] of [[]] uses default 23", async () => {
    const src = `
      export function test(): number {
        const data: any[][] = [[]];
        let xVal = -1;
        for (const [x = 23] of data) {
          xVal = x;
        }
        return xVal === 23 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("for-of any[][]: real value wins over default", async () => {
    const src = `
      export function test(): number {
        const data: any[][] = [[100]];
        let xVal = -1;
        for (const [x = 23] of data) {
          xVal = x;
        }
        return xVal === 100 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("for-of any[][]: multi-element with default for missing trailing element", async () => {
    const src = `
      export function test(): number {
        const data: any[][] = [[5]];
        let aVal = -1, bVal = -1;
        for (const [a, b = 99] of data) {
          aVal = a; bVal = b;
        }
        return aVal === 5 && bVal === 99 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("spec regression: [null] should NOT trigger default (defaults fire only for undefined)", async () => {
    // Per ECMA-262 §13.7.5.5 — destructuring defaults fire only when the
    // value is `undefined`, not `null`. Our fix uses JS `undefined` (via
    // `__get_undefined`) for OOB sentinels but preserves `null` semantics
    // for actual null values in the array.
    const src = `
      export function test(): number {
        const data: any[][] = [[null]];
        let xVal: any = -1;
        for (const [x = 23] of data) {
          xVal = x;
        }
        return xVal === null ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("regression: number[][] (vec with f64 elements) still works via sNaN sentinel", async () => {
    const src = `
      export function test(): number {
        const data: number[][] = [[]];
        let xVal = -1;
        for (const [x = 23] of data) {
          xVal = x;
        }
        return xVal === 23 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("regression: number[][] with multi-element default", async () => {
    const src = `
      export function test(): number {
        const data: number[][] = [[5]];
        let aVal = -1, bVal = -1;
        for (const [a, b = 99] of data) {
          aVal = a; bVal = b;
        }
        return aVal === 5 && bVal === 99 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("for-of any[][]: counter increments correctly (loop body runs)", async () => {
    // Mirrors test262 var-ary-ptrn-elem-id-init-exhausted.js pattern
    const src = `
      export function test(): number {
        const data: any[][] = [[]];
        let count = 0;
        let xVal = -1;
        for (const [x = 23] of data) {
          xVal = x;
          count++;
        }
        return count === 1 && xVal === 23 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });
});
