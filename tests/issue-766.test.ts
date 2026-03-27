import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("Issue #766: Symbol.iterator protocol for custom iterables", () => {
  it("for-of with const on array compiles (no false syntax error)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const arr = [10, 20, 30];
        let sum = 0;
        for (const x of arr) {
          sum += x;
        }
        return sum;
      }
    `);
    expect(exports.test()).toBe(60);
  });

  it("for-of with const on string compiles", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let count = 0;
        for (const c of "abc") {
          count += 1;
        }
        return count;
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("for-of with let on array compiles", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const arr: number[] = [1, 2, 3, 4];
        let sum = 0;
        for (let x of arr) {
          x *= 2;
          sum += x;
        }
        return sum;
      }
    `);
    expect(exports.test()).toBe(20);
  });

  it("for-in with const compiles", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const obj = { a: 1, b: 2, c: 3 };
        let count = 0;
        for (const k in obj) {
          count += 1;
        }
        return count;
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("for-of with const destructuring compiles", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const pairs: number[][] = [[1, 2], [3, 4]];
        let sum = 0;
        for (const pair of pairs) {
          sum += pair[0];
        }
        return sum;
      }
    `);
    expect(exports.test()).toBe(4);
  });

  it("custom iterable class with direct Wasm iteration", async () => {
    const exports = await compileToWasm(`
      class Range {
        private start: number;
        private end: number;
        constructor(start: number, end: number) {
          this.start = start;
          this.end = end;
        }
        [Symbol.iterator]() {
          let current = this.start;
          const end = this.end;
          return {
            next() {
              if (current <= end) {
                return { value: current++, done: false };
              }
              return { value: undefined, done: true };
            }
          };
        }
      }
      export function test(): number {
        const r = new Range(1, 3);
        let sum = 0;
        for (const x of r) {
          sum += x;
        }
        return sum;
      }
    `);
    expect(exports.test()).toBe(6);
  });

  it("non-array struct is not treated as vec for for-of", async () => {
    // This test ensures that a class instance (struct) is not mistakenly
    // treated as an array (vec struct) by compileForOfArrayTentative
    const exports = await compileToWasm(`
      class Counter {
        count: number;
        constructor() { this.count = 0; }
        [Symbol.iterator]() {
          let i = 0;
          const max = 3;
          return {
            next() {
              if (i < max) {
                return { value: ++i, done: false };
              }
              return { value: undefined, done: true };
            }
          };
        }
      }
      export function test(): number {
        const c = new Counter();
        let sum = 0;
        for (const x of c) {
          sum += x;
        }
        return sum;
      }
    `);
    expect(exports.test()).toBe(6);
  });
});
