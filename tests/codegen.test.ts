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

describe("comparison operators", () => {
  it("less than", async () => {
    const e = await compileAndRun(`
      export function lt(a: number, b: number): number {
        if (a < b) return 1;
        return 0;
      }
    `);
    expect(e.lt(1, 2)).toBe(1);
    expect(e.lt(2, 1)).toBe(0);
  });

  it("greater than", async () => {
    const e = await compileAndRun(`
      export function gt(a: number, b: number): number {
        if (a > b) return 1;
        return 0;
      }
    `);
    expect(e.gt(2, 1)).toBe(1);
    expect(e.gt(1, 2)).toBe(0);
  });

  it("equality", async () => {
    const e = await compileAndRun(`
      export function eq(a: number, b: number): number {
        if (a === b) return 1;
        return 0;
      }
    `);
    expect(e.eq(5, 5)).toBe(1);
    expect(e.eq(5, 6)).toBe(0);
  });
});

describe("nested control flow", () => {
  it("nested if", async () => {
    const e = await compileAndRun(`
      export function classify(x: number): number {
        if (x > 0) {
          if (x > 100) {
            return 2;
          }
          return 1;
        } else {
          return 0;
        }
      }
    `);
    expect(e.classify(50)).toBe(1);
    expect(e.classify(150)).toBe(2);
    expect(e.classify(-5)).toBe(0);
  });

  it("while with early return", async () => {
    const e = await compileAndRun(`
      export function isPrime(n: number): number {
        if (n <= 1) return 0;
        let i: number = 2;
        while (i * i <= n) {
          if (n - Math.floor(n / i) * i === 0) return 0;
          i = i + 1;
        }
        return 1;
      }
    `);
    expect(e.isPrime(7)).toBe(1);
    expect(e.isPrime(4)).toBe(0);
    expect(e.isPrime(13)).toBe(1);
    expect(e.isPrime(1)).toBe(0);
  });
});

describe("math operations", () => {
  it("Math.sqrt", async () => {
    const e = await compileAndRun(`
      export function hypotenuse(a: number, b: number): number {
        return Math.sqrt(a * a + b * b);
      }
    `);
    expect(e.hypotenuse(3, 4)).toBe(5);
  });

  it("Math.floor and Math.ceil", async () => {
    const e = await compileAndRun(`
      export function floorVal(x: number): number {
        return Math.floor(x);
      }
      export function ceilVal(x: number): number {
        return Math.ceil(x);
      }
    `);
    expect(e.floorVal(3.7)).toBe(3);
    expect(e.ceilVal(3.2)).toBe(4);
  });
});

describe("math host imports", () => {
  it("Math.sin and Math.cos via host import", async () => {
    const result = compile(`
      export function sinCos(x: number): number {
        return Math.sin(x) + Math.cos(x);
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    expect(result.wat).toContain("Math_sin");
    expect(result.wat).toContain("Math_cos");

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
        Math_sin: Math.sin,
        Math_cos: Math.cos,
      },
    });
    const exports = instance.exports as any;
    expect(exports.sinCos(0)).toBeCloseTo(1); // sin(0)=0, cos(0)=1
  });

  it("Math.pow via host import", async () => {
    const result = compile(`
      export function power(base: number, exp: number): number {
        return Math.pow(base, exp);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.wat).toContain("Math_pow");

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
        Math_pow: Math.pow,
      },
    });
    const exports = instance.exports as any;
    expect(exports.power(2, 10)).toBe(1024);
  });

  it("Math.exp and Math.log via host import", async () => {
    const result = compile(`
      export function expLog(x: number): number {
        return Math.log(Math.exp(x));
      }
    `);
    expect(result.success).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
        Math_exp: Math.exp,
        Math_log: Math.log,
      },
    });
    const exports = instance.exports as any;
    expect(exports.expLog(1)).toBeCloseTo(1);
  });

  it("Math.round via native f64.nearest", async () => {
    const result = compile(`
      export function roundVal(x: number): number {
        return Math.round(x);
      }
    `);
    expect(result.success).toBe(true);
    // Should NOT create a host import for round (uses f64.nearest)
    expect(result.wat).not.toContain("Math_round");

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
      },
    });
    const exports = instance.exports as any;
    expect(exports.roundVal(3.7)).toBe(4);
    expect(exports.roundVal(3.2)).toBe(3);
  });
});

describe("compound operations", () => {
  it("gcd using while and modulo substitute", async () => {
    const e = await compileAndRun(`
      export function gcd(a: number, b: number): number {
        while (b !== 0) {
          let temp: number = b;
          b = a - Math.floor(a / b) * b;
          a = temp;
        }
        return a;
      }
    `);
    expect(e.gcd(12, 8)).toBe(4);
    expect(e.gcd(15, 5)).toBe(5);
  });

  it("power function", async () => {
    const e = await compileAndRun(`
      export function pow(base: number, exp: number): number {
        let result: number = 1;
        let i: number = 0;
        while (i < exp) {
          result = result * base;
          i = i + 1;
        }
        return result;
      }
    `);
    expect(e.pow(2, 10)).toBe(1024);
  });
});
