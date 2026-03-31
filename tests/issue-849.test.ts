import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(src: string): Promise<number> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as any).test();
}

describe("Mapped arguments object (#849)", () => {
  it("param assignment syncs to arguments[i]", async () => {
    const src = `export function test(): number {
      function f(a: any) {
        a = 2;
        if (arguments[0] !== 2) return 0;
        return 1;
      }
      return f(1);
    }`;
    expect(await run(src)).toBe(1);
  });

  it("arguments[i] assignment syncs to param", async () => {
    const src = `export function test(): number {
      function f(a: any) {
        arguments[0] = 2;
        if (a !== 2) return 0;
        return 1;
      }
      return f(1);
    }`;
    expect(await run(src)).toBe(1);
  });

  it("multiple params sync both directions", async () => {
    const src = `export function test(): number {
      function f(a: any, b: any, c: any) {
        a = 10; b = 20; c = 30;
        if (arguments[0] !== 10) return 0;
        if (arguments[1] !== 20) return 0;
        if (arguments[2] !== 30) return 0;
        arguments[0] = 100;
        if (a !== 100) return 0;
        return 1;
      }
      return f(1, 2, 3);
    }`;
    expect(await run(src)).toBe(1);
  });

  it("no arguments reference does not break", async () => {
    const src = `export function test(): number {
      function f(a: any) {
        a = 2;
        return a;
      }
      return f(1) === 2 ? 1 : 0;
    }`;
    expect(await run(src)).toBe(1);
  });

  it("string param syncs to arguments", async () => {
    const src = `export function test(): number {
      function f(a: any, b: any, c: any) {
        a = 1; b = 'str'; c = 2.1;
        if (arguments[0] !== 1) return 0;
        if (arguments[1] !== 'str') return 0;
        if (arguments[2] !== 2.1) return 0;
        return 1;
      }
      return f(10, 'sss', 1);
    }`;
    expect(await run(src)).toBe(1);
  });
});
