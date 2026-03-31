/**
 * Issue #818: Internal error "fctx is not defined" during compilation.
 *
 * buildClosureCallInstrs in array-methods.ts referenced `fctx` (FunctionContext)
 * without having it as a parameter. This caused a ReferenceError when compiling
 * array methods (forEach, filter, map, find, etc.) with closure callbacks that
 * needed type coercion for their parameters.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(src: string): Promise<number> {
  const result = compile(src, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile error: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any).test();
}

describe("Issue #818: fctx is not defined in array closure callbacks", () => {
  it("forEach with closure callback compiles without error", async () => {
    const src = `
export function test(): f64 {
  var sum: f64 = 0;
  [10, 20, 30].forEach((value: f64) => {
    sum = sum + value;
  });
  return sum;
}`;
    expect(await compileAndRun(src)).toBe(60);
  });

  it("filter with closure callback compiles without error", async () => {
    const src = `
export function test(): f64 {
  var result = [1, 2, 3, 4, 5].filter((v: f64) => v > 3);
  return result.length;
}`;
    expect(await compileAndRun(src)).toBe(2);
  });

  it("map with closure callback compiles without error", async () => {
    const src = `
export function test(): f64 {
  var result = [1, 2, 3].map((v: f64) => v * 2);
  return result[0] + result[1] + result[2];
}`;
    expect(await compileAndRun(src)).toBe(12);
  });

  it("forEach with captured variable compiles without error", async () => {
    const src = `
export function test(): f64 {
  var count: f64 = 0;
  var arr = [1, 2, 3];
  arr.forEach((v: f64) => {
    count = count + 1;
  });
  return count;
}`;
    expect(await compileAndRun(src)).toBe(3);
  });

  it("find with closure callback compiles without error", async () => {
    const src = `
export function test(): f64 {
  var result = [10, 20, 30].find((v: f64) => v > 15);
  return result;
}`;
    expect(await compileAndRun(src)).toBe(20);
  });

  it("some with closure callback compiles without error", async () => {
    const src = `
export function test(): f64 {
  var result = [1, 2, 3].some((v: f64) => v > 2);
  if (result) return 1;
  return 0;
}`;
    expect(await compileAndRun(src)).toBe(1);
  });

  it("every with closure callback compiles without error", async () => {
    const src = `
export function test(): f64 {
  var result = [1, 2, 3].every((v: f64) => v > 0);
  if (result) return 1;
  return 0;
}`;
    expect(await compileAndRun(src)).toBe(1);
  });
});
