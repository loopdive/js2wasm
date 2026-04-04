import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// Shared assert_throws preamble — mirrors the test262 wrapper exactly.
// The TypeError check is stripped (as assert.throws → assert_throws does).
const ASSERT_THROWS = `
  let passed = 0;
  function assert_throws(fn: () => void): void {
    try { fn(); } catch (e) { passed++; return; }
  }
`;

/**
 * #930: Not-a-constructor detection for built-in methods.
 * Calling `new` on non-constructor functions must throw TypeError.
 * Uses the test262 assert_throws pattern (type check stripped).
 */
describe("not-a-constructor detection (#930)", () => {
  it("Array.prototype.forEach throws when called with new", async () => {
    const exports = await compileToWasm(`
      ${ASSERT_THROWS}
      export function test(): number {
        assert_throws(() => { new Array.prototype.forEach(() => {}); });
        return passed;
      }
    `);
    expect(exports["test"]!()).toBe(1);
  });

  it("Array.prototype.map throws when called with new", async () => {
    const exports = await compileToWasm(`
      ${ASSERT_THROWS}
      export function test(): number {
        assert_throws(() => { new Array.prototype.map((x: number) => x); });
        return passed;
      }
    `);
    expect(exports["test"]!()).toBe(1);
  });

  it("Array.prototype.with throws when called with new (ES2023)", async () => {
    const exports = await compileToWasm(`
      ${ASSERT_THROWS}
      export function test(): number {
        assert_throws(() => { new Array.prototype.with(0, 1); });
        return passed;
      }
    `);
    expect(exports["test"]!()).toBe(1);
  });

  it("Array.prototype.toSorted throws when called with new (ES2023)", async () => {
    const exports = await compileToWasm(`
      ${ASSERT_THROWS}
      export function test(): number {
        assert_throws(() => { new Array.prototype.toSorted(); });
        return passed;
      }
    `);
    expect(exports["test"]!()).toBe(1);
  });

  it("all four Array prototype methods throw", async () => {
    const exports = await compileToWasm(`
      ${ASSERT_THROWS}
      export function test(): number {
        assert_throws(() => { new Array.prototype.forEach(() => {}); });
        assert_throws(() => { new Array.prototype.map((x: number) => x); });
        assert_throws(() => { new Array.prototype.with(0, 1); });
        assert_throws(() => { new Array.prototype.toSorted(); });
        return passed;
      }
    `);
    expect(exports["test"]!()).toBe(4);
  });

  it("new on regular class is NOT affected", async () => {
    const exports = await compileToWasm(`
      class Foo {
        x: number;
        constructor(x: number) { this.x = x; }
      }
      export function test(): number {
        const f = new Foo(42);
        return f.x;
      }
    `);
    expect(exports["test"]!()).toBe(42);
  });
});
