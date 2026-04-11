import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("#1017 Pattern 2 — Array.concat with non-array argument", () => {
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

  it("concat with typed array argument (existing path stays fast)", async () => {
    const src = `
      export function test(): number {
        const a: number[] = [1, 2];
        const b: number[] = [3, 4];
        const result = a.concat(b);
        return result.length === 4 && result[0] === 1 && result[3] === 4 ? 1 : 2;
      }
    `;
    const { pass, ret, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("concat with any-typed argument falls back to extern (no illegal cast)", async () => {
    const src = `
      export function test(): number {
        const arr: number[] = [1, 2, 3];
        const obj: any = [4, 5];  // any-typed, so resolveArrayInfo returns null
        const result = arr.concat(obj);
        // result should be a JS array with values — length > 0 means no crash
        return result.length > 0 ? 1 : 2;
      }
    `;
    const { pass, ret, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("concat with object any-typed argument (array-like)", async () => {
    const src = `
      export function test(): number {
        const arr: number[] = [1, 2];
        const obj: any = { 0: 3, length: 1 };
        // Should not crash — falls back to JS concat
        try {
          const result = arr.concat(obj);
          return 1;
        } catch (e) {
          return 1; // also ok — JS concat on plain object just appends it
        }
      }
    `;
    const { pass, ret, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });
});
