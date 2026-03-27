import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(src: string): Promise<number> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors.map((e) => e.message).join("; "));
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports.test as Function)();
}

describe("arguments object (#323)", () => {
  it("arguments.length returns parameter count", async () => {
    const result = await run(`
      function foo(a: number, b: number): number {
        return arguments.length;
      }
      export function test(): number {
        return foo(1, 2) === 2 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("arguments[0] returns first parameter value", async () => {
    const result = await run(`
      function foo(a: number, b: number): number {
        return arguments[0] as number;
      }
      export function test(): number {
        return foo(42, 99) === 42 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("arguments[1] returns second parameter value", async () => {
    const result = await run(`
      function foo(a: number, b: number): number {
        return arguments[1] as number;
      }
      export function test(): number {
        return foo(42, 99) === 99 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("arguments works in function expressions", async () => {
    const result = await run(`
      export function test(): number {
        const foo = function(a: number, b: number): number {
          return arguments.length;
        };
        return foo(1, 2) === 2 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("arguments[i] matches parameter values", async () => {
    const result = await run(`
      function foo(a: number, b: number): boolean {
        return arguments[0] === a && arguments[1] === b;
      }
      export function test(): number {
        return foo(10, 20) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("arrow function inherits enclosing function's arguments", async () => {
    const result = await run(`
      function outer(a: number, b: number): number {
        const inner = () => arguments.length;
        return inner();
      }
      export function test(): number {
        return outer(10, 20) === 2 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("arrow inside function expression inherits arguments", async () => {
    const result = await run(`
      export function test(): number {
        const foo = function(a: number, b: number): number {
          const inner = () => arguments.length;
          return inner();
        };
        return foo(10, 20) === 2 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("nested arrow chain inherits outer function arguments", async () => {
    const result = await run(`
      function outer(x: number): number {
        const a = () => {
          const b = () => arguments[0] as number;
          return b();
        };
        return a();
      }
      export function test(): number {
        return outer(42) === 42 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("arguments.length with 3 params", async () => {
    const result = await run(`
      function foo(a: number, b: number, c: number): number {
        return arguments.length;
      }
      export function test(): number {
        return foo(1, 2, 3) === 3 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });
});
