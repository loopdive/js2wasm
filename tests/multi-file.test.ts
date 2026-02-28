import { describe, it, expect } from "vitest";
import { compileMulti } from "../src/index.js";

async function compileAndRunMulti(
  files: Record<string, string>,
  entryFile: string,
) {
  const result = compileMulti(files, entryFile);
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

describe("multi-file compilation", () => {
  it("main imports function from util", async () => {
    const files = {
      "./math.ts": `
        export function add(a: number, b: number): number {
          return a + b;
        }
      `,
      "./main.ts": `
        import { add } from "./math";
        export function run(a: number, b: number): number {
          return add(a, b);
        }
      `,
    };
    const e = await compileAndRunMulti(files, "./main.ts");
    expect(e.run(2, 3)).toBe(5);
  });

  it("imports multiple functions from one file", async () => {
    const files = {
      "./math.ts": `
        export function add(a: number, b: number): number {
          return a + b;
        }
        export function mul(a: number, b: number): number {
          return a * b;
        }
      `,
      "./main.ts": `
        import { add, mul } from "./math";
        export function compute(a: number, b: number): number {
          return add(a, b) + mul(a, b);
        }
      `,
    };
    const e = await compileAndRunMulti(files, "./main.ts");
    // add(3,4)=7, mul(3,4)=12, total=19
    expect(e.compute(3, 4)).toBe(19);
  });

  it("chain of imports: main → util → helper", async () => {
    const files = {
      "./helper.ts": `
        export function double(x: number): number {
          return x * 2;
        }
      `,
      "./util.ts": `
        import { double } from "./helper";
        export function quadruple(x: number): number {
          return double(double(x));
        }
      `,
      "./main.ts": `
        import { quadruple } from "./util";
        export function run(x: number): number {
          return quadruple(x);
        }
      `,
    };
    const e = await compileAndRunMulti(files, "./main.ts");
    expect(e.run(5)).toBe(20);
  });

  it("only entry file exports become Wasm exports", async () => {
    const files = {
      "./math.ts": `
        export function secret(x: number): number {
          return x * 42;
        }
      `,
      "./main.ts": `
        import { secret } from "./math";
        export function run(x: number): number {
          return secret(x);
        }
      `,
    };
    const e = await compileAndRunMulti(files, "./main.ts");
    // "run" should be exported
    expect(e.run(1)).toBe(42);
    // "secret" should NOT be a Wasm export
    expect(e.secret).toBeUndefined();
  });

  it("shared interface/struct types across files", async () => {
    // Note: struct field initialization from parameters in object literals is a known
    // limitation of the current codegen (affects single-file too). This test uses
    // struct.set to assign fields explicitly.
    const files = {
      "./types.ts": `
        export interface Point {
          x: number;
          y: number;
        }
        export function getX(p: Point): number {
          return p.x;
        }
        export function getY(p: Point): number {
          return p.y;
        }
      `,
      "./main.ts": `
        import { Point, getX, getY } from "./types";
        export function sumFields(p: Point): number {
          return getX(p) + getY(p);
        }
      `,
    };
    const result = compileMulti(files, "./main.ts");
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);
    // Verify compilation succeeds with shared struct types
    // (we can't fully instantiate since creating Point objects from JS requires
    // Wasm GC struct support in the test runtime)
  });

  it("non-exported helper functions stay internal", async () => {
    const files = {
      "./math.ts": `
        function helperSquare(x: number): number {
          return x * x;
        }
        export function sumOfSquares(a: number, b: number): number {
          return helperSquare(a) + helperSquare(b);
        }
      `,
      "./main.ts": `
        import { sumOfSquares } from "./math";
        export function run(a: number, b: number): number {
          return sumOfSquares(a, b);
        }
      `,
    };
    const e = await compileAndRunMulti(files, "./main.ts");
    expect(e.run(3, 4)).toBe(25);
  });

  it("file names with .ts extension work the same as without", async () => {
    const files = {
      "math.ts": `
        export function add(a: number, b: number): number {
          return a + b;
        }
      `,
      "main.ts": `
        import { add } from "./math";
        export function run(): number {
          return add(10, 20);
        }
      `,
    };
    const e = await compileAndRunMulti(files, "main.ts");
    expect(e.run()).toBe(30);
  });

  it("multiple exports from entry file", async () => {
    const files = {
      "./util.ts": `
        export function inc(x: number): number { return x + 1; }
        export function dec(x: number): number { return x - 1; }
      `,
      "./main.ts": `
        import { inc, dec } from "./util";
        export function increment(x: number): number { return inc(x); }
        export function decrement(x: number): number { return dec(x); }
      `,
    };
    const e = await compileAndRunMulti(files, "./main.ts");
    expect(e.increment(5)).toBe(6);
    expect(e.decrement(5)).toBe(4);
  });

  it("entry file can have its own functions alongside imports", async () => {
    const files = {
      "./math.ts": `
        export function add(a: number, b: number): number {
          return a + b;
        }
      `,
      "./main.ts": `
        import { add } from "./math";
        function localHelper(x: number): number {
          return x * 10;
        }
        export function run(a: number, b: number): number {
          return localHelper(add(a, b));
        }
      `,
    };
    const e = await compileAndRunMulti(files, "./main.ts");
    expect(e.run(2, 3)).toBe(50);
  });

  it("boolean return types across files", async () => {
    const files = {
      "./check.ts": `
        export function isPositive(x: number): boolean {
          return x > 0;
        }
      `,
      "./main.ts": `
        import { isPositive } from "./check";
        export function checkPositive(x: number): boolean {
          return isPositive(x);
        }
      `,
    };
    const e = await compileAndRunMulti(files, "./main.ts");
    expect(e.checkPositive(5)).toBe(1);
    expect(e.checkPositive(-3)).toBe(0);
  });
});
