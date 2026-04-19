import { describe, it, expect } from "vitest";
import { compile } from "./src/index.js";
import { buildImports } from "./src/runtime.js";

describe("#1006 — eval via JS host import", () => {
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

  it("direct eval of arithmetic expression returns value", async () => {
    const src = `
      export function test(): number {
        const r: any = eval("1 + 2");
        return r === 3 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("indirect eval (0, eval)(src) returns value", async () => {
    const src = `
      export function test(): number {
        const r: any = (0, eval)("2 + 3");
        return r === 5 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("eval with no arguments returns undefined", async () => {
    const src = `
      export function test(): number {
        const r: any = (eval as any)();
        return r === undefined ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("eval SyntaxError propagates as catchable exception", async () => {
    const src = `
      export function test(): number {
        try {
          eval("@@@");
          return 0;
        } catch (e) {
          return 1;
        }
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("eval runtime error propagates as catchable exception", async () => {
    const src = `
      export function test(): number {
        try {
          eval("(function(){ throw new Error('boom'); })()");
          return 0;
        } catch (e) {
          return 1;
        }
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("eval returns string values", async () => {
    const src = `
      export function test(): number {
        const r: any = eval('"hello"');
        return r === "hello" ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("nested eval calls work", async () => {
    const src = `
      export function test(): number {
        const r: any = eval('eval("40 + 2")');
        return r === 42 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });
});
