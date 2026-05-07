// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile, compileProject } from "../src/index.js";
import { buildImports, wrapExports } from "../src/runtime.js";

/**
 * #1308 — Wasm closure struct returned to JS host is not JS-callable.
 *
 * Two-part fix:
 *
 * 1. **Codegen** — `generateMultiModule` was missing the `__call_fn_0` /
 *    `__call_fn_1` (and several other) export emit calls that the
 *    single-source `generateModule` had. For multi-source projects (e.g.
 *    lodash via `compileProject`) those exports never reached the binary,
 *    so even runtime helpers that wanted to dispatch via `__call_fn_0`
 *    couldn't. Fixed by adding the same emit calls to `generateMultiModule`.
 *
 * 2. **Runtime** — added `wrapExports(instance.exports)` which returns a
 *    new exports object whose user-visible callable exports auto-wrap
 *    any returned Wasm closure struct in a JS function. The wrapper
 *    dispatches via `__call_fn_0` (0 args) or `__call_fn_1` (1 arg).
 *
 * Limitation: variadic closures (`function(...args){...}`) are lifted as
 * 0-arg functions whose body reads `arguments`. Without a JS-side path
 * to populate `__extras_argv` + `__argc` before invoking, calls like
 * `wrapped(2)` fall back to `__call_fn_0` and the closure body sees an
 * empty arguments object. That's tracked as the next step on this issue.
 */

async function runSingle(src: string): Promise<{ exports: Record<string, any> }> {
  const r = compile(src, { fileName: "test.ts" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return { exports: wrapExports(instance.exports) };
}

describe("#1308 — wrapExports makes Wasm closure returns JS-callable", () => {
  it("typeof exported closure return is 'function' (was 'object')", async () => {
    const { exports } = await runSingle(`
      export function makeFn(): () => number {
        return () => 42;
      }
    `);
    const fn = exports.makeFn();
    expect(typeof fn).toBe("function");
  });

  it("zero-arg closure dispatches via __call_fn_0", async () => {
    const { exports } = await runSingle(`
      export function makeFn(): () => number {
        return () => 42;
      }
    `);
    const fn = exports.makeFn();
    expect(fn()).toBe(42);
  });

  it("captured-value closure: makeAdder(5)() returns 6", async () => {
    const { exports } = await runSingle(`
      export function makeAdder(x: number): () => number {
        return () => x + 1;
      }
    `);
    const adder = exports.makeAdder(5);
    expect(typeof adder).toBe("function");
    expect(adder()).toBe(6);
  });

  it("1-arg closure dispatches via __call_fn_1", async () => {
    const { exports } = await runSingle(`
      export function makeIdentity(): (n: number) => number {
        return (n) => n + 1;
      }
    `);
    const inc = exports.makeIdentity();
    expect(typeof inc).toBe("function");
    expect(inc(7)).toBe(8);
  });

  it("non-callable exports pass through unchanged", async () => {
    const { exports } = await runSingle(`
      export function pure(x: number): number {
        return x * 2;
      }
    `);
    // Number-returning export is not a closure — wrapper just returns the number.
    expect(typeof exports.pure).toBe("function");
    expect(exports.pure(3)).toBe(6);
  });

  it("internal __-prefixed exports stay accessible by name", async () => {
    const { exports } = await runSingle(`
      export function makeFn(): () => number {
        return () => 1;
      }
    `);
    // The wrapper preserves __call_fn_0 (and other internals) so the runtime
    // and the wrapper itself can still reach them.
    expect(typeof exports.__call_fn_0).toBe("function");
  });

  it("lodash negate(jsFn): typeof guard cleared (#1304) + JS-callable (#1308)", async () => {
    const r = compileProject("node_modules/lodash-es/negate.js", { allowJs: true });
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    const exp = wrapExports(instance.exports);

    const isEven = (n: number) => n % 2 === 0;
    const negated = exp.negate(isEven);

    // Pre-#1304: lodash's `typeof predicate != 'function'` guard threw
    // before reaching this point. Pre-#1308: typeof was "object".
    expect(typeof negated).toBe("function");

    // 0-arg call goes through case 0 of negate's switch:
    // `!predicate.call(this)` → !isEven(undefined) → !false → 1.
    // (Variadic arg propagation is the remaining gap — `negated(2)` still
    // routes through __call_fn_0 with no args until __extras_argv plumbing
    // from JS lands.)
    expect(negated()).toBe(1);
  });
});
