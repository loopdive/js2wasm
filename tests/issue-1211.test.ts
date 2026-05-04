import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

/**
 * Regression test for #1211 — fast-mode codegen of `f(n - 1) + f(n - 2)`
 * inside a recursive `any`-typed function (untyped JS) used to drop the
 * `i32.sub` operation entirely, miscompiling the recursion to a constant.
 *
 * Symptoms before the fix:
 * - `function fib(n) { if (n <= 1) return n; return fib(n-1) + fib(n-2); }`
 *   compiled to `fib(1) + fib(2)` for any input n > 1, returning 2 instead
 *   of the correct Fibonacci value.
 * - When the bundle source surrounded the function with `run_hot` (which
 *   forces the return type to AnyValue), wasm-opt rejected the binary
 *   with `[wasm-validator error in function fib] call param types must
 *   match` because `__any_add` was called with raw f64/i32 args instead
 *   of boxed AnyValue refs.
 *
 * The fix in `compileBinaryExpression` routes arithmetic ops on i32-typed
 * operands (where the TS-checker reports `any` due to recursive inference)
 * to `compileI32BinaryOp` instead of the comparison-only
 * `compileBooleanBinaryOp`, which silently fell through on `+ - * %`.
 *
 * The companion fix in `compileAnyBinaryDispatch` boxes the operands to
 * AnyValue refs before calling the helper so the call validates regardless
 * of the natural operand types.
 */
async function run(src: string, exportName: string, ...args: number[]): Promise<number> {
  const r = compile(src, { fileName: "t.ts", allowJs: true, target: "gc", fast: true, optimize: 0 });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(r.imports, {}, r.stringPool);
  const { instance } = await instantiateWasm(r.binary, imports.env, imports.string_constants);
  if (imports.setExports) imports.setExports(instance.exports);
  const fn = instance.exports[exportName] as (...a: number[]) => unknown;
  if (typeof fn !== "function") {
    throw new Error(`export ${exportName} is not a function`);
  }
  return Number(fn(...args));
}

describe("#1211 — fast-mode recursive arithmetic", () => {
  it("recursive fib(n - 1) + fib(n - 2) returns correct values", async () => {
    const src = `
      function fib(n) {
        if (n <= 1) return n;
        return fib(n - 1) + fib(n - 2);
      }
      export function run(n) { return fib(n); }
    `;
    expect(await run(src, "run", 0)).toBe(0);
    expect(await run(src, "run", 1)).toBe(1);
    expect(await run(src, "run", 2)).toBe(1);
    expect(await run(src, "run", 5)).toBe(5);
    expect(await run(src, "run", 10)).toBe(55);
    expect(await run(src, "run", 15)).toBe(610);
  });

  it("simple recursive call with `n - 1` does not drop `i32.sub`", async () => {
    // Reduces to test the codegen path: in the fast-mode untyped recursion,
    // the compiler used to emit `local.get; drop; i32.const 1; call $bar`
    // instead of `local.get; i32.const 1; i32.sub; call $bar`.
    const src = `
      function countdown(n) {
        if (n <= 0) return 0;
        return 1 + countdown(n - 1);
      }
      export function run(n) { return countdown(n); }
    `;
    expect(await run(src, "run", 0)).toBe(0);
    expect(await run(src, "run", 1)).toBe(1);
    expect(await run(src, "run", 5)).toBe(5);
    expect(await run(src, "run", 100)).toBe(100);
  });

  it("recursive function with run_hot wrapper compiles to a valid Wasm binary", async () => {
    // The bundled benchmark source wraps the body in a `run_hot` helper
    // whose loop re-assignment forces `result` (and therefore the
    // recursive function's return type) to AnyValue. Without the boxing
    // fix in compileAnyBinaryDispatch, wasm-opt rejected the binary
    // with "call param types must match".
    //
    // We assert the binary instantiates cleanly (i.e. validates) and
    // that the simple `run(n)` entry still produces the right value.
    // The `run_hot` boxed-result path returns an AnyValue struct that
    // would require an unboxer to inspect from JS — out of scope for
    // this regression test.
    const src = `
      function fib(n) {
        if (n <= 1) return n;
        return fib(n - 1) + fib(n - 2);
      }
      export function run(n) { return fib(n); }
      export function run_hot(iterations, input) {
        let result = run(input);
        for (let i = 0; i < iterations; i++) { result = run(input); }
        return result;
      }
    `;
    const r = compile(src, { fileName: "t.ts", allowJs: true, target: "gc", fast: true, optimize: 0 });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const imports = buildImports(r.imports, {}, r.stringPool);
    const { instance } = await instantiateWasm(r.binary, imports.env, imports.string_constants);
    if (imports.setExports) imports.setExports(instance.exports);
    expect(typeof instance.exports.run).toBe("function");
    expect(typeof instance.exports.run_hot).toBe("function");
    // `run` returns f64 directly, so this remains a primitive number.
    expect(Number((instance.exports.run as (n: number) => unknown)(25))).toBe(75025);
  });
});
