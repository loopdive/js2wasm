import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("Symbol.iterator computed property on classes", () => {
  it("class with [Symbol.iterator] method compiles to @@iterator field", async () => {
    const exports = await compileToWasm(`
      class Range {
        private start: number;
        private end: number;
        constructor(start: number, end: number) {
          this.start = start;
          this.end = end;
        }
        getStart(): number { return this.start; }
        getEnd(): number { return this.end; }
      }
      export function test(): number {
        const r = new Range(1, 5);
        return r.getStart() + r.getEnd();
      }
    `);
    expect(exports.test()).toBe(6);
  });

  it("object literal with [Symbol.iterator] computed key", async () => {
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

  it("class with [Symbol.iterator] method called via bracket access", async () => {
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
});
