import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(
  source: string,
  fn: string,
  args: unknown[] = [],
): Promise<unknown> {
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

describe("string literal caching", () => {
  it("string literals use imported string constants (WAT inspection)", { timeout: 15000 }, () => {
    const src = `
      export function greet(): string {
        return "hello";
      }
    `;
    const result = compile(src);
    expect(result.success).toBe(true);
    const wat = result.wat!;
    // String literals are now imported as string_constants globals
    expect(wat).toContain('string_constants');
    expect(wat).toContain('global.get');
  });

  it("string literal in loop uses global.get", () => {
    const src = `
      export function bench(): string {
        let s: string = "";
        for (let i: number = 0; i < 100; i++) {
          s = s + "x";
        }
        return s;
      }
    `;
    const result = compile(src);
    expect(result.success).toBe(true);
    const wat = result.wat!;
    // String constants should be imported as globals
    expect(wat).toContain('string_constants');
    expect(wat).toContain('global.get');
  });

  it("string concat in loop produces correct result", async () => {
    const src = `
      export function repeat5(): string {
        let s: string = "";
        for (let i: number = 0; i < 5; i++) {
          s = s + "ab";
        }
        return s;
      }
    `;
    expect(await run(src, "repeat5")).toBe("ababababab");
  });

  it("multiple different string literals have separate constants", () => {
    const src = `
      export function test(): string {
        const a: string = "hello";
        const b: string = "world";
        return a + " " + b;
      }
    `;
    const result = compile(src);
    expect(result.success).toBe(true);
    // Each unique string should be in the stringPool
    expect(result.stringPool).toContain("hello");
    expect(result.stringPool).toContain("world");
    expect(result.stringPool).toContain(" ");
  });

  it("same string literal used twice appears once in stringPool", () => {
    const src = `
      export function test(): string {
        const a: string = "x";
        const b: string = "x";
        return a + b;
      }
    `;
    const result = compile(src);
    expect(result.success).toBe(true);
    // "x" appears twice in source but should only be in stringPool once
    const xCount = result.stringPool.filter((s: string) => s === "x").length;
    expect(xCount).toBe(1);
  });

  it("string enum value is cached correctly", async () => {
    const src = `
      enum Color { Red = "RED", Green = "GREEN" }
      export function getColor(): string {
        return Color.Red;
      }
    `;
    expect(await run(src, "getColor")).toBe("RED");
  });

  it("string comparison works with caching", async () => {
    const src = `
      export function isHello(s: string): boolean {
        return s === "hello";
      }
    `;
    expect(await run(src, "isHello", ["hello"])).toBe(1);
    expect(await run(src, "isHello", ["world"])).toBe(0);
  });

  it("template literal with cached parts", async () => {
    const src = `
      export function greet(name: string): string {
        return "Hello, " + name + "!";
      }
    `;
    expect(await run(src, "greet", ["Alice"])).toBe("Hello, Alice!");
  });

  it("string literal in nested loop", async () => {
    const src = `
      export function nested(): string {
        let s: string = "";
        for (let i: number = 0; i < 3; i++) {
          for (let j: number = 0; j < 2; j++) {
            s = s + "a";
          }
        }
        return s;
      }
    `;
    expect(await run(src, "nested")).toBe("aaaaaa");
  });
});
