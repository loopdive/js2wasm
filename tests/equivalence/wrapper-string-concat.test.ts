import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

describe("String wrapper type in + operator (#649)", () => {
  it("new String('1') + number compiles without type error", async () => {
    const source = `
      export function test(): number {
        const s = new String("1");
        const n = 1;
        const result = s + n;
        return 1;
      }
    `;
    const result = compile(source, { fileName: "test.ts" });
    expect(result.success).toBe(true);
    // Verify it instantiates without validation error
    const { instance } = await WebAssembly.instantiate(result.binary, buildImports(result));
    expect((instance.exports as any).test()).toBe(1);
  });

  it("number + new String('1') compiles without type error", async () => {
    const source = `
      export function test(): number {
        const s = new String("1");
        const n = 1;
        const result = n + s;
        return 1;
      }
    `;
    const result = compile(source, { fileName: "test.ts" });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, buildImports(result));
    expect((instance.exports as any).test()).toBe(1);
  });

  it("new String + new Number compiles without type error", async () => {
    const source = `
      export function test(): number {
        const s = new String("x");
        const n = new Number(1);
        const result = s + n;
        return 1;
      }
    `;
    const result = compile(source, { fileName: "test.ts" });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, buildImports(result));
    expect((instance.exports as any).test()).toBe(1);
  });

  it("string + new Number compiles without type error", async () => {
    const source = `
      export function test(): number {
        const result = "abc" + new Number(1);
        return 1;
      }
    `;
    const result = compile(source, { fileName: "test.ts" });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, buildImports(result));
    expect((instance.exports as any).test()).toBe(1);
  });

  it("new Number + string compiles without type error", async () => {
    const source = `
      export function test(): number {
        const result = new Number(1) + "abc";
        return 1;
      }
    `;
    const result = compile(source, { fileName: "test.ts" });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, buildImports(result));
    expect((instance.exports as any).test()).toBe(1);
  });
});

function buildImports(result: any) {
  const env: Record<string, any> = {};
  for (const imp of result.imports || []) {
    if (imp.module === "env" && !env[imp.name]) {
      if (imp.name === "number_toString") env[imp.name] = (v: number) => String(v);
      else if (imp.name === "__box_number") env[imp.name] = (v: number) => v;
      else if (imp.name === "__unbox_number") env[imp.name] = (v: any) => Number(v);
      else env[imp.name] = () => {};
    }
  }
  const stringConstants: Record<string, any> = {};
  if (result.stringPool) {
    for (const s of result.stringPool) {
      stringConstants[s] = s;
    }
  }
  const jsString = {
    concat: (a: string, b: string) => (a || "") + (b || ""),
    length: (s: string) => (s ? s.length : 0),
    equals: (a: string, b: string) => (a === b ? 1 : 0),
    substring: (s: string, start: number, end: number) => (s ? s.substring(start, end) : ""),
    charCodeAt: (s: string, i: number) => (s ? s.charCodeAt(i) : 0),
  };
  return { env, string_constants: stringConstants, "wasm:js-string": jsString };
}
