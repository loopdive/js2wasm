import { describe, it, expect } from "vitest";
import { assertEquivalent, compileToWasm } from "./equivalence/helpers.js";

describe("Issue #279: Arrow function parameter and body patterns", () => {
  describe("Arrow functions with object destructuring parameters", () => {
    it("should handle basic object destructuring in arrow params", async () => {
      const source = `
        export function test(): number {
          const fn = ({x, y}: {x: number, y: number}) => x + y;
          return fn({x: 3, y: 4});
        }
      `;
      const exports = await compileToWasm(source);
      expect(exports.test()).toBe(7);
    });

    it("should handle object destructuring with rename in arrow params", async () => {
      const source = `
        export function test(): number {
          const fn = ({x: a, y: b}: {x: number, y: number}) => a * b;
          return fn({x: 5, y: 6});
        }
      `;
      const exports = await compileToWasm(source);
      expect(exports.test()).toBe(30);
    });

    it("should handle object destructuring with multiple fields", async () => {
      const source = `
        export function test(): number {
          const add = ({a, b, c}: {a: number, b: number, c: number}) => a + b + c;
          return add({a: 1, b: 2, c: 3});
        }
      `;
      const exports = await compileToWasm(source);
      expect(exports.test()).toBe(6);
    });
  });

  describe("Arrow functions with default parameter values", () => {
    it("should handle arrow with default numeric param (closure)", async () => {
      const source = `
        export function test(): number {
          const outer = 10;
          const fn = (x: number = 5) => x + outer;
          return fn();
        }
      `;
      // Default param in closure context - the caller passes 0 for omitted f64
      // and the default check (f64.eq 0) would trigger the default assignment.
      // This test verifies the mechanism works.
      const exports = await compileToWasm(source);
      // fn() with no args: x defaults to 5, result = 5 + 10 = 15
      expect(exports.test()).toBe(15);
    });
  });

  describe("Arrow functions used as values in various contexts", () => {
    it("should handle arrow function returning arithmetic", async () => {
      const source = `
        export function test(): number {
          const double = (x: number) => x * 2;
          return double(21);
        }
      `;
      const exports = await compileToWasm(source);
      expect(exports.test()).toBe(42);
    });

    it("should handle arrow function with block body", async () => {
      const source = `
        export function test(): number {
          const calc = (x: number, y: number) => {
            const sum = x + y;
            return sum * 2;
          };
          return calc(3, 4);
        }
      `;
      const exports = await compileToWasm(source);
      expect(exports.test()).toBe(14);
    });

    it("should handle arrow function with captures and destructuring", async () => {
      const source = `
        export function test(): number {
          const factor = 3;
          const fn = ({x, y}: {x: number, y: number}) => (x + y) * factor;
          return fn({x: 2, y: 3});
        }
      `;
      const exports = await compileToWasm(source);
      expect(exports.test()).toBe(15);
    });
  });

  describe("Arrow function compilation does not error", () => {
    it("should compile arrow with destructuring without errors", async () => {
      const source = `
        export function test(): number {
          const fn = ({a, b}: {a: number, b: number}) => a - b;
          return fn({a: 10, b: 3});
        }
      `;
      // Should not throw compile error
      const exports = await compileToWasm(source);
      expect(exports.test()).toBe(7);
    });

    it("should compile arrow with multiple destructured params", async () => {
      const source = `
        export function test(): number {
          const fn = ({x}: {x: number}, {y}: {y: number}) => x + y;
          return fn({x: 5}, {y: 10});
        }
      `;
      const exports = await compileToWasm(source);
      expect(exports.test()).toBe(15);
    });
  });
});
