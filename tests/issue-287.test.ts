import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

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

function collectAll(gen: any): any[] {
  const values: any[] = [];
  let result = gen.next();
  while (!result.done) {
    values.push(result.value);
    result = gen.next();
  }
  return values;
}

describe("issue-287: generator yield in nested contexts", () => {
  it("yield with early return in conditional", async () => {
    const { exports } = await compileAndRun(`
      export function* earlyReturn(n: number): Generator<number> {
        for (let i = 0; i < n; i++) {
          yield i;
          if (i >= 2) {
            return;
          }
        }
      }
    `);
    expect(collectAll((exports.earlyReturn as Function)(10))).toEqual([0, 1, 2]);
  }, 30000);

  it("yield inside if/else branches", async () => {
    const { exports } = await compileAndRun(`
      export function* test(flag: boolean): Generator<number> {
        if (flag) {
          yield 1;
        } else {
          yield 2;
        }
        yield 3;
      }
    `);
    expect(collectAll((exports.test as Function)(true))).toEqual([1, 3]);
    expect(collectAll((exports.test as Function)(false))).toEqual([2, 3]);
  }, 30000);

  it("yield inside nested for loops", async () => {
    const { exports } = await compileAndRun(`
      export function* nested(): Generator<number> {
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 2; j++) {
            yield i * 10 + j;
          }
        }
      }
    `);
    expect(collectAll((exports.nested as Function)())).toEqual([0, 1, 10, 11, 20, 21]);
  }, 30000);

  it("multiple yields at different nesting levels", async () => {
    const { exports } = await compileAndRun(`
      export function* multiLevel(): Generator<number> {
        yield 1;
        for (let i = 2; i <= 3; i++) {
          yield i;
          if (i === 3) {
            yield 100;
          }
        }
        yield 4;
      }
    `);
    expect(collectAll((exports.multiLevel as Function)())).toEqual([1, 2, 3, 100, 4]);
  }, 30000);

  it("yield inside do-while loop", async () => {
    const { exports } = await compileAndRun(`
      export function* doWhileGen(n: number): Generator<number> {
        let i: number = 0;
        do {
          yield i;
          i = i + 1;
        } while (i < n);
      }
    `);
    expect(collectAll((exports.doWhileGen as Function)(3))).toEqual([0, 1, 2]);
  }, 30000);
});
