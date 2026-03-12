import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";
import { compile } from "../src/index.js";

describe("Issue #273: anonymous class expression in new", () => {
  it("should instantiate anonymous class with method", async () => {
    const source = `
      export function test(): number {
        return new (class {
          x: number;
          constructor() { this.x = 42; }
          getX(): number { return this.x; }
        })().getX();
      }
    `;
    const exports = await compileToWasm(source);
    expect(exports.test()).toBe(42);
  });

  it("should instantiate anonymous class with constructor param", async () => {
    const source = `
      export function test(): number {
        const obj = new (class {
          val: number;
          constructor(v: number) { this.val = v; }
        })(99);
        return obj.val;
      }
    `;
    const exports = await compileToWasm(source);
    expect(exports.test()).toBe(99);
  });

  it("should compile without errors", () => {
    const source = `
      export function test(): number {
        const obj = new (class {
          x: number;
          constructor() { this.x = 10; }
        })();
        return obj.x;
      }
    `;
    const result = compile(source);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should handle anonymous class with multiple methods", async () => {
    const source = `
      export function test(): number {
        const obj = new (class {
          a: number;
          b: number;
          constructor(a: number, b: number) {
            this.a = a;
            this.b = b;
          }
          sum(): number { return this.a + this.b; }
        })(3, 7);
        return obj.sum();
      }
    `;
    const exports = await compileToWasm(source);
    expect(exports.test()).toBe(10);
  });
});
