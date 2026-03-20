import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("Symbol.iterator iterable protocol (#345)", () => {
  it("class method named @@iterator compiles and is callable", async () => {
    const exports = await compileToWasm(`
      class Iter {
        [Symbol.iterator](): number {
          return 99;
        }
      }
      export function test(): number {
        const it = new Iter();
        return it[Symbol.iterator]();
      }
    `);
    expect(exports.test()).toBe(99);
  });

  it("for-of on array still works (regression check)", async () => {
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

  it("for-of on custom iterable class coerces struct ref to externref", async () => {
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

  it("object literal with [Symbol.iterator] method", async () => {
    const exports = await compileToWasm(`
      const obj: { [Symbol.iterator]: () => number } = {
        [Symbol.iterator](): number {
          return 42;
        }
      };
      export function test(): number {
        return obj[Symbol.iterator]();
      }
    `);
    expect(exports.test()).toBe(42);
  });
});
