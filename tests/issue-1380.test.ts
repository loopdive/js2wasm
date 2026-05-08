import { describe, it, expect } from "vitest";
import { compile } from "./src/index.js";
import { buildImports } from "./src/runtime.js";

describe("#1380 — equality with undeclared identifier throws ReferenceError (spec §13.10.1)", () => {
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

  it("`1 == undeclared` throws a ReferenceError instance (S11.9.1_A2.1_T3)", async () => {
    const src = `
      export function test(): number {
        try {
          // @ts-ignore
          const _ = 1 == truly_undeclared_y;
          return 0;
        } catch (e: any) {
          return e instanceof ReferenceError ? 1 : 0;
        }
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("`undeclared == 1` throws a ReferenceError instance (left-side eval)", async () => {
    const src = `
      export function test(): number {
        try {
          // @ts-ignore
          const _ = truly_undeclared_x == 1;
          return 0;
        } catch (e: any) {
          return e instanceof ReferenceError ? 1 : 0;
        }
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("`1 !== undeclared` throws a ReferenceError instance (strict-not-equals)", async () => {
    const src = `
      export function test(): number {
        try {
          // @ts-ignore
          const _ = 1 !== truly_undeclared_y;
          return 0;
        } catch (e: any) {
          return e instanceof ReferenceError ? 1 : 0;
        }
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("`1 === undeclared` throws a ReferenceError instance (strict-equals)", async () => {
    const src = `
      export function test(): number {
        try {
          // @ts-ignore
          const _ = 1 === truly_undeclared_y;
          return 0;
        } catch (e: any) {
          return e instanceof ReferenceError ? 1 : 0;
        }
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("ReferenceError message contains the identifier name", async () => {
    const src = `
      export function test(): number {
        try {
          // @ts-ignore
          const _ = 1 == undefined_marker_xyz;
          return 0;
        } catch (e: any) {
          return e instanceof ReferenceError && String(e.message).indexOf("undefined_marker_xyz") >= 0 ? 1 : 0;
        }
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("declared variables still work (no false-positive throw)", async () => {
    const src = `
      export function test(): number {
        const y: any = 1;
        return (1 == y) ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });
});
