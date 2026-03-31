import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<Record<string, Function>> {
  const result = compile(source);
  if (!result.success)
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return instance.exports as Record<string, Function>;
}

describe("typeof expression", () => {
  it("compiles typeof for number, string, boolean literals", () => {
    const result = compile(`
      export function testNum(): string { return typeof 42; }
      export function testStr(): string { return typeof "hello"; }
      export function testBool(): string { return typeof true; }
    `);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    // Should have type-name string constants in the pool
    expect(result.stringPool).toContain("number");
    expect(result.stringPool).toContain("boolean");
    // "string" and "hello" should both be in the pool
    expect(result.stringPool).toContain("string");
  });

  it("returns correct type strings at runtime", async () => {
    const exports = await run(`
      export function testNum(): string { return typeof 42; }
      export function testStr(): string { return typeof "hello"; }
      export function testBool(): string { return typeof true; }
    `);
    expect(exports.testNum()).toBe("number");
    expect(exports.testStr()).toBe("string");
    expect(exports.testBool()).toBe("boolean");
  });

  it("typeof on typed variables returns correct string", async () => {
    const exports = await run(`
      export function testNumVar(): string {
        const x: number = 10;
        return typeof x;
      }
      export function testStrVar(): string {
        const s: string = "world";
        return typeof s;
      }
      export function testBoolVar(): string {
        const b: boolean = false;
        return typeof b;
      }
    `);
    expect(exports.testNumVar()).toBe("number");
    expect(exports.testStrVar()).toBe("string");
    expect(exports.testBoolVar()).toBe("boolean");
  });

  it("typeof result can be assigned to a variable", async () => {
    const exports = await run(`
      export function test(): string {
        const x: number = 99;
        const t: string = typeof x;
        return t;
      }
    `);
    expect(exports.test()).toBe("number");
  });

  it("typeof on union type uses runtime check", async () => {
    const exports = await run(`
      export function test(x: number | string): string {
        return typeof x;
      }
    `);
    expect(exports.test(42)).toBe("number");
    expect(exports.test("hello")).toBe("string");
  });
});
