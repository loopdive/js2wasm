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

describe("void expression", () => {
  it("void 0 produces undefined (null externref)", async () => {
    const e = await compileAndRun(`
      export function test(): undefined {
        return void 0;
      }
    `);
    expect(e.test()).toBeUndefined();
  });

  it("void with arbitrary expression", async () => {
    const e = await compileAndRun(`
      export function test(): undefined {
        return void (1 + 2);
      }
    `);
    expect(e.test()).toBeUndefined();
  });

  it("void discards function return value", async () => {
    const e = await compileAndRun(`
      function sideEffect(): number {
        return 42;
      }
      export function test(): undefined {
        return void sideEffect();
      }
    `);
    expect(e.test()).toBeUndefined();
  });
});
