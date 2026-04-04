import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn: string, ...args: unknown[]): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return (instance.exports as any)[fn](...args);
}

describe("RegExp", () => {
  it("new RegExp with pattern and flags compiles", () => {
    const source = `
      export function test(): number {
        const re = new RegExp("\\\\d+", "g");
        return 1;
      }
    `;
    const result = compile(source);
    if (!result.success) {
      console.log("Errors:", result.errors);
    }
    expect(result.success).toBe(true);
  });

  it("RegExp.test() returns true for matching string", async () => {
    const source = `
      export function test(): number {
        const re = new RegExp("\\\\d+", "g");
        if (re.test("abc123")) {
          return 1;
        }
        return 0;
      }
    `;
    expect(await run(source, "test")).toBe(1);
  });

  it("RegExp.test() returns false for non-matching string", async () => {
    const source = `
      export function test(): number {
        const re = new RegExp("\\\\d+", "g");
        if (re.test("abcdef")) {
          return 1;
        }
        return 0;
      }
    `;
    expect(await run(source, "test")).toBe(0);
  });

  it("RegExp without flags", async () => {
    const source = `
      export function test(): number {
        const re = new RegExp("hello");
        if (re.test("say hello world")) {
          return 1;
        }
        return 0;
      }
    `;
    expect(await run(source, "test")).toBe(1);
  });

  it("RegExp case-insensitive flag", async () => {
    const source = `
      export function test(): number {
        const re = new RegExp("hello", "i");
        if (re.test("HELLO WORLD")) {
          return 1;
        }
        return 0;
      }
    `;
    expect(await run(source, "test")).toBe(1);
  });

  it("RegExp literal with flags", async () => {
    const source = `
      export function test(): number {
        const re = /\\d+/g;
        if (re.test("abc123")) {
          return 1;
        }
        return 0;
      }
    `;
    expect(await run(source, "test")).toBe(1);
  });

  it("RegExp literal without flags", async () => {
    const source = `
      export function test(): number {
        const re = /hello/;
        if (re.test("say hello world")) {
          return 1;
        }
        return 0;
      }
    `;
    expect(await run(source, "test")).toBe(1);
  });

  it("RegExp literal case-insensitive", async () => {
    const source = `
      export function test(): number {
        const re = /hello/i;
        if (re.test("HELLO WORLD")) {
          return 1;
        }
        return 0;
      }
    `;
    expect(await run(source, "test")).toBe(1);
  });

  it("RegExp literal non-matching returns false", async () => {
    const source = `
      export function test(): number {
        const re = /\\d+/;
        if (re.test("abcdef")) {
          return 1;
        }
        return 0;
      }
    `;
    expect(await run(source, "test")).toBe(0);
  });

  it("multiple test calls on same regex", async () => {
    const source = `
      export function test(): number {
        const re = new RegExp("\\\\d+", "g");
        const a = re.test("abc123");
        const b = re.test("xyz");
        if (a && !b) {
          return 1;
        }
        return 0;
      }
    `;
    expect(await run(source, "test")).toBe(1);
  });
});
