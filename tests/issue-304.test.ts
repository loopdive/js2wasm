import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string) {
  const result = compile(source, { fileName: "test.ts" });
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const imports = buildImports(result.imports);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

describe("issue-304: unary minus coercion and -0 fixes", () => {
  it("double negation -(-5) works", async () => {
    const e = await compileAndRun(`
      export function test(): number { return -(-5); }
    `);
    expect(e.test()).toBe(5);
  });

  it("-0 literal produces -0", async () => {
    const e = await compileAndRun(`
      export function test(): number { return -0; }
    `);
    const result = e.test();
    expect(Object.is(result, -0)).toBe(true);
  });

  it("-(0) produces -0", async () => {
    const e = await compileAndRun(`
      export function test(): number { return -(0); }
    `);
    const result = e.test();
    expect(Object.is(result, -0)).toBe(true);
  });
});
