import { describe, it, expect } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";
import ts from "typescript";

const jsStringPolyfill = {
  concat: (a: string, b: string) => a + b,
  length: (s: string) => s.length,
  equals: (a: string, b: string) => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number) =>
    s.substring(start, end),
  charCodeAt: (s: string, i: number) => s.charCodeAt(i),
};

function buildImports(result: CompileResult): WebAssembly.Imports {
  const env: Record<string, Function> = {
    console_log_number: () => {},
    console_log_string: () => {},
    console_log_bool: () => {},
    Math_sin: Math.sin,
    Math_cos: Math.cos,
    Math_pow: Math.pow,
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

function evaluateAsJs(source: string): Record<string, Function> {
  const jsOutput = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  });
  const exports: Record<string, unknown> = {};
  const module = { exports };
  const fn = new Function("exports", "module", "Math", jsOutput.outputText);
  fn(exports, module, Math);
  return exports as Record<string, Function>;
}

async function assertEquivalent(
  source: string,
  testCases: { fn: string; args: unknown[]; approx?: boolean }[],
) {
  const wasmExports = await compileToWasm(source);
  const jsExports = evaluateAsJs(source);

  for (const { fn, args, approx } of testCases) {
    const wasmResult = wasmExports[fn]!(...args);
    const jsResult = jsExports[fn]!(...args);

    if (approx) {
      expect(wasmResult).toBeCloseTo(jsResult as number, 10);
    } else {
      expect(wasmResult).toBe(jsResult);
    }
  }
}

describe("Issue #284: for-of destructuring", () => {
  it("object binding destructuring in for-of", async () => {
    await assertEquivalent(
      `
      interface Item { a: number; b: number; }
      export function test(): number {
        const items: Item[] = [{a: 1, b: 2}, {a: 3, b: 4}];
        let sum = 0;
        for (const {a, b} of items) {
          sum = sum + a + b;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array binding destructuring in for-of", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const items: number[][] = [[1, 2], [3, 4]];
        let sum = 0;
        for (const [x, y] of items) {
          sum = sum + x + y;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("object assignment destructuring in for-of", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let a: number = 0;
        let b: number = 0;
        const items: {a: number, b: number}[] = [{a: 5, b: 6}];
        for ({a, b} of items) {}
        return a + b;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array assignment destructuring in for-of", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x: number = 0;
        let y: number = 0;
        for ([x, y] of [[3, 4], [5, 6]]) {}
        return x + y;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested array-object destructuring in for-of", async () => {
    await assertEquivalent(
      `
      interface Inner { x: number; y: number; }
      export function test(): number {
        const items: Inner[][] = [[{x: 10, y: 20}]];
        let sum = 0;
        for (const [{x, y}] of items) {
          sum = sum + x + y;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("var destructuring with multiple iterations", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let total = 0;
        for (var {a, b} of [{a: 1, b: 2}, {a: 3, b: 4}, {a: 5, b: 6}] as {a: number, b: number}[]) {
          total = total + a * b;
        }
        return total;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("simple for-of regression check", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let sum = 0;
        for (const x of [1, 2, 3, 4]) {
          sum = sum + x;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
