import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }

  // Build imports: provide env stubs needed for any-typed code paths
  const env: Record<string, Function | WebAssembly.Global> = {
    console_log_number: () => {},
    console_log_string: () => {},
    console_log_bool: () => {},
    __box_number: (v: number) => v,
    __box_boolean: (v: number) => Boolean(v),
    __unbox_number: (v: unknown) => Number(v),
    __unbox_boolean: (v: unknown) => (v ? 1 : 0),
    __is_truthy: (v: unknown) => (v ? 1 : 0),
    __typeof: (v: unknown) => typeof v,
    Math_pow: Math.pow,
    parseFloat: (s: any) => parseFloat(String(s)),
    number_toString: (v: number) => String(v),
  };

  // Use a proxy so any missing env import returns a no-op stub
  const proxyEnv = new Proxy(env, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      // Return a function that returns 0 for missing imports
      return (..._args: unknown[]) => 0;
    },
  });

  const jsStringPolyfill = {
    concat: (a: string, b: string) => a + b,
    length: (s: string) => s.length,
    equals: (a: string, b: string) => (a === b ? 1 : 0),
    substring: (s: string, start: number, end: number) => s.substring(start, end),
    charCodeAt: (s: string, i: number) => s.charCodeAt(i),
  };

  // Build string constants if the module needs them
  const stringConstants: Record<string, string> = {};
  if (result.wat) {
    const constRegex = /\(global \$__str_const_(\d+)/g;
    let match;
    while ((match = constRegex.exec(result.wat)) !== null) {
      // These are auto-populated from the module
    }
  }

  const imports: WebAssembly.Imports = {
    env: proxyEnv as unknown as Record<string, WebAssembly.ImportValue>,
    "wasm:js-string": jsStringPolyfill,
  };

  // Auto-stub any module not in imports
  const proxyImports = new Proxy(imports, {
    get(target, module: string) {
      if (module in target) {
        return new Proxy(target[module] as Record<string, unknown>, {
          get(inner, field: string) {
            if (field in inner) return inner[field];
            return () => 0;
          },
        });
      }
      return new Proxy({}, { get: () => () => 0 });
    },
  });

  const { instance } = await WebAssembly.instantiate(
    result.binary,
    proxyImports as WebAssembly.Imports,
  );
  return (instance.exports as any)[fn](...args);
}

describe("Type-specialized arithmetic: skip AnyValue for known types (#597)", () => {
  it("both operands number: subtraction uses direct f64", async () => {
    expect(await run(`
      function calc(a: number, b: number): number { return a - b; }
      export function main(): number { return calc(10, 3); }
    `, "main")).toBe(7);
  });

  it("both operands number: multiplication", async () => {
    expect(await run(`
      function calc(a: number, b: number): number { return a * b; }
      export function main(): number { return calc(6, 7); }
    `, "main")).toBe(42);
  });

  it("both operands number: division", async () => {
    expect(await run(`
      function calc(a: number, b: number): number { return a / b; }
      export function main(): number { return calc(15, 3); }
    `, "main")).toBe(5);
  });

  it("both operands number: modulus", async () => {
    expect(await run(`
      function calc(a: number, b: number): number { return a % b; }
      export function main(): number { return calc(17, 5); }
    `, "main")).toBe(2);
  });

  it("both operands number: comparisons", async () => {
    expect(await run(`
      export function main(): number {
        const a: number = 5;
        const b: number = 10;
        let result = 0;
        if (a < b) result += 1;
        if (a <= b) result += 2;
        if (b > a) result += 4;
        if (b >= a) result += 8;
        return result;
      }
    `, "main")).toBe(15);
  });

  it("any-typed operands: subtraction via numeric path (not AnyValue)", async () => {
    expect(await run(`
      export function main(): number {
        const a: any = 20;
        const b: any = 8;
        return a - b;
      }
    `, "main")).toBe(12);
  });

  it("any-typed operands: multiplication via numeric path", async () => {
    expect(await run(`
      export function main(): number {
        const a: any = 6;
        const b: any = 7;
        return a * b;
      }
    `, "main")).toBe(42);
  });

  it("any-typed operands: division via numeric path", async () => {
    expect(await run(`
      export function main(): number {
        const a: any = 100;
        const b: any = 4;
        return a / b;
      }
    `, "main")).toBe(25);
  });

  it("any-typed operands: modulus via numeric path", async () => {
    expect(await run(`
      export function main(): number {
        const a: any = 17;
        const b: any = 5;
        return a % b;
      }
    `, "main")).toBe(2);
  });

  it("any-typed operands: comparison operators", async () => {
    expect(await run(`
      export function main(): number {
        const a: any = 3;
        const b: any = 7;
        let result = 0;
        if (a < b) result += 1;
        if (a <= b) result += 2;
        if (b > a) result += 4;
        if (b >= a) result += 8;
        return result;
      }
    `, "main")).toBe(15);
  });

  it("any-typed operands: bitwise operators", async () => {
    expect(await run(`
      export function main(): number {
        const a: any = 255;
        const b: any = 15;
        const and = a & b;
        const or = a | b;
        const xor = a ^ b;
        return and + or + xor;
      }
    `, "main")).toBe(15 + 255 + 240);
  });

  it("any-typed operands: shift operators", async () => {
    expect(await run(`
      export function main(): number {
        const a: any = 8;
        const shl = a << 2;
        const shr = a >> 1;
        return shl + shr;
      }
    `, "main")).toBe(36);
  });

  it("any-typed: addition still works (via AnyValue for string safety)", async () => {
    expect(await run(`
      export function main(): number {
        const a: any = 10;
        const b: any = 20;
        return a + b;
      }
    `, "main")).toBe(30);
  });

  it("any-typed operands: exponentiation", async () => {
    expect(await run(`
      export function main(): number {
        const a: any = 2;
        const b: any = 10;
        return a ** b;
      }
    `, "main")).toBe(1024);
  });

  it("chained arithmetic with any-typed operands", async () => {
    expect(await run(`
      export function main(): number {
        const a: any = 10;
        const b: any = 3;
        const c: any = 2;
        return a - b * c;
      }
    `, "main")).toBe(4);
  });
});
