import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any)[fn](...args);
}

describe("JSON.stringify / JSON.parse", () => {
  it("JSON.stringify with a number", async () => {
    const result = await run(
      `
      export function test(): string {
        return JSON.stringify(42);
      }
    `,
      "test",
    );
    expect(result).toBe("42");
  });

  it("JSON.stringify with a string", async () => {
    const result = await run(
      `
      export function test(): string {
        return JSON.stringify("hello");
      }
    `,
      "test",
    );
    expect(result).toBe('"hello"');
  });

  it("JSON roundtrip: stringify then parse", async () => {
    const result = await run(
      `
      export function test(): string {
        const str = JSON.stringify("roundtrip");
        const parsed = JSON.parse(str);
        return JSON.stringify(parsed);
      }
    `,
      "test",
    );
    // stringify("roundtrip") => '"roundtrip"', parse('"roundtrip"') => "roundtrip",
    // stringify("roundtrip") => '"roundtrip"'
    expect(result).toBe('"roundtrip"');
  });

  it("compiles JSON.stringify to host import call", () => {
    const result = compile(`
      export function test(): string {
        return JSON.stringify(42);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.wat).toContain("JSON_stringify");
  });

  it("compiles JSON.parse to host import call", () => {
    const result = compile(`
      export function test(s: string): string {
        return JSON.parse(s);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.wat).toContain("JSON_parse");
  });
});
