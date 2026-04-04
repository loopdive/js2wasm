import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("optional parameters", () => {
  it("missing optional param gets default 0", async () => {
    const result = compile(`
      function helper(a: number, b?: number): number {
        return a + b;
      }
      export function test(): number {
        return helper(10);
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
      },
    });
    const exports = instance.exports as any;
    expect(exports.test()).toBe(10); // 10 + 0
  });

  it("provided optional param is used", async () => {
    const result = compile(`
      function helper(a: number, b?: number): number {
        return a + b;
      }
      export function test(): number {
        return helper(10, 5);
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
      },
    });
    const exports = instance.exports as any;
    expect(exports.test()).toBe(15); // 10 + 5
  });

  it("optional param truthiness check", async () => {
    const result = compile(`
      function helper(a: number, scale?: number): number {
        if (scale) {
          return a * scale;
        }
        return a;
      }
      export function withScale(): number {
        return helper(10, 3);
      }
      export function withoutScale(): number {
        return helper(10);
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
      },
    });
    const exports = instance.exports as any;
    expect(exports.withScale()).toBe(30); // 10 * 3
    expect(exports.withoutScale()).toBe(10); // fallback, scale is 0 (falsy)
  });
});
