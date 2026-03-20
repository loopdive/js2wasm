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
  };
  env["number_toString"] = (v: number) => String(v);
  env["__unbox_number"] = (v: unknown) => Number(v);
  env["__unbox_boolean"] = (v: unknown) => (v ? 1 : 0);
  env["__box_number"] = (v: number) => v;
  env["__box_boolean"] = (v: number) => Boolean(v);
  env["__typeof"] = (v: unknown) => typeof v;
  env["__typeof_number"] = (v: unknown) => (typeof v === "number" ? 1 : 0);
  env["__typeof_string"] = (v: unknown) => (typeof v === "string" ? 1 : 0);
  env["__typeof_boolean"] = (v: unknown) => (typeof v === "boolean" ? 1 : 0);
  env["__is_truthy"] = (v: unknown) => (v ? 1 : 0);
  env["string_compare"] = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  env["parseFloat"] = (s: any) => parseFloat(String(s));
  env["parseInt"] = (s: any, radix: number) => {
    const r = isNaN(radix) ? undefined : radix;
    return parseInt(String(s), r);
  };

  const jsStringPolyfill = {
    concat: (a: string, b: string) => a + b,
    length: (s: string) => s.length,
    equals: (a: string, b: string) => (a === b ? 1 : 0),
    substring: (s: string, start: number, end: number) => s.substring(start, end),
    charCodeAt: (s: string, i: number) => s.charCodeAt(i),
  };

  const { instance } = await WebAssembly.instantiate(result.binary, {
    env,
    "wasm:js-string": jsStringPolyfill,
    string_constants: buildStringConstants(result.stringPool),
  } as WebAssembly.Imports);
  return (instance.exports as any)[fn](...args);
}

describe("call argument type coercion (#626)", () => {
  it("should coerce f64 result to externref parameter", async () => {
    // Function expects any (externref) but caller passes a number expression
    const src = `
      export function identity(x: any): any { return x; }
      export function test(): number {
        const a: number = 1;
        const b: number = 2;
        return identity(a + b) as number;
      }
    `;
    expect(await run(src, "test")).toBe(3);
  });

  it("should coerce externref to f64 in call args", async () => {
    const src = `
      export function double(x: number): number { return x * 2; }
      export function test(): number {
        const obj: any = 5;
        return double(obj as number);
      }
    `;
    expect(await run(src, "test")).toBe(10);
  });

  it("should coerce arguments in method calls", async () => {
    const src = `
      class Calc {
        add(a: number, b: number): number { return a + b; }
      }
      export function test(): number {
        const c = new Calc();
        return c.add(1, 2);
      }
    `;
    expect(await run(src, "test")).toBe(3);
  });

  it("should coerce arguments in closure calls", async () => {
    const src = `
      function makeAdder(x: number): (y: number) => number {
        return (y: number) => x + y;
      }
      export function test(): number {
        const add5 = makeAdder(5);
        return add5(10);
      }
    `;
    expect(await run(src, "test")).toBe(15);
  });

  it("should handle multiple argument coercions in one call", async () => {
    const src = `
      export function sum3(a: any, b: any, c: any): number {
        return (a as number) + (b as number) + (c as number);
      }
      export function test(): number {
        return sum3(1, 2, 3);
      }
    `;
    expect(await run(src, "test")).toBe(6);
  });

  it("should coerce in static method calls", async () => {
    const src = `
      class MathHelper {
        static multiply(a: number, b: number): number { return a * b; }
      }
      export function test(): number {
        return MathHelper.multiply(3, 4);
      }
    `;
    expect(await run(src, "test")).toBe(12);
  });
});
