/**
 * Issue #686 — Closure capture type preservation
 *
 * Verifies that mutable closure captures use concrete-typed ref cells
 * (e.g., (mut f64), (mut i32)) instead of widening to externref,
 * and that read-only captures pass values directly without ref cells.
 */
import { describe, it, expect } from "vitest";
import { compile, compileToWat } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(src: string): Promise<number> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors.map((e) => e.message).join(", "));
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports.test as Function)();
}

describe("#686 Closure capture type preservation", () => {
  it("mutable f64 capture uses typed ref cell", () => {
    const wat = compileToWat(`
      export function test(): number {
        let count = 0;
        const inc = () => { count++; return count; };
        inc(); inc();
        return count;
      }
    `);
    // Should have __ref_cell_f64, NOT __ref_cell_externref
    expect(wat).toContain("__ref_cell_f64");
    expect(wat).not.toMatch(/__ref_cell_externref/);
  });

  it("mutable i32 (boolean) capture uses typed ref cell", () => {
    const wat = compileToWat(`
      export function test(): number {
        let flag = false;
        const toggle = () => { flag = !flag; };
        toggle();
        return flag ? 1 : 0;
      }
    `);
    expect(wat).toContain("__ref_cell_i32");
    expect(wat).not.toMatch(/__ref_cell_externref/);
  });

  it("read-only capture does not use ref cell", () => {
    const wat = compileToWat(`
      export function test(): number {
        const x = 42;
        const fn = () => x + 1;
        return fn();
      }
    `);
    expect(wat).not.toContain("ref_cell");
  });

  it("mutable f64 capture — counter works correctly", async () => {
    const result = await run(`
      export function test(): number {
        let count = 0;
        const inc = () => { count++; return count; };
        const a = inc();
        const b = inc();
        return a + b; // 1 + 2 = 3
      }
    `);
    expect(result).toBe(3);
  });

  it("nested closure with mutable capture", async () => {
    const result = await run(`
      export function test(): number {
        function makeCounter(start: number): () => number {
          let count = start;
          return () => { count++; return count; };
        }
        const c1 = makeCounter(0);
        const c2 = makeCounter(10);
        return c1() + c2() + c1(); // 1 + 11 + 2 = 14
      }
    `);
    expect(result).toBe(14);
  });

  it("boolean capture toggle", async () => {
    const result = await run(`
      export function test(): number {
        let flag = false;
        const toggle = () => { flag = !flag; return flag; };
        toggle(); toggle(); toggle();
        return flag ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("compound assignment through ref cell", async () => {
    const result = await run(`
      export function test(): number {
        let sum = 0;
        const add = (n: number) => { sum += n; };
        add(1); add(2); add(3); add(4); add(5);
        return sum; // 15
      }
    `);
    expect(result).toBe(15);
  });

  it("closure with comparison on captured value", async () => {
    const result = await run(`
      export function test(): number {
        let count = 0;
        const inc = () => {
          count++;
          if (count > 2) return -1;
          return count;
        };
        return inc() + inc() + inc(); // 1 + 2 + (-1) = 2
      }
    `);
    expect(result).toBe(2);
  });

  it("generator with captured counter", async () => {
    const result = await run(`
      export function test(): number {
        function* gen() {
          let count = 0;
          while (count < 3) { count++; yield count; }
        }
        const g = gen();
        let sum = 0;
        let r = g.next();
        while (!r.done) { sum += r.value; r = g.next(); }
        return sum; // 6
      }
    `);
    expect(result).toBe(6);
  });
});
