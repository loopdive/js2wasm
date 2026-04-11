import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("#1037 — Symbol.dispose / Symbol.asyncDispose registration", () => {
  async function run(src: string): Promise<any> {
    const r = compile(src, { fileName: "test.ts" });
    if (!r.success) throw new Error(`CE: ${r.errors[0]?.message}`);
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    (imports as any).setExports?.(instance.exports);
    return (instance.exports as any).test?.();
  }

  it("Symbol.dispose is accessible and identity-equal", async () => {
    const ret = await run(`
      export function test(): i32 {
        return Symbol.dispose === Symbol.dispose ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("Symbol.asyncDispose is accessible and identity-equal", async () => {
    const ret = await run(`
      export function test(): i32 {
        return Symbol.asyncDispose === Symbol.asyncDispose ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("Symbol.dispose !== Symbol.asyncDispose", async () => {
    const ret = await run(`
      export function test(): i32 {
        return Symbol.dispose !== Symbol.asyncDispose ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });
});
