import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function compileLinear(source: string) {
  const result = compile(source, { target: "linear" });
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  return instance.exports as Record<string, Function>;
}

describe("linear-bitwise: bitwise operators", () => {
  it("bitwise AND", async () => {
    const e = await compileLinear(`
      export function band(a: number, b: number): number {
        return a & b;
      }
    `);
    expect(e.band(0xff, 0x0f)).toBe(0x0f);
    expect(e.band(12, 10)).toBe(8); // 1100 & 1010 = 1000
  });

  it("bitwise OR", async () => {
    const e = await compileLinear(`
      export function bor(a: number, b: number): number {
        return a | b;
      }
    `);
    expect(e.bor(12, 10)).toBe(14); // 1100 | 1010 = 1110
  });

  it("bitwise XOR", async () => {
    const e = await compileLinear(`
      export function bxor(a: number, b: number): number {
        return a ^ b;
      }
    `);
    expect(e.bxor(12, 10)).toBe(6); // 1100 ^ 1010 = 0110
  });

  it("left shift", async () => {
    const e = await compileLinear(`
      export function shl(a: number, b: number): number {
        return a << b;
      }
    `);
    expect(e.shl(1, 4)).toBe(16);
    expect(e.shl(3, 2)).toBe(12);
  });

  it("arithmetic right shift", async () => {
    const e = await compileLinear(`
      export function shr(a: number, b: number): number {
        return a >> b;
      }
    `);
    expect(e.shr(16, 2)).toBe(4);
    expect(e.shr(-16, 2)).toBe(-4); // sign-extending
  });

  it("unsigned right shift", async () => {
    const e = await compileLinear(`
      export function ushr(a: number, b: number): number {
        return a >>> b;
      }
    `);
    expect(e.ushr(16, 2)).toBe(4);
    // -1 >>> 0 should be 4294967295 (all bits set, interpreted as unsigned)
    expect(e.ushr(-1, 0)).toBe(4294967295);
  });

  it("bitwise NOT", async () => {
    const e = await compileLinear(`
      export function bnot(a: number): number {
        return ~a;
      }
    `);
    expect(e.bnot(0)).toBe(-1);
    expect(e.bnot(-1)).toBe(0);
    expect(e.bnot(5)).toBe(-6);
  });
});
