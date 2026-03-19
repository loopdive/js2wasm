import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// Helper to compile and run a generator test with the standard runtime imports
async function compileAndRun(source: string): Promise<{
  exports: Record<string, Function>;
  instance: WebAssembly.Instance;
}> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }

  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    imports as unknown as WebAssembly.Imports,
  );
  return { exports: instance.exports as any, instance };
}

describe("yield expression in various generator contexts (#628)", () => {
  it("yield in a basic generator function declaration", async () => {
    const { exports } = await compileAndRun(`
      export function* gen(): Generator<number> {
        yield 1;
        yield 2;
        yield 3;
      }
    `);
    const g = (exports.gen as Function)();
    expect(g.next().value).toBe(1);
    expect(g.next().value).toBe(2);
    expect(g.next().value).toBe(3);
    expect(g.next().done).toBe(true);
  });

  it("yield in a generator function expression", async () => {
    const { exports } = await compileAndRun(`
      const gen = function*(): Generator<number> {
        yield 10;
        yield 20;
      };
      export function run(): number {
        const g = gen();
        let sum = 0;
        let r = g.next();
        while (!r.done) {
          sum += r.value;
          r = g.next();
        }
        return sum;
      }
    `);
    expect((exports.run as Function)()).toBe(30);
  });

  it("yield in an object literal generator method", async () => {
    const { exports } = await compileAndRun(`
      const obj = {
        *gen(): Generator<number> {
          yield 5;
          yield 15;
        }
      };
      export function run(): number {
        const g = obj.gen();
        let sum = 0;
        let r = g.next();
        while (!r.done) {
          sum += r.value;
          r = g.next();
        }
        return sum;
      }
    `);
    expect((exports.run as Function)()).toBe(20);
  });

  it("yield in a class generator method", async () => {
    const { exports } = await compileAndRun(`
      class MyClass {
        *values(): Generator<number> {
          yield 100;
          yield 200;
        }
      }
      export function run(): number {
        const obj = new MyClass();
        const g = obj.values();
        let sum = 0;
        let r = g.next();
        while (!r.done) {
          sum += r.value;
          r = g.next();
        }
        return sum;
      }
    `);
    expect((exports.run as Function)()).toBe(300);
  });

  it("yield with loop inside generator", async () => {
    const { exports } = await compileAndRun(`
      export function* range(n: number): Generator<number> {
        for (let i = 0; i < n; i++) {
          yield i;
        }
      }
    `);
    const g = (exports.range as Function)(5);
    const values: number[] = [];
    let r = g.next();
    while (!r.done) {
      values.push(r.value);
      r = g.next();
    }
    expect(values).toEqual([0, 1, 2, 3, 4]);
  });

  it("generator with conditional yield", async () => {
    const { exports } = await compileAndRun(`
      export function* evens(n: number): Generator<number> {
        for (let i = 0; i < n; i++) {
          if (i % 2 === 0) {
            yield i;
          }
        }
      }
    `);
    const g = (exports.evens as Function)(8);
    const values: number[] = [];
    let r = g.next();
    while (!r.done) {
      values.push(r.value);
      r = g.next();
    }
    expect(values).toEqual([0, 2, 4, 6]);
  });
});
