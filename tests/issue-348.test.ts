import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("Null/undefined arithmetic coercion (#348)", () => {
  it("+null produces 0", async () => {
    const exports = await compileToWasm(`
      export function test(): number { return +null; }
    `);
    expect(exports.test()).toBe(0);
  });

  it("+undefined produces NaN", async () => {
    const exports = await compileToWasm(`
      export function test(): number { return +(undefined as any); }
    `);
    expect(exports.test()).toBeNaN();
  });

  it("-null produces -0", async () => {
    const exports = await compileToWasm(`
      export function test(): number { return -null; }
    `);
    const result = exports.test();
    expect(result === 0).toBe(true);
  });

  it("-undefined produces NaN", async () => {
    const exports = await compileToWasm(`
      export function test(): number { return -(undefined as any); }
    `);
    expect(exports.test()).toBeNaN();
  });

  it("null + 1 produces 1", async () => {
    const exports = await compileToWasm(`
      export function test(): number { return (null as any) + 1; }
    `);
    expect(exports.test()).toBe(1);
  });

  it("1 + null produces 1", async () => {
    const exports = await compileToWasm(`
      export function test(): number { return 1 + (null as any); }
    `);
    expect(exports.test()).toBe(1);
  });

  it("undefined + 1 produces NaN", async () => {
    const exports = await compileToWasm(`
      export function test(): number { return (undefined as any) + 1; }
    `);
    expect(exports.test()).toBeNaN();
  });

  it("null * 5 produces 0", async () => {
    const exports = await compileToWasm(`
      export function test(): number { return (null as any) * 5; }
    `);
    expect(exports.test()).toBe(0);
  });

  it("undefined * 5 produces NaN", async () => {
    const exports = await compileToWasm(`
      export function test(): number { return (undefined as any) * 5; }
    `);
    expect(exports.test()).toBeNaN();
  });

  it("null - 3 produces -3", async () => {
    const exports = await compileToWasm(`
      export function test(): number { return (null as any) - 3; }
    `);
    expect(exports.test()).toBe(-3);
  });

  it("undefined - 3 produces NaN", async () => {
    const exports = await compileToWasm(`
      export function test(): number { return (undefined as any) - 3; }
    `);
    expect(exports.test()).toBeNaN();
  });

  it("null / 2 produces 0", async () => {
    const exports = await compileToWasm(`
      export function test(): number { return (null as any) / 2; }
    `);
    expect(exports.test()).toBe(0);
  });
});
