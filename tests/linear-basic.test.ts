import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/** Compile with linear-memory backend and instantiate */
async function compileLinear(source: string) {
  const result = compile(source, { target: "linear" });
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  return instance.exports as Record<string, Function>;
}

describe("linear-basic: constant return", () => {
  it("returns a constant number", async () => {
    const e = await compileLinear(`
      export function answer(): number {
        return 42;
      }
    `);
    expect(e.answer()).toBe(42);
  });

  it("returns zero", async () => {
    const e = await compileLinear(`
      export function zero(): number {
        return 0;
      }
    `);
    expect(e.zero()).toBe(0);
  });

  it("returns a negative number", async () => {
    const e = await compileLinear(`
      export function neg(): number {
        return -7;
      }
    `);
    expect(e.neg()).toBe(-7);
  });

  it("returns a floating point number", async () => {
    const e = await compileLinear(`
      export function pi(): number {
        return 3.14;
      }
    `);
    expect(e.pi()).toBeCloseTo(3.14);
  });
});

describe("linear-basic: arithmetic", () => {
  it("adds two numbers", async () => {
    const e = await compileLinear(`
      export function add(a: number, b: number): number {
        return a + b;
      }
    `);
    expect(e.add(2, 3)).toBe(5);
    expect(e.add(-1, 1)).toBe(0);
    expect(e.add(0.5, 0.5)).toBeCloseTo(1.0);
  });

  it("subtracts two numbers", async () => {
    const e = await compileLinear(`
      export function sub(a: number, b: number): number {
        return a - b;
      }
    `);
    expect(e.sub(10, 3)).toBe(7);
  });

  it("multiplies two numbers", async () => {
    const e = await compileLinear(`
      export function mul(a: number, b: number): number {
        return a * b;
      }
    `);
    expect(e.mul(4, 5)).toBe(20);
  });

  it("divides two numbers", async () => {
    const e = await compileLinear(`
      export function div(a: number, b: number): number {
        return a / b;
      }
    `);
    expect(e.div(10, 2)).toBe(5);
    expect(e.div(7, 2)).toBe(3.5);
  });

  it("complex expression", async () => {
    const e = await compileLinear(`
      export function calc(x: number): number {
        return (x + 1) * 2;
      }
    `);
    expect(e.calc(3)).toBe(8);
    expect(e.calc(0)).toBe(2);
  });
});

describe("linear-basic: multiple functions", () => {
  it("compiles multiple exported functions", async () => {
    const e = await compileLinear(`
      export function double(x: number): number {
        return x * 2;
      }
      export function triple(x: number): number {
        return x * 3;
      }
    `);
    expect(e.double(5)).toBe(10);
    expect(e.triple(5)).toBe(15);
  });
});
