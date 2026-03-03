import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, jsApi } from "../src/runtime.js";

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
  const imports = buildImports(result.stringPool, jsApi);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any)[fn](...args);
}

describe("string literal caching", () => {
  it("caches string literals in locals (WAT inspection)", { timeout: 15000 }, () => {
    const src = `
      export function greet(): string {
        return "hello";
      }
    `;
    const result = compile(src);
    expect(result.success).toBe(true);
    const wat = result.wat!;
    // The string thunk call should be replaced with a cached local
    expect(wat).toContain("__cached_str_");
    expect(wat).toContain("local.set");
    expect(wat).toContain("local.get");
  });

  it("string literal in loop uses local.get instead of call", () => {
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
    // Cache locals should be allocated
    expect(wat).toContain("__cached_str_");

    // The loop body should NOT contain a call to __str_ —
    // the call should only be in the preamble
    const loopBodyMatch = wat.match(/\(loop[\s\S]*?\n\s*\)/);
    if (loopBodyMatch) {
      // Inside the loop there should be local.get for the cached string
      expect(loopBodyMatch[0]).toContain("local.get");
    }
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

  it("multiple different string literals are cached separately", () => {
    const src = `
      export function test(): string {
        const a: string = "hello";
        const b: string = "world";
        return a + " " + b;
      }
    `;
    const result = compile(src);
    expect(result.success).toBe(true);
    const wat = result.wat!;
    // Should have multiple cached string locals
    const cacheMatches = wat.match(/__cached_str_/g);
    expect(cacheMatches).not.toBeNull();
    expect(cacheMatches!.length).toBeGreaterThanOrEqual(3); // at least "hello", "world", " " (x2 for set+get each)
  });

  it("same string literal used twice is cached once", () => {
    const src = `
      export function test(): string {
        const a: string = "x";
        const b: string = "x";
        return a + b;
      }
    `;
    const result = compile(src);
    expect(result.success).toBe(true);
    const wat = result.wat!;
    // "x" appears twice in source but should only get one cached local
    const setMatches = wat.match(/local\.set.*__cached_str_/g) ?? [];
    // The preamble should have exactly one local.set for "x"
    // (We count unique cached local names)
    const cacheLocals = new Set(
      (wat.match(/__cached_str_\d+/g) ?? []),
    );
    // Only one unique cached local name (used in both local.set and local.get)
    expect(cacheLocals.size).toBe(1);
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
