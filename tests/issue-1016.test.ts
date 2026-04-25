import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(code: string): Promise<unknown> {
  const result = compile(code, { fileName: "test.ts" });
  if (!result.success) throw new Error(`CE: ${result.errors[0]?.message}`);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any).main();
}

describe("#1016a — class method param array destructuring defaults", () => {
  it("fires default when array element is missing (exhausted iterator)", { timeout: 30000 }, async () => {
    const result = await run(`
      class C {
        method([x = 23]: any) { return x; }
      }
      export function main(): f64 { return new C().method([]); }
    `);
    expect(result).toBe(23);
  });

  it("does NOT fire default when array element is present", async () => {
    const result = await run(`
      class C {
        method([x = 23]: any) { return x; }
      }
      export function main(): f64 { return new C().method([42]); }
    `);
    expect(result).toBe(42);
  });

  it("fires default for second element when array has only one", async () => {
    const result = await run(`
      class C {
        method([a, b = 99]: any) { return b; }
      }
      export function main(): f64 { return new C().method([1]); }
    `);
    expect(result).toBe(99);
  });

  it("does NOT fire default for null array element (null !== undefined)", async () => {
    const result = await run(`
      class C {
        method([x = 23]: any) { return x; }
      }
      export function main(): f64 { return new C().method([null]) ? 1 : 0; }
    `);
    // null is not undefined, so default should NOT fire; x should be null (falsy → 0)
    expect(result).toBe(0);
  });
});

/**
 * #1016 — Iterator protocol null access (parameter-default capture).
 *
 * When a nested function or arrow function declares a parameter default that
 * references an outer-scope variable (e.g. `function f([] = iter)`), the
 * default must be able to read that variable through the normal closure-
 * capture mechanism. Previously, parameter-default initializers were not
 * scanned during the captured-variable analysis, so the default expression
 * resolved to a null/zero value at runtime, causing spurious
 * "Cannot destructure 'null' or 'undefined'" TypeErrors.
 *
 * Spec: ECMA-262 §14.3.3 BindingInitialization for ArrayBindingPattern.
 *       For an empty `[]` pattern body the spec says "Return unused", so we
 *       must not invoke Array.from / __array_from_iter on the source value
 *       (which would observably advance a generator iterator).
 */
describe("#1016 — parameter-default closure capture & empty pattern no-iterate", () => {
  it("nested function param default reads outer-scope object", async () => {
    const result = await run(`
      export function main(): f64 {
        var iter: any = { foo: 42 };
        var callCount = 0;
        function f([] = iter): void { callCount = callCount + 1; }
        f();
        return callCount;
      }
    `);
    expect(result).toBe(1);
  });

  it("arrow function param default reads outer-scope object", async () => {
    const result = await run(`
      export function main(): f64 {
        var iter: any = { foo: 42 };
        var callCount = 0;
        var f = ([] = iter): void => { callCount = callCount + 1; };
        f();
        return callCount;
      }
    `);
    expect(result).toBe(1);
  });

  it("nested function param default delivers outer numeric value", async () => {
    const result = await run(`
      export function main(): f64 {
        var n: number = 42;
        function f(x: number = n): number { return x; }
        return f();
      }
    `);
    expect(result).toBe(42);
  });

  it("empty [] pattern as param does not iterate the source", async () => {
    // For a hand-rolled iterator with a counter, the empty pattern must NOT
    // call .next() — per spec the body is "Return unused".
    const result = await run(`
      export function main(): f64 {
        var iterCount = 0;
        var iter: any = {
          next: function() { iterCount = iterCount + 1; return { value: undefined, done: true }; },
          [Symbol.iterator]: function() { return this; }
        };
        function f([] = iter): void {}
        f();
        return iterCount;
      }
    `);
    expect(result).toBe(0);
  });

  it("empty [] pattern accepts an array source without iterating", async () => {
    const result = await run(`
      export function main(): f64 {
        var src: any = [1, 2, 3];
        var callCount = 0;
        function f([] = src): void { callCount = callCount + 1; }
        f();
        return callCount;
      }
    `);
    expect(result).toBe(1);
  });
});
