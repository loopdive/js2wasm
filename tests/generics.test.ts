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

describe("generics", () => {
  it("identity with number", async () => {
    const e = await compileAndRun(`
      function identity<T>(x: T): T { return x; }
      export function main(): number { return identity(42); }
    `);
    expect(e.main()).toBe(42);
  });

  it("identity with boolean", async () => {
    const e = await compileAndRun(`
      function identity<T>(x: T): T { return x; }
      export function main(): boolean { return identity(true); }
    `);
    expect(e.main()).toBe(1); // booleans are i32 in wasm
  });

  it("generic function with number constraint", async () => {
    const e = await compileAndRun(`
      function double<T extends number>(x: T): T { return (x * 2) as T; }
      export function main(): number { return double(21); }
    `);
    expect(e.main()).toBe(42);
  });

  it("generic with arithmetic", async () => {
    const e = await compileAndRun(`
      function add<T extends number>(a: T, b: T): T { return (a + b) as T; }
      export function main(): number { return add(10, 32); }
    `);
    expect(e.main()).toBe(42);
  });

  it("generic used in expression", async () => {
    const e = await compileAndRun(`
      function identity<T>(x: T): T { return x; }
      export function main(): number { return identity(20) + identity(22); }
    `);
    expect(e.main()).toBe(42);
  });
});
