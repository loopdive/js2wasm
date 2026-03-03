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

describe("numeric separators", () => {
  it("integer with underscores (1_000_000)", async () => {
    const e = await compileAndRun(`
      export function million(): number { return 1_000_000; }
    `);
    expect(e.million()).toBe(1000000);
  });

  it("hex with underscores (0xFF_FF)", async () => {
    const e = await compileAndRun(`
      export function hexVal(): number { return 0xFF_FF; }
    `);
    expect(e.hexVal()).toBe(65535);
  });

  it("binary with underscores (0b1010_0001)", async () => {
    const e = await compileAndRun(`
      export function binVal(): number { return 0b1010_0001; }
    `);
    expect(e.binVal()).toBe(161);
  });

  it("float with underscores (1_000.50)", async () => {
    const e = await compileAndRun(`
      export function floatVal(): number { return 1_000.50; }
    `);
    expect(e.floatVal()).toBe(1000.5);
  });

  it("arithmetic with separated numbers", async () => {
    const e = await compileAndRun(`
      export function add(): number { return 1_000 + 2_000; }
      export function mul(): number { return 1_000 * 3; }
    `);
    expect(e.add()).toBe(3000);
    expect(e.mul()).toBe(3000);
  });

  it("enum with separated numeric values", async () => {
    const e = await compileAndRun(`
      enum Size {
        Small = 1_000,
        Medium = 5_000,
        Large = 10_000,
      }
      export function getSmall(): number { return Size.Small; }
      export function getMedium(): number { return Size.Medium; }
      export function getLarge(): number { return Size.Large; }
    `);
    expect(e.getSmall()).toBe(1000);
    expect(e.getMedium()).toBe(5000);
    expect(e.getLarge()).toBe(10000);
  });
});
