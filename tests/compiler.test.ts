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
    },
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

describe("arithmetic", () => {
  it("add", async () => {
    const e = await compileAndRun(`
      export function add(a: number, b: number): number { return a + b; }
    `);
    expect(e.add(2, 3)).toBe(5);
  });

  it("subtract", async () => {
    const e = await compileAndRun(`
      export function sub(a: number, b: number): number { return a - b; }
    `);
    expect(e.sub(10, 3)).toBe(7);
  });

  it("multiply", async () => {
    const e = await compileAndRun(`
      export function mul(a: number, b: number): number { return a * b; }
    `);
    expect(e.mul(4, 5)).toBe(20);
  });

  it("divide", async () => {
    const e = await compileAndRun(`
      export function div(a: number, b: number): number { return a / b; }
    `);
    expect(e.div(10, 2)).toBe(5);
  });

  it("negate", async () => {
    const e = await compileAndRun(`
      export function neg(a: number): number { return -a; }
    `);
    expect(e.neg(5)).toBe(-5);
  });

  it("complex expression", async () => {
    const e = await compileAndRun(`
      export function calc(a: number, b: number): number {
        return (a + b) * (a - b);
      }
    `);
    expect(e.calc(5, 3)).toBe(16);
  });

  it("fibonacci", async () => {
    const e = await compileAndRun(`
      export function fib(n: number): number {
        if (n <= 1) return n;
        return fib(n - 1) + fib(n - 2);
      }
    `);
    expect(e.fib(10)).toBe(55);
  });
});

describe("control flow", () => {
  it("if/else", async () => {
    const e = await compileAndRun(`
      export function max(a: number, b: number): number {
        if (a > b) {
          return a;
        } else {
          return b;
        }
      }
    `);
    expect(e.max(3, 7)).toBe(7);
    expect(e.max(10, 2)).toBe(10);
  });

  it("while loop", async () => {
    const e = await compileAndRun(`
      export function sum(n: number): number {
        let result: number = 0;
        let i: number = 1;
        while (i <= n) {
          result = result + i;
          i = i + 1;
        }
        return result;
      }
    `);
    expect(e.sum(10)).toBe(55);
  });

  it("for loop", async () => {
    const e = await compileAndRun(`
      export function factorial(n: number): number {
        let result: number = 1;
        for (let i: number = 2; i <= n; i = i + 1) {
          result = result * i;
        }
        return result;
      }
    `);
    expect(e.factorial(5)).toBe(120);
  });

  it("ternary", async () => {
    const e = await compileAndRun(`
      export function abs(x: number): number {
        return x >= 0 ? x : -x;
      }
    `);
    expect(e.abs(-5)).toBe(5);
    expect(e.abs(3)).toBe(3);
  });
});

describe("variables", () => {
  it("let declaration with assignment", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        let x: number = 10;
        let y: number = 20;
        return x + y;
      }
    `);
    expect(e.test()).toBe(30);
  });

  it("reassignment", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        let x: number = 10;
        x = 20;
        return x;
      }
    `);
    expect(e.test()).toBe(20);
  });
});

describe("multiple functions", () => {
  it("function calling another function", async () => {
    const e = await compileAndRun(`
      export function double(x: number): number {
        return x * 2;
      }
      export function quadruple(x: number): number {
        return double(double(x));
      }
    `);
    expect(e.quadruple(3)).toBe(12);
  });
});

describe("math builtins", () => {
  it("Math.sqrt", async () => {
    const e = await compileAndRun(`
      export function test(x: number): number {
        return Math.sqrt(x);
      }
    `);
    expect(e.test(16)).toBe(4);
  });

  it("Math.abs", async () => {
    const e = await compileAndRun(`
      export function test(x: number): number {
        return Math.abs(x);
      }
    `);
    expect(e.test(-5)).toBe(5);
  });

  it("Math.floor", async () => {
    const e = await compileAndRun(`
      export function test(x: number): number {
        return Math.floor(x);
      }
    `);
    expect(e.test(3.7)).toBe(3);
  });
});

describe("binary encoder", () => {
  it("valid wasm header", () => {
    const r = compile(
      `export function id(x: number): number { return x; }`,
    );
    expect(r.binary[0]).toBe(0x00);
    expect(r.binary[1]).toBe(0x61);
    expect(r.binary[2]).toBe(0x73);
    expect(r.binary[3]).toBe(0x6d);
  });

  it("WebAssembly.validate accepts output", () => {
    const r = compile(
      `export function add(a: number, b: number): number { return a + b; }`,
    );
    expect(r.success).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });
});

describe("wat output", () => {
  it("readable", () => {
    const r = compile(
      `export function add(a: number, b: number): number { return a + b; }`,
    );
    expect(r.wat).toContain("func");
    expect(r.wat).toContain("f64.add");
    expect(r.wat).toContain("export");
  });
});
