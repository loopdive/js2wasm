import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

describe("string support", () => {
  it("string parameter passes as externref", async () => {
    const result = compile(`
      export function greet(name: string): string {
        return name;
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    // Function should take and return externref
    expect(result.wat).toContain("externref");
  });

  it("string literal compiles to global import from string_constants", async () => {
    const result = compile(`
      export function hello(): string {
        return "world";
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    // Should have a string_constants global import (externref global)
    expect(result.wat).toContain("string_constants");
    expect(result.wat).toContain('(import "string_constants"');
    expect(result.wat).toContain("(global");
    // Should have wasm:js-string imports
    expect(result.wat).toContain("wasm:js-string");

    // String pool should contain the value
    expect(result.stringPool).toContain("world");
  });

  it("string concatenation uses wasm:js-string concat", async () => {
    const result = compile(`
      export function greet(name: string): string {
        return "Hello, " + name;
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    expect(result.wat).toContain("concat");
    expect(result.stringPool).toContain("Hello, ");
  });

  it("string equality uses wasm:js-string equals", () => {
    const result = compile(`
      export function isHello(s: string): boolean {
        return s === "hello";
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    expect(result.wat).toContain("equals");
  });

  it("console.log with string uses console_log_string", () => {
    const result = compile(`
      export function test(): void {
        console.log("hello");
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    expect(result.wat).toContain("console_log_string");
  });

  it("string literal runs end-to-end with polyfill", async () => {
    const result = compile(`
      export function hello(): string {
        return "world";
      }
    `);
    expect(result.success).toBe(true);

    const env: Record<string, Function> = {
      console_log_number: () => {},
      console_log_bool: () => {},
      console_log_string: () => {},
    };

    const jsStringPolyfill = {
      concat: (a: string, b: string) => a + b,
      length: (s: string) => s.length,
      equals: (a: string, b: string) => (a === b ? 1 : 0),
      substring: (s: string, start: number, end: number) =>
        s.substring(start, end),
      charCodeAt: (s: string, i: number) => s.charCodeAt(i),
    };

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env,
      "wasm:js-string": jsStringPolyfill,
      string_constants: buildStringConstants(result.stringPool),
    } as WebAssembly.Imports);
    const exports = instance.exports as any;
    expect(exports.hello()).toBe("world");
  });

  it("string concat runs end-to-end with polyfill", async () => {
    const result = compile(`
      export function greet(name: string): string {
        return "Hello, " + name;
      }
    `);
    expect(result.success).toBe(true);

    const env: Record<string, Function> = {
      console_log_number: () => {},
      console_log_bool: () => {},
      console_log_string: () => {},
    };

    const jsStringPolyfill = {
      concat: (a: string, b: string) => a + b,
      length: (s: string) => s.length,
      equals: (a: string, b: string) => (a === b ? 1 : 0),
      substring: (s: string, start: number, end: number) =>
        s.substring(start, end),
      charCodeAt: (s: string, i: number) => s.charCodeAt(i),
    };

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env,
      "wasm:js-string": jsStringPolyfill,
      string_constants: buildStringConstants(result.stringPool),
    } as WebAssembly.Imports);
    const exports = instance.exports as any;
    expect(exports.greet("World")).toBe("Hello, World");
  });
});
