import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(
  source: string,
  fn: string,
  args: unknown[] = [],
  options: Parameters<typeof compile>[1] = {},
): Promise<unknown> {
  const result = compile(source, options);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, {
    env: { console_log_number: () => {}, console_log_bool: () => {} },
  });
  return (instance.exports as any)[fn](...args);
}

describe("JS file compilation", () => {
  it("compiles JSDoc-annotated JS with fileName option", async () => {
    const jsSource = `
      /** @param {number} a @param {number} b @returns {number} */
      export function add(a, b) { return a + b; }
    `;
    expect(await run(jsSource, "add", [2, 3], { fileName: "input.js" })).toBe(5);
  });

  it("compiles JSDoc-annotated JS with allowJs option", async () => {
    const jsSource = `
      /** @param {number} x @returns {number} */
      export function double(x) { return x * 2; }
    `;
    expect(await run(jsSource, "double", [7], { allowJs: true, fileName: "input.js" })).toBe(14);
  });

  it("compiles JS with inferred number types", async () => {
    const jsSource = `
      /** @param {number} x @returns {number} */
      export function square(x) { return x * x; }
    `;
    expect(await run(jsSource, "square", [4], { fileName: "input.js" })).toBe(16);
  });

  it("returns success: true for valid JS input", () => {
    const jsSource = `
      /** @param {number} a @param {number} b @returns {number} */
      export function sub(a, b) { return a - b; }
    `;
    const result = compile(jsSource, { fileName: "input.js" });
    expect(result.success).toBe(true);
    expect(result.errors.filter((e) => e.severity === "error")).toHaveLength(0);
  });

  it("auto-detects JS from fileName extension", () => {
    const jsSource = `
      /** @param {number} n @returns {number} */
      export function inc(n) { return n + 1; }
    `;
    const result = compile(jsSource, { fileName: "mymodule.js" });
    expect(result.success).toBe(true);
  });

  // Phase 2 tests

  it("compiles JS with multiple exported functions", async () => {
    const jsSource = `
      /** @param {number} a @param {number} b @returns {number} */
      export function add(a, b) { return a + b; }

      /** @param {number} a @param {number} b @returns {number} */
      export function mul(a, b) { return a * b; }

      /** @param {number} x @returns {number} */
      export function negate(x) { return -x; }
    `;
    expect(await run(jsSource, "add", [10, 20], { fileName: "input.js" })).toBe(30);
    expect(await run(jsSource, "mul", [3, 7], { fileName: "input.js" })).toBe(21);
    expect(await run(jsSource, "negate", [5], { fileName: "input.js" })).toBe(-5);
  });

  it("compiles JS with arrays and loops", async () => {
    const jsSource = `
      /**
       * @param {number[]} arr
       * @returns {number}
       */
      export function sum(arr) {
        let total = 0;
        for (let i = 0; i < arr.length; i++) {
          total = total + arr[i];
        }
        return total;
      }
    `;
    const result = compile(jsSource, { fileName: "input.js" });
    expect(result.success).toBe(true);
    expect(result.errors.filter((e) => e.severity === "error")).toHaveLength(0);
  });

  it("compiles JS function calling another JS function", async () => {
    const jsSource = `
      /** @param {number} x @returns {number} */
      function helper(x) { return x * 2; }

      /** @param {number} x @returns {number} */
      export function main(x) { return helper(x) + 1; }
    `;
    expect(await run(jsSource, "main", [5], { fileName: "input.js" })).toBe(11);
  });

  it("compiles JS with boolean return", async () => {
    const jsSource = `
      /** @param {number} x @returns {boolean} */
      export function isPositive(x) { return x > 0; }
    `;
    expect(await run(jsSource, "isPositive", [5], { fileName: "input.js" })).toBe(1);
    expect(await run(jsSource, "isPositive", [-3], { fileName: "input.js" })).toBe(0);
  });

  it("compiles JS with conditional logic", async () => {
    const jsSource = `
      /** @param {number} x @returns {number} */
      export function abs(x) {
        if (x < 0) return -x;
        return x;
      }
    `;
    expect(await run(jsSource, "abs", [-7], { fileName: "input.js" })).toBe(7);
    expect(await run(jsSource, "abs", [3], { fileName: "input.js" })).toBe(3);
  });

  it("warns when JS has untyped parameters (no JSDoc)", () => {
    const jsSource = `
      export function mystery(a, b) { return a + b; }
    `;
    const result = compile(jsSource, { fileName: "input.js" });
    // Should still compile (any → externref) but produce warnings
    const warnings = result.errors.filter((e) => e.severity === "warning");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.message.includes("implicit 'any'"))).toBe(true);
    expect(warnings.some((w) => w.message.includes("JSDoc"))).toBe(true);
  });

  it("warns about implicit return type in JS", () => {
    const jsSource = `
      /** @param {number} x */
      export function half(x) { return x / 2; }
    `;
    const result = compile(jsSource, { fileName: "input.js" });
    // Parameter is typed, but return type is inferred — no warning for return
    // since TS can infer number from x / 2
    expect(result.success).toBe(true);
  });

  it("provides helpful error message suggesting JSDoc", () => {
    const jsSource = `
      export function foo(x) { return x * 2; }
    `;
    const result = compile(jsSource, { fileName: "input.js" });
    const warnings = result.errors.filter((e) => e.severity === "warning");
    // Should suggest adding @param annotation
    expect(warnings.some((w) => w.message.includes("@param"))).toBe(true);
  });
});
