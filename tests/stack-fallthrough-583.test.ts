import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("Issue #583: Stack not empty at fallthrough", () => {
  it("should drop expression statement results (non-void)", async () => {
    const exports = await compileToWasm(`
      export function main(): number {
        let x = 10;
        x + 5;  // expression statement - result should be dropped
        x * 2;  // another expression statement
        return x;
      }
    `);
    expect(exports.main()).toBe(10);
  });

  it("should handle void expression statements", async () => {
    const exports = await compileToWasm(`
      function sideEffect(): void {
        // nothing
      }
      export function main(): number {
        sideEffect(); // void expression statement
        return 1;
      }
    `);
    expect(exports.main()).toBe(1);
  });

  it("should handle bigint expression statement (pure bigint)", async () => {
    const exports = await compileToWasm(`
      export function main(): number {
        const a: bigint = 1n;
        const b: bigint = 2n;
        a + b; // bigint expression statement - should be dropped
        return 42;
      }
    `);
    expect(exports.main()).toBe(42);
  });

  it("should handle multiple expression statements without stack buildup", async () => {
    const exports = await compileToWasm(`
      export function main(): number {
        let x = 1;
        let y = 2;
        x + y;
        x * y;
        x - y;
        x + y + 3;
        return x;
      }
    `);
    expect(exports.main()).toBe(1);
  });
});
