import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string): Promise<{ ce?: string; result?: unknown }> {
  const result = compile(source);
  if (!result.success) {
    return { ce: result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n") };
  }
  try {
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    return { result: (instance.exports as any).test?.() };
  } catch (e: any) {
    return { ce: e.message };
  }
}

describe("issue #999 for-of destructuring type mismatches", () => {
  it("for-of obj-assign-destructuring: f64 field into externref var (null-typed)", async () => {
    // Reproduction for: call[0] expected type externref, found call of type f64
    // `x` is typed as null (→ externref), struct field `a` is f64
    const { ce, result } = await compileAndRun(`
      var x: null = null;
      export function test(): number {
        for ({ a: x } of [{ a: 3 }] as any) {}
        return 0;
      }
    `);
    expect(ce, "should compile without CE").toBeUndefined();
    expect(result).toBe(0);
  });

  it("for-of obj-assign-destructuring: shorthand, any-typed target", async () => {
    // var _yield is any → externref, struct field is f64
    const { ce, result } = await compileAndRun(`
      var _yield: any;
      var counter: number = 0;
      export function test(): number {
        for ({ _yield } of [{ _yield: 3 } as any] as any) {
          counter += 1;
        }
        return counter;
      }
    `);
    expect(ce, "should compile without CE").toBeUndefined();
    expect(result).toBe(1);
  });

  it("for-of obj-assign-destructuring with typed struct element", async () => {
    // Simulates: for ({ a: x } of [{ a: 3 }]) where x is externref
    const { ce, result } = await compileAndRun(`
      export function test(): number {
        var x: any = null;
        for ({ a: x } of [{ a: 3 }]) {}
        return 0;
      }
    `);
    expect(ce, "should compile without CE").toBeUndefined();
    expect(result).toBe(0);
  });

  it("for-await-of array elision destructuring with async generator", async () => {
    // Reproduction for: struct.new[0] expected type f64, found local.get of type (ref null N)
    // Async generator expression captures variables; closure struct field type mismatch
    const { ce } = await compileAndRun(`
      export function test(): number {
        var first: number = 0;
        var second: number = 0;
        function* g() {
          first += 1;
          yield;
          second += 1;
        }
        var iterCount: number = 0;
        var asyncIter = (async function*() {
          yield* [g()];
        })();
        async function fn() {
          for await (var [,] of asyncIter as any) {
            iterCount += 1;
          }
        }
        return 0;
      }
    `);
    expect(ce, "should compile without CE").toBeUndefined();
  });
});
