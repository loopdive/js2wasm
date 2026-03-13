import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string) {
  const result = compile(source);
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    imports as unknown as WebAssembly.Imports,
  );
  return instance.exports as Record<string, Function>;
}

describe("parseInt edge cases", () => {
  it("basic cases and looped radix", async () => {
    const e = await compileAndRun(`
      export function radix0(): number { return parseInt("123", 0); }
      export function noRadix(): number { return parseInt("123"); }
      export function hexNoRadix(): number { return parseInt("0x1A"); }
      export function radix16(): number { return parseInt("1A", 16); }
      export function radix2(): number { return parseInt("10", 2); }
      export function whitespace(): number { return parseInt("  42  "); }
      export function negative(): number { return parseInt("-10"); }
      export function radix0hex(): number { return parseInt("0xFF", 0); }
      export function numberParseInt(): number { return Number.parseInt("42", 10); }
      export function radix1(): number { return parseInt("10", 1); }
      export function radix37(): number { return parseInt("10", 37); }
      export function octalNotation(): number { return parseInt("010"); }
      export function loopRadix(): number {
        let fail: number = 0;
        for (let i: number = 2; i <= 36; i++) {
          if (parseInt("10", i) !== i) {
            fail = 1;
          }
        }
        return fail;
      }
      export function parseIntNumArg(): number {
        // parseInt(-1) should parse "-1" -> -1
        return parseInt("-1");
      }
      export function parseIntZero(): number {
        return parseInt("-0");
      }
    `);
    expect(e.radix0()).toBe(123);
    expect(e.noRadix()).toBe(123);
    expect(e.hexNoRadix()).toBe(26);
    expect(e.radix16()).toBe(26);
    expect(e.radix2()).toBe(2);
    expect(e.whitespace()).toBe(42);
    expect(e.negative()).toBe(-10);
    expect(e.radix0hex()).toBe(255);
    expect(e.numberParseInt()).toBe(42);
    expect(e.radix1()).toBeNaN();
    expect(e.radix37()).toBeNaN();
    expect(e.octalNotation()).toBe(10);
    expect(e.loopRadix()).toBe(0);
    expect(e.parseIntNumArg()).toBe(-1);
    // parseInt("-0") returns -0 per JS spec
    expect(Object.is(e.parseIntZero(), -0)).toBe(true);
  }, 30_000);
});
