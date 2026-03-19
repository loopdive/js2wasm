import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map(e => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`);
  }
  const { instance } = await WebAssembly.instantiate(result.binary, {
    env: { console_log_number: () => {}, console_log_bool: () => {}, console_log_string: () => {} },
  });
  return (instance.exports as any).main();
}

describe("SpreadElement in IIFE and expression positions", () => {
  it("should handle spread on array literal in IIFE", async () => {
    const result = await run(`
      let result = 0;
      (function(a: number, b: number, c: number) {
        result = a + b + c;
      })(...[10, 20, 30]);
      export function main() { return result; }
    `);
    expect(result).toBe(60);
  });

  it("should handle spread with extra args in IIFE (evaluated and dropped)", async () => {
    const result = await run(`
      let result = 0;
      (function(a: number, b: number) {
        result = a + b;
      })(1, 2, ...[3, 4, 5]);
      export function main() { return result; }
    `);
    expect(result).toBe(3);
  });

  it("should not produce SpreadElement errors", async () => {
    const result = compile(`
      let result = 0;
      (function(a: number, b: number, c: number) {
        result = a + b + c;
      })(...[10, 20, 30]);
      export function main() { return result; }
    `);
    const hasSpreadError = result.errors.some(e => e.message.includes("SpreadElement"));
    expect(hasSpreadError).toBe(false);
  });
});
