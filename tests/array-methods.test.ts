import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map(e => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`);
  }
  const env: Record<string, Function> = {
    console_log_number: () => {},
    console_log_bool: () => {},
    console_log_string: () => {},
  };
  // String literal thunks
  for (let i = 0; i < result.stringPool.length; i++) {
    const value = result.stringPool[i]!;
    env[`__str_${i}`] = () => value;
  }
  // number_toString
  env["number_toString"] = (v: number) => String(v);

  const jsStringPolyfill = {
    concat: (a: string, b: string) => a + b,
    length: (s: string) => s.length,
    equals: (a: string, b: string) => (a === b ? 1 : 0),
    substring: (s: string, start: number, end: number) => s.substring(start, end),
    charCodeAt: (s: string, i: number) => s.charCodeAt(i),
  };

  const { instance } = await WebAssembly.instantiate(result.binary, {
    env,
    "wasm:js-string": jsStringPolyfill,
  } as WebAssembly.Imports);
  return (instance.exports as any)[fn](...args);
}

describe("array methods", () => {
  describe("indexOf", () => {
    it("finds element at beginning", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30];
          return arr.indexOf(10);
        }
      `;
      expect(await run(src, "test")).toBe(0);
    });

    it("finds element in middle", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30];
          return arr.indexOf(20);
        }
      `;
      expect(await run(src, "test")).toBe(1);
    });

    it("returns -1 for missing element", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30];
          return arr.indexOf(99);
        }
      `;
      expect(await run(src, "test")).toBe(-1);
    });
  });

  describe("includes", () => {
    it("returns true (1) when element exists", async () => {
      const src = `
        export function test(): boolean {
          const arr = [10, 20, 30];
          return arr.includes(20);
        }
      `;
      expect(await run(src, "test")).toBe(1);
    });

    it("returns false (0) when element missing", async () => {
      const src = `
        export function test(): boolean {
          const arr = [10, 20, 30];
          return arr.includes(99);
        }
      `;
      expect(await run(src, "test")).toBe(0);
    });
  });

  describe("push", () => {
    it("adds element and returns new length", async () => {
      const src = `
        export function test(): number {
          let arr = [1, 2, 3];
          return arr.push(4);
        }
      `;
      expect(await run(src, "test")).toBe(4);
    });

    it("element is accessible after push", async () => {
      const src = `
        export function test(): number {
          let arr = [10, 20];
          arr.push(30);
          return arr[2];
        }
      `;
      expect(await run(src, "test")).toBe(30);
    });

    it("length updates after push", async () => {
      const src = `
        export function test(): number {
          let arr = [1, 2];
          arr.push(3);
          return arr.length;
        }
      `;
      expect(await run(src, "test")).toBe(3);
    });
  });

  describe("pop", () => {
    it("returns last element", async () => {
      const src = `
        export function test(): number {
          let arr = [10, 20, 30];
          return arr.pop();
        }
      `;
      expect(await run(src, "test")).toBe(30);
    });

    it("array shrinks after pop", async () => {
      const src = `
        export function test(): number {
          let arr = [10, 20, 30];
          arr.pop();
          return arr.length;
        }
      `;
      expect(await run(src, "test")).toBe(2);
    });
  });

  describe("shift", () => {
    it("returns first element", async () => {
      const src = `
        export function test(): number {
          let arr = [10, 20, 30];
          return arr.shift();
        }
      `;
      expect(await run(src, "test")).toBe(10);
    });

    it("remaining elements shift down", async () => {
      const src = `
        export function test(): number {
          let arr = [10, 20, 30];
          arr.shift();
          return arr[0];
        }
      `;
      expect(await run(src, "test")).toBe(20);
    });
  });

  describe("slice", () => {
    it("slices with start and end", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30, 40, 50];
          const s = arr.slice(1, 3);
          return s[0] + s[1];
        }
      `;
      expect(await run(src, "test")).toBe(50); // 20 + 30
    });

    it("slices with only start", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30, 40];
          const s = arr.slice(2);
          return s.length;
        }
      `;
      expect(await run(src, "test")).toBe(2);
    });

    it("does not modify original", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30];
          const s = arr.slice(0, 2);
          return arr.length;
        }
      `;
      expect(await run(src, "test")).toBe(3);
    });
  });

  describe("concat", () => {
    it("concatenates two arrays", async () => {
      const src = `
        export function test(): number {
          const a = [1, 2];
          const b = [3, 4];
          const c = a.concat(b);
          return c.length;
        }
      `;
      expect(await run(src, "test")).toBe(4);
    });

    it("elements are correct after concat", async () => {
      const src = `
        export function test(): number {
          const a = [10, 20];
          const b = [30, 40];
          const c = a.concat(b);
          return c[2];
        }
      `;
      expect(await run(src, "test")).toBe(30);
    });
  });

  describe("reverse", () => {
    it("reverses array in place", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3];
          arr.reverse();
          return arr[0];
        }
      `;
      expect(await run(src, "test")).toBe(3);
    });

    it("reversed last becomes first", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30, 40];
          arr.reverse();
          return arr[0] + arr[3];
        }
      `;
      expect(await run(src, "test")).toBe(50); // 40 + 10
    });
  });

  describe("splice", () => {
    it("removes elements and returns them", async () => {
      const src = `
        export function test(): number {
          let arr = [10, 20, 30, 40];
          const removed = arr.splice(1, 2);
          return removed[0] + removed[1];
        }
      `;
      expect(await run(src, "test")).toBe(50); // 20 + 30
    });

    it("original array shrinks", async () => {
      const src = `
        export function test(): number {
          let arr = [10, 20, 30, 40];
          arr.splice(1, 2);
          return arr.length;
        }
      `;
      expect(await run(src, "test")).toBe(2);
    });

    it("remaining elements are correct", async () => {
      const src = `
        export function test(): number {
          let arr = [10, 20, 30, 40];
          arr.splice(1, 2);
          return arr[0] + arr[1];
        }
      `;
      expect(await run(src, "test")).toBe(50); // 10 + 40
    });
  });
});
