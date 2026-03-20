import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("Spread in new expressions (#177)", () => {
  it("new with spread array literal", async () => {
    const exports = await compileToWasm(`
      class Vec {
        x: number;
        y: number;
        z: number;
        constructor(x: number, y: number, z: number) {
          this.x = x;
          this.y = y;
          this.z = z;
        }
        sum(): number { return this.x + this.y + this.z; }
      }
      export function test(): number {
        const v = new Vec(...[3, 4, 5]);
        return v.sum();
      }
    `);
    expect(exports.test()).toBe(12);
  });
});
