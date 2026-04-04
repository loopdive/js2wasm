import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

/**
 * Verify that peephole dead-load elimination (#947) doesn't change semantics.
 * These patterns produce local.get/tee + drop sequences that should be eliminated.
 */
describe("peephole: local.get/tee + drop elimination (#947)", () => {
  it("assignment expression result is correct when result is unused", async () => {
    // Generates local.tee + drop pattern: assignment used as statement
    const { compileToWasm } = await import("./helpers.js");
    const exports = await compileToWasm(`
      export function test(): number {
        let x = 0;
        let y = 0;
        x = y = 5;   // assignment chain: inner tee may be dropped
        return x + y;
      }
    `);
    expect(exports["test"]!()).toBe(10);
  });

  it("variable declared and immediately assigned keeps correct value", async () => {
    const { compileToWasm } = await import("./helpers.js");
    const exports = await compileToWasm(`
      export function test(): number {
        let a = 1;
        let b = 2;
        let c = a + b;
        return c;
      }
    `);
    expect(exports["test"]!()).toBe(3);
  });

  it("unused intermediate in ternary expression produces correct result", async () => {
    // May generate local.tee + drop for the condition result
    const { compileToWasm } = await import("./helpers.js");
    const exports = await compileToWasm(`
      export function test(): number {
        const x = 5;
        const y = x > 3 ? x * 2 : x + 1;
        return y;
      }
    `);
    expect(exports["test"]!()).toBe(10);
  });

  it("compiled binary validates as correct Wasm", () => {
    const src = `
      export function test(): number {
        let x = 10;
        let y = x;  // local.get x followed by local.set y (may create dead load)
        return y;
      }
    `;
    const result = compile(src, { fileName: "test.ts" });
    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });
});
