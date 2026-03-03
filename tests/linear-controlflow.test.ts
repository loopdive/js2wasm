import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/** Compile with linear-memory backend and instantiate */
async function compileLinear(source: string) {
  const result = compile(source, { target: "linear" });
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  return instance.exports as Record<string, Function>;
}

describe("linear-controlflow: variables", () => {
  it("declares and uses local variables", async () => {
    const e = await compileLinear(`
      export function test(): number {
        let x: number = 10;
        let y: number = 20;
        return x + y;
      }
    `);
    expect(e.test()).toBe(30);
  });

  it("reassigns variables", async () => {
    const e = await compileLinear(`
      export function test(): number {
        let x: number = 5;
        x = 10;
        return x;
      }
    `);
    expect(e.test()).toBe(10);
  });

  it("compound assignment operators", async () => {
    const e = await compileLinear(`
      export function test(): number {
        let x: number = 10;
        x += 5;
        x -= 3;
        x *= 2;
        return x;
      }
    `);
    // 10 + 5 = 15, - 3 = 12, * 2 = 24
    expect(e.test()).toBe(24);
  });
});

describe("linear-controlflow: if/else", () => {
  it("if without else", async () => {
    const e = await compileLinear(`
      export function abs(x: number): number {
        if (x < 0) {
          return -x;
        }
        return x;
      }
    `);
    expect(e.abs(-5)).toBe(5);
    expect(e.abs(3)).toBe(3);
  });

  it("if with else", async () => {
    const e = await compileLinear(`
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

  it("nested if/else", async () => {
    const e = await compileLinear(`
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
    expect(e.classify(200)).toBe(2);
    expect(e.classify(-5)).toBe(0);
  });
});

describe("linear-controlflow: while loops", () => {
  it("simple while loop", async () => {
    const e = await compileLinear(`
      export function sum(n: number): number {
        let result: number = 0;
        let i: number = 1;
        while (i <= n) {
          result += i;
          i += 1;
        }
        return result;
      }
    `);
    expect(e.sum(5)).toBe(15); // 1+2+3+4+5
    expect(e.sum(0)).toBe(0);
    expect(e.sum(1)).toBe(1);
  });

  it("while loop counting down", async () => {
    const e = await compileLinear(`
      export function countdown(n: number): number {
        let result: number = 0;
        while (n > 0) {
          result += n;
          n -= 1;
        }
        return result;
      }
    `);
    expect(e.countdown(5)).toBe(15); // 5+4+3+2+1
    expect(e.countdown(0)).toBe(0);
  });
});

describe("linear-controlflow: for loops", () => {
  it("simple for loop", async () => {
    const e = await compileLinear(`
      export function sum(n: number): number {
        let result: number = 0;
        for (let i: number = 0; i < n; i += 1) {
          result += i;
        }
        return result;
      }
    `);
    expect(e.sum(5)).toBe(10); // 0+1+2+3+4
    expect(e.sum(0)).toBe(0);
  });

  it("nested for loops", async () => {
    const e = await compileLinear(`
      export function mulTable(n: number): number {
        let total: number = 0;
        for (let i: number = 1; i <= n; i += 1) {
          for (let j: number = 1; j <= n; j += 1) {
            total += i * j;
          }
        }
        return total;
      }
    `);
    // Sum of i*j for i,j in 1..3 = (1+2+3)*(1+2+3) = 36
    expect(e.mulTable(3)).toBe(36);
  });
});

describe("linear-controlflow: comparison operators", () => {
  it("less than", async () => {
    const e = await compileLinear(`
      export function lt(a: number, b: number): number {
        if (a < b) return 1;
        return 0;
      }
    `);
    expect(e.lt(1, 2)).toBe(1);
    expect(e.lt(2, 1)).toBe(0);
    expect(e.lt(1, 1)).toBe(0);
  });

  it("greater than or equal", async () => {
    const e = await compileLinear(`
      export function gte(a: number, b: number): number {
        if (a >= b) return 1;
        return 0;
      }
    `);
    expect(e.gte(2, 1)).toBe(1);
    expect(e.gte(1, 1)).toBe(1);
    expect(e.gte(0, 1)).toBe(0);
  });

  it("equality", async () => {
    const e = await compileLinear(`
      export function eq(a: number, b: number): number {
        if (a === b) return 1;
        return 0;
      }
    `);
    expect(e.eq(5, 5)).toBe(1);
    expect(e.eq(5, 6)).toBe(0);
  });

  it("not equal", async () => {
    const e = await compileLinear(`
      export function neq(a: number, b: number): number {
        if (a !== b) return 1;
        return 0;
      }
    `);
    expect(e.neq(5, 6)).toBe(1);
    expect(e.neq(5, 5)).toBe(0);
  });
});

describe("linear-controlflow: prefix unary", () => {
  it("unary minus", async () => {
    const e = await compileLinear(`
      export function neg(x: number): number {
        return -x;
      }
    `);
    expect(e.neg(5)).toBe(-5);
    expect(e.neg(-3)).toBe(3);
    // f64.neg(0) produces -0 per IEEE 754; verify magnitude is zero
    expect(e.neg(0) === 0).toBe(true);
  });
});

describe("linear-controlflow: expression statements", () => {
  it("increment via expression statement", async () => {
    const e = await compileLinear(`
      export function test(): number {
        let x: number = 0;
        x = x + 1;
        x = x + 1;
        return x;
      }
    `);
    expect(e.test()).toBe(2);
  });
});
