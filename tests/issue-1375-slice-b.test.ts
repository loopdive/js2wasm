import { describe, it, expect } from "vitest";
import { compile } from "./src/index.js";
import { buildImports } from "./src/runtime.js";

describe("#1375 Slice B — IR-native ?. on nullable extern receivers (#1392 primitives)", () => {
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

  it("null RegExp | undefined: r?.source returns undefined via if/else null arm", async () => {
    const src = `
      export function test(): number {
        let r: RegExp | undefined = undefined;
        const s = r?.source;
        return s === undefined ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("real RegExp | undefined: r?.source returns the source string via else arm", async () => {
    const src = `
      export function test(): number {
        let r: RegExp | undefined = /abc/;
        return (r?.source ?? "") === "abc" ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("null RegExp: r?.flags returns undefined", async () => {
    const src = `
      export function test(): number {
        let r: RegExp | undefined = undefined;
        const f = r?.flags;
        return f === undefined ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("real RegExp: r?.flags returns 'g'", async () => {
    const src = `
      export function test(): number {
        let r: RegExp | undefined = /abc/g;
        return (r?.flags ?? "") === "g" ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  // Regression guards — Slice A (TS-narrowing fast-path) and earlier slices still work

  it("regression guard: Slice A — Map (non-null TS) m?.get(k) still works", async () => {
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

  it("regression guard: object literal o?.x (existing non-null IR path)", async () => {
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

  it("regression guard: class instance c?.field (existing non-null IR path)", async () => {
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
});
