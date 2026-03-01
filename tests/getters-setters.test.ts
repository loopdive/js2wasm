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

describe("getters and setters", () => {
  it("basic getter returning computed value", async () => {
    expect(
      await run(
        `
      class Rect {
        w: number;
        h: number;
        constructor(w: number, h: number) {
          this.w = w;
          this.h = h;
        }
        get area(): number {
          return this.w * this.h;
        }
      }
      export function test(): number {
        const r = new Rect(3, 4);
        return r.area;
      }
    `,
        "test",
      ),
    ).toBe(12);
  });

  it("basic setter mutating internal state", async () => {
    expect(
      await run(
        `
      class Box {
        _size: number;
        constructor(s: number) {
          this._size = s;
        }
        get size(): number {
          return this._size;
        }
        set size(val: number) {
          this._size = val;
        }
      }
      export function test(): number {
        const b = new Box(5);
        b.size = 10;
        return b.size;
      }
    `,
        "test",
      ),
    ).toBe(10);
  });

  it("getter with calculation from multiple fields", async () => {
    expect(
      await run(
        `
      class Circle {
        radius: number;
        constructor(r: number) {
          this.radius = r;
        }
        get diameter(): number {
          return this.radius * 2;
        }
      }
      export function test(): number {
        const c = new Circle(5);
        return c.diameter;
      }
    `,
        "test",
      ),
    ).toBe(10);
  });

  it("setter with validation logic", async () => {
    expect(
      await run(
        `
      class Clamped {
        _value: number;
        constructor(v: number) {
          this._value = v;
        }
        get value(): number {
          return this._value;
        }
        set value(v: number) {
          if (v < 0) {
            this._value = 0;
          } else if (v > 100) {
            this._value = 100;
          } else {
            this._value = v;
          }
        }
      }
      export function test(): number {
        const c = new Clamped(50);
        c.value = 200;
        return c.value;
      }
    `,
        "test",
      ),
    ).toBe(100);
  });

  it("getter used in expression", async () => {
    expect(
      await run(
        `
      class Vec2 {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
        get lengthSquared(): number {
          return this.x * this.x + this.y * this.y;
        }
      }
      export function test(): number {
        const v = new Vec2(3, 4);
        return v.lengthSquared + 1;
      }
    `,
        "test",
      ),
    ).toBe(26);
  });

  it("multiple getters on same class", async () => {
    expect(
      await run(
        `
      class Temp {
        celsius: number;
        constructor(c: number) {
          this.celsius = c;
        }
        get fahrenheit(): number {
          return this.celsius * 1.8 + 32;
        }
        get kelvin(): number {
          return this.celsius + 273.15;
        }
      }
      export function test(): number {
        const t = new Temp(100);
        return t.fahrenheit;
      }
    `,
        "test",
      ),
    ).toBe(212);
  });
});
