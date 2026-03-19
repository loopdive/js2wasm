import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string = "test"): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map(e => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`);
  }
  const { instance } = await WebAssembly.instantiate(result.binary, {
    env: { console_log_number: () => {}, console_log_bool: () => {} },
  });
  return (instance.exports as any)[fn]();
}

describe("null dereference guards", () => {
  it("property access on possibly-null object with null check", async () => {
    const src = `
      function getObj(flag: boolean): { x: number } | null {
        if (flag) return { x: 42 };
        return null;
      }
      export function test(): number {
        const obj = getObj(true);
        if (obj !== null) {
          return obj.x;
        }
        return -1;
      }
    `;
    expect(await run(src)).toBe(42);
  });

  it("property access on non-null object works normally", async () => {
    const src = `
      export function test(): number {
        const obj = { x: 10, y: 20 };
        return obj.x + obj.y;
      }
    `;
    expect(await run(src)).toBe(30);
  });

  it("chained property access", async () => {
    const src = `
      export function test(): number {
        const a = { b: { c: 5 } };
        return a.b.c;
      }
    `;
    expect(await run(src)).toBe(5);
  });

  it("property set on struct object", async () => {
    const src = `
      export function test(): number {
        const obj = { x: 0 };
        obj.x = 99;
        return obj.x;
      }
    `;
    expect(await run(src)).toBe(99);
  });

  it("null-returning function property access is safe with guard", async () => {
    const src = `
      function maybeNull(): { val: number } | null {
        return null;
      }
      export function test(): number {
        const obj = maybeNull();
        if (obj === null) return -1;
        return obj.val;
      }
    `;
    expect(await run(src)).toBe(-1);
  });

  it("rest destructuring of array", async () => {
    const src = `
      export function test(): number {
        const values = [1, 2, 3];
        const [...x] = values;
        return x.length;
      }
    `;
    expect(await run(src)).toBe(3);
  });

  it("rest destructuring with leading elements", async () => {
    const src = `
      export function test(): number {
        const values = [10, 20, 30];
        const [a, ...rest] = values;
        return a + rest.length;
      }
    `;
    expect(await run(src)).toBe(12);
  });

  it("function with rest destructuring parameter", async () => {
    const src = `
      function fn([...x]: number[]): number {
        return x.length;
      }
      export function test(): number {
        return fn([1, 2, 3]);
      }
    `;
    expect(await run(src)).toBe(3);
  });

  it("function with leading + rest destructuring parameter", async () => {
    const src = `
      function fn([a, ...rest]: number[]): number {
        return a + rest.length;
      }
      export function test(): number {
        return fn([10, 20, 30]);
      }
    `;
    expect(await run(src)).toBe(12);
  });

  it("function expression with rest destructuring and array check", async () => {
    const src = `
      const values: number[] = [1, 2, 3];
      let callCount = 0;
      function fn([...x]: number[]): number {
        callCount = callCount + 1;
        return x.length;
      }
      export function test(): number {
        return fn(values) + callCount;
      }
    `;
    expect(await run(src)).toBe(4); // 3 + 1
  });

  it("module-level rest destructuring syncs to global", async () => {
    const src = `
      const values: number[] = [1, 2, 3];
      var [...x] = values;
      export function test(): number {
        return x.length;
      }
    `;
    expect(await run(src)).toBe(3);
  });

  it("module-level array destructuring syncs to global", async () => {
    const src = `
      var [a, b]: number[] = [10, 20];
      export function test(): number {
        return a + b;
      }
    `;
    expect(await run(src)).toBe(30);
  });

  it("module-level object destructuring syncs to global", async () => {
    const src = `
      const obj = { x: 42, y: 99 };
      var { x, y } = obj;
      export function test(): number {
        return x + y;
      }
    `;
    expect(await run(src)).toBe(141);
  });

  it("rest destructuring with elision: [, , ...x]", async () => {
    const src = `
      function fn([, , ...x]: number[]): number {
        return x.length;
      }
      export function test(): number {
        return fn([1, 2, 3, 4, 5]);
      }
    `;
    expect(await run(src)).toBe(3);
  });

  it("rest destructuring exhausted: [, , ...x] on shorter array", async () => {
    const src = `
      function fn([, , ...x]: number[]): number {
        return x.length;
      }
      export function test(): number {
        return fn([1, 2]);
      }
    `;
    expect(await run(src)).toBe(0);
  });
});
