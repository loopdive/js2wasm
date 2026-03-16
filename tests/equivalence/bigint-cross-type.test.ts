import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("BigInt cross-type comparisons (#174)", () => {
  it("bigint == non-finite numbers", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const zero: bigint = 0n;
        const one: bigint = 1n;
        const negOne: bigint = -1n;
        const inf: number = Infinity;
        const negInf: number = -Infinity;
        const nan: number = NaN;
        let result = 0;
        // All of these should be false
        if (!(zero == inf)) result += 1;
        if (!(inf == zero)) result += 2;
        if (!(one == inf)) result += 4;
        if (!(zero == negInf)) result += 8;
        if (!(negInf == zero)) result += 16;
        if (!(zero == nan)) result += 32;
        if (!(nan == zero)) result += 64;
        if (!(one == nan)) result += 128;
        if (!(nan == one)) result += 256;
        if (!(negOne == nan)) result += 512;
        return result;
      }
    `);
    expect(exports.test()).toBe(1023);
  });

  it("bigint != non-finite numbers", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const zero: bigint = 0n;
        const inf: number = Infinity;
        const nan: number = NaN;
        let result = 0;
        // All of these should be true
        if (zero != inf) result += 1;
        if (inf != zero) result += 2;
        if (zero != nan) result += 4;
        if (nan != zero) result += 8;
        return result;
      }
    `);
    expect(exports.test()).toBe(15);
  });

  it("bigint < > <= >= with non-finite numbers", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const zero: bigint = 0n;
        const inf: number = Infinity;
        const negInf: number = -Infinity;
        const nan: number = NaN;
        let result = 0;
        if (zero < inf) result += 1;       // true
        if (zero > negInf) result += 2;    // true
        if (!(zero > inf)) result += 4;    // true (0 not > Inf)
        if (!(zero < negInf)) result += 8; // true (0 not < -Inf)
        // NaN comparisons are all false
        if (!(zero < nan)) result += 16;
        if (!(zero > nan)) result += 32;
        if (!(zero <= nan)) result += 64;
        if (!(zero >= nan)) result += 128;
        return result;
      }
    `);
    expect(exports.test()).toBe(255);
  });

  it("bigint === number always false", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const a: bigint = 0n;
        const b: number = 0;
        const c: bigint = 1n;
        const d: number = 1;
        let result = 0;
        if (!(a === b)) result += 1;  // true: different types
        if (!(c === d)) result += 2;  // true: different types
        if (a !== b) result += 4;     // true: different types
        if (c !== d) result += 8;     // true: different types
        return result;
      }
    `);
    expect(exports.test()).toBe(15);
  });

  it("bigint === boolean always false", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const a: bigint = 0n;
        const b: boolean = false;
        const c: bigint = 1n;
        const d: boolean = true;
        let result = 0;
        if (!(a === b)) result += 1;
        if (!(c === d)) result += 2;
        if (a !== b) result += 4;
        if (c !== d) result += 8;
        return result;
      }
    `);
    expect(exports.test()).toBe(15);
  });

  it("unary minus on bigint", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const a: bigint = 0n;
        const b: bigint = 1n;
        const c: bigint = -1n;
        let result = 0;
        if (-a == 0n) result += 1;     // -0n === 0n
        if (-b == -1n) result += 2;    // -1n
        if (-c == 1n) result += 4;     // -(-1n) === 1n
        if (-(-b) == 1n) result += 8;  // double negate
        return result;
      }
    `);
    expect(exports.test()).toBe(15);
  });

  it("bigint == boolean loose equality", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let result = 0;
        const zero: bigint = 0n;
        const one: bigint = 1n;
        const two: bigint = 2n;
        const negOne: bigint = -1n;
        const t: boolean = true;
        const f: boolean = false;
        if (zero == f) result += 1;       // true: 0n == 0
        if (one == t) result += 2;        // true: 1n == 1
        if (!(negOne == f)) result += 4;  // false: -1n != 0
        if (!(negOne == t)) result += 8;  // false: -1n != 1
        if (!(two == t)) result += 16;    // false: 2n != 1
        if (!(two == f)) result += 32;    // false: 2n != 0
        if (f == zero) result += 64;      // true: 0 == 0n
        if (t == one) result += 128;      // true: 1 == 1n
        return result;
      }
    `);
    expect(exports.test()).toBe(255);
  });

  it("bigint == number with fractional values", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const a: bigint = 0n;
        const b: bigint = 1n;
        let result = 0;
        if (a == 0) result += 1;             // true
        if (b == 1) result += 2;             // true
        if (!(a == 0.000000000001)) result += 4;  // false: 0n != 0.000000000001
        if (!(b == 0.999999999999)) result += 8;  // false: 1n != 0.999999999999
        return result;
      }
    `);
    expect(exports.test()).toBe(15);
  });

  it("bigint relational with non-finite - number on left", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const zero: bigint = 0n;
        const inf: number = Infinity;
        const negInf: number = -Infinity;
        const nan: number = NaN;
        let result = 0;
        if (inf > zero) result += 1;      // true
        if (negInf < zero) result += 2;   // true
        if (!(inf < zero)) result += 4;   // true
        if (!(negInf > zero)) result += 8; // true
        // NaN on left
        if (!(nan < zero)) result += 16;
        if (!(nan > zero)) result += 32;
        if (!(nan <= zero)) result += 64;
        if (!(nan >= zero)) result += 128;
        return result;
      }
    `);
    expect(exports.test()).toBe(255);
  });

  it("bigint number-extremes equality", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const zero: bigint = 0n;
        const negTen: bigint = -10n;
        const minVal: number = Number.MIN_VALUE;
        const negMinVal: number = -Number.MIN_VALUE;
        let result = 0;
        if (!(zero == minVal)) result += 1;     // false: 0n != 5e-324
        if (!(minVal == zero)) result += 2;     // false
        if (!(zero == negMinVal)) result += 4;  // false: 0n != -5e-324
        if (!(negMinVal == zero)) result += 8;  // false
        if (!(negTen == minVal)) result += 16;  // false
        if (!(minVal == negTen)) result += 32;  // false
        return result;
      }
    `);
    expect(exports.test()).toBe(63);
  });
});
