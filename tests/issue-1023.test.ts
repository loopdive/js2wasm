import { describe, it, expect } from "vitest";
import { compile } from "./src/index.js";
import { buildImports } from "./src/runtime.js";

describe("#1023 — Number(null) / ToNumber semantics", () => {
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

  it("Number(null) === 0 (ToNumber(null) = +0 per spec)", async () => {
    const src = `
      export function test(): number {
        const x: any = null;
        return Number(x) === 0 ? 1 : 2;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("Number(undefined) === NaN (ToNumber(undefined) = NaN per spec)", async () => {
    const src = `
      export function test(): number {
        const x: any = undefined;
        return isNaN(Number(x)) ? 1 : 2;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("Number('') === 0 (not NaN — parseFloat would return NaN)", async () => {
    const src = `
      export function test(): number {
        const x: any = "";
        return Number(x) === 0 ? 1 : 2;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("Number('  ') === 0 (whitespace-only strings)", async () => {
    const src = `
      export function test(): number {
        const x: any = "  ";
        return Number(x) === 0 ? 1 : 2;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("Number('123abc') === NaN (parseFloat gives 123, Number gives NaN)", async () => {
    const src = `
      export function test(): number {
        const x: any = "123abc";
        return isNaN(Number(x)) ? 1 : 2;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("+null === 0 (unary plus already worked)", async () => {
    const src = `
      export function test(): number {
        const x: any = null;
        return +x === 0 ? 1 : 2;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("null in arithmetic context: null + 1 === 1", async () => {
    const src = `
      export function test(): number {
        const x: any = null;
        return (x as any) + 1 === 1 ? 1 : 2;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });
});
