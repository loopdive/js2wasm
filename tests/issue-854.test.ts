/**
 * Issue #854 — Iterator protocol: null next/return/throw methods
 * Tests that Array.prototype.entries/keys/values return valid iterators.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function compileAndRun(source: string): Promise<number> {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compilation failed: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  if (result.errors.length > 0) {
    throw new Error(`Compile errors: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as any).test();
}

describe("Issue #854: Array iterator methods", () => {
  it("arr.values() in for-of", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const arr = [10, 20, 30];
        let sum = 0;
        for (const v of arr.values()) {
          sum += v;
        }
        return sum === 60 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("arr.keys() in for-of", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const arr = [10, 20, 30];
        let sum = 0;
        for (const k of arr.keys()) {
          sum += k;
        }
        return sum === 3 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("arr.entries() in for-of", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const arr = [10, 20, 30];
        let sum = 0;
        for (const [i, v] of arr.entries()) {
          sum += i;
        }
        return sum === 3 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("arr.values() compiles without errors", () => {
    const source = `
      export function test(): number {
        const arr = [1, 2, 3];
        const iter = arr.values();
        return 1;
      }
    `;
    const result = compile(source, { fileName: "test.ts" });
    expect(result.success).toBe(true);
    const iterErrors = result.errors.filter(
      (e) => e.message.includes("unsupported") || e.message.includes("not a function"),
    );
    expect(iterErrors).toHaveLength(0);
  });

  it("arr.keys() compiles without errors", () => {
    const source = `
      export function test(): number {
        const arr = [1, 2, 3];
        const iter = arr.keys();
        return 1;
      }
    `;
    const result = compile(source, { fileName: "test.ts" });
    expect(result.success).toBe(true);
    const iterErrors = result.errors.filter(
      (e) => e.message.includes("unsupported") || e.message.includes("not a function"),
    );
    expect(iterErrors).toHaveLength(0);
  });

  it("arr.entries() compiles without errors", () => {
    const source = `
      export function test(): number {
        const arr = [1, 2, 3];
        const iter = arr.entries();
        return 1;
      }
    `;
    const result = compile(source, { fileName: "test.ts" });
    expect(result.success).toBe(true);
    const iterErrors = result.errors.filter(
      (e) => e.message.includes("unsupported") || e.message.includes("not a function"),
    );
    expect(iterErrors).toHaveLength(0);
  });
});
