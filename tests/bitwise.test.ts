import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function compileAndRun(source: string) {
  const result = compile(source);
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const imports = {
    env: {
      console_log_number: () => {},
      console_log_string: () => {},
      console_log_bool: () => {},
    },
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

describe("bitwise operators", () => {
  it("AND (&)", async () => {
    const e = await compileAndRun(`
      export function band(a: number, b: number): number { return a & b; }
    `);
    expect(e.band(5, 3)).toBe(1);
    expect(e.band(0xff, 0x0f)).toBe(0x0f);
  });

  it("OR (|)", async () => {
    const e = await compileAndRun(`
      export function bor(a: number, b: number): number { return a | b; }
    `);
    expect(e.bor(5, 3)).toBe(7);
    expect(e.bor(0xf0, 0x0f)).toBe(0xff);
  });

  it("XOR (^)", async () => {
    const e = await compileAndRun(`
      export function bxor(a: number, b: number): number { return a ^ b; }
    `);
    expect(e.bxor(5, 3)).toBe(6);
    expect(e.bxor(0xff, 0xff)).toBe(0);
  });

  it("left shift (<<)", async () => {
    const e = await compileAndRun(`
      export function shl(a: number, b: number): number { return a << b; }
    `);
    expect(e.shl(1, 3)).toBe(8);
    expect(e.shl(5, 1)).toBe(10);
  });

  it("signed right shift (>>)", async () => {
    const e = await compileAndRun(`
      export function shr(a: number, b: number): number { return a >> b; }
    `);
    expect(e.shr(8, 2)).toBe(2);
    expect(e.shr(-8, 2)).toBe(-2);
  });

  it("unsigned right shift (>>>)", async () => {
    const e = await compileAndRun(`
      export function shru(a: number, b: number): number { return a >>> b; }
    `);
    expect(e.shru(8, 2)).toBe(2);
    // -1 >>> 0 should give 4294967295 (all bits set, unsigned)
    expect(e.shru(-1, 0)).toBe(4294967295);
  });

  it("NOT (~)", async () => {
    const e = await compileAndRun(`
      export function bnot(a: number): number { return ~a; }
    `);
    expect(e.bnot(0)).toBe(-1);
    expect(e.bnot(-1)).toBe(0);
    expect(e.bnot(5)).toBe(-6);
  });
});

describe("bitwise compound assignments", () => {
  it("&=", async () => {
    const e = await compileAndRun(`
      export function bandEq(): number { let x: number = 7; x &= 3; return x; }
    `);
    expect(e.bandEq()).toBe(3);
  });

  it("|=", async () => {
    const e = await compileAndRun(`
      export function borEq(): number { let x: number = 5; x |= 3; return x; }
    `);
    expect(e.borEq()).toBe(7);
  });

  it("^=", async () => {
    const e = await compileAndRun(`
      export function bxorEq(): number { let x: number = 5; x ^= 3; return x; }
    `);
    expect(e.bxorEq()).toBe(6);
  });

  it("<<=", async () => {
    const e = await compileAndRun(`
      export function shlEq(): number { let x: number = 1; x <<= 3; return x; }
    `);
    expect(e.shlEq()).toBe(8);
  });

  it(">>=", async () => {
    const e = await compileAndRun(`
      export function shrEq(): number { let x: number = 8; x >>= 2; return x; }
    `);
    expect(e.shrEq()).toBe(2);
  });

  it(">>>=", async () => {
    const e = await compileAndRun(`
      export function shruEq(): number { let x: number = -1; x >>>= 0; return x; }
    `);
    expect(e.shruEq()).toBe(4294967295);
  });
});

describe("bitwise expressions in context", () => {
  it("combined bitwise ops", async () => {
    const e = await compileAndRun(`
      export function flags(a: number, b: number): number {
        return (a & 0xff) | (b << 8);
      }
    `);
    expect(e.flags(0x12, 0x34)).toBe(0x3412);
  });
});
