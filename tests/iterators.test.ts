import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

const jsStringPolyfill = {
  concat: (a: string, b: string) => a + b,
  length: (s: string) => s.length,
  equals: (a: string, b: string) => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number) => s.substring(start, end),
  charCodeAt: (s: string, i: number) => s.charCodeAt(i),
};

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const env: Record<string, Function> = {
    console_log_number: () => {},
    console_log_bool: () => {},
    console_log_string: () => {},
    console_log_externref: () => {},
    // Iterator protocol host functions
    __iterator: (obj: any) => obj[Symbol.iterator](),
    __iterator_next: (iter: any) => iter.next(),
    __iterator_done: (result: any) => (result.done ? 1 : 0),
    __iterator_value: (result: any) => result.value,
  };
  // String literal thunks
  for (let i = 0; i < result.stringPool.length; i++) {
    const value = result.stringPool[i]!;
    env[`__str_${i}`] = () => value;
  }

  const { instance } = await WebAssembly.instantiate(result.binary, {
    env,
    "wasm:js-string": jsStringPolyfill,
  } as WebAssembly.Imports);
  return (instance.exports as any)[fn](...args);
}

describe("iterators", () => {
  describe("for...of over string", () => {
    it("iterates characters and concatenates them", async () => {
      const src = `
        export function test(): string {
          let result: string = "";
          for (const ch of "hello") {
            result = result + ch;
          }
          return result;
        }
      `;
      expect(await run(src, "test")).toBe("hello");
    });

    it("counts characters in a string", async () => {
      const src = `
        export function countChars(s: string): number {
          let count: number = 0;
          for (const ch of s) {
            count = count + 1;
          }
          return count;
        }
      `;
      expect(await run(src, "countChars", ["hello"])).toBe(5);
      expect(await run(src, "countChars", [""])).toBe(0);
      expect(await run(src, "countChars", ["abc"])).toBe(3);
    });

    it("break inside for...of over string", async () => {
      const src = `
        export function test(): number {
          let count: number = 0;
          for (const ch of "abcdef") {
            if (count === 3) break;
            count = count + 1;
          }
          return count;
        }
      `;
      expect(await run(src, "test")).toBe(3);
    });

    it("iterates string parameter characters", async () => {
      const src = `
        export function firstChar(s: string): string {
          let result: string = "";
          for (const ch of s) {
            result = ch;
            break;
          }
          return result;
        }
      `;
      expect(await run(src, "firstChar", ["xyz"])).toBe("x");
    });
  });

  describe("compilation", () => {
    it("generates iterator imports for string for...of", () => {
      const result = compile(`
        export function test(): string {
          let r: string = "";
          for (const ch of "hi") {
            r = r + ch;
          }
          return r;
        }
      `);
      expect(result.success).toBe(true);
      expect(result.wat).toContain("__iterator");
      expect(result.wat).toContain("__iterator_next");
      expect(result.wat).toContain("__iterator_done");
      expect(result.wat).toContain("__iterator_value");
    });

    it("does NOT generate iterator imports for array for...of", () => {
      const result = compile(`
        export function test(): number {
          let sum: number = 0;
          for (const x of [1, 2, 3]) {
            sum = sum + x;
          }
          return sum;
        }
      `);
      expect(result.success).toBe(true);
      // Array for...of should use the index-based approach, not iterators
      expect(result.wat).not.toContain("__iterator");
    });
  });
});
