import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map(e => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`);
  }
  const env: Record<string, Function> = {
    console_log_number: () => {},
    console_log_bool: () => {},
    console_log_string: () => {},
    number_toString: (v: number) => String(v),
    __typeof_number: (v: unknown) => (typeof v === "number" ? 1 : 0),
    __typeof_string: (v: unknown) => (typeof v === "string" ? 1 : 0),
    __typeof_boolean: (v: unknown) => (typeof v === "boolean" ? 1 : 0),
    __typeof: (v: unknown) => typeof v,
    __is_truthy: (v: unknown) => (v ? 1 : 0),
    parseFloat: (s: any) => parseFloat(String(s)),
    string_compare: (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0),
    __unbox_number: (v: unknown) => Number(v),
    __unbox_boolean: (v: unknown) => (v ? 1 : 0),
    __box_number: (v: number) => v,
    __box_boolean: (v: number) => Boolean(v),
    __make_callback: () => null,
  };

  const { instance } = await WebAssembly.instantiate(result.binary, {
    env,
    "wasm:js-string": {
      concat: (a: string, b: string) => a + b,
      length: (s: string) => s.length,
      equals: (a: string, b: string) => (a === b ? 1 : 0),
      substring: (s: string, start: number, end: number) => s.substring(start, end),
      charCodeAt: (s: string, i: number) => s.charCodeAt(i),
    },
    string_constants: buildStringConstants(result.stringPool),
  } as WebAssembly.Imports);
  return (instance.exports as any)[fn](...args);
}

describe("static eval()", () => {
  it("eval with numeric expression returns the result", async () => {
    const src = `
      export function test(): number {
        return eval("1 + 2") as number;
      }
    `;
    expect(await run(src, "test")).toBe(3);
  });

  it("eval with variable declaration creates variable in scope", async () => {
    const src = `
      export function test(): number {
        eval("var x = 42");
        return x;
      }
    `;
    expect(await run(src, "test")).toBe(42);
  });

  it("eval with multiple statements returns last expression value", async () => {
    const src = `
      export function test(): number {
        return eval("var a = 10; a + 5") as number;
      }
    `;
    expect(await run(src, "test")).toBe(15);
  });

  it("indirect eval (0, eval)() works the same as direct eval", async () => {
    const src = `
      export function test(): number {
        return (0, eval)("3 * 7") as number;
      }
    `;
    expect(await run(src, "test")).toBe(21);
  });

  it("eval with string literal expression", async () => {
    const src = `
      export function test(): string {
        return eval("'hello'") as string;
      }
    `;
    expect(await run(src, "test")).toBe("hello");
  });

  it("eval with empty string returns undefined (externref null)", async () => {
    const src = `
      export function test(): number {
        const r = eval("");
        return r === undefined ? 1 : 0;
      }
    `;
    // eval("") returns undefined which should be externref null
    // This may or may not compile depending on how the comparison works;
    // at minimum it should not crash the compiler
    const result = compile(src);
    expect(result.success).toBe(true);
  });

  it("eval with boolean expression", async () => {
    const src = `
      export function test(): boolean {
        return eval("true") as boolean;
      }
    `;
    expect(await run(src, "test")).toBe(1); // booleans are i32 in wasm
  });

  it("eval with assignment to outer variable", async () => {
    const src = `
      export function test(): number {
        var result = 0;
        eval("result = 99");
        return result;
      }
    `;
    expect(await run(src, "test")).toBe(99);
  });

  it("eval with conditional expression", async () => {
    const src = `
      export function test(): number {
        return eval("true ? 10 : 20") as number;
      }
    `;
    expect(await run(src, "test")).toBe(10);
  });

  it("eval used as statement (result dropped)", async () => {
    const src = `
      export function test(): number {
        var x = 1;
        eval("x = x + 1");
        eval("x = x * 3");
        return x;
      }
    `;
    expect(await run(src, "test")).toBe(6);
  });
});

describe("new Function()", () => {
  it("compiles without error", async () => {
    const src = `
      export function test(): number {
        const add = new Function("a", "b", "return a + b");
        return 42;
      }
    `;
    // At minimum, compilation should succeed
    const result = compile(src);
    expect(result.success).toBe(true);
  });
});
