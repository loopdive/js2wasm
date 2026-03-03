import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/** Compile with linear-memory backend and instantiate */
async function compileLinear(source: string) {
  const result = compile(source, { target: "linear" });
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  return instance.exports as Record<string, Function>;
}

describe("linear-advanced", { timeout: 30_000 }, () => {
  // Task 16: for-of loops
  it("compiles for-of over arrays", async () => {
    const e = await compileLinear(`
      export function sum(): number {
        const arr = [10, 20, 30];
        let total = 0;
        for (const x of arr) {
          total = total + x;
        }
        return total;
      }
    `);
    expect(e.sum()).toBe(60);
  });

  // Task 17: do-while loops
  it("compiles do-while loop", async () => {
    const e = await compileLinear(`
      export function test(): number {
        let x = 0;
        do {
          x = x + 1;
        } while (x < 5);
        return x;
      }
    `);
    expect(e.test()).toBe(5);
  });

  // Task 18: switch statements
  it("compiles switch statement", async () => {
    const e = await compileLinear(`
      export function test(x: number): number {
        switch (x) {
          case 1: return 10;
          case 2: return 20;
          case 3: return 30;
          default: return 0;
        }
      }
    `);
    expect(e.test(1)).toBe(10);
    expect(e.test(2)).toBe(20);
    expect(e.test(99)).toBe(0);
  });

  // Task 19: getter properties
  it("compiles getter properties", async () => {
    const e = await compileLinear(`
      class Reader {
        pos: number;
        len: number;
        constructor(len: number) {
          this.pos = 0;
          this.len = len;
        }
        get remaining(): number {
          return this.len - this.pos;
        }
      }
      export function test(): number {
        const r = new Reader(100);
        r.pos = 30;
        return r.remaining;
      }
    `);
    expect(e.test()).toBe(70);
  });

  // Task 20: template literals
  it("compiles template literals with number", async () => {
    const e = await compileLinear(`
      export function test(): number {
        const name = "world";
        const msg = \`hello \${name}\`;
        return msg.length;
      }
    `);
    expect(e.test()).toBe(11); // "hello world"
  });

  // Task 21: array destructuring
  it("compiles array destructuring", async () => {
    const e = await compileLinear(`
      export function test(): number {
        const arr = [10, 20, 30];
        const [a, b, c] = arr;
        return a + b + c;
      }
    `);
    expect(e.test()).toBe(60);
  });

  // Task 22: for-of over map entries
  it("compiles for-of over map entries", async () => {
    const e = await compileLinear(`
      export function test(): number {
        const map = new Map<number, number>();
        map.set(1, 10);
        map.set(2, 20);
        let total = 0;
        for (const [k, v] of map) {
          total = total + v;
        }
        return total;
      }
    `);
    expect(e.test()).toBe(30);
  });

  // Task 23: string .length
  it("compiles string length", async () => {
    const e = await compileLinear(`
      export function test(): number {
        const s = "hello world";
        return s.length;
      }
    `);
    expect(e.test()).toBe(11);
  });
});
