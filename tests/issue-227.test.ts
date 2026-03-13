import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("Issue #227: BigInt comparison with Infinity", () => {
  it("BigInt > -Infinity should be true", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const x: bigint = 0n;
        if (x > -Infinity) return 1;
        return 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("BigInt < Infinity should be true", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const x: bigint = 0n;
        if (x < Infinity) return 1;
        return 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("BigInt >= -Infinity should be true", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const x: bigint = 42n;
        if (x >= -Infinity) return 1;
        return 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("BigInt <= Infinity should be true", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const x: bigint = 42n;
        if (x <= Infinity) return 1;
        return 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("BigInt comparisons with NaN should all be false", async () => {
    const exports = await compileToWasm(`
      export function gtNaN(): number {
        const x: bigint = 0n;
        if (x > NaN) return 1;
        return 0;
      }
      export function ltNaN(): number {
        const x: bigint = 0n;
        if (x < NaN) return 1;
        return 0;
      }
      export function eqNaN(): number {
        const x: bigint = 0n;
        if (x == NaN) return 1;
        return 0;
      }
    `);
    expect(exports.gtNaN()).toBe(0);
    expect(exports.ltNaN()).toBe(0);
    expect(exports.eqNaN()).toBe(0);
  });

  it("BigInt comparison with finite numbers", async () => {
    const exports = await compileToWasm(`
      export function bigintGtNumber(): number {
        const x: bigint = 10n;
        if (x > 5) return 1;
        return 0;
      }
      export function bigintLtNumber(): number {
        const x: bigint = 3n;
        if (x < 5) return 1;
        return 0;
      }
      export function bigintEqNumber(): number {
        const x: bigint = 5n;
        if (x == 5) return 1;
        return 0;
      }
    `);
    expect(exports.bigintGtNumber()).toBe(1);
    expect(exports.bigintLtNumber()).toBe(1);
    expect(exports.bigintEqNumber()).toBe(1);
  });
});
