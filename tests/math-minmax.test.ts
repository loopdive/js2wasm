import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string) {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.binary || result.binary.length === 0) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

describe("Math.min / Math.max", () => {
  it("Math.min with 2 args", async () => {
    const e = await compileAndRun(`
      export function test(): number { return Math.min(3, 7); }
    `);
    expect(e.test()).toBe(3);
  });

  it("Math.max with 2 args", async () => {
    const e = await compileAndRun(`
      export function test(): number { return Math.max(3, 7); }
    `);
    expect(e.test()).toBe(7);
  });

  it("Math.min with 3 args", async () => {
    const e = await compileAndRun(`
      export function test(): number { return Math.min(5, 2, 8); }
    `);
    expect(e.test()).toBe(2);
  });

  it("Math.max with 4 args", async () => {
    const e = await compileAndRun(`
      export function test(): number { return Math.max(1, 9, 3, 7); }
    `);
    expect(e.test()).toBe(9);
  });

  it("Math.min with 1 arg", async () => {
    const e = await compileAndRun(`
      export function test(): number { return Math.min(42); }
    `);
    expect(e.test()).toBe(42);
  });

  it("Math.min with NaN propagates", async () => {
    const e = await compileAndRun(`
      export function test(): number { return Math.min(1, NaN, 3); }
    `);
    expect(e.test()).toBeNaN();
  });

  it("Math.max with negative values", async () => {
    const e = await compileAndRun(`
      export function test(): number { return Math.max(-5, -2, -8); }
    `);
    expect(e.test()).toBe(-2);
  });

  it("Math.min with no args returns Infinity", async () => {
    const e = await compileAndRun(`
      export function test(): number { return Math.min(); }
    `);
    expect(e.test()).toBe(Infinity);
  });

  it("Math.max with no args returns -Infinity", async () => {
    const e = await compileAndRun(`
      export function test(): number { return Math.max(); }
    `);
    expect(e.test()).toBe(-Infinity);
  });
});
