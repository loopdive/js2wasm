import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "./equivalence/helpers.js";

async function compileAndRun(source: string): Promise<Record<string, Function>> {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    buildImports(result),
  );
  return instance.exports as Record<string, Function>;
}

describe("Issue #198: Switch statement compile errors and type coercion", () => {
  it("switch with boolean discriminant", async () => {
    const exports = await compileAndRun(`
      export function test(flag: boolean): number {
        switch (flag) {
          case true: return 1;
          case false: return 0;
        }
        return -1;
      }
    `);
    expect(exports.test(true)).toBe(1);
    expect(exports.test(false)).toBe(0);
  });

  it("switch with default only", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        switch (42) {
          default: return 99;
        }
      }
    `);
    expect(exports.test()).toBe(99);
  });

  it("switch with empty cases and fallthrough", async () => {
    const exports = await compileAndRun(`
      export function test(x: number): number {
        let result = 0;
        switch (x) {
          case 1:
          case 2:
          case 3:
            result = 100;
            break;
          case 4:
            result = 200;
            break;
          default:
            result = -1;
        }
        return result;
      }
    `);
    expect(exports.test(1)).toBe(100);
    expect(exports.test(2)).toBe(100);
    expect(exports.test(3)).toBe(100);
    expect(exports.test(4)).toBe(200);
    expect(exports.test(5)).toBe(-1);
  });

  it("switch with negative case values", async () => {
    const exports = await compileAndRun(`
      export function test(x: number): number {
        switch (x) {
          case -1: return 10;
          case 0: return 20;
          case 1: return 30;
          default: return -1;
        }
      }
    `);
    expect(exports.test(-1)).toBe(10);
    expect(exports.test(0)).toBe(20);
    expect(exports.test(1)).toBe(30);
  });

  // test262 S12.11_A1_T1 pattern: default in middle with cases after default
  it("fallthrough with default in middle and case after default", async () => {
    const exports = await compileAndRun(`
      export function switchTest(value: number): number {
        let result = 0;
        switch(value) {
          case 0:
            result += 2;
          case 1:
            result += 4;
            break;
          case 2:
            result += 8;
          case 3:
            result += 16;
          default:
            result += 32;
            break;
          case 4:
            result += 64;
        }
        return result;
      }
    `);
    expect(exports.switchTest(0)).toBe(6);   // 2 + 4
    expect(exports.switchTest(1)).toBe(4);   // 4
    expect(exports.switchTest(2)).toBe(56);  // 8 + 16 + 32
    expect(exports.switchTest(3)).toBe(48);  // 16 + 32
    expect(exports.switchTest(4)).toBe(64);  // 64
    expect(exports.switchTest(5)).toBe(32);  // default: 32
  });

  // test262 S12.11_A1_T3 pattern: switch with expression case (2+3)
  it("switch with expression case values like 2+3", async () => {
    const exports = await compileAndRun(`
      export function switchTest(value: number): number {
        let result = 0;
        switch(value) {
          case 0:
            result += 2;
          case 1:
            result += 4;
            break;
          case 2:
            result += 8;
          case 3:
            result += 16;
          default:
            result += 32;
            break;
          case 2+3:
            result += 512;
            break;
        }
        return result;
      }
    `);
    expect(exports.switchTest(0)).toBe(6);   // 2 + 4
    expect(exports.switchTest(1)).toBe(4);   // 4
    expect(exports.switchTest(2)).toBe(56);  // 8 + 16 + 32
    expect(exports.switchTest(3)).toBe(48);  // 16 + 32
    expect(exports.switchTest(5)).toBe(512); // 2+3=5, matches
  });

  it("switch on comparison result (i32) with boolean cases", async () => {
    const exports = await compileAndRun(`
      export function test(a: number, b: number): number {
        switch (a > b) {
          case true: return 1;
          case false: return 0;
        }
        return -1;
      }
    `);
    expect(exports.test(5, 3)).toBe(1);
    expect(exports.test(3, 5)).toBe(0);
  });

  // Closures inside switch case bodies (tests the collectDeclaredFuncRefs fix)
  it("arrow function inside switch case", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let multiplier: number = 3;
        let result: number = 0;
        switch (1 as number) {
          case 1: {
            let fn = (x: number): number => x * multiplier;
            result = fn(7);
            break;
          }
        }
        return result;
      }
    `);
    expect(exports.test()).toBe(21);
  });

  it("function declaration inside switch case", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let val: number = 0;
        switch (2 as number) {
          case 1:
            val = 10;
            break;
          case 2: {
            function helper(): number { return 42; }
            val = helper();
            break;
          }
          default:
            val = -1;
        }
        return val;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("closure capturing outer variable inside switch case", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        switch (1 as number) {
          case 1: {
            let val: number = 55;
            let fn = (): number => val;
            return fn();
          }
        }
        return 0;
      }
    `);
    expect(exports.test()).toBe(55);
  });

  it("let declarations in switch cases", async () => {
    const exports = await compileAndRun(`
      export function test(x: number): number {
        switch (x) {
          case 1: {
            let a = 10;
            return a;
          }
          case 2: {
            let a = 20;
            return a;
          }
          default: return 0;
        }
      }
    `);
    expect(exports.test(1)).toBe(10);
    expect(exports.test(2)).toBe(20);
    expect(exports.test(3)).toBe(0);
  });
});
