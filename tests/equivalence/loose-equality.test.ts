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
