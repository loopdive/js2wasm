import { describe, it, expect } from "vitest";
import { assertEquivalent, buildImports } from "./equivalence/helpers.js";
import { compile } from "../src/index.js";

describe("callable parameter dispatch (#446)", () => {
  it("higher-order function: pass named function as callback", async () => {
    const src = `
      function apply(fn: (x: number) => number, val: number): number {
        return fn(val);
      }
      function double(x: number): number { return x * 2; }
      export function test(): number { return apply(double, 5); }
    `;
    await assertEquivalent(src, [{ fn: "test", args: [] }]);
  });

  it("higher-order function: pass arrow as callback", async () => {
    const src = `
      function apply(fn: (x: number) => number, val: number): number {
        return fn(val);
      }
      export function test(): number { return apply((x: number) => x * 3, 4); }
    `;
    await assertEquivalent(src, [{ fn: "test", args: [] }]);
  });

  it("higher-order function: void callback", async () => {
    const src = `
      var count: number = 0;
      function doWith(fn: (x: number) => void, val: number): void {
        fn(val);
      }
      export function test(): number {
        doWith((x: number) => { count = count + x; }, 10);
        return count;
      }
    `;
    await assertEquivalent(src, [{ fn: "test", args: [] }]);
  });

  it("closure stored in var via IIFE", async () => {
    const src = `
export function test(): number {
  var probe: () => number;
  (function() {
    var x: number = 42;
    probe = function() { return x; };
  }());
  return probe();
}
    `;
    const result = compile(src);
    expect(result.errors).toHaveLength(0);
    const imports = buildImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    expect((instance.exports as any).test()).toBe(42);
  });

  it("function expression assigned to var with mutable capture", async () => {
    const src = `
export function test(): number {
  var callCount: number = 0;
  var ref: (a: number, b: number) => void;
  ref = function(a: number, b: number) {
    callCount = callCount + 1;
  };
  ref(42, 39);
  return callCount;
}
    `;
    const result = compile(src);
    expect(result.errors).toHaveLength(0);
    const imports = buildImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    expect((instance.exports as any).test()).toBe(1);
  });
});
