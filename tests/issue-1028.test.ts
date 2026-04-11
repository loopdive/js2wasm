import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("#1028 — TypedArray.prototype.toLocaleString element access", () => {
  async function run(src: string): Promise<any> {
    const r = compile(src, { fileName: "test.ts" });
    if (!r.success) throw new Error(`CE: ${r.errors[0]?.message}`);
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    (imports as any).setExports?.(instance.exports);
    return (instance.exports as any).test?.();
  }

  it("Int8Array.toLocaleString() returns a non-null string", async () => {
    const ret = await run(`
      export function test(): i32 {
        const sample = new Int8Array([42, 0]);
        const r: any = sample.toLocaleString();
        if (r == null) return 0;
        if (typeof r !== "string") return 0;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("empty Int8Array.toLocaleString() returns empty string", async () => {
    const ret = await run(`
      export function test(): i32 {
        const sample = new Int8Array(0);
        const r: any = sample.toLocaleString();
        if (r == null) return 0;
        if (typeof r !== "string") return 0;
        return (r as string).length === 0 ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("Uint8Array.toLocaleString() is non-null for populated arrays", async () => {
    const ret = await run(`
      export function test(): i32 {
        const sample = new Uint8Array([1, 2, 3]);
        const r: any = sample.toLocaleString();
        return r != null && typeof r === "string" ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });
});
