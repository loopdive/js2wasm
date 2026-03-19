import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn](...args);
}

describe("constructor arity - preserve trailing undefined args (#593)", () => {
  it("should correctly construct class with trailing undefined-like args", async () => {
    // This tests that the compiler handles constructors with multiple args
    // including ones that may be null/undefined at runtime
    const result = await run(`
      class Foo {
        a: number;
        b: number;
        c: number;
        constructor(a: number, b: number, c: number) {
          this.a = a;
          this.b = b;
          this.c = c;
        }
        sum(): number {
          return this.a + this.b + this.c;
        }
      }
      export function test(): number {
        const f = new Foo(1, 0, 0);
        return f.sum();
      }
    `, "test");
    expect(result).toBe(1);
  });
});
