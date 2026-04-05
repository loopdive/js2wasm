import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports as buildRuntimeImports } from "../src/runtime.js";
import { buildStringConstants } from "../src/runtime.js";

function buildImports(result: any): WebAssembly.Imports {
  const manualEnv: Record<string, Function> = {
    number_toString: (v: number) => String(v),
  };
  const jsString = {
    concat: (a: string, b: string) => (a || "") + (b || ""),
    length: (s: string) => (s ? s.length : 0),
    equals: (a: string, b: string) => (a === b ? 1 : 0),
    substring: (s: string, start: number, end: number) => (s ? s.substring(start, end) : ""),
    charCodeAt: (s: string, i: number) => (s ? s.charCodeAt(i) : 0),
  };
  // Use runtime buildImports for full support (including __concat_N)
  if (result.imports && result.imports.length > 0) {
    const runtimeResult = buildRuntimeImports(result.imports, undefined, result.stringPool);
    const mergedEnv = { ...manualEnv, ...runtimeResult.env };
    return {
      env: mergedEnv,
      "wasm:js-string": jsString,
      string_constants: buildStringConstants(result.stringPool),
    } as WebAssembly.Imports;
  }
  return {
    env: manualEnv,
    "wasm:js-string": jsString,
    string_constants: buildStringConstants(result.stringPool),
  } as WebAssembly.Imports;
}

describe("String concat chain batching (#958)", () => {
  it("3-operand chain uses __concat_3 import", () => {
    const source = `export function test(): string {
      return "hello" + " " + "world";
    }`;
    const result = compile(source);
    expect(result.success).toBe(true);
    expect(result.wat).toContain("__concat_3");
  });

  it("6-operand chain uses __concat_6 import", () => {
    const source = `export function test(): string {
      return "a" + "b" + "c" + "d" + "e" + "f";
    }`;
    const result = compile(source);
    expect(result.success).toBe(true);
    expect(result.wat).toContain("__concat_6");
  });

  it("2-operand chain does NOT use batching", () => {
    const source = `export function test(): string {
      return "hello" + "world";
    }`;
    const result = compile(source);
    expect(result.success).toBe(true);
    expect(result.wat).not.toContain("__concat_");
  });

  it("3-operand chain produces correct result at runtime", async () => {
    const source = `export function test(): string {
      return "hello" + " " + "world";
    }`;
    const result = compile(source);
    expect(result.success).toBe(true);
    const imports = buildImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    expect((instance.exports as any).test()).toBe("hello world");
  });

  it("6-operand chain produces correct result at runtime", async () => {
    const source = `export function test(): string {
      return "a" + "b" + "c" + "d" + "e" + "f";
    }`;
    const result = compile(source);
    expect(result.success).toBe(true);
    const imports = buildImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    expect((instance.exports as any).test()).toBe("abcdef");
  });

  it("mixed types: string + number + boolean", async () => {
    const source = `export function test(): string {
      const n: number = 42;
      const b: boolean = true;
      return "value: " + n + " ok: " + b;
    }`;
    const result = compile(source);
    expect(result.success).toBe(true);
    const imports = buildImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    expect((instance.exports as any).test()).toBe("value: 42 ok: true");
  });

  it("chain with variables", async () => {
    const source = `export function test(): string {
      const a: string = "hello";
      const b: string = " ";
      const c: string = "world";
      return a + b + c;
    }`;
    const result = compile(source);
    expect(result.success).toBe(true);
    const imports = buildImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    expect((instance.exports as any).test()).toBe("hello world");
  });

  it("chain with function calls", async () => {
    const source = `
    function getPrefix(): string { return "pre-"; }
    function getSuffix(): string { return "-suf"; }
    export function test(): string {
      return getPrefix() + "middle" + getSuffix();
    }`;
    const result = compile(source);
    expect(result.success).toBe(true);
    const imports = buildImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    expect((instance.exports as any).test()).toBe("pre-middle-suf");
  });
});
