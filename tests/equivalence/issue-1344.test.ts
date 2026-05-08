import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

// #1344 — Date.prototype invalid-Date NaN propagation (slice 1).
//
// Per ECMA-262 §21.4.4.x, every Date.prototype getter and accessor must
// return NaN when the receiver's internal `[[DateValue]]` is NaN
// (`new Date(NaN)`). Our compiler stored timestamps as i64 — `i64.trunc_sat_f64_s`
// saturates NaN to 0, so `new Date(NaN)` silently became the epoch and
// every getter returned a valid 0-based result. 26 test262 tests under
// `built-ins/Date/prototype/*/this-value-invalid-date.js` failed for this
// exact reason.
//
// Fix:
//   1. In `new-super.ts`, `new Date(arg)` checks if `arg` is NaN; if so it
//      stores the i64 sentinel `i64.const -9223372036854775808` (i64 min,
//      well outside the spec-valid Date range of ±8.64e15 ms).
//   2. In `builtins.ts`, every getter (`getTime`, `valueOf`,
//      `getTimezoneOffset`, `getHours`/UTC, `getMinutes`/UTC,
//      `getSeconds`/UTC, `getMilliseconds`/UTC, `getDay`/UTC,
//      `getFullYear`/UTC, `getMonth`/UTC, `getDate`/UTC) wraps its
//      arithmetic in an `if (timestamp == SENTINEL) NaN else <arith>`
//      check. The shared `wrapWithInvalidDateGuard` helper reuses one
//      i64 local for the receiver across all branches.
//
// Slice 2 (deferred): setX methods (`setHours`, `setFullYear`, etc.)
// should also NaN-out when the receiver is invalid (~7 tests). The
// formatter methods (`toISOString` should throw RangeError on invalid;
// `toString` should return "Invalid Date") are also slice 2.

describe("#1344 — Date(NaN) returns invalid Date with NaN getters (slice 1)", () => {
  it("getTime / valueOf return NaN for invalid Date", async () => {
    const exp = await compileToWasm(`
      export function getTime(): number { return new Date(NaN).getTime(); }
      export function valueOf(): number { return new Date(NaN).valueOf(); }
    `);
    expect(exp.getTime!()).toBeNaN();
    expect(exp.valueOf!()).toBeNaN();
  });

  it("getTimezoneOffset returns NaN for invalid Date, 0 for valid", async () => {
    const exp = await compileToWasm(`
      export function inv(): number { return new Date(NaN).getTimezoneOffset(); }
      export function val(): number { return new Date(0).getTimezoneOffset(); }
    `);
    expect(exp.inv!()).toBeNaN();
    expect(exp.val!()).toBe(0);
  });

  it("time-component getters return NaN for invalid Date", async () => {
    const exp = await compileToWasm(`
      export function hours(): number { return new Date(NaN).getHours(); }
      export function minutes(): number { return new Date(NaN).getMinutes(); }
      export function seconds(): number { return new Date(NaN).getSeconds(); }
      export function ms(): number { return new Date(NaN).getMilliseconds(); }
      export function day(): number { return new Date(NaN).getDay(); }
    `);
    expect(exp.hours!()).toBeNaN();
    expect(exp.minutes!()).toBeNaN();
    expect(exp.seconds!()).toBeNaN();
    expect(exp.ms!()).toBeNaN();
    expect(exp.day!()).toBeNaN();
  });

  it("calendar getters return NaN for invalid Date", async () => {
    const exp = await compileToWasm(`
      export function year(): number { return new Date(NaN).getFullYear(); }
      export function month(): number { return new Date(NaN).getMonth(); }
      export function date(): number { return new Date(NaN).getDate(); }
    `);
    expect(exp.year!()).toBeNaN();
    expect(exp.month!()).toBeNaN();
    expect(exp.date!()).toBeNaN();
  });

  it("valid Date(0) getters preserve their existing semantics", async () => {
    // Regression check: the sentinel guard must not affect the valid path.
    const exp = await compileToWasm(`
      export function time(): number { return new Date(0).getTime(); }
      export function fullYear(): number { return new Date(0).getFullYear(); }
      export function month(): number { return new Date(0).getMonth(); }
      export function date(): number { return new Date(0).getDate(); }
      export function hours(): number { return new Date(0).getHours(); }
      export function day(): number { return new Date(0).getDay(); }
    `);
    expect(exp.time!()).toBe(0);
    expect(exp.fullYear!()).toBe(1970);
    expect(exp.month!()).toBe(0); // January (0-indexed)
    expect(exp.date!()).toBe(1); // first of month
    expect(exp.hours!()).toBe(0);
    expect(exp.day!()).toBe(4); // 1970-01-01 was a Thursday
  });
});
