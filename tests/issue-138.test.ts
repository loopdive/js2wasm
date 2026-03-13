import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("valueOf/toString coercion on comparison operators (#138)", () => {
  it("object with valueOf in comparison (greater than)", async () => {
    const exports = await compileToWasm(`
      class Obj {
        val: number;
        constructor(v: number) { this.val = v; }
        valueOf(): number { return this.val; }
      }

      export function test(): boolean { const obj = new Obj(42); return obj > 10; }
    `);
    expect(exports.test()).toBe(1); // true as i32
  });

  it("object with valueOf in comparison (less than)", async () => {
    const exports = await compileToWasm(`
      class Obj {
        val: number;
        constructor(v: number) { this.val = v; }
        valueOf(): number { return this.val; }
      }

      export function test(): boolean { const obj = new Obj(5); return obj > 10; }
    `);
    expect(exports.test()).toBe(0); // false as i32
  });

  it("two objects compared via valueOf", async () => {
    const exports = await compileToWasm(`
      class Num {
        val: number;
        constructor(v: number) { this.val = v; }
        valueOf(): number { return this.val; }
      }

      export function test(): boolean {
        const a = new Num(1);
        const b = new Num(2);
        return a < b;
      }
    `);
    expect(exports.test()).toBe(1); // true as i32
  });

  it("two objects: a > b when a.valueOf() > b.valueOf()", async () => {
    const exports = await compileToWasm(`
      class Num {
        val: number;
        constructor(v: number) { this.val = v; }
        valueOf(): number { return this.val; }
      }

      export function test(): boolean {
        const a = new Num(10);
        const b = new Num(2);
        return a > b;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("valueOf coercion with >= and <=", async () => {
    const exports = await compileToWasm(`
      class Box {
        val: number;
        constructor(v: number) { this.val = v; }
        valueOf(): number { return this.val; }
      }

      export function gteTrue(): number { const b = new Box(10); return b >= 10 ? 1 : 0; }
      export function lteTrue(): number { const b = new Box(10); return b <= 10 ? 1 : 0; }
      export function gteFalse(): number { const b = new Box(9); return b >= 10 ? 1 : 0; }
      export function lteFalse(): number { const b = new Box(11); return b <= 10 ? 1 : 0; }
    `);
    expect(exports.gteTrue()).toBe(1);
    expect(exports.lteTrue()).toBe(1);
    expect(exports.gteFalse()).toBe(0);
    expect(exports.lteFalse()).toBe(0);
  });

  it("valueOf coercion on loose equality", async () => {
    const exports = await compileToWasm(`
      class Val {
        val: number;
        constructor(v: number) { this.val = v; }
        valueOf(): number { return this.val; }
      }

      export function eqTrue(): number { const v = new Val(42); return v == 42 ? 1 : 0; }
      export function eqFalse(): number { const v = new Val(42); return v == 99 ? 1 : 0; }
      export function neqTrue(): number { const v = new Val(42); return v != 99 ? 1 : 0; }
    `);
    expect(exports.eqTrue()).toBe(1);
    expect(exports.eqFalse()).toBe(0);
    expect(exports.neqTrue()).toBe(1);
  });

  it("strict equality compares by reference, not valueOf", async () => {
    const exports = await compileToWasm(`
      class Val {
        val: number;
        constructor(v: number) { this.val = v; }
        valueOf(): number { return this.val; }
      }

      export function sameRef(): number {
        const v = new Val(42);
        const w = v;
        return v === w ? 1 : 0;
      }
      export function diffRef(): number {
        const v = new Val(42);
        const w = new Val(42);
        return v === w ? 1 : 0;
      }
    `);
    expect(exports.sameRef()).toBe(1);
    expect(exports.diffRef()).toBe(0);
  });
});
