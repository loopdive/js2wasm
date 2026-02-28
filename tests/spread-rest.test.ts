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

// ── Rest parameters ────────────────────────────────────────────────────

describe("rest parameters", () => {
  it("sum with rest params", async () => {
    const e = await compileAndRun(`
      function sum(...nums: number[]): number {
        let total = 0;
        for (const n of nums) total = total + n;
        return total;
      }
      export function test(): number {
        return sum(1, 2, 3);
      }
    `);
    expect(e.test()).toBe(6);
  });

  it("rest params with leading normal params", async () => {
    const e = await compileAndRun(`
      function add(base: number, ...extras: number[]): number {
        let total = base;
        for (const n of extras) total = total + n;
        return total;
      }
      export function test(): number {
        return add(10, 1, 2, 3);
      }
    `);
    expect(e.test()).toBe(16);
  });

  it("rest params with no trailing args", async () => {
    const e = await compileAndRun(`
      function add(base: number, ...extras: number[]): number {
        let total = base;
        for (const n of extras) total = total + n;
        return total;
      }
      export function test(): number {
        return add(42);
      }
    `);
    expect(e.test()).toBe(42);
  });

  it("rest params array length", async () => {
    const e = await compileAndRun(`
      function count(...items: number[]): number {
        return items.length;
      }
      export function test(): number {
        return count(10, 20, 30, 40);
      }
    `);
    expect(e.test()).toBe(4);
  });
});

// ── Array spread ───────────────────────────────────────────────────────

describe("array spread", () => {
  it("spread into array literal", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const a = [1, 2];
        const b = [...a, 3, 4];
        return b[0] + b[1] + b[2] + b[3];
      }
    `);
    expect(e.test()).toBe(10);
  });

  it("spread at end of array", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const a = [3, 4];
        const b = [1, 2, ...a];
        return b[0] + b[1] + b[2] + b[3];
      }
    `);
    expect(e.test()).toBe(10);
  });

  it("spread array length is correct", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const a = [10, 20, 30];
        const b = [...a, 40];
        return b.length;
      }
    `);
    expect(e.test()).toBe(4);
  });

  it("spread empty array", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const a: number[] = [];
        const b = [1, ...a, 2];
        return b[0] + b[1];
      }
    `);
    expect(e.test()).toBe(3);
  });
});

// ── Object spread ──────────────────────────────────────────────────────

describe("object spread", () => {
  it("copy struct via spread", async () => {
    const e = await compileAndRun(`
      interface Point { x: number; y: number }
      export function test(): number {
        const p: Point = { x: 3, y: 4 };
        const p2: Point = { ...p };
        return p2.x + p2.y;
      }
    `);
    expect(e.test()).toBe(7);
  });

  it("spread with override", async () => {
    const e = await compileAndRun(`
      interface Point { x: number; y: number }
      export function test(): number {
        const p: Point = { x: 3, y: 4 };
        const p2: Point = { ...p, x: 10 };
        return p2.x + p2.y;
      }
    `);
    expect(e.test()).toBe(14);
  });

  it("spread preserves original", async () => {
    const e = await compileAndRun(`
      interface Point { x: number; y: number }
      export function test(): number {
        const p: Point = { x: 1, y: 2 };
        const p2: Point = { ...p, x: 99 };
        return p.x;
      }
    `);
    expect(e.test()).toBe(1);
  });
});

// ── Spread in function calls ───────────────────────────────────────────

describe("spread in function calls", () => {
  it("spread array into rest param function", async () => {
    const e = await compileAndRun(`
      function sum(...nums: number[]): number {
        let total = 0;
        for (const n of nums) total = total + n;
        return total;
      }
      export function test(): number {
        const args = [1, 2, 3];
        return sum(...args);
      }
    `);
    expect(e.test()).toBe(6);
  });

  it("spread array into positional params", async () => {
    const e = await compileAndRun(`
      function add(a: number, b: number, c: number): number {
        return a + b + c;
      }
      export function test(): number {
        const args = [10, 20, 30];
        return add(...args);
      }
    `);
    expect(e.test()).toBe(60);
  });
});
