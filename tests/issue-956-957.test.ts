import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

/**
 * Tests for #956 (i32.const direct emit) and #957 (dead-store elimination).
 */

describe("#956: emit i32.const directly in i32 context", () => {
  it("loop with integer bound compiles to valid Wasm", () => {
    const src = `
      export function test(): number {
        let sum = 0;
        for (let i = 0; i < 10; i++) sum += i;
        return sum;
      }
    `;
    const result = compile(src, { fileName: "test.ts" });
    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("for loop sum 0..9 returns 45", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let sum = 0;
        for (let i = 0; i < 10; i++) sum += i;
        return sum;
      }
    `);
    expect(exports["test"]!()).toBe(45);
  });

  it("for loop countdown sum 9..0 returns 45", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let sum = 0;
        for (let i = 9; i >= 0; i--) sum += i;
        return sum;
      }
    `);
    expect(exports["test"]!()).toBe(45);
  });

  it("comparison with integer literal in i32 context", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        type i32 = number;
        let x: i32 = 5;
        return x < 10 ? 1 : 0;
      }
    `);
    expect(exports["test"]!()).toBe(1);
  });

  it("large integer constant stays within i32 range", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let sum = 0;
        for (let i = 0; i < 1000; i++) sum++;
        return sum;
      }
    `);
    expect(exports["test"]!()).toBe(1000);
  });
});

describe("#957: dead-store elimination for postfix increment as statement", () => {
  it("i++ as statement in for loop compiles to valid Wasm", () => {
    const src = `
      export function test(): number {
        let sum = 0;
        for (let i = 0; i < 5; i++) sum += i;
        return sum;
      }
    `;
    const result = compile(src, { fileName: "test.ts" });
    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("for loop with i++ produces correct result", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let sum = 0;
        for (let i = 0; i < 10; i++) sum += i;
        return sum;
      }
    `);
    expect(exports["test"]!()).toBe(45);
  });

  it("explicit i++ statement produces correct side effect", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let i = 0;
        i++;
        i++;
        i++;
        return i;
      }
    `);
    expect(exports["test"]!()).toBe(3);
  });

  it("i-- statement produces correct side effect", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let i = 10;
        i--;
        i--;
        return i;
      }
    `);
    expect(exports["test"]!()).toBe(8);
  });

  it("postfix used as expression (not statement) still returns old value", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let i = 5;
        let old = i++;  // old = 5, i = 6
        return old + i;
      }
    `);
    expect(exports["test"]!()).toBe(11); // 5 + 6
  });

  it("for loop with i-- produces correct result", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let sum = 0;
        for (let i = 9; i >= 0; i--) sum += i;
        return sum;
      }
    `);
    expect(exports["test"]!()).toBe(45);
  });
});
