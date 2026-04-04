import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[]): Promise<unknown> {
  const result = compile(source);
  if (!result.success)
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  const imports = buildImports(result.imports);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return (instance.exports as any)[fn](...args);
}

describe("union types", () => {
  it("number | string parameter compiles", () => {
    const result = compile(`
      export function test(x: number | string): number {
        return 0;
      }
    `);
    expect(result.success).toBe(true);
    // Union parameter should be externref
    expect(result.wat).toContain("externref");
  });

  it("typeof narrowing: number branch", async () => {
    const result = await run(
      `
      export function isNum(x: number | string): number {
        if (typeof x === "number") {
          return 1;
        }
        return 0;
      }
    `,
      "isNum",
      [42],
    );
    expect(result).toBe(1);
  });

  it("typeof narrowing: string branch", async () => {
    const result = await run(
      `
      export function isNum(x: number | string): number {
        if (typeof x === "number") {
          return 1;
        }
        return 0;
      }
    `,
      "isNum",
      ["hello"],
    );
    expect(result).toBe(0);
  });
});

describe("null narrowing", () => {
  it("T | null — non-null path returns value", async () => {
    const result = compile(`
      export function test(x: number | null): number {
        if (x !== null) {
          return 1;
        }
        return 0;
      }
    `);
    expect(result.success).toBe(true);
  });
});
