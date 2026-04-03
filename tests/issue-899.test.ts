/**
 * Issue #899: Extend compile-time TDZ elimination to provably safe closure captures
 *
 * Tests that TDZ checks are correctly skipped for closures defined after variable
 * initialization, and preserved for genuinely unsafe cross-function cases.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(src: string): Promise<number> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`CE: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports.test as () => number)();
}

function compileOnly(src: string) {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`CE: ${r.errors[0]?.message}`);
  return r;
}

describe("Issue #899: TDZ elimination for closure captures", () => {
  it("safe nested function call after let init returns correct value", async () => {
    const result = await run(`
      export function test(): number {
        let x: number = 42;
        function inner(): number { return x; }
        return inner();
      }
    `);
    expect(result).toBe(42);
  });

  it("safe multi-capture nested function", async () => {
    const result = await run(`
      export function test(): number {
        let x: number = 10;
        let y: number = 20;
        function sum(): number { return x + y; }
        return sum();
      }
    `);
    expect(result).toBe(30);
  });

  it("unsafe call before let init throws TDZ error", async () => {
    await expect(
      run(`
        export function test(): number {
          function inner(): number { return x; }
          const result = inner();
          let x: number = 42;
          return result;
        }
      `),
    ).rejects.toThrow();
  });

  it("arrow function defined after let init works without TDZ check", async () => {
    const result = await run(`
      export function test(): number {
        let x: number = 42;
        const f = (): number => x;
        return f();
      }
    `);
    expect(result).toBe(42);
  });

  it("function expression defined after let init works", async () => {
    const result = await run(`
      export function test(): number {
        let x: number = 42;
        const f = function(): number { return x; };
        return f();
      }
    `);
    expect(result).toBe(42);
  });

  it("mutable capture through nested function", async () => {
    const result = await run(`
      export function test(): number {
        let x: number = 0;
        function inc(): void { x = x + 1; }
        inc();
        inc();
        inc();
        return x;
      }
    `);
    expect(result).toBe(3);
  });

  it("safe call-site TDZ check produces smaller binary (no TDZ check code)", () => {
    const safe = compileOnly(`
      export function test(): number {
        let x: number = 42;
        function inner(): number { return x; }
        return inner();
      }
    `);
    const unsafe = compileOnly(`
      export function test(): number {
        function inner(): number { return x; }
        const result = inner();
        let x: number = 42;
        return result;
      }
    `);
    // Safe should be smaller (no TDZ check instructions)
    expect(safe.binary.length).toBeLessThan(unsafe.binary.length);
  });
});
