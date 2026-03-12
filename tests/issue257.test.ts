import { describe, it, expect } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

const jsStringPolyfill = {
  concat: (a: string, b: string) => a + b,
  length: (s: string) => s.length,
  equals: (a: string, b: string) => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number) => s.substring(start, end),
  charCodeAt: (s: string, i: number) => s.charCodeAt(i),
};

function buildImports(result: CompileResult): WebAssembly.Imports {
  const env: Record<string, Function> = {
    console_log_number: () => {},
    console_log_string: () => {},
    console_log_bool: () => {},
    number_toString: (v: number) => String(v),
    string_concat: (a: string, b: string) => a + b,
    string_toUpperCase: (s: string) => s.toUpperCase(),
    string_toLowerCase: (s: string) => s.toLowerCase(),
    string_trim: (s: string) => s.trim(),
    string_trimStart: (s: string) => s.trimStart(),
    string_trimEnd: (s: string) => s.trimEnd(),
    string_charAt: (s: string, i: number) => s.charAt(i),
    string_slice: (s: string, start: number, end: number) => s.slice(start, end),
    string_substring: (s: string, start: number, end: number) => s.substring(start, end),
    string_indexOf: (s: string, search: string, fromIndex: string) => s.indexOf(search, Number(fromIndex) || 0),
    string_lastIndexOf: (s: string, search: string, fromIndex: string) => s.lastIndexOf(search, Number(fromIndex) || undefined as any),
    string_includes: (s: string, search: string) => s.includes(search) ? 1 : 0,
    string_startsWith: (s: string, search: string) => s.startsWith(search) ? 1 : 0,
    string_endsWith: (s: string, search: string) => s.endsWith(search) ? 1 : 0,
    string_replace: (s: string, search: string, replace: string) => s.replace(search, replace),
    string_repeat: (s: string, count: number) => s.repeat(count),
    string_padStart: (s: string, length: number, fill: string) => s.padStart(length, fill),
    string_padEnd: (s: string, length: number, fill: string) => s.padEnd(length, fill),
    string_split: (s: string, sep: string) => s.split(sep),
    string_at: (s: string, index: number) => s.at(index),
    __box_number: (v: number) => v,
    __unbox_number: (v: unknown) => Number(v),
    __typeof: (v: unknown) => typeof v,
  };
  return {
    env,
    "wasm:js-string": jsStringPolyfill,
    string_constants: buildStringConstants(result.stringPool),
  } as WebAssembly.Imports;
}

async function compileToWasm(source: string) {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    buildImports(result),
  );
  return instance.exports as Record<string, Function>;
}

describe("Issue #257: method calls on returned values", () => {
  it("method call on function return value", async () => {
    const exports = await compileToWasm(`
      class Foo {
        value: number;
        constructor(v: number) { this.value = v; }
        getValue(): number { return this.value; }
      }
      function getFoo(): Foo { return new Foo(42); }
      export function test(): number { return getFoo().getValue(); }
    `);
    expect(exports.test()).toBe(42);
  });

  it("chained method calls on class instances", async () => {
    const exports = await compileToWasm(`
      class Builder {
        val: number;
        constructor() { this.val = 0; }
        add(n: number): Builder { this.val = this.val + n; return this; }
        result(): number { return this.val; }
      }
      export function test(): number {
        const b = new Builder();
        return b.add(10).add(20).add(12).result();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("string method on function return value", async () => {
    const exports = await compileToWasm(`
      function getStr(): string { return "hello world"; }
      export function test(): number { return getStr().length; }
    `);
    expect(exports.test()).toBe(11);
  });

  it("parenthesized function call: (f)()", async () => {
    const exports = await compileToWasm(`
      function f(): number { return 42; }
      export function test(): number { return (f)(); }
    `);
    expect(exports.test()).toBe(42);
  });

  it("string .concat() method compiles without errors", async () => {
    const result = compile(`
      export function test(): string { return "hello".concat(" world"); }
    `);
    const unsupported = result.errors.filter(e => e.message === "Unsupported call expression");
    expect(unsupported).toHaveLength(0);
  });

  it("method call on struct return value", async () => {
    const exports = await compileToWasm(`
      function makeObj(): { x: number; getX(): number } {
        return { x: 42, getX() { return this.x; } };
      }
      export function test(): number { return makeObj().getX(); }
    `);
    expect(exports.test()).toBe(42);
  });

  it("element access call with string literal key converts to property access", async () => {
    // Test that obj["method"]() is handled the same as obj.method()
    // Use a function-scoped object so struct resolution works
    const exports = await compileToWasm(`
      export function test(): number {
        const obj = { a(): number { return 42; } };
        return obj["a"]();
      }
    `);
    expect(exports.test()).toBe(42);
  });
});
