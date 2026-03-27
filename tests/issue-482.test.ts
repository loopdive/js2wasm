import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("Symbol.toPrimitive support (#482)", () => {
  it("class with [Symbol.toPrimitive] used in unary + (hint 'number')", async () => {
    const exports = await compileToWasm(`
      class Price {
        amount: number;
        constructor(a: number) { this.amount = a; }
        [Symbol.toPrimitive](hint: string): number | string {
          if (hint === "number") return this.amount;
          if (hint === "string") return "$" + this.amount;
          return this.amount;
        }
      }
      export function test(): number {
        const p = new Price(42);
        return +p;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("class with [Symbol.toPrimitive] used in String() (hint 'string')", async () => {
    const exports = await compileToWasm(`
      class Price {
        amount: number;
        constructor(a: number) { this.amount = a; }
        [Symbol.toPrimitive](hint: string): number | string {
          if (hint === "number") return this.amount;
          if (hint === "string") return "price:" + this.amount;
          return this.amount;
        }
      }
      export function test(): string {
        const p = new Price(99);
        return String(p);
      }
    `);
    expect(exports.test()).toBe("price:99");
  });

  it("class with [Symbol.toPrimitive] in arithmetic (hint 'number')", async () => {
    const exports = await compileToWasm(`
      class Wrapper {
        val: number;
        constructor(v: number) { this.val = v; }
        [Symbol.toPrimitive](hint: string): number {
          return this.val;
        }
      }
      export function test(): number {
        const w = new Wrapper(10);
        return w * 3;
      }
    `);
    expect(exports.test()).toBe(30);
  });

  it("class with [Symbol.toPrimitive] used in comparison", async () => {
    const exports = await compileToWasm(`
      class Val {
        n: number;
        constructor(n: number) { this.n = n; }
        [Symbol.toPrimitive](hint: string): number {
          return this.n;
        }
      }
      export function test(): boolean {
        const v = new Val(5);
        return v > 3;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("[Symbol.toPrimitive] takes precedence over valueOf", async () => {
    const exports = await compileToWasm(`
      class Obj {
        [Symbol.toPrimitive](hint: string): number {
          return 100;
        }
        valueOf(): number {
          return 999;
        }
      }
      export function test(): number {
        const o = new Obj();
        return +o;
      }
    `);
    // toPrimitive should be called, not valueOf
    expect(exports.test()).toBe(100);
  });

  it("Number() calls [Symbol.toPrimitive] with 'number' hint", async () => {
    const exports = await compileToWasm(`
      class MyNum {
        val: number;
        constructor(v: number) { this.val = v; }
        [Symbol.toPrimitive](hint: string): number {
          return this.val * 2;
        }
      }
      export function test(): number {
        const n = new MyNum(21);
        return Number(n);
      }
    `);
    expect(exports.test()).toBe(42);
  });
});
