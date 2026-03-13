import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "./equivalence/helpers.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    buildImports(result),
  );
  return (instance.exports as any)[fn](...args);
}

describe("new.target meta-property (#189)", () => {
  it("new.target is truthy inside a class constructor", async () => {
    const result = await run(
      `
      class Foo {
        hasNewTarget: number;
        constructor() {
          this.hasNewTarget = new.target ? 1 : 0;
        }
      }
      export function test(): number {
        const f = new Foo();
        return f.hasNewTarget;
      }
    `,
      "test",
    );
    expect(result).toBe(1);
  });

  it("new.target compiles without error in a regular function (returns falsy)", async () => {
    // In a standalone function (not called via new), new.target should be undefined/falsy.
    // Our compiler treats non-constructor functions as having new.target === undefined.
    const result = await run(
      `
      export function test(): number {
        const t = new.target;
        return t ? 1 : 0;
      }
    `,
      "test",
    );
    expect(result).toBe(0);
  });

  it("new.target used in conditional inside constructor", async () => {
    const result = await run(
      `
      class Bar {
        value: number;
        constructor() {
          if (new.target) {
            this.value = 42;
          } else {
            this.value = 0;
          }
        }
      }
      export function test(): number {
        const b = new Bar();
        return b.value;
      }
    `,
      "test",
    );
    expect(result).toBe(42);
  });

  it("new.target negation in constructor", async () => {
    const result = await run(
      `
      class Baz {
        value: number;
        constructor() {
          if (!new.target) {
            this.value = 0;
          } else {
            this.value = 99;
          }
        }
      }
      export function test(): number {
        const b = new Baz();
        return b.value;
      }
    `,
      "test",
    );
    expect(result).toBe(99);
  });
});
