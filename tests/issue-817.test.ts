/**
 * Issue #817: let/const declarations inside loop bodies must not leak
 * into the outer scope. When a for/while/do-while loop body is a block,
 * the compiler was inlining the block statements without saving/restoring
 * block-scoped name shadows, causing let/const variables to overwrite
 * outer parameters or variables with the same name.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<number> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as any).test();
}

describe("issue-817: loop body let scoping", () => {
  it("for loop: let x inside body should not shadow parameter x", async () => {
    const result = await run(`
      export function test(): number {
        function f(x: number): number {
          for (var i = 0; i < 3; i = i + 1) {
            let x: number = 99;
          }
          return x;
        }
        return f(42);
      }
    `);
    expect(result).toBe(42);
  });

  it("while loop: let x inside body should not shadow outer x", async () => {
    const result = await run(`
      export function test(): number {
        function f(x: number): number {
          var i: number = 0;
          while (i < 3) {
            let x: number = 99;
            i = i + 1;
          }
          return x;
        }
        return f(42);
      }
    `);
    expect(result).toBe(42);
  });

  it("do-while loop: let x inside body should not shadow outer x", async () => {
    const result = await run(`
      export function test(): number {
        function f(x: number): number {
          var i: number = 0;
          do {
            let x: number = 99;
            i = i + 1;
          } while (i < 3);
          return x;
        }
        return f(42);
      }
    `);
    expect(result).toBe(42);
  });

  it("nested for loops: each let scoped independently", async () => {
    const result = await run(`
      export function test(): number {
        function f(x: number): number {
          for (var i = 0; i < 2; i = i + 1) {
            let x: number = 10;
            for (var j = 0; j < 2; j = j + 1) {
              let x: number = 20;
            }
          }
          return x;
        }
        return f(42);
      }
    `);
    expect(result).toBe(42);
  });

  it("for loop with string let variable", async () => {
    const result = await run(`
      export function test(): number {
        function f(x: string): number {
          for (var i = 0; i < 3; i = i + 1) {
            let x: string = 'inner';
          }
          if (x === 'outer') return 1;
          return 0;
        }
        return f('outer');
      }
    `);
    expect(result).toBe(1);
  });

  it("try block: let x inside try should not shadow outer x in catch", async () => {
    const result = await run(`
      export function test(): number {
        function f(x: number): number {
          try {
            let x: number = 99;
            throw 0;
          } catch (e) {
            return x;
          }
          return 0;
        }
        return f(42);
      }
    `);
    expect(result).toBe(42);
  });

  it("plain block let still works (baseline)", async () => {
    const result = await run(`
      export function test(): number {
        function f(x: number): number {
          {
            let x: number = 99;
          }
          return x;
        }
        return f(42);
      }
    `);
    expect(result).toBe(42);
  });
});
