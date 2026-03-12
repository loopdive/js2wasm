import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("Nested class declarations (#150)", () => {
  it("class inside if block", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        if (true) {
          class Foo {
            x: number;
            constructor(x: number) { this.x = x; }
            getX(): number { return this.x; }
          }
          const f = new Foo(42);
          return f.getX();
        }
        return 0;
      }
    `);
    expect(exports.test()).toBe(42);
  });
});
