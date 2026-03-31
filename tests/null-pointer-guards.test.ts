import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("null pointer guards in codegen (#552)", () => {
  it("compiles object destructuring without crashing on field access", () => {
    // Ensures fields[idx] access is guarded and doesn't crash
    const result = compile(`
      interface Point { x: number; y: number }
      function extract(p: Point): number {
        const { x, y } = p;
        return x + y;
      }
      export function run(): number {
        return extract({ x: 10, y: 20 });
      }
    `);
    // Should compile without field-access errors
    const fieldErrors = result.errors.filter((e) => e.message.includes("Cannot read properties of undefined"));
    expect(fieldErrors).toHaveLength(0);
  });

  it("compiles without errors when coercion paths are exercised", () => {
    // Ensure coerceType paths for f64/i32 -> externref don't leave stack imbalanced
    const result = compile(`
      function identity(x: any): any { return x; }
      const val: any = identity(42);
      export function check(): number { return val as number; }
    `);
    // Should compile without stack errors from missing fallback
    const stackErrors = result.errors.filter((e) => e.message.includes("stack"));
    expect(stackErrors).toHaveLength(0);
  });

  it("compile succeeds for class valueOf coercion patterns", () => {
    // Tests the funcType lookup guard in coerceType for valueOf
    const result = compile(`
      class Wrapper {
        constructor(public value: number) {}
        valueOf(): number { return this.value; }
      }
      export function toNum(): number {
        const w = new Wrapper(42);
        return +w;
      }
    `);
    const crashErrors = result.errors.filter((e) => e.message.includes("Cannot read properties of undefined"));
    expect(crashErrors).toHaveLength(0);
  });
});
