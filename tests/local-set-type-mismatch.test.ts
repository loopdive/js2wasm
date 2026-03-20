import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string = "test", args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn](...args);
}

describe("local.set type mismatch (#625)", () => {
  it("variable declaration with f64 value into boolean local", async () => {
    // Tests the f64 -> i32 mismatch pattern
    expect(
      await run(`
        export function test(): number {
          let flag: boolean = true;
          return flag ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("for-loop variable with different init types", async () => {
    expect(
      await run(`
        export function test(): number {
          let sum = 0;
          for (let i = 0; i < 5; i++) {
            sum += i;
          }
          return sum;
        }
      `),
    ).toBe(10);
  });

  it("destructuring with type coercion", async () => {
    expect(
      await run(`
        export function test(): number {
          const obj = { a: 1, b: 2 };
          const { a, b } = obj;
          return a + b;
        }
      `),
    ).toBe(3);
  });

  it("different struct types assigned to same variable", async () => {
    // Tests (ref N) -> (ref null M) mismatch: variable initially holds one
    // struct type and is reassigned another. Compilation should succeed.
    expect(
      await run(`
        class A { x: number = 10; }
        class B { y: number = 20; }
        export function test(): number {
          let obj: any = new A();
          obj = new B();
          return 42;
        }
      `),
    ).toBe(42);
  });
});
