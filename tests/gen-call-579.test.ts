import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("Generator function call patterns (#579)", () => {
  it("any-typed variable method call compiles without error", () => {
    const result = compile(`
      var ref: any = {};
      ref.someMethod(1, 2);
      export const result = 42;
    `);
    const unsupported = result.errors.filter(e => e.message === "Unsupported call expression");
    expect(unsupported).toHaveLength(0);
  }, 30000);

  it("generator function expression assigned to any var, then ref().next()", () => {
    const result = compile(`
      var ref: any;
      ref = function*(a: number, b: number) {
        yield a + b;
      };
      ref(1, 2).next();
      export const result = 42;
    `);
    const unsupported = result.errors.filter(e => e.message === "Unsupported call expression");
    expect(unsupported).toHaveLength(0);
  }, 30000);

  it("generator with default params, ref(undefined).next() -- test262 pattern", () => {
    const result = compile(`
      var callCount = 0;
      var ref: any;
      ref = function*(fromLiteral = 23, fromExpr = 45, fromHole = 99) {
        callCount = callCount + 1;
      };
      ref(undefined, void 0).next();
      export const result = callCount;
    `);
    const unsupported = result.errors.filter(e => e.message === "Unsupported call expression");
    expect(unsupported).toHaveLength(0);
  }, 30000);

  it("obj.method(args).next() pattern compiles", () => {
    const result = compile(`
      var callCount = 0;
      var obj: any = {
        *method(x: any) {
          callCount = callCount + 1;
        }
      };
      obj.method({}).next();
      export const result = callCount;
    `);
    const unsupported = result.errors.filter(e => e.message === "Unsupported call expression");
    expect(unsupported).toHaveLength(0);
  }, 30000);

  it("generator function expression with destructuring param -- test262 dstr pattern", () => {
    const result = compile(`
      var callCount = 0;
      var f: any;
      f = function*([x, y, z]: number[]) {
        callCount = callCount + 1;
      };
      f([1, 2, 3]).next();
      export const result = callCount;
    `);
    const unsupported = result.errors.filter(e => e.message === "Unsupported call expression");
    expect(unsupported).toHaveLength(0);
  }, 30000);

  it("direct generator call still works", async () => {
    const result = compile(`
      export function* gen(a: number): Generator<number> {
        yield a * 2;
        yield a * 3;
      }
    `);
    expect(result.success).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(
      result.binary,
      imports as unknown as WebAssembly.Imports,
    );
    const gen = (instance.exports.gen as Function)(5);
    expect(gen.next().value).toBe(10);
    expect(gen.next().value).toBe(15);
  }, 30000);

  it("assert.sameValue call on any compiles (test262 harness pattern)", () => {
    // test262 uses assert.sameValue(actual, expected) everywhere
    const result = compile(`
      var assert: any = { sameValue: function(a: any, b: any) {} };
      assert.sameValue(1, 1);
      export const result = 42;
    `);
    const unsupported = result.errors.filter(e => e.message === "Unsupported call expression");
    expect(unsupported).toHaveLength(0);
  }, 30000);
});
