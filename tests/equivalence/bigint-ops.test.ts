import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("BigInt arithmetic operations (#434)", () => {
  it("bigint division truncates toward zero", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const a: bigint = 100n;
        const b: bigint = 3n;
        let result = 0;
        if (a / b === 33n) result += 1;       // 100/3 = 33 (truncated)
        if (-100n / 3n === -33n) result += 2;  // -100/3 = -33 (truncated toward zero)
        if (100n / -3n === -33n) result += 4;  // 100/-3 = -33
        if (-100n / -3n === 33n) result += 8;  // -100/-3 = 33
        return result;
      }
    `);
    expect(exports.test()).toBe(15);
  });

  it("bigint modulus (remainder)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let result = 0;
        if (100n % 3n === 1n) result += 1;
        if (-100n % 3n === -1n) result += 2;   // sign follows dividend
        if (100n % -3n === 1n) result += 4;    // sign follows dividend
        if (-100n % -3n === -1n) result += 8;  // sign follows dividend
        if (7n % 2n === 1n) result += 16;
        return result;
      }
    `);
    expect(exports.test()).toBe(31);
  });

  it("bigint shift operations", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let result = 0;
        if ((1n << 3n) === 8n) result += 1;
        if ((8n >> 2n) === 2n) result += 2;
        if ((16n << 0n) === 16n) result += 4;
        if ((-8n >> 1n) === -4n) result += 8;
        return result;
      }
    `);
    expect(exports.test()).toBe(15);
  });

  it("bigint bitwise operations", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let result = 0;
        if ((0xFFn & 0x0Fn) === 0x0Fn) result += 1;
        if ((0x0Fn | 0xF0n) === 0xFFn) result += 2;
        if ((0xFFn ^ 0x0Fn) === 0xF0n) result += 4;
        if ((5n & 3n) === 1n) result += 8;
        if ((5n | 3n) === 7n) result += 16;
        if ((5n ^ 3n) === 6n) result += 32;
        return result;
      }
    `);
    expect(exports.test()).toBe(63);
  });

  it("bigint strict equality (same type)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let result = 0;
        const a: bigint = 1n;
        const b: bigint = 1n;
        const c: bigint = 2n;
        if (a === b) result += 1;       // true: same value
        if (a === 1n) result += 2;      // true: same value
        if (!(a === c)) result += 4;    // true: different value
        if (a !== c) result += 8;       // true: different value
        if (!(a !== b)) result += 16;   // true: same value
        return result;
      }
    `);
    expect(exports.test()).toBe(31);
  });

  it("bigint exponentiation via loop", async () => {
    // Since ** isn't supported directly, test manual power
    const exports = await compileToWasm(`
      export function test(): number {
        let result = 0;
        // Manual power: 2^10 = 1024
        let base: bigint = 2n;
        let power: bigint = 1n;
        for (let i = 0; i < 10; i++) {
          power = power * base;
        }
        if (power === 1024n) result += 1;
        return result;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("bigint unary bitwise not", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let result = 0;
        if (~0n === -1n) result += 1;
        if (~(-1n) === 0n) result += 2;
        if (~1n === -2n) result += 4;
        return result;
      }
    `);
    expect(exports.test()).toBe(7);
  });

  it("bigint addition and subtraction", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let result = 0;
        if (1n + 2n === 3n) result += 1;
        if (10n - 3n === 7n) result += 2;
        if (0n + 0n === 0n) result += 4;
        if (-1n + 1n === 0n) result += 8;
        if (-5n - (-3n) === -2n) result += 16;
        return result;
      }
    `);
    expect(exports.test()).toBe(31);
  });

  it("bigint multiplication", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let result = 0;
        if (3n * 4n === 12n) result += 1;
        if (-3n * 4n === -12n) result += 2;
        if (0n * 999n === 0n) result += 4;
        if (-2n * -3n === 6n) result += 8;
        return result;
      }
    `);
    expect(exports.test()).toBe(15);
  });

  it("bigint comparison operators return correct results", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let result = 0;
        if (1n < 2n) result += 1;
        if (2n > 1n) result += 2;
        if (1n <= 1n) result += 4;
        if (2n >= 2n) result += 8;
        if (!(2n < 1n)) result += 16;
        if (!(1n > 2n)) result += 32;
        return result;
      }
    `);
    expect(exports.test()).toBe(63);
  });

  it("bigint unsigned right shift", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let result = 0;
        if ((16n >>> 2n) === 4n) result += 1;
        return result;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("bigint assignment operators", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let result = 0;
        let a: bigint = 10n;
        a += 5n;
        if (a === 15n) result += 1;
        a -= 3n;
        if (a === 12n) result += 2;
        a *= 2n;
        if (a === 24n) result += 4;
        a /= 3n;
        if (a === 8n) result += 8;
        a %= 5n;
        if (a === 3n) result += 16;
        return result;
      }
    `);
    expect(exports.test()).toBe(31);
  });

  it("bigint exponentiation operator", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let result = 0;
        if (2n ** 10n === 1024n) result += 1;
        if (3n ** 3n === 27n) result += 2;
        if (5n ** 0n === 1n) result += 4;
        if (1n ** 100n === 1n) result += 8;
        if ((-2n) ** 3n === -8n) result += 16;
        return result;
      }
    `);
    expect(exports.test()).toBe(31);
  });

  it("bigint large values beyond Number precision", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let result = 0;
        const big: bigint = 9007199254740992n; // 2^53
        if (big + 1n === 9007199254740993n) result += 1;
        if (big - 1n === 9007199254740991n) result += 2;
        return result;
      }
    `);
    expect(exports.test()).toBe(3);
  });
});
