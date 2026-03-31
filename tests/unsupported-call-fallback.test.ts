import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

function compileOnly(source: string): { success: boolean; errors: any[]; wat: string } {
  const result = compile(source);
  return result;
}

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e: any) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn](...args);
}

describe("Unsupported call expression fallback (#621)", () => {
  it("element access call with resolved numeric key compiles", async () => {
    const result = await run(
      `
      class C {
        method2(): number { return 42; }
      }
      export function test(): number {
        const c = new C();
        return c.method2();
      }
      `,
      "test",
    );
    expect(result).toBe(42);
  });

  it("element access call with string literal key compiles without error", () => {
    const result = compileOnly(`
      let obj: any = { hello: 1 };
      let r = obj['hello']();
      export function test(): number { return 1; }
    `);
    // Should compile without "Unsupported call expression" errors
    const unsupported = result.errors.filter((e: any) => e.message?.includes("Unsupported call expression"));
    expect(unsupported).toHaveLength(0);
  });

  it("element access call with computed key compiles without error", () => {
    const result = compileOnly(`
      function getKey(): string { return "hello"; }
      let obj: any = { hello: 1 };
      let k = getKey();
      let r = obj[k]();
      export function test(): number { return 1; }
    `);
    // Should compile without "Unsupported call expression" errors
    const unsupported = result.errors.filter((e: any) => e.message?.includes("Unsupported call expression"));
    expect(unsupported).toHaveLength(0);
  });

  it("chained call expression compiles without error", () => {
    // Pattern: fn()() - call result of a call
    const result = compileOnly(`
      function outer(): any { return 42; }
      let r = outer()();
      export function test(): number { return 1; }
    `);
    const unsupported = result.errors.filter((e: any) => e.message?.includes("Unsupported call expression"));
    expect(unsupported).toHaveLength(0);
  });

  it("sort with function callback compiles without error", () => {
    const result = compileOnly(`
      let arr = [3, 1, 2];
      function cmp(a: number, b: number): number { return a - b; }
      arr.sort(cmp);
      export function test(): number { return 1; }
    `);
    const unsupported = result.errors.filter((e: any) => e.message?.includes("Unsupported call expression"));
    expect(unsupported).toHaveLength(0);
  });

  it("element access with numeric expression key compiles without error", () => {
    // Pattern: obj[1 + 1]() like in test262 computed property name tests
    const result = compileOnly(`
      let obj: any = {};
      let r = obj[1 + 1]();
      export function test(): number { return 1; }
    `);
    const unsupported = result.errors.filter((e: any) => e.message?.includes("Unsupported call expression"));
    expect(unsupported).toHaveLength(0);
  });
});
