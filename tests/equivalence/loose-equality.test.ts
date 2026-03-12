import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("Loose equality (== / !=)", () => {
  it("number == boolean coercion", async () => {
    await assertEquivalent(
      `
      export function zeroEqFalse(): number { return (0 == false) ? 1 : 0; }
      export function oneEqTrue(): number { return (1 == true) ? 1 : 0; }
      export function twoNeqTrue(): number { return (2 != true) ? 1 : 0; }
      `,
      [
        { fn: "zeroEqFalse", args: [] },
        { fn: "oneEqTrue", args: [] },
        { fn: "twoNeqTrue", args: [] },
      ],
    );
  });
  it("boolean == number coercion", async () => {
    await assertEquivalent(
      `
      export function falseEqZero(): number { return (false == 0) ? 1 : 0; }
      export function trueEqOne(): number { return (true == 1) ? 1 : 0; }
      export function trueNeqTwo(): number { return (true != 2) ? 1 : 0; }
      `,
      [
        { fn: "falseEqZero", args: [] },
        { fn: "trueEqOne", args: [] },
        { fn: "trueNeqTwo", args: [] },
      ],
    );
  });
  it("null == undefined coercion", async () => {
    const exports = await compileToWasm(`
      export function nullEqUndef(): number { return (null == undefined) ? 1 : 0; }
      export function undefEqNull(): number { return (undefined == null) ? 1 : 0; }
      export function nullNeqUndef(): number { return (null != undefined) ? 1 : 0; }
    `);
    expect(exports.nullEqUndef()).toBe(1);
    expect(exports.undefEqNull()).toBe(1);
    expect(exports.nullNeqUndef()).toBe(0);
  });
  it("undefined-typed variable == null (loose)", async () => {
    const exports = await compileToWasm(`
      export function undefVarEqNull(): number {
        const x: undefined = undefined;
        return (x == null) ? 1 : 0;
      }
      export function nullEqUndefVar(): number {
        const x: undefined = undefined;
        return (null == x) ? 1 : 0;
      }
      export function undefVarNeqNull(): number {
        const x: undefined = undefined;
        return (x != null) ? 1 : 0;
      }
    `);
    expect(exports.undefVarEqNull()).toBe(1);
    expect(exports.nullEqUndefVar()).toBe(1);
    expect(exports.undefVarNeqNull()).toBe(0);
  });
  it("null === undefined is false (strict)", async () => {
    const exports = await compileToWasm(`
      export function nullStrictEqUndef(): number {
        return (null === undefined) ? 1 : 0;
      }
      export function nullStrictNeqUndef(): number {
        return (null !== undefined) ? 1 : 0;
      }
      export function nullVarStrictEqUndef(): number {
        const x: null = null;
        return (x === undefined) ? 1 : 0;
      }
    `);
    expect(exports.nullStrictEqUndef()).toBe(0);
    expect(exports.nullStrictNeqUndef()).toBe(1);
    expect(exports.nullVarStrictEqUndef()).toBe(0);
  });
  it("non-nullish values != null (loose)", async () => {
    const exports = await compileToWasm(`
      export function falseEqNull(): number { return (false == null) ? 1 : 0; }
      export function zeroEqNull(): number { return (0 == null) ? 1 : 0; }
      export function zeroNeqNull(): number { return (0 != null) ? 1 : 0; }
      export function falseEqUndef(): number { return (false == undefined) ? 1 : 0; }
    `);
    expect(exports.falseEqNull()).toBe(0);
    expect(exports.zeroEqNull()).toBe(0);
    expect(exports.zeroNeqNull()).toBe(1);
    expect(exports.falseEqUndef()).toBe(0);
  });
  it("same-type loose equality delegates to strict", async () => {
    await assertEquivalent(
      `
      export function numEq(): number { return (5 == 5) ? 1 : 0; }
      export function numNeq(): number { return (5 != 3) ? 1 : 0; }
      export function boolEq(): number { return (true == true) ? 1 : 0; }
      `,
      [
        { fn: "numEq", args: [] },
        { fn: "numNeq", args: [] },
        { fn: "boolEq", args: [] },
      ],
    );
  });
});
