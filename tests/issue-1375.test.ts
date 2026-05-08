import { describe, it, expect } from "vitest";
import { compile } from "./src/index.js";
import { buildImports } from "./src/runtime.js";

describe("#1375 — IR optional-chain TS-narrowing fast-path", () => {
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

  it("Map (non-null TS type): m?.get(k) works via TS-narrowing fast-path", async () => {
    const src = `
      export function test(): number {
        const m = new Map<string, number>();
        m.set("x", 42);
        const v = m?.get("x") ?? -1;
        return v === 42 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("Map | undefined (nullable): m?.get(k) still works via legacy fallback", async () => {
    const src = `
      export function test(): number {
        let m: Map<string, number> | undefined = new Map();
        m?.set("x", 42);
        const v = m?.get("x") ?? -1;
        return v === 42 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("object literal o?.x continues to work (existing non-null IR path)", async () => {
    const src = `
      export function test(): number {
        const o = { x: 42 };
        return o?.x === 42 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("class instance c?.field continues to work (existing non-null IR path)", async () => {
    const src = `
      class C { x: number = 42; }
      export function test(): number {
        const c = new C();
        return c?.x === 42 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("nullable receiver (truly undefined at runtime) still returns undefined via legacy", async () => {
    // m typed as Map | undefined and actually undefined at runtime.
    // Legacy fallback handles the null guard correctly.
    const src = `
      export function test(): number {
        let m: Map<string, number> | undefined = undefined;
        const v = m?.get("x") ?? -1;
        return v === -1 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("RegExp instance: r?.source works via TS-narrowing fast-path", async () => {
    const src = `
      export function test(): number {
        const r = /hello/;
        const src = r?.source ?? "";
        return src === "hello" ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });
});
