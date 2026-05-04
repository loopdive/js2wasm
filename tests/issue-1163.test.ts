import { describe, it, expect } from "vitest";
import { compile } from "./src/index.js";
import { buildImports } from "./src/runtime.js";

describe("#1163 — static eval inlining (compile-time eval of string literal)", () => {
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

  it("eval of arithmetic expression returns value", async () => {
    const src = `
      export function test(): number {
        const r: any = eval("1 + 2");
        return r === 3 ? 1 : 0;
      }
    `;
    const { pass, error, ret } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass, `got ret=${String(ret)}`).toBe(true);
  });

  it("eval of string concatenation returns string", async () => {
    const src = `
      export function test(): number {
        const r: any = eval('"foo" + "bar"');
        return r === "foobar" ? 1 : 0;
      }
    `;
    const { pass, error, ret } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass, `got ret=${String(ret)}`).toBe(true);
  });

  it("eval with var declaration + identifier returns declared value", async () => {
    const src = `
      export function test(): number {
        const r: any = eval("var x = 42; x");
        return r === 42 ? 1 : 0;
      }
    `;
    const { pass, error, ret } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass, `got ret=${String(ret)}`).toBe(true);
  });

  it("eval of throw TypeError propagates as catchable TypeError", async () => {
    const src = `
      export function test(): number {
        try {
          eval("throw new TypeError('boom')");
          return 0;
        } catch (e: any) {
          return e instanceof TypeError ? 1 : 0;
        }
      }
    `;
    const { pass, error, ret } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass, `got ret=${String(ret)}`).toBe(true);
  });

  it("eval of string literal concatenated at source level (compile-time) inlines", async () => {
    const src = `
      export function test(): number {
        const r: any = eval("1 + " + "2");
        return r === 3 ? 1 : 0;
      }
    `;
    const { pass, error, ret } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass, `got ret=${String(ret)}`).toBe(true);
  });

  it("eval of template literal with no substitutions inlines", async () => {
    const src = `
      export function test(): number {
        const r: any = eval(\`10 * 4\`);
        return r === 40 ? 1 : 0;
      }
    `;
    const { pass, error, ret } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass, `got ret=${String(ret)}`).toBe(true);
  });

  it("indirect (0, eval)(literal) inlines", async () => {
    const src = `
      export function test(): number {
        const r: any = (0, eval)("100 - 58");
        return r === 42 ? 1 : 0;
      }
    `;
    const { pass, error, ret } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass, `got ret=${String(ret)}`).toBe(true);
  });

  it("eval with no arguments still returns undefined (non-literal fallback path)", async () => {
    const src = `
      export function test(): number {
        const r: any = (eval as any)();
        return r === undefined ? 1 : 0;
      }
    `;
    const { pass, error, ret } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass, `got ret=${String(ret)}`).toBe(true);
  });
});
