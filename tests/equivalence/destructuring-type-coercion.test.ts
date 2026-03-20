import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";
import { compile } from "../../src/index.js";

describe("destructuring parameter type coercion (#658)", () => {
  it("class generator method with tuple destructuring default validates Wasm", async () => {
    // Pattern 1 (96 CE): local.set[0] expected type f64, found struct.get of type i32
    // struct.get on a tuple produces i32 but ensureBindingLocals typed the local as f64
    const result = compile(`
      class C {
        *method([x = 23] = [,]): Generator<number> {
          yield x;
        }
      }
    `);
    expect(result.success).toBe(true);
    await expect(WebAssembly.compile(result.binary)).resolves.toBeDefined();
  });

  it("object param destructuring compiles without local.set type mismatch", async () => {
    const exports = await compileToWasm(`
      function take({x}: {x: number}): number {
        return x;
      }
      export function test(): number {
        return take({x: 42});
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("tuple array destructuring with type coercion validates Wasm", async () => {
    // Verify Wasm validation passes (no CompileError on local.set type mismatch)
    // for patterns where the tuple field type differs from the TS-resolved binding type
    const result = compile(`
      class C {
        *method([x = "hello"] = [,]): Generator<string> {
          yield x;
        }
      }
      const iter = new C().method();
      const val = iter.next().value;
      console.log(val);
    `);
    expect(result.success).toBe(true);
    // The key test: Wasm module validates without CompileError
    await expect(WebAssembly.compile(result.binary)).resolves.toBeDefined();
  });

  it("vec array destructuring with type coercion validates Wasm", async () => {
    // Verify that array element destructuring where elem type differs from local type
    // does not produce local.set type mismatch
    const result = compile(`
      function destructure([a, b]: number[]): number {
        return a + b;
      }
      console.log(destructure([1, 2]));
    `);
    expect(result.success).toBe(true);
    await expect(WebAssembly.compile(result.binary)).resolves.toBeDefined();
  });
});
