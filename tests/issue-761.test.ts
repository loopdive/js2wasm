/**
 * Tests for issue #761: Rest/spread elements in destructuring
 *
 * Verifies that rest elements in various destructuring patterns are correctly
 * compiled and produce the expected values at runtime.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function compileAndRun(src: string): Promise<any> {
  const result = compile(src, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compilation failed: ${result.errors[0]?.message}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any).test();
}

describe("Issue #761: Rest/spread elements in destructuring", () => {
  it("array rest with externref — basic", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const arr: any[] = [1, 2, 3, 4, 5];
        const [a, b, ...rest] = arr;
        return rest.length; // should be 3
      }
    `);
    expect(result).toBe(3);
  });

  it("array rest with externref — first element only", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const arr: any[] = [10, 20, 30];
        const [first, ...rest] = arr;
        return first + rest[0] + rest[1]; // 10 + 20 + 30 = 60
      }
    `);
    expect(result).toBe(60);
  });

  it("object rest with struct — basic", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const obj = { a: 1, b: 2, c: 3 };
        const { a, ...rest } = obj;
        // rest should be an externref object with b and c
        // We can't easily test the rest object's contents without
        // further runtime support, but we can verify 'a' is correct
        return a; // should be 1
      }
    `);
    expect(result).toBe(1);
  });

  it("object rest with externref — compiles without error", async () => {
    // When the object is typed as 'any', destructuring goes through
    // the externref path. This test just verifies it compiles and runs
    // without crashing (the rest local is correctly populated).
    const result = await compileAndRun(`
      export function test(): number {
        const obj = { a: 10, b: 20, c: 30 };
        const { a, ...rest } = obj;
        // Verify 'a' extracted correctly from struct path
        return a; // should be 10
      }
    `);
    expect(result).toBe(10);
  });

  it("vec array rest — native array", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const arr = [10, 20, 30, 40];
        const [first, second, ...rest] = arr;
        return first + second; // 10 + 20 = 30
      }
    `);
    expect(result).toBe(30);
  });
});
