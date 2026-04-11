import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(src: string): Promise<number> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  const anyImports = imports as unknown as { setExports?: (e: unknown) => void };
  if (anyImports.setExports) anyImports.setExports(instance.exports);
  return (instance.exports as { test: () => number }).test();
}

describe("createMathOperation closure ref (#1063)", () => {
  it("inlined factory returning a closure emits fresh ref.func per copy", async () => {
    // Regression: the outer `make` is short enough to be inlined at the
    // module-init call site. Before the fix, `ref.func` and `struct.new`
    // Instr objects were shared between `make.body` and the inlined copy
    // inside `__module_init`, and dead-elimination double-remapped the same
    // object — producing `ref.func 0` (undeclared reference to an import).
    const src = `
      type Op = (v: number) => number;
      function make(op: Op): (v: number) => number {
        return function (v: number): number { return op(v); };
      }
      function double(x: number): number { return x * 2; }
      const f = make(double);
      export function test(): number {
        return f(21);
      }
    `;
    expect(await run(src)).toBe(42);
  });

  it("typed createMathOperation factory returns a working closure", async () => {
    const src = `
      type BinOp = (a: number, b: number) => number;
      function createMathOperation(operator: BinOp, defaultValue: number) {
        return function (value: number, other: number): number {
          if (value === undefined && other === undefined) return defaultValue;
          if (value === undefined) return other;
          if (other === undefined) return value;
          return operator(value, other);
        };
      }
      function addOp(a: number, b: number): number { return a + b; }
      const add = createMathOperation(addOp, 0);
      export function test(): number {
        return add(6, 7);
      }
    `;
    expect(await run(src)).toBe(13);
  });

  it("two separate inlined closures in module-init don't collide", async () => {
    const src = `
      type Op = (v: number) => number;
      function wrap(op: Op): (v: number) => number {
        return function (v: number): number { return op(v); };
      }
      function dbl(x: number): number { return x * 2; }
      function neg(x: number): number { return -x; }
      const a = wrap(dbl);
      const b = wrap(neg);
      export function test(): number {
        return a(5) + b(3);
      }
    `;
    // 5*2 + (-3) = 7
    expect(await run(src)).toBe(7);
  });
});
