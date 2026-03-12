/**
 * Issue #280: Function expression compile errors -- name binding and hoisting
 *
 * Tests for named function expressions, closure variable assignment,
 * and various function expression patterns.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function compileAndRun(source: string) {
  const result = compile(source);
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const imports = {
    env: {
      console_log_number: () => {},
      console_log_string: () => {},
      console_log_bool: () => {},
      __make_callback: () => {},
    },
  };
  try {
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    return instance.exports as Record<string, Function>;
  } catch (e) {
    throw new Error(`Instantiation failed: ${e}\nWAT:\n${result.wat}`);
  }
}

describe("Issue #280: Function expression name binding", () => {
  it("named function expression self-reference (recursion)", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const factorial = function fact(n: number): number {
          if (n <= 1) return 1;
          return n * fact(n - 1);
        };
        return factorial(5);
      }
    `);
    expect(e.test()).toBe(120);
  });

  it("named function expression name does not leak to outer scope", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const f = function inner(n: number): number {
          if (n <= 0) return 0;
          return inner(n - 1) + 1;
        };
        return f(3);
      }
    `);
    expect(e.test()).toBe(3);
  });

  it("function expression assigned via separate assignment", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        let f: (x: number) => number;
        f = function(x: number): number { return x * 2; };
        return f(21);
      }
    `);
    expect(e.test()).toBe(42);
  });

  it("named function expression assigned via separate assignment with recursion", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        let f: (n: number) => number;
        f = function factorial(n: number): number {
          if (n <= 1) return 1;
          return n * factorial(n - 1);
        };
        return f(5);
      }
    `);
    expect(e.test()).toBe(120);
  });

  it("IIFE (immediately invoked function expression)", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        return (function(): number { return 42; })();
      }
    `);
    expect(e.test()).toBe(42);
  });

  it("multiple function expressions in same scope", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const a = function(): number { return 10; };
        const b = function(): number { return 20; };
        const c = function(): number { return 12; };
        return a() + b() + c();
      }
    `);
    expect(e.test()).toBe(42);
  });

  it("nested named function expressions", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const outer = function outerFn(): number {
          const inner = function innerFn(n: number): number {
            if (n <= 0) return 0;
            return n + innerFn(n - 1);
          };
          return inner(5);
        };
        return outer();
      }
    `);
    expect(e.test()).toBe(15);
  });

  it("function expression with closure capture", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        let x = 10;
        const f = function(): number { return x; };
        return f();
      }
    `);
    expect(e.test()).toBe(10);
  });

  it("function expression compiles without error when assigned to separate var", async () => {
    // This tests that `var ref; ref = function(a, b) { ... }; ref(...)` compiles
    // which is the most common pattern in test262 function expression tests
    const e = await compileAndRun(`
      export function test(): number {
        let callCount: number = 0;
        let ref: (a: number, b: number) => number;
        ref = function(a: number, b: number): number {
          callCount = callCount + 1;
          return a + b;
        };
        const result = ref(3, 4);
        return result + callCount;
      }
    `);
    expect(e.test()).toBe(8); // 3+4=7, callCount=1, total=8
  });

  it("named function expression with same name as variable", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const fact = function fact(n: number): number {
          if (n <= 1) return 1;
          return n * fact(n - 1);
        };
        return fact(6);
      }
    `);
    expect(e.test()).toBe(720);
  });

  it("function expression with captured parameter", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const f = function(a: number): number {
          const inner = function(): number { return a; };
          return inner() + 2;
        };
        return f(40);
      }
    `);
    expect(e.test()).toBe(42);
  });

  it("function expression with multiple parameters and no captures", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const add3 = function(a: number, b: number, c: number): number {
          return a + b + c;
        };
        return add3(10, 20, 12);
      }
    `);
    expect(e.test()).toBe(42);
  });

  it("reassigned closure variable still callable", async () => {
    // Verify that closures assigned via = can be called
    const e = await compileAndRun(`
      export function test(): number {
        let f: (x: number) => number;
        f = function(x: number): number { return x + 1; };
        return f(41);
      }
    `);
    expect(e.test()).toBe(42);
  });

  it("function expression with single param", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        let ref: (a: number) => number;
        ref = function(a: number): number {
          return a * 2;
        };
        return ref(21);
      }
    `);
    expect(e.test()).toBe(42);
  });
});
