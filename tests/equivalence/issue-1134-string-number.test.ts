import { describe, expect, it } from "vitest";
import { compileToWasm } from "./helpers.js";

// #1134 round 3 — string == number / string == boolean loose equality.
//
// The fast paths in `compileBinaryEquality` (binary-ops.ts:715, :762) used
// to call `parseFloat(string)` and then `f64.eq` for `string == number` and
// `string == boolean`. But `parseFloat` doesn't match ECMA-262 §7.2.15 +
// §7.1.4 ToNumber semantics:
//
//   parseFloat("0xff") === NaN     // hex strings: parseFloat fails
//   parseFloat("")     === NaN     // empty string: parseFloat fails
//   Number("0xff")     === 255     // ToNumber parses hex
//   Number("")         === 0       // ToNumber treats empty as 0
//
// So `255 == "0xff"`, `0 == ""`, `false == ""` etc. silently returned false.
// Both fast paths now route through `__host_loose_eq` (JS `==`) which uses
// real ToNumber.
//
// test262 fix: `language/expressions/equals/S11.9.1_A5.2.js` was failing
// on assert #4 (`(255 == "0xff") === true`) — now passes.

describe("#1134 round 3 — string ⇆ number / string ⇆ boolean loose equality", () => {
  it("number == hex-string is true (255 == '0xff')", async () => {
    const exp = await compileToWasm(`
      export function eq(): number { return (255 == "0xff") ? 1 : 0; }
      export function eqRev(): number { return ("0xff" == 255) ? 1 : 0; }
    `);
    expect(exp.eq!()).toBe(1);
    expect(exp.eqRev!()).toBe(1);
  });

  it("number == empty-string is true (0 == '')", async () => {
    const exp = await compileToWasm(`
      export function eq(): number { return (0 == "") ? 1 : 0; }
      export function eqRev(): number { return ("" == 0) ? 1 : 0; }
    `);
    expect(exp.eq!()).toBe(1);
    expect(exp.eqRev!()).toBe(1);
  });

  it("number == numeric-string still works (basic case)", async () => {
    const exp = await compileToWasm(`
      export function eq(): number { return (1 == "1") ? 1 : 0; }
      export function eqDecimal(): number { return (1.1 == "+1.10") ? 1 : 0; }
      export function neqWord(): number { return (1 == "true") ? 1 : 0; }
    `);
    expect(exp.eq!()).toBe(1);
    expect(exp.eqDecimal!()).toBe(1);
    expect(exp.neqWord!()).toBe(0);
  });

  it("boolean == empty-string is true (false == '')", async () => {
    const exp = await compileToWasm(`
      export function eq(): number { return (false == "") ? 1 : 0; }
      export function eqRev(): number { return ("" == false) ? 1 : 0; }
    `);
    expect(exp.eq!()).toBe(1);
    expect(exp.eqRev!()).toBe(1);
  });

  it("boolean == numeric-string follows JS rules (true == '1')", async () => {
    const exp = await compileToWasm(`
      export function eq(): number { return (true == "1") ? 1 : 0; }
      export function neq(): number { return (true == "true") ? 1 : 0; }
    `);
    expect(exp.eq!()).toBe(1); // true → 1, "1" → 1
    expect(exp.neq!()).toBe(0); // true → 1, "true" → NaN, 1 != NaN
  });

  it("loose != negation is consistent", async () => {
    const exp = await compileToWasm(`
      export function neq(): number { return (255 != "0xff") ? 1 : 0; }
    `);
    expect(exp.neq!()).toBe(0); // 255 == "0xff" is true, so != is false
  });
});
