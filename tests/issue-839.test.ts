/**
 * Issue #839 — return_call stack args and type mismatch in class constructors
 *
 * Root cause: static method calls via `this.#method()` used a stale funcIdx
 * for parameter type lookup after late imports shifted function indices.
 * This caused arguments to be dropped before the call instruction.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

function expectValid(name: string, source: string) {
  it(name, () => {
    const result = compile(source, { fileName: "test.ts" });
    expect(result.success).toBe(true);
    if (result.success) {
      // Validate the wasm binary
      expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
    }
  });
}

describe("Issue #839: static private method calls via this", () => {
  expectValid("static private method via this (sub-pattern 1: stack args)", `
    var C = class {
      static async *m() { return 42; }
      static #dollar(value: number): number { return value; }
      static getDollar(value: number): number { return this.#dollar(value); }
    }
    export function test(): number { return 1; }
  `);

  expectValid("static async private method via this (sub-pattern 2: type mismatch)", `
    var C = class {
      *m() { return 42; }
      static async #dollar(value: number): Promise<number> { return value; }
      static async getDollar(value: number): Promise<number> { return this.#dollar(value); }
    }
    export function test(): number { return 1; }
  `);

  expectValid("two static private methods", `
    var C = class {
      static async *m() { return 42; }
      static #x(value: number): number { return value / 2; }
      static #y(value: number): number { return value * 2; }
      static getX(value: number): number { return this.#x(value); }
      static getY(value: number): number { return this.#y(value); }
    }
    export function test(): number { return 1; }
  `);

  expectValid("non-return position private static call", `
    var C = class {
      static #dollar(value: number): number { return value; }
      static getDollar(value: number): number {
        const x = this.#dollar(value);
        return x;
      }
    }
    export function test(): number { return 1; }
  `);

  expectValid("instance private method call", `
    class C {
      #value: number;
      constructor(v: number) { this.#value = v; }
      #getVal(): number { return this.#value; }
      getValue(): number { return this.#getVal(); }
    }
    export function test(): number { return 1; }
  `);
});
