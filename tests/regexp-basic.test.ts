import { describe, it, expect } from "vitest";
import { compileAndInstantiate } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const exports = await compileAndInstantiate(source);
  return (exports as any)[fn](...args);
}

describe("RegExp basic operations (#632)", () => {

  // -- Core fix: RegExp literals without flags no longer pass null to constructor --

  it("RegExp literal without flags does not throw", async () => {
    const src = `
      export function test(): number {
        const re = /hello/;
        return 1;
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  it("RegExp.test() returns true for matching string (no flags)", async () => {
    const src = `
      export function test(): boolean {
        const re = /hello/;
        return re.test("hello world");
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  it("RegExp.test() returns false for non-matching string (no flags)", async () => {
    const src = `
      export function test(): boolean {
        const re = /xyz/;
        return re.test("hello world");
      }
    `;
    expect(await run(src, "test")).toBe(0);
  });

  it("RegExp literal with flags works", async () => {
    const src = `
      export function test(): boolean {
        const re = /hello/i;
        return re.test("HELLO world");
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  it("two RegExp literals are not identical (identity check)", async () => {
    const src = `
      export function test(): boolean {
        const a = /(?:)/;
        const b = /(?:)/;
        return a !== b;
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  it("RegExp.exec() returns match result (character class pattern)", async () => {
    const src = `
      export function test(): string {
        const re = /([0-9]+)/;
        const match = re.exec("abc123def");
        if (match === null) return "null";
        return match[0];
      }
    `;
    expect(await run(src, "test")).toBe("123");
  });

  it("RegExp with backslash escape (\\d) works", async () => {
    const src = `
      export function test(): boolean {
        const re = /\\d+/;
        return re.test("abc123");
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  it("String.replace() with RegExp (no flags)", async () => {
    const src = `
      export function test(): string {
        return "hello world".replace(/world/, "there");
      }
    `;
    expect(await run(src, "test")).toBe("hello there");
  });

  // -- Known limitations: String.match/search with RegExp args, exec loop --
  // These require additional compiler support beyond the null-flags fix.

  it.skip("String.match() with RegExp (needs string_match import)", async () => {
    const src = `
      export function test(): string {
        const result = "hello world".match(/world/);
        if (result === null) return "null";
        return result[0];
      }
    `;
    expect(await run(src, "test")).toBe("world");
  });

  it.skip("String.search() with RegExp (needs string_search import)", async () => {
    const src = `
      export function test(): number {
        return "hello world".search(/world/);
      }
    `;
    expect(await run(src, "test")).toBe(6);
  });

  it.skip("RegExp global flag with exec loop (assignment in condition)", async () => {
    const src = `
      export function test(): number {
        const re = /[0-9]+/g;
        let count = 0;
        let match;
        while ((match = re.exec("a1b22c333")) !== null) {
          count++;
        }
        return count;
      }
    `;
    expect(await run(src, "test")).toBe(3);
  });

});
