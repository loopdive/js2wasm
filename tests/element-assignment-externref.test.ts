import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("Element assignment on non-array types", () => {
  it("string key assignment on any-typed parameter", async () => {
    const exports = await compileToWasm(`
      export function test(obj: any): any {
        obj["key"] = "hello";
        return obj["key"];
      }
    `);
    const o: any = {};
    const result = exports.test(o);
    expect(result).toBe("hello");
  });

  it("numeric key assignment on any-typed parameter", async () => {
    const exports = await compileToWasm(`
      export function test(obj: any): any {
        obj[0] = 42;
        return obj[0];
      }
    `);
    const o: any = {};
    const result = exports.test(o);
    expect(result).toBe(42);
  });

  it("dynamic key assignment on any-typed parameter", async () => {
    const exports = await compileToWasm(`
      export function test(obj: any, key: any, val: any): any {
        obj[key] = val;
        return obj[key];
      }
    `);
    const o: any = {};
    exports.test(o, "x", 99);
    expect(o.x).toBe(99);
  });

  it("assignment mutates external object", async () => {
    const exports = await compileToWasm(`
      export function test(obj: any): void {
        obj["a"] = 1;
        obj["b"] = 2;
      }
    `);
    const o: any = {};
    exports.test(o);
    expect(o.a).toBe(1);
    expect(o.b).toBe(2);
  });
});
