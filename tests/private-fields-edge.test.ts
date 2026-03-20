import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("Private fields edge cases (getter accessor)", () => {
  it("private getter accessor on private field", async () => {
    const exports = await compileToWasm(`
      class C {
        #x = 42;
        get value(): number { return this.#x; }
      }
      export function test(): number {
        const c = new C();
        return c.value;
      }
    `);
    expect(exports.test()).toBe(42);
  });
});
