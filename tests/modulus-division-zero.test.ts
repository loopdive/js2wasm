import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn](...args);
}

describe("modulus and division by zero constant folding", () => {
  it("x % 0 produces NaN", async () => {
    const result = await run(
      `export function test(): number { return 5 % 0; }`,
      "test",
    );
    expect(result).toBeNaN();
  });

  it("0 % 0 produces NaN", async () => {
    const result = await run(
      `export function test(): number { return 0 % 0; }`,
      "test",
    );
    expect(result).toBeNaN();
  });

  it("x / 0 produces Infinity", async () => {
    const result = await run(
      `export function test(): number { return 5 / 0; }`,
      "test",
    );
    expect(result).toBe(Infinity);
  });

  it("-x / 0 produces -Infinity", async () => {
    const result = await run(
      `export function test(): number { return -5 / 0; }`,
      "test",
    );
    expect(result).toBe(-Infinity);
  });

  it("0 / 0 produces NaN", async () => {
    const result = await run(
      `export function test(): number { return 0 / 0; }`,
      "test",
    );
    expect(result).toBeNaN();
  });

  it("normal modulus still works", async () => {
    const result = await run(
      `export function test(): number { return 10 % 3; }`,
      "test",
    );
    expect(result).toBe(1);
  });

  it("normal division still works", async () => {
    const result = await run(
      `export function test(): number { return 10 / 2; }`,
      "test",
    );
    expect(result).toBe(5);
  });
});
