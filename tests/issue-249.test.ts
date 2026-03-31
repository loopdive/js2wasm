import { describe, it, expect } from "vitest";
import { compileToWasm, assertEquivalent } from "./equivalence/helpers.js";

describe("Issue #249: Miscellaneous runtime fixes", () => {
  it("typeof Math constants returns 'number'", async () => {
    await assertEquivalent(
      `
      export function typeofMathPI(): string { return typeof Math.PI; }
      export function typeofMathE(): string { return typeof Math.E; }
      export function typeofMathLN2(): string { return typeof Math.LN2; }
      `,
      [
        { fn: "typeofMathPI", args: [] },
        { fn: "typeofMathE", args: [] },
        { fn: "typeofMathLN2", args: [] },
      ],
    );
  });

  it("typeof Math methods returns 'function'", async () => {
    await assertEquivalent(
      `
      export function typeofMathAbs(): string { return typeof Math.abs; }
      export function typeofMathFloor(): string { return typeof Math.floor; }
      `,
      [
        { fn: "typeofMathAbs", args: [] },
        { fn: "typeofMathFloor", args: [] },
      ],
    );
  });

  it("typeof Math.PI === 'number' comparison", async () => {
    const exports = await compileToWasm(`
      export function testTypeofMathPI(): boolean { return typeof Math.PI === "number"; }
      export function testTypeofMathPINotFunc(): boolean { return typeof Math.PI !== "function"; }
    `);
    // Wasm returns i32 for booleans (1 = true, 0 = false)
    expect(exports.testTypeofMathPI!()).toBe(1);
    expect(exports.testTypeofMathPINotFunc!()).toBe(1);
  });

  it("typeof number literals", async () => {
    await assertEquivalent(
      `
      export function typeofOne(): string { return typeof 1; }
      export function typeofNaN(): string { return typeof NaN; }
      export function typeofInfinity(): string { return typeof Infinity; }
      `,
      [
        { fn: "typeofOne", args: [] },
        { fn: "typeofNaN", args: [] },
        { fn: "typeofInfinity", args: [] },
      ],
    );
  });

  it("Math.round basic cases", async () => {
    await assertEquivalent(
      `
      export function roundPositive(): number { return Math.round(2.5); }
      export function roundNegHalf(): number { return Math.round(-0.5); }
      export function roundNegQuarter(): number { return Math.round(-0.25); }
      export function roundZero(): number { return Math.round(0); }
      export function roundOne(): number { return Math.round(1.4); }
      export function roundNeg(): number { return Math.round(-1.6); }
      `,
      [
        { fn: "roundPositive", args: [] },
        { fn: "roundNegHalf", args: [] },
        { fn: "roundNegQuarter", args: [] },
        { fn: "roundZero", args: [] },
        { fn: "roundOne", args: [] },
        { fn: "roundNeg", args: [] },
      ],
    );
  });

  it("Math.round preserves -0", async () => {
    const exports = await compileToWasm(`
      export function roundNegHalfSign(): number { return 1 / Math.round(-0.5); }
      export function roundNegQuarterSign(): number { return 1 / Math.round(-0.25); }
      export function roundNegZeroSign(): number { return 1 / Math.round(-0); }
    `);
    // 1 / -0 === -Infinity
    expect(exports.roundNegHalfSign!()).toBe(-Infinity);
    expect(exports.roundNegQuarterSign!()).toBe(-Infinity);
    expect(exports.roundNegZeroSign!()).toBe(-Infinity);
  });

  it("Math.round precision for large integers", async () => {
    const exports = await compileToWasm(`
      export function roundLargeOddNeg(): number {
        var x = -(2 / Number.EPSILON - 1);
        return Math.round(x) - x;
      }
      export function roundLargeOddPos(): number {
        var x = 2 / Number.EPSILON - 1;
        return Math.round(x) - x;
      }
      export function roundLargeOddNeg2(): number {
        var x = -(1 / Number.EPSILON + 1);
        return Math.round(x) - x;
      }
      export function roundLargeOddPos2(): number {
        var x = 1 / Number.EPSILON + 1;
        return Math.round(x) - x;
      }
    `);
    // Math.round(x) should equal x for large integers (diff = 0)
    expect(exports.roundLargeOddNeg!()).toBe(0);
    expect(exports.roundLargeOddPos!()).toBe(0);
    expect(exports.roundLargeOddNeg2!()).toBe(0);
    expect(exports.roundLargeOddPos2!()).toBe(0);
  });

  it("Math.round near-half precision", async () => {
    const exports = await compileToWasm(`
      export function roundNearHalf(): number {
        var x = 0.5 - Number.EPSILON / 4;
        return Math.round(x);
      }
      export function roundNearHalfSign(): number {
        var x = 0.5 - Number.EPSILON / 4;
        return 1 / Math.round(x);
      }
    `);
    // 0.5 - epsilon/4 rounds to 0 (not 1), and should be +0 (not -0)
    expect(exports.roundNearHalf!()).toBe(0);
    expect(exports.roundNearHalfSign!()).toBe(Infinity); // 1/+0 = +Infinity
  });

  it("void expression evaluates operand for side effects", async () => {
    await assertEquivalent(
      `
      export function voidAssignment(): number {
        var x = 0;
        void (x = 42);
        return x;
      }
      `,
      [{ fn: "voidAssignment", args: [] }],
    );
  });

  it("Boolean() coercion edge cases", async () => {
    const exports = await compileToWasm(`
      export function boolEmpty(): boolean { return Boolean(); }
      export function boolZero(): boolean { return Boolean(0); }
      export function boolOne(): boolean { return Boolean(1); }
      export function boolNaN(): boolean { return Boolean(NaN); }
      export function boolEmptyStr(): boolean { return Boolean(""); }
      export function boolStr(): boolean { return Boolean("hello"); }
      export function boolTrue(): boolean { return Boolean(true); }
      export function boolFalse(): boolean { return Boolean(false); }
    `);
    // Wasm returns i32 for booleans (1 = true, 0 = false)
    expect(exports.boolEmpty!()).toBe(0);
    expect(exports.boolZero!()).toBe(0);
    expect(exports.boolOne!()).toBe(1);
    expect(exports.boolNaN!()).toBe(0);
    expect(exports.boolEmptyStr!()).toBe(0);
    expect(exports.boolStr!()).toBe(1);
    expect(exports.boolTrue!()).toBe(1);
    expect(exports.boolFalse!()).toBe(0);
  });

  it("unary plus on string literals", async () => {
    await assertEquivalent(
      `
      export function plusEmpty(): number { return +""; }
      export function plusNumStr(): number { return +"123"; }
      export function plusTrue(): number { return +true; }
      export function plusFalse(): number { return +false; }
      `,
      [
        { fn: "plusEmpty", args: [] },
        { fn: "plusNumStr", args: [] },
        { fn: "plusTrue", args: [] },
        { fn: "plusFalse", args: [] },
      ],
    );
  });
});
