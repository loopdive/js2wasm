import { describe, test, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

function compileAndRun(code: string): number {
  const result = compile(code);
  expect(result.success).toBe(true);
  const wasmModule = new WebAssembly.Module(result.binary);
  const imports = buildImports(
    WebAssembly.Module.imports(wasmModule).map((i) => ({
      module: i.module,
      name: i.name,
      kind: i.kind as any,
    })),
    undefined,
    result.stringPool,
  );
  const instance = new WebAssembly.Instance(wasmModule, imports);
  return (instance.exports as any).test();
}

describe("Static TDZ optimization (#800)", () => {
  test("access after declaration skips TDZ check", { timeout: 15000 }, () => {
    // Access is after declaration — should compile and run without TDZ check
    const val = compileAndRun(`
      export function test(): number {
        let x: number = 42;
        return x;
      }
    `);
    expect(val).toBe(42);
  });

  test("multiple sequential let/const", { timeout: 15000 }, () => {
    const val = compileAndRun(`
      export function test(): number {
        let a: number = 1;
        let b: number = 2;
        const c: number = a + b;
        return c;
      }
    `);
    expect(val).toBe(3);
  });

  test("let in for loop body works correctly", { timeout: 15000 }, () => {
    const val = compileAndRun(`
      export function test(): number {
        let sum: number = 0;
        for (let i: number = 0; i < 3; i = i + 1) {
          let val: number = i;
          sum = sum + val;
        }
        return sum;
      }
    `);
    expect(val).toBe(3);
  });

  test("let in if-else branches", { timeout: 15000 }, () => {
    const val = compileAndRun(`
      export function test(): number {
        let x: number = 10;
        let result: number = 0;
        if (x > 5) {
          let a: number = x + 1;
          result = a;
        } else {
          let b: number = x - 1;
          result = b;
        }
        return result;
      }
    `);
    expect(val).toBe(11);
  });

  test("const used in expression after declaration", { timeout: 15000 }, () => {
    const val = compileAndRun(`
      export function test(): number {
        const a: number = 7;
        const b: number = a * 2;
        const c: number = a + b;
        return c;
      }
    `);
    expect(val).toBe(21);
  });

  test("WAT output has fewer TDZ checks for simple straight-line code", { timeout: 15000 }, () => {
    // Simple straight-line code: let x = 1; return x;
    // The TDZ flag local may still be allocated by hoistLetConstWithTdz,
    // but the if/throw TDZ check should be optimized away
    const result = compile(`
      export function test(): number {
        let x: number = 42;
        return x;
      }
    `);
    expect(result.success).toBe(true);
    // The WAT should NOT contain an i32.eqz + if pattern for TDZ in the test function
    // (The TDZ flag local __tdz_x may still exist but shouldn't be checked)
    const wat = result.wat;
    // Count TDZ-related check patterns: local.get $__tdz_ followed by i32.eqz
    const tdzCheckPattern = /local\.get \$__tdz_x[\s\S]*?i32\.eqz/;
    expect(tdzCheckPattern.test(wat)).toBe(false);
  });

  test("module-level let accessed in function keeps TDZ check", { timeout: 15000 }, () => {
    // Module-level let accessed from a function must keep TDZ check
    // because the function could be called before the let runs
    const result = compile(`
      export function test(): number { return x; }
      let x: number = 1;
    `);
    expect(result.success).toBe(true);
    // Should still have TDZ flag for x
    expect(result.wat).toContain("__tdz_x");
  });
});
