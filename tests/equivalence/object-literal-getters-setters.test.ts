import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("object literal getters/setters", () => {
  it("getter returns computed value", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const obj = { _val: 10, get x() { return this._val * 2; } };
        return obj.x;
      }
    `);
    expect(exports.test()).toBe(20);
  });

  it("setter stores value", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const obj = {
          _val: 0,
          get x() { return this._val; },
          set x(v: number) { this._val = v; }
        };
        obj.x = 42;
        return obj.x;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("object literal method", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const obj = {
          val: 5,
          double() { return this.val * 2; }
        };
        return obj.double();
      }
    `);
    expect(exports.test()).toBe(10);
  });

  // ── valueOf/toString coercion on operators (#138/#139) ──

  it("valueOf coercion on comparison operators (#138)", async () => {
    // First test: simple valueOf via class method
    const exports = await compileToWasm(`
      class Box {
        val: number;
        constructor(v: number) { this.val = v; }
        valueOf(): number { return this.val; }
      }

      export function gtTrue(): number { const b = new Box(42); return b > 10 ? 1 : 0; }
      export function gtFalse(): number { const b = new Box(5); return b > 10 ? 1 : 0; }
      export function ltTrue(): number { const b = new Box(3); return b < 10 ? 1 : 0; }
      export function gteTrue(): number { const b = new Box(10); return b >= 10 ? 1 : 0; }
      export function lteTrue(): number { const b = new Box(10); return b <= 10 ? 1 : 0; }
    `);
    expect(exports.gtTrue()).toBe(1);
    expect(exports.gtFalse()).toBe(0);
    expect(exports.ltTrue()).toBe(1);
    expect(exports.gteTrue()).toBe(1);
    expect(exports.lteTrue()).toBe(1);
  });

  it("valueOf coercion on arithmetic operators (#139)", async () => {
    const exports = await compileToWasm(`
      class Num {
        val: number;
        constructor(v: number) { this.val = v; }
        valueOf(): number { return this.val; }
      }

      export function add(): number { const n = new Num(5); return n + 3; }
      export function sub(): number { const n = new Num(10); return n - 3; }
      export function mul(): number { const n = new Num(4); return n * 5; }
      export function div(): number { const n = new Num(20); return n / 4; }
      export function mod(): number { const n = new Num(17); return n % 5; }
      export function neg(): number { const n = new Num(7); return -n; }
      export function pos(): number { const n = new Num(42); return +n; }
    `);
    expect(exports.add()).toBe(8);
    expect(exports.sub()).toBe(7);
    expect(exports.mul()).toBe(20);
    expect(exports.div()).toBe(5);
    expect(exports.mod()).toBe(2);
    expect(exports.neg()).toBe(-7);
    expect(exports.pos()).toBe(42);
  });

  it("valueOf coercion on loose equality (#138)", async () => {
    const exports = await compileToWasm(`
      class Val {
        val: number;
        constructor(v: number) { this.val = v; }
        valueOf(): number { return this.val; }
      }

      export function eqTrue(): number { const v = new Val(42); return v == 42 ? 1 : 0; }
      export function eqFalse(): number { const v = new Val(42); return v == 99 ? 1 : 0; }
      export function neqTrue(): number { const v = new Val(42); return v != 99 ? 1 : 0; }
      export function neqFalse(): number { const v = new Val(42); return v != 42 ? 1 : 0; }
    `);
    expect(exports.eqTrue()).toBe(1);
    expect(exports.eqFalse()).toBe(0);
    expect(exports.neqTrue()).toBe(1);
    expect(exports.neqFalse()).toBe(0);
  });
});
