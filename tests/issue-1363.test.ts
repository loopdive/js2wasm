/**
 * Issue #1363 — class destructuring parameter defaults
 *
 * The test262 wrapping function previously trapped class methods that
 * referenced enclosing-function `var` declarations from a parameter default
 * (e.g. `method([] = iter)` where `iter` is a `var` in the test scope).
 * Class methods compile to module-level Wasm functions and cannot capture
 * enclosing-function locals — the default expression resolved to
 * `ref.null.extern`, then the destructuring guard threw
 * "Cannot destructure 'null' or 'undefined'".
 *
 * Fix: extend the test262 runner's var-hoisting pass to recognise
 * `var x = <expr>;` declarations referenced from a class body and hoist
 * them to module scope (preserving the in-place assignment for
 * initialisation order).
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.ts";
import { runTest262File } from "./test262-runner.ts";

describe("#1363 class destructuring parameter defaults", () => {
  it("class method with empty array default `[]`", async () => {
    const src = `
class C {
  method([]: number[] = []): number {
    return 42;
  }
}
export function test(): number {
  return new C().method();
}
`;
    const r = await compileToWasm(src);
    expect((r as any).test()).toBe(42);
  });

  it("class method with default array elem when no arg", async () => {
    const src = `
class C {
  method([x = 23]: number[] = []): number {
    return x;
  }
}
export function test(): number {
  return new C().method();
}
`;
    const r = await compileToWasm(src);
    expect((r as any).test()).toBe(23);
  });

  it("class method with default object pattern `{} = {}`", async () => {
    const src = `
class C {
  method({}: { x?: number } = {}): number {
    return 7;
  }
}
export function test(): number {
  return new C().method();
}
`;
    const r = await compileToWasm(src);
    expect((r as any).test()).toBe(7);
  });

  it("static method with default empty obj pattern", async () => {
    const src = `
class C {
  static method({}: { x?: number } = {}): number {
    return 9;
  }
}
export function test(): number {
  return C.method();
}
`;
    const r = await compileToWasm(src);
    expect((r as any).test()).toBe(9);
  });

  it("generator method with default empty array pattern", async () => {
    const src = `
class C {
  *method([]: number[] = []): Generator<number> {
    yield 5;
  }
}
export function test(): number {
  const g = new C().method();
  return g.next().value;
}
`;
    const r = await compileToWasm(src);
    expect((r as any).test()).toBe(5);
  });

  // The runtime_error bucket on language/{expressions,statements}/class/dstr/
  // — these test262 files used to trap with "Cannot destructure null/undefined"
  // because a parameter default referencing a closure `var` resolved to
  // ref.null.extern. After the runner fix, the bridge variable reaches the
  // method and the destructuring guard passes.
  const FIXED_TEST262 = [
    // Static-method case: `static async *method({} = obj)` where
    // `var obj = Object.defineProperty(...)`. Now hoisted to module scope.
    "test/language/expressions/class/dstr/async-gen-meth-static-dflt-obj-ptrn-empty.js",
    // Private async-gen with iterator default: `[x] = iter` where
    // `var iter = {}; iter[Symbol.iterator] = ...`.
    "test/language/expressions/class/dstr/async-private-gen-meth-dflt-ary-init-iter-no-close.js",
  ];
  for (const t of FIXED_TEST262) {
    it(`test262: ${t} no longer traps`, async () => {
      const result = await runTest262File(`/workspace/${t.startsWith("test/") ? "test262/" + t : t}`, "language");
      expect(result.status).toBe("pass");
    });
  }
});
