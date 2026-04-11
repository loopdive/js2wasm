import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<number> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("compile: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as any).setExports?.(instance.exports);
  return (instance.exports as any).test();
}

describe("#1055 RegExp(pattern, flags) without `new`", () => {
  it("routes to host RegExp constructor and throws SyntaxError on invalid modifier", async () => {
    const src = `
      export function test(): number {
        try {
          const r = RegExp("(?s-s:a)", "");
          return 99;
        } catch (e) {
          return (e instanceof SyntaxError) ? 1 : 2;
        }
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("throws SyntaxError on repeated flag in modifier", async () => {
    const src = `
      export function test(): number {
        try {
          const r = RegExp("(?i-i:a)", "");
          return 99;
        } catch (e) {
          return (e instanceof SyntaxError) ? 1 : 2;
        }
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("compiles a plain RegExp() call and returns a usable regex", async () => {
    const src = `
      export function test(): number {
        const r: any = RegExp("abc", "");
        return r.test("abc") ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("still supports new RegExp() without regression", async () => {
    const src = `
      export function test(): number {
        const r: any = new RegExp("x", "g");
        return r.test("xyz") ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("throws SyntaxError for malformed pattern via RegExp()", async () => {
    const src = `
      export function test(): number {
        try {
          const r = RegExp("[", "");
          return 99;
        } catch (e) {
          return (e instanceof SyntaxError) ? 1 : 2;
        }
      }
    `;
    expect(await run(src)).toBe(1);
  });
});
