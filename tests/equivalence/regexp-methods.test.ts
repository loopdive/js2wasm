import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { buildImports } from "../../src/runtime.js";

/**
 * Compile TS source, instantiate with the full runtime imports (needed for
 * RegExp host imports like RegExp_new, RegExp_test, RegExp_exec, etc.),
 * and call the named export.
 */
async function run(source: string, fn: string = "main"): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    imports as WebAssembly.Imports,
  );
  return (instance.exports as any)[fn]();
}

describe("RegExp methods equivalence", () => {
  // --- RegExp.test() ---

  it("RegExp.test() returns true for matching pattern", async () => {
    expect(await run(`
      export function main(): number {
        const re = /\\d+/;
        return re.test("abc123") ? 1 : 0;
      }
    `)).toBe(1);
  });

  it("RegExp.test() returns false for non-matching pattern", async () => {
    expect(await run(`
      export function main(): number {
        const re = /\\d+/;
        return re.test("abcdef") ? 1 : 0;
      }
    `)).toBe(0);
  });

  it("RegExp.test() with case-insensitive flag", async () => {
    expect(await run(`
      export function main(): number {
        const re = /hello/i;
        return re.test("HELLO WORLD") ? 1 : 0;
      }
    `)).toBe(1);
  });

  it("RegExp.test() with global flag", async () => {
    expect(await run(`
      export function main(): number {
        const re = /[a-z]+/g;
        return re.test("abc123") ? 1 : 0;
      }
    `)).toBe(1);
  });

  it("new RegExp() constructor with string pattern", async () => {
    expect(await run(`
      export function main(): number {
        const re = new RegExp("\\\\d+");
        return re.test("abc123") ? 1 : 0;
      }
    `)).toBe(1);
  });

  it("new RegExp() constructor with flags", async () => {
    expect(await run(`
      export function main(): number {
        const re = new RegExp("hello", "i");
        return re.test("HELLO") ? 1 : 0;
      }
    `)).toBe(1);
  });

  // --- String.search() ---

  it("String.search() returns match index", async () => {
    expect(await run(`
      export function main(): number {
        return "abc123def".search(/\\d+/);
      }
    `)).toBe(3);
  });

  it("String.search() returns -1 for no match", async () => {
    expect(await run(`
      export function main(): number {
        return "abcdef".search(/\\d+/);
      }
    `)).toBe(-1);
  });

  it("String.search() with word boundary", async () => {
    expect(await run(`
      export function main(): number {
        return "hello world".search(/world/);
      }
    `)).toBe(6);
  });

  // --- String.replace() ---

  it("String.replace() with regex pattern", async () => {
    expect(await run(`
      export function main(): string {
        return "hello world".replace(/world/, "there");
      }
    `)).toBe("hello there");
  });

  it("String.replace() replaces first occurrence only", async () => {
    expect(await run(`
      export function main(): string {
        return "aabbcc".replace(/b+/, "X");
      }
    `)).toBe("aaXcc");
  });

  it("String.replace() with character class", async () => {
    expect(await run(`
      export function main(): string {
        return "123abc456".replace(/[a-z]+/, "XXX");
      }
    `)).toBe("123XXX456");
  });

  // --- String.match() ---

  it("String.match() returns non-null for matching pattern", async () => {
    expect(await run(`
      export function main(): number {
        const result = "abc123def".match(/\\d+/);
        return result !== null ? 1 : 0;
      }
    `)).toBe(1);
  });

  it("String.match() returns null for non-matching pattern", async () => {
    expect(await run(`
      export function main(): number {
        const result = "abcdef".match(/\\d+/);
        return result !== null ? 1 : 0;
      }
    `)).toBe(0);
  });

  // --- RegExp.exec() ---

  it("RegExp.exec() returns non-null for match", async () => {
    expect(await run(`
      export function main(): number {
        const re = /\\d+/;
        const result = re.exec("abc123");
        return result !== null ? 1 : 0;
      }
    `)).toBe(1);
  });

  it("RegExp.exec() returns null for no match", async () => {
    expect(await run(`
      export function main(): number {
        const re = /\\d+/;
        const result = re.exec("abcdef");
        return result !== null ? 1 : 0;
      }
    `)).toBe(0);
  });

  // Note: String.split() is tested in string-methods.test.ts.
  // The host import returns externref arrays which currently trigger
  // ref.cast issues when accessing .length, so we skip split here.
});
