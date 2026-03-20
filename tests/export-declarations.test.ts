import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * Tests that export declarations at the top level do not cause compile errors.
 * Issue #332: export statements should be silently ignored (no-op) since
 * the compiler targets a single Wasm module without ES module semantics.
 */

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

function compileOnly(source: string) {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  return result;
}

describe("export declarations (#332)", () => {
  it("export default expression does not crash", () => {
    // export default should evaluate the expression and discard it
    compileOnly(`
      const x = 42;
      export default x;
      export function test(): number { return x; }
    `);
  });

  it("named export declaration does not crash", () => {
    // export { x } should be a no-op
    compileOnly(`
      const x = 10;
      export { x };
      export function test(): number { return x; }
    `);
  });

  it("export function still works", async () => {
    // export function is already handled by the export modifier on FunctionDeclaration
    expect(
      await run(
        `
        export function test(): number {
          return 99;
        }
      `,
        "test",
      ),
    ).toBe(99);
  });

  it("export const still works", async () => {
    expect(
      await run(
        `
        export const value = 7;
        export function test(): number {
          return value;
        }
      `,
        "test",
      ),
    ).toBe(7);
  });

  it("code with export default expression runs correctly", async () => {
    expect(
      await run(
        `
        const result = 123;
        export default result;
        export function test(): number { return result; }
      `,
        "test",
      ),
    ).toBe(123);
  });

  it("code with named exports runs correctly", async () => {
    expect(
      await run(
        `
        const a = 10;
        const b = 20;
        export { a, b };
        export function test(): number { return a + b; }
      `,
        "test",
      ),
    ).toBe(30);
  });
});
