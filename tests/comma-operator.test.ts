import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function compileAndRun(source: string) {
  const result = compile(source);
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
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

describe("comma operator", () => {
  it("returns the right-hand value", async () => {
    const e = await compileAndRun(`
      export function test(): number { return (1, 2); }
    `);
    expect(e.test()).toBe(2);
  });

  it("evaluates left side for side effects", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        let x: number = 0;
        x = (x = 5, x + 10);
        return x;
      }
    `);
    expect(e.test()).toBe(15);
  });

  it("chains multiple comma operators", async () => {
    const e = await compileAndRun(`
      export function test(): number { return (1, 2, 3); }
    `);
    expect(e.test()).toBe(3);
  });

  it("works inside a for-loop update expression", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        let a: number = 0;
        let b: number = 0;
        for (let i: number = 0; i < 5; i = i + 1, a = a + 1) {
          b = b + 2;
        }
        return a + b;
      }
    `);
    // a increments 5 times (0..4), b increments 5 times by 2
    expect(e.test()).toBe(15);
  });

  it("works with different types on left and right", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        let x: number = 42;
        return (x = 10, x + 1);
      }
    `);
    expect(e.test()).toBe(11);
  });
});
