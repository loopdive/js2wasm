import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn](...args);
}

describe("Accessor/getter/setter side effects (#634)", () => {
  it("getter side effect is triggered on property access", async () => {
    const result = await run(`
      class Counter {
        private _count: number = 0;
        private _accessed: number = 0;

        get count(): number {
          this._accessed++;
          return this._count;
        }

        set count(val: number) {
          this._count = val;
        }

        get accessed(): number {
          return this._accessed;
        }
      }

      export function test(): number {
        const c = new Counter();
        c.count;  // trigger getter side effect
        c.count;  // trigger again
        c.count;  // trigger again
        return c.accessed;  // should be 3
      }
    `, "test");
    expect(result).toBe(3);
  });

  it("setter side effect is triggered on property assignment", async () => {
    const result = await run(`
      class Logger {
        private _value: number = 0;
        private _setCount: number = 0;

        get value(): number {
          return this._value;
        }

        set value(val: number) {
          this._setCount++;
          this._value = val;
        }

        get setCount(): number {
          return this._setCount;
        }
      }

      export function test(): number {
        const l = new Logger();
        l.value = 10;
        l.value = 20;
        return l.setCount;  // should be 2
      }
    `, "test");
    expect(result).toBe(2);
  });

  it("getter returns computed value, not raw field", async () => {
    const result = await run(`
      class Doubler {
        private _x: number = 5;

        get x(): number {
          return this._x * 2;
        }

        set x(val: number) {
          this._x = val;
        }
      }

      export function test(): number {
        const d = new Doubler();
        return d.x;  // should be 10 (5 * 2)
      }
    `, "test");
    expect(result).toBe(10);
  });

  it("setter transforms value before storing", async () => {
    const result = await run(`
      class Clamper {
        private _val: number = 0;

        get val(): number {
          return this._val;
        }

        set val(v: number) {
          if (v > 100) {
            this._val = 100;
          } else {
            this._val = v;
          }
        }
      }

      export function test(): number {
        const c = new Clamper();
        c.val = 200;
        return c.val;  // should be 100 (clamped)
      }
    `, "test");
    expect(result).toBe(100);
  });

  it("getter-only computed property (no setter)", async () => {
    const result = await run(`
      class Rectangle {
        width: number;
        height: number;

        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
        }

        get area(): number {
          return this.width * this.height;
        }
      }

      export function test(): number {
        const r = new Rectangle(3, 4);
        return r.area;  // should be 12
      }
    `, "test");
    expect(result).toBe(12);
  });

  it("object literal getter is invoked", async () => {
    const result = await run(`
      export function test(): number {
        let count = 0;
        const obj = {
          get v(): number {
            count++;
            return 42;
          }
        };
        const val = obj.v;
        return count;  // should be 1
      }
    `, "test");
    expect(result).toBe(1);
  });

  it("object literal getter+setter both capture function-local", async () => {
    const result = await run(`
      export function test(): number {
        let count = 0;
        const obj = {
          _x: 0,
          get x(): number {
            count = count + 1;
            return this._x;
          },
          set x(val: number) {
            count = count + 1;
            this._x = val;
          }
        };
        obj.x = 10;
        const v = obj.x;
        return count;
      }
    `, "test");
    expect(result).toBe(2);
  });

  it("object literal setter with count++ on captured local", async () => {
    const result = await run(`
      export function test(): number {
        let count = 0;
        const obj = {
          set x(val: number) {
            count++;
          }
        };
        obj.x = 10;
        obj.x = 20;
        return count;
      }
    `, "test");
    expect(result).toBe(2);
  });

  it("object literal setter captures function-local variable (set only)", async () => {
    const result = await run(`
      export function test(): number {
        let count = 0;
        const obj = {
          _x: 0,
          set x(val: number) {
            count = count + 1;
            this._x = val;
          }
        };
        obj.x = 10;
        return count;
      }
    `, "test");
    expect(result).toBe(1);
  });

  it("object literal setter is invoked", async () => {
    const result = await run(`
      let count = 0;
      const obj = {
        _x: 0,
        get x(): number {
          return this._x;
        },
        set x(val: number) {
          count++;
          this._x = val;
        }
      };
      export function test(): number {
        obj.x = 10;
        obj.x = 20;
        return count;  // should be 2
      }
    `, "test");
    expect(result).toBe(2);
  });

  it("object literal getter reads module-level variable", async () => {
    const result = await run(`
      let val = 42;
      const obj = {
        get v(): number {
          return val;
        }
      };
      export function test(): number {
        return obj.v;  // should be 42
      }
    `, "test");
    expect(result).toBe(42);
  });

  it("object literal getter writes module-level variable", async () => {
    const result = await run(`
      let count = 0;
      const obj = {
        get v(): number {
          count = count + 1;
          return count;
        }
      };
      export function test(): number {
        obj.v;
        obj.v;
        return count;  // should be 2
      }
    `, "test");
    expect(result).toBe(2);
  });

  it("object literal getter reads closure variable", async () => {
    const result = await run(`
      export function test(): number {
        let val = 42;
        const obj = {
          get v(): number {
            return val;
          }
        };
        return obj.v;  // should be 42
      }
    `, "test");
    expect(result).toBe(42);
  });

  it("object literal getter writes closure variable via ref cell", async () => {
    const result = await run(`
      export function test(): number {
        let count = 0;
        const obj = {
          get v(): number {
            count = count + 1;
            return count;
          }
        };
        obj.v;
        return count;  // should be 1
      }
    `, "test");
    expect(result).toBe(1);
  });

  it("object literal getter returns computed value (no closure)", async () => {
    const result = await run(`
      export function test(): number {
        const obj = {
          _x: 5,
          get x(): number {
            return this._x * 2;
          }
        };
        return obj.x;  // should be 10
      }
    `, "test");
    expect(result).toBe(10);
  });

  it("getter invoked on expression statement (side effect only)", async () => {
    const result = await run(`
      class Foo {
        private _x: number = 0;
        get x(): number {
          this._x = 99;
          return this._x;
        }
      }
      export function test(): number {
        const f = new Foo();
        f.x;  // expression statement - getter should still run
        return f._x;  // should be 99
      }
    `, "test");
    // Note: _x is private but we access it via the backing field
    // This may or may not work - depends on private field compilation
    expect(result).toBe(99);
  });
});
