import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("null dereference guards (#396)", () => {
  it("property access on null struct returns NaN instead of trapping", async () => {
    const exports = await compileToWasm(`
      function getObj(): { x: number } | null {
        return null;
      }
      export function main(): number {
        const obj = getObj();
        return obj!.x;
      }
    `);
    // Should not trap; returns NaN as default for f64 on null access
    expect(exports.main!()).toBeNaN();
  });

  it("method call on null class instance returns default instead of trapping", async () => {
    const exports = await compileToWasm(`
      class Foo {
        getValue(): number { return 42; }
      }
      function getFoo(): Foo | null {
        return null;
      }
      export function main(): number {
        const f = getFoo();
        return f!.getValue();
      }
    `);
    expect(exports.main!()).toBeNaN();
  });

  it("array element access on null array returns NaN instead of trapping", async () => {
    const exports = await compileToWasm(`
      function getArr(): number[] | null {
        return null;
      }
      export function main(): number {
        const arr = getArr();
        return arr![0];
      }
    `);
    expect(exports.main!()).toBeNaN();
  });

  it("chained property access on null intermediate returns default", async () => {
    const exports = await compileToWasm(`
      class Inner { value: number = 10; }
      class Outer { inner: Inner | null = null; }
      export function main(): number {
        const o = new Outer();
        return o.inner!.value;
      }
    `);
    expect(exports.main!()).toBeNaN();
  });

  it("non-null property access still works correctly", async () => {
    const exports = await compileToWasm(`
      class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
      }
      export function main(): number {
        const p = new Point(3, 4);
        return p.x + p.y;
      }
    `);
    expect(exports.main!()).toBe(7);
  });

  it("non-null method call still works correctly", async () => {
    const exports = await compileToWasm(`
      class Adder {
        a: number;
        b: number;
        constructor(a: number, b: number) {
          this.a = a;
          this.b = b;
        }
        sum(): number { return this.a + this.b; }
      }
      export function main(): number {
        const adder = new Adder(10, 20);
        return adder.sum();
      }
    `);
    expect(exports.main!()).toBe(30);
  });

  it("uninitialized class variable property access returns default", async () => {
    const exports = await compileToWasm(`
      class Config {
        value: number = 99;
      }
      let cfg: Config;
      export function main(): number {
        return cfg.value;
      }
    `);
    expect(exports.main!()).toBeNaN();
  });
});
