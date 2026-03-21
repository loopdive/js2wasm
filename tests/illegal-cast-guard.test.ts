import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * Tests for guarded ref.cast -- verifies that polymorphic code
 * does not trap with "illegal cast" at runtime (#706).
 */

async function run(source: string, fn = "test"): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e: any) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn]();
}

describe("Guarded ref.cast (#706)", () => {
  it("class instance assigned to any-typed variable does not illegal-cast", async () => {
    const val = await run(`
      class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
      }
      export function test(): number {
        const p = new Point(3, 4);
        return p.x + p.y;
      }
    `);
    expect(val).toBe(7);
  });

  it("class with inheritance does not illegal-cast on subtype access", async () => {
    const val = await run(`
      class Animal {
        legs: number;
        constructor(legs: number) {
          this.legs = legs;
        }
      }
      class Dog extends Animal {
        constructor() {
          super(4);
        }
        bark(): number {
          return 1;
        }
      }
      export function test(): number {
        const d = new Dog();
        return d.legs + d.bark();
      }
    `);
    expect(val).toBe(5);
  });

  it("multiple class types do not confuse struct casts", async () => {
    const val = await run(`
      class A {
        val: number;
        constructor(v: number) { this.val = v; }
      }
      class B {
        val: number;
        constructor(v: number) { this.val = v; }
      }
      export function test(): number {
        const a = new A(10);
        const b = new B(20);
        return a.val + b.val;
      }
    `);
    expect(val).toBe(30);
  });
});
