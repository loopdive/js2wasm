import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("Symbol.toPrimitive for type coercion (#482)", () => {
  it("class with [Symbol.toPrimitive] used in unary + (number hint)", async () => {
    const exports = await compileToWasm(`
      class MyNum {
        value: number;
        constructor(v: number) { this.value = v; }
        [Symbol.toPrimitive](hint: string): number {
          return this.value;
        }
      }
      export function test(): number {
        const n = new MyNum(42);
        return +n;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("class with [Symbol.toPrimitive] used in arithmetic", async () => {
    const exports = await compileToWasm(`
      class MyNum {
        value: number;
        constructor(v: number) { this.value = v; }
        [Symbol.toPrimitive](hint: string): number {
          return this.value;
        }
      }
      export function test(): number {
        const a = new MyNum(10);
        const b = new MyNum(3);
        return a + b;
      }
    `);
    expect(exports.test()).toBe(13);
  });

  it("[Symbol.toPrimitive] takes precedence over valueOf", async () => {
    const exports = await compileToWasm(`
      class Both {
        valueOf(): number { return 1; }
        [Symbol.toPrimitive](hint: string): number {
          return 42;
        }
      }
      export function test(): number {
        const b = new Both();
        return +b;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("[Symbol.toPrimitive] with comparison operators", async () => {
    const exports = await compileToWasm(`
      class MyNum {
        value: number;
        constructor(v: number) { this.value = v; }
        [Symbol.toPrimitive](hint: string): number {
          return this.value;
        }
      }
      export function test(): number {
        const a = new MyNum(5);
        const b = new MyNum(3);
        return a > b ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });
});
