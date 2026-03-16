import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("computed property names in class declarations", () => {
  it("string literal computed method name", async () => {
    const exports = await compileToWasm(`
      class C {
        ["greet"](): number {
          return 42;
        }
      }
      export function test(): number {
        const c = new C();
        return c.greet();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("string literal computed property", async () => {
    const exports = await compileToWasm(`
      class C {
        ["x"]: number = 10;
      }
      export function test(): number {
        const c = new C();
        return c.x;
      }
    `);
    expect(exports.test()).toBe(10);
  });

  it("numeric literal computed method name", async () => {
    const exports = await compileToWasm(`
      class C {
        [0](): number {
          return 99;
        }
      }
      export function test(): number {
        const c = new C();
        return c[0]();
      }
    `);
    expect(exports.test()).toBe(99);
  });

  it("const variable computed method name", async () => {
    const exports = await compileToWasm(`
      const key = "myMethod";
      class C {
        [key](): number {
          return 7;
        }
      }
      export function test(): number {
        const c = new C();
        return c.myMethod();
      }
    `);
    expect(exports.test()).toBe(7);
  });

  it("computed getter and setter", async () => {
    const exports = await compileToWasm(`
      class C {
        private _val: number = 0;
        get ["value"](): number {
          return this._val;
        }
        set ["value"](v: number) {
          this._val = v;
        }
      }
      export function test(): number {
        const c = new C();
        c.value = 55;
        return c.value;
      }
    `);
    expect(exports.test()).toBe(55);
  });

  it("computed static method", async () => {
    const exports = await compileToWasm(`
      class C {
        static ["create"](): number {
          return 123;
        }
      }
      export function test(): number {
        return C.create();
      }
    `);
    expect(exports.test()).toBe(123);
  });

  it("multiple computed methods", async () => {
    const exports = await compileToWasm(`
      class C {
        ["add"](a: number, b: number): number {
          return a + b;
        }
        ["mul"](a: number, b: number): number {
          return a * b;
        }
      }
      export function test(): number {
        const c = new C();
        return c.add(3, 4) + c.mul(2, 5);
      }
    `);
    expect(exports.test()).toBe(17);
  });
});
