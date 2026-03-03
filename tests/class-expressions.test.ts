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

describe("class expressions", () => {
  it("basic class expression with property", async () => {
    expect(
      await run(
        `
      const Point = class {
        x: number;
        constructor(x: number) {
          this.x = x;
        }
      };
      export function test(): number {
        const p = new Point(42);
        return p.x;
      }
    `,
        "test",
      ),
    ).toBe(42);
  });

  it("class expression with methods", async () => {
    expect(
      await run(
        `
      const Calc = class {
        a: number;
        b: number;
        constructor(a: number, b: number) {
          this.a = a;
          this.b = b;
        }
        sum(): number {
          return this.a + this.b;
        }
        product(): number {
          return this.a * this.b;
        }
      };
      export function test(): number {
        const c = new Calc(3, 7);
        return c.sum() + c.product();
      }
    `,
        "test",
      ),
    ).toBe(31); // (3+7) + (3*7) = 10 + 21 = 31
  });

  it("new on class expression", async () => {
    expect(
      await run(
        `
      const Vec2 = class {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
        length(): number {
          return this.x + this.y;
        }
      };
      export function test(): number {
        const v1 = new Vec2(10, 20);
        const v2 = new Vec2(3, 4);
        return v1.length() + v2.length();
      }
    `,
        "test",
      ),
    ).toBe(37); // (10+20) + (3+4) = 30 + 7 = 37
  });
});
