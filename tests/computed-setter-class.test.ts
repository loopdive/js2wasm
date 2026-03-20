import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("computed property setter in class", () => {
  it("should call setter with computed property name", async () => {
    const exports = await compileToWasm(`
      var calls = 0;
      class C {
        set ['a'](_: any) {
          calls++;
        }
      }
      export function test(): number {
        new C().a = 'A' as any;
        return calls;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("should reference shared variables between object/class and reference types", async () => {
    const exports = await compileToWasm(`
      export function testReference(): number {
        var a = [1, 2, 3];
        var b = a;
        return b[1];
      }
    `);
    expect(exports.testReference()).toBe(2);
  });
});
