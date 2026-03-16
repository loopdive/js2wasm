import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("decorator syntax support (#376)", () => {
  it("class with decorator compiles (decorator ignored)", async () => {
    const exports = await compileToWasm(`
      function myDecorator(target: any) { return target; }

      @myDecorator
      class Foo {
        value: number = 42;
      }

      export function test(): number {
        const f = new Foo();
        return f.value;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("method decorator compiles (decorator ignored)", async () => {
    const exports = await compileToWasm(`
      function log(target: any, key: string, descriptor: any) { return descriptor; }

      class Bar {
        @log
        getValue(): number {
          return 99;
        }
      }

      export function test(): number {
        const b = new Bar();
        return b.getValue();
      }
    `);
    expect(exports.test()).toBe(99);
  });

  it("multiple decorators compile (decorators ignored)", async () => {
    const exports = await compileToWasm(`
      function d1(target: any) { return target; }
      function d2(target: any) { return target; }

      @d1
      @d2
      class Multi {
        x: number = 7;
      }

      export function test(): number {
        const m = new Multi();
        return m.x;
      }
    `);
    expect(exports.test()).toBe(7);
  });
});
