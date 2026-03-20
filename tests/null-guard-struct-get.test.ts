import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * Helper: compile source and run an exported function via the Wasm runtime.
 * Uses buildImports from the runtime module for proper host function setup.
 */
async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const { buildImports } = await import("../src/runtime.js");
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any)[fn](...args);
}

describe("null-guarded struct.get for externref destructuring (#647)", () => {
  it("rest destructuring in class method with untyped param", { timeout: 30000 }, async () => {
    // When a class method has an untyped array destructuring parameter ([...x]),
    // the param becomes externref in the Wasm signature. At runtime, the value
    // is a __vec_f64 wrapped in externref. The compiler must convert it to
    // __vec_externref before the rest destructuring code can access it.
    const result = await run(
      `
      let callResult: number = 0;
      class C {
        method([...x]) {
          callResult = x.length;
        }
      };
      export function test(): number {
        new C().method([1, 2, 3]);
        return callResult;
      }
      `,
      "test",
    );
    expect(result).toBe(3);
  });

  it("rest destructuring with element access", { timeout: 30000 }, async () => {
    const result = await run(
      `
      let callResult: number = 0;
      class C {
        method([...x]) {
          callResult = x[0] + x[1] + x[2];
        }
      };
      export function test(): number {
        new C().method([10, 20, 30]);
        return callResult;
      }
      `,
      "test",
    );
    expect(result).toBe(60);
  });

  it("positional array destructuring in class method", { timeout: 30000 }, async () => {
    const result = await run(
      `
      let callResult: number = 0;
      class C {
        method([a, b, c]) {
          callResult = a + b + c;
        }
      };
      export function test(): number {
        new C().method([100, 200, 300]);
        return callResult;
      }
      `,
      "test",
    );
    expect(result).toBe(600);
  });

  it("typed array destructuring still works", { timeout: 30000 }, async () => {
    // Typed parameters should continue to work without the externref conversion
    const result = await run(
      `
      let callResult: number = 0;
      function f([a, b, c]: number[]): void {
        callResult = a + b + c;
      }
      export function test(): number {
        f([1, 2, 3]);
        return callResult;
      }
      `,
      "test",
    );
    expect(result).toBe(6);
  });

  it("property access on optional parameter with null check", { timeout: 30000 }, async () => {
    const result = await run(
      `
      interface Opts { x: number; y: number }
      function getX(opts?: Opts): number {
        if (!opts) return -1;
        return opts.x;
      }
      export function test(): number {
        return getX();
      }
      `,
      "test",
    );
    expect(result).toBe(-1);
  });

  it("property access on nullable union type", { timeout: 30000 }, async () => {
    const result = await run(
      `
      interface Obj { val: number }
      function read(o: Obj | null): number {
        if (o === null) return 0;
        return o.val;
      }
      export function test(): number {
        return read(null) + read({ val: 42 });
      }
      `,
      "test",
    );
    expect(result).toBe(42);
  });
});
