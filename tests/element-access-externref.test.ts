import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("Element access on externref", () => {
  it("string key element access on any-typed parameter", async () => {
    const exports = await compileToWasm(`
      export function test(obj: any): any {
        return obj["hello"];
      }
    `);
    const result = exports.test({ hello: 42 });
    expect(result).toBe(42);
  });

  it("numeric key element access on any-typed parameter", async () => {
    const exports = await compileToWasm(`
      export function test(obj: any): any {
        return obj[0];
      }
    `);
    const result = exports.test([10, 20, 30]);
    expect(result).toBe(10);
  });

  it("dynamic key element access on any-typed parameter", async () => {
    const exports = await compileToWasm(`
      export function test(obj: any, key: any): any {
        return obj[key];
      }
    `);
    expect(exports.test({ a: 1, b: 2 }, "a")).toBe(1);
    expect(exports.test({ a: 1, b: 2 }, "b")).toBe(2);
    expect(exports.test([10, 20], 0)).toBe(10);
    expect(exports.test([10, 20], 1)).toBe(20);
  });

  it("chained element access on externref", async () => {
    const exports = await compileToWasm(`
      export function test(obj: any): any {
        return obj["nested"]["value"];
      }
    `);
    const result = exports.test({ nested: { value: 99 } });
    expect(result).toBe(99);
  });
});
