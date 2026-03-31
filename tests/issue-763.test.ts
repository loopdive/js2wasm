import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * Compile TS source, instantiate with runtime imports, and call the named export.
 */
async function run(source: string, fn: string = "main"): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return (instance.exports as any)[fn]();
}

describe("Issue #763: RegExp runtime method gaps", () => {
  // --- RegExp.exec() result access ---

  it("exec() result[0] returns matched string", async () => {
    expect(
      await run(`
      export function main(): string {
        const re = /hello/;
        const result = re.exec("hello world");
        if (result === null) return "null";
        const s: string = result[0];
        return s;
      }
    `),
    ).toBe("hello");
  });

  it("exec() result.index returns match position", async () => {
    expect(
      await run(`
      export function main(): number {
        const re = /world/;
        const result = re.exec("hello world");
        if (result === null) return -1;
        return result.index;
      }
    `),
    ).toBe(6);
  });

  it("exec() result.input returns original string", async () => {
    expect(
      await run(`
      export function main(): string {
        const re = /hello/;
        const result = re.exec("hello world");
        if (result === null) return "null";
        return result.input!;
      }
    `),
    ).toBe("hello world");
  });

  it("exec() with capture groups", async () => {
    expect(
      await run(`
      export function main(): string {
        const re = /(\\w+)\\s(\\w+)/;
        const result = re.exec("hello world");
        if (result === null) return "null";
        const g1: string = result[1];
        return g1;
      }
    `),
    ).toBe("hello");
  });

  it("exec() result.toString() on match array", async () => {
    expect(
      await run(`
      export function main(): string {
        const re = new RegExp("World");
        const result = re.exec("Hello World!");
        if (result === null) return "null";
        return result.toString();
      }
    `),
    ).toBe("World");
  });

  // --- String.replace() with RegExp ---

  it("replace() with regex returns replaced string", async () => {
    expect(
      await run(`
      export function main(): string {
        return "hello world".replace(/world/, "there");
      }
    `),
    ).toBe("hello there");
  });

  it("replace() with global regex replaces all", async () => {
    expect(
      await run(`
      export function main(): string {
        return "aabaa".replace(/a/g, "x");
      }
    `),
    ).toBe("xxbxx");
  });

  // --- String.match() with RegExp ---

  it("match() returns match for matching regex", async () => {
    expect(
      await run(`
      export function main(): number {
        const result = "abc123".match(/\\d+/);
        return result !== null ? 1 : 0;
      }
    `),
    ).toBe(1);
  });

  it("match() returns null for non-matching regex", async () => {
    expect(
      await run(`
      export function main(): number {
        const result = "abcdef".match(/\\d+/);
        return result !== null ? 1 : 0;
      }
    `),
    ).toBe(0);
  });

  // --- String.split() with RegExp ---

  it("split() with regex delimiter", async () => {
    expect(
      await run(`
      export function main(): number {
        const parts = "a1b2c3".split(/\\d/);
        return parts.length;
      }
    `),
    ).toBe(4);
  });

  // --- String.search() with RegExp ---

  it("search() returns match index", async () => {
    expect(
      await run(`
      export function main(): number {
        return "hello world".search(/world/);
      }
    `),
    ).toBe(6);
  });

  it("search() returns -1 for no match", async () => {
    expect(
      await run(`
      export function main(): number {
        return "hello world".search(/xyz/);
      }
    `),
    ).toBe(-1);
  });
});
