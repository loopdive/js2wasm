import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("Issue #289: For-in compile errors -- property enumeration edge cases", () => {
  it("for-in with bare identifier initializer", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        const obj = { a: 1, b: 2, c: 3 };
        let result = "";
        let k: string = "";
        for (k in obj) {
          result += k;
        }
        return result;
      }
    `);
    const result = exports.test() as string;
    // Property names should all appear, order may vary
    expect(result.length).toBe(3);
    expect(result).toContain("a");
    expect(result).toContain("b");
    expect(result).toContain("c");
  });

  it("for-in with var declaration over object", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        const obj = { x: 10, y: 20 };
        let result = "";
        for (var k in obj) {
          result += k;
        }
        return result;
      }
    `);
    const result = exports.test() as string;
    expect(result.length).toBe(2);
    expect(result).toContain("x");
    expect(result).toContain("y");
  });

  it("for-in with let declaration", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        const obj = { foo: 1, bar: 2 };
        let result = "";
        for (let k in obj) {
          result += k;
        }
        return result;
      }
    `);
    const result = exports.test() as string;
    expect(result).toContain("foo");
    expect(result).toContain("bar");
  });

  it("for-in body uses the key variable", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const obj = { a: 10, b: 20, c: 30 };
        let count = 0;
        for (let k in obj) {
          count++;
        }
        return count;
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("for-in over empty object does nothing", async () => {
    // This should compile without error even though there are no props
    const exports = await compileToWasm(`
      export function test(): number {
        const obj: Record<string, number> = {};
        let count = 0;
        for (let k in obj) {
          count++;
        }
        return count;
      }
    `);
    expect(exports.test()).toBe(0);
  });
});
