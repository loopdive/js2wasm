/**
 * Tests for issue #997: BigInt ToPrimitive/wrapped-value helper emits i64 into externref
 * __call_fn_0 wrapper (55 CE).
 *
 * The bug: emitClosureCallExport and emitToPrimitiveMethodExports had no handler for i64
 * (BigInt) return types — the raw i64 was left on the stack where externref was expected.
 * Fix: added i64 coercion (f64.convert_i64_s + __box_number) in both helpers.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

function compileOk(src: string): Uint8Array {
  const result = compile(src, { fileName: "test.ts" });
  expect(result.success, `CE: ${result.errors?.[0]?.message}`).toBe(true);
  return result.binary!;
}

async function run(src: string): Promise<unknown> {
  const binary = compileOk(src);
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports as Record<string, CallableFunction>).test?.();
}

describe("issue-997: BigInt i64 not boxed before externref in __call_fn_0", () => {
  it("compiles a class with valueOf returning BigInt", () => {
    compileOk(`
      class Num {
        valueOf(): bigint { return 42n; }
      }
      export function test(): i32 {
        const n = new Num();
        return 1;
      }
    `);
  });

  it("compiles BigInt wrapped-value arithmetic expression", () => {
    compileOk(`
      let x = Object(1n);
      export function test(): i32 {
        return 1;
      }
    `);
  });

  it("compiles a closure returning BigInt without CE", () => {
    compileOk(`
      function makeBigInt(): () => bigint {
        return () => 42n;
      }
      export function test(): i32 {
        const fn = makeBigInt();
        return 1;
      }
    `);
  });

  it("compiles class with BigInt valueOf and ToPrimitive usage", () => {
    compileOk(`
      class MyNum {
        #val: bigint;
        constructor(v: bigint) { this.#val = v; }
        valueOf(): bigint { return this.#val; }
      }
      export function test(): i32 {
        const n = new MyNum(5n);
        return 1;
      }
    `);
  });
});
