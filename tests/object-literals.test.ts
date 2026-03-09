import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any)[fn](...args);
}

// ── Basic object literals ──────────────────────────────────────────────

describe("object literals", () => {
  it("simple numeric fields", async () => {
    expect(
      await run(
        `
      function make(): { x: number; y: number } {
        return { x: 10, y: 20 };
      }
      export function test(): number {
        const p = make();
        return p.x + p.y;
      }
    `,
        "test",
      ),
    ).toBe(30);
  });

  it("inline object literal without intermediate variable", async () => {
    expect(
      await run(
        `
      function sum(p: { a: number; b: number }): number {
        return p.a + p.b;
      }
      export function test(): number {
        return sum({ a: 3, b: 7 });
      }
    `,
        "test",
      ),
    ).toBe(10);
  });

  it("nested object literals", async () => {
    expect(
      await run(
        `
      function getAge(data: { user: { age: number } }): number {
        return data.user.age;
      }
      export function test(): number {
        return getAge({ user: { age: 30 } });
      }
    `,
        "test",
      ),
    ).toBe(30);
  });

  it("object literal assigned to variable", async () => {
    expect(
      await run(
        `
      export function test(): number {
        const config: { width: number; height: number } = { width: 800, height: 600 };
        return config.width * config.height;
      }
    `,
        "test",
      ),
    ).toBe(480000);
  });

  it("object literal with boolean field", async () => {
    expect(
      await run(
        `
      export function test(): number {
        const obj: { ok: boolean; value: number } = { ok: true, value: 42 };
        if (obj.ok) return obj.value;
        return 0;
      }
    `,
        "test",
      ),
    ).toBe(42);
  });

  it("returning object literal and accessing fields", async () => {
    expect(
      await run(
        `
      function makePoint(x: number, y: number): { x: number; y: number } {
        return { x: x, y: y };
      }
      export function test(): number {
        const p = makePoint(5, 12);
        return p.x * p.x + p.y * p.y;
      }
    `,
        "test",
      ),
    ).toBe(169);
  });
});

// ── Shorthand properties ───────────────────────────────────────────────

describe("shorthand properties", () => {
  it("shorthand property assignment", async () => {
    expect(
      await run(
        `
      export function test(): number {
        const x = 10;
        const y = 20;
        const p: { x: number; y: number } = { x, y };
        return p.x + p.y;
      }
    `,
        "test",
      ),
    ).toBe(30);
  });

  it("mixed shorthand and explicit properties", async () => {
    expect(
      await run(
        `
      export function test(): number {
        const a = 5;
        const obj: { a: number; b: number; c: number } = { a, b: 10, c: 15 };
        return obj.a + obj.b + obj.c;
      }
    `,
        "test",
      ),
    ).toBe(30);
  });
});

// ── Object spread ──────────────────────────────────────────────────────

describe("object spread", () => {
  it("spread copies all fields", async () => {
    expect(
      await run(
        `
      export function test(): number {
        const a: { x: number; y: number } = { x: 1, y: 2 };
        const b: { x: number; y: number } = { ...a };
        return b.x + b.y;
      }
    `,
        "test",
      ),
    ).toBe(3);
  });

  it("spread with additional fields", async () => {
    expect(
      await run(
        `
      export function test(): number {
        const a: { x: number; y: number } = { x: 1, y: 2 };
        const b: { x: number; y: number; z: number } = { ...a, z: 3 };
        return b.x + b.y + b.z;
      }
    `,
        "test",
      ),
    ).toBe(6);
  });

  it("spread with field override", async () => {
    expect(
      await run(
        `
      export function test(): number {
        const a: { x: number; y: number } = { x: 1, y: 2 };
        const b: { x: number; y: number } = { ...a, x: 99 };
        return b.x + b.y;
      }
    `,
        "test",
      ),
    ).toBe(101);
  });

  it("multiple spreads — last wins", async () => {
    expect(
      await run(
        `
      export function test(): number {
        const a: { x: number; y: number } = { x: 1, y: 2 };
        const b: { x: number; y: number } = { x: 10, y: 20 };
        const c: { x: number; y: number } = { ...a, ...b };
        return c.x + c.y;
      }
    `,
        "test",
      ),
    ).toBe(30);
  });
});

// ── Structural typing ──────────────────────────────────────────────────

describe("structural typing", () => {
  it("interface satisfied by object literal", async () => {
    expect(
      await run(
        `
      interface Point { x: number; y: number }
      function dist(p: Point): number {
        return p.x * p.x + p.y * p.y;
      }
      export function test(): number {
        return dist({ x: 3, y: 4 });
      }
    `,
        "test",
      ),
    ).toBe(25);
  });

  it("type alias satisfied by object literal", async () => {
    expect(
      await run(
        `
      type Config = { width: number; height: number };
      function area(c: Config): number {
        return c.width * c.height;
      }
      export function test(): number {
        return area({ width: 10, height: 5 });
      }
    `,
        "test",
      ),
    ).toBe(50);
  });

  it("same shape reuses struct type", async () => {
    expect(
      await run(
        `
      function sumXY(p: { x: number; y: number }): number {
        return p.x + p.y;
      }
      export function test(): number {
        const a = sumXY({ x: 1, y: 2 });
        const b = sumXY({ x: 10, y: 20 });
        return a + b;
      }
    `,
        "test",
      ),
    ).toBe(33);
  });

  it("interface used across multiple functions", async () => {
    expect(
      await run(
        `
      interface Vec2 { x: number; y: number }
      function add(a: Vec2, b: Vec2): Vec2 {
        return { x: a.x + b.x, y: a.y + b.y };
      }
      function dot(a: Vec2, b: Vec2): number {
        return a.x * b.x + a.y * b.y;
      }
      export function test(): number {
        const sum = add({ x: 1, y: 2 }, { x: 3, y: 4 });
        return dot(sum, { x: 1, y: 1 });
      }
    `,
        "test",
      ),
    ).toBe(10);
  });
});

// ── Object literals with classes ───────────────────────────────────────

describe("object literals with classes", () => {
  it("object literal field holding a number from class", async () => {
    expect(
      await run(
        `
      class Counter {
        value: number;
        constructor(v: number) { this.value = v; }
        get(): number { return this.value; }
      }
      export function test(): number {
        const c = new Counter(42);
        const obj: { result: number } = { result: c.get() };
        return obj.result;
      }
    `,
        "test",
      ),
    ).toBe(42);
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────

describe("object literal edge cases", () => {
  it("single-field object", async () => {
    expect(
      await run(
        `
      export function test(): number {
        const obj: { val: number } = { val: 77 };
        return obj.val;
      }
    `,
        "test",
      ),
    ).toBe(77);
  });

  it("many fields", async () => {
    expect(
      await run(
        `
      export function test(): number {
        const obj: { a: number; b: number; c: number; d: number; e: number } = {
          a: 1, b: 2, c: 3, d: 4, e: 5,
        };
        return obj.a + obj.b + obj.c + obj.d + obj.e;
      }
    `,
        "test",
      ),
    ).toBe(15);
  });

  it("object literal in conditional", async () => {
    expect(
      await run(
        `
      function pick(flag: boolean): { v: number } {
        if (flag) return { v: 1 };
        return { v: 2 };
      }
      export function test(): number {
        return pick(true).v + pick(false).v;
      }
    `,
        "test",
      ),
    ).toBe(3);
  });

  it("object literal passed to function and returned", async () => {
    expect(
      await run(
        `
      function identity(p: { x: number; y: number }): { x: number; y: number } {
        return p;
      }
      export function test(): number {
        const r = identity({ x: 5, y: 10 });
        return r.x + r.y;
      }
    `,
        "test",
      ),
    ).toBe(15);
  });
});
