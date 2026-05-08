// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #1347 — for-of IteratorClose semantics on abrupt body completion.
 *
 * The compiler already emits `__iterator_return` calls on break / continue /
 * return / throw via `compileForOfIterator`'s `finallyStack` + try/catch_all
 * (#851). What was missing: spec-conformant behaviour at the **runtime**
 * layer for the case where `iterator.return` exists but is **not callable**
 * (e.g. `return: 1`). Per ES §7.4.6 IteratorClose + §7.3.11 GetMethod:
 *
 * - GetMethod throws TypeError when `return` is non-null + non-callable.
 * - For close-by-throw: the outer throw wins (step 6 — IteratorClose's
 *   error is suppressed).
 * - For close-by-break/continue/return: the IteratorClose error
 *   propagates (step 7).
 *
 * Two-part fix:
 * 1. **Runtime** (`src/runtime.ts`) — `__iterator_return` now throws
 *    TypeError when `iter.return` is non-null and non-callable. Errors
 *    from calling `iter.return()` itself continue to propagate.
 * 2. **Compiler** (`src/codegen/statements/loops.ts`) — the throw-path
 *    `catchAll` wraps its `__iterator_return` call in a nested
 *    try/catch_all so that any error from IteratorClose is dropped
 *    before the outer `rethrow 0` re-raises the original exception.
 *    The break/continue/return paths (via `finallyStack` cloned
 *    body) call `__iterator_return` directly, so any TypeError from
 *    a non-callable `return` propagates to the user as required.
 *
 * Tests use a host import `getIterable()` to surface a JS iterable
 * with a deliberately non-callable `return`. Going through a host
 * import avoids the function-typed-parameter codegen path (which has
 * unrelated bugs tracked elsewhere) and exercises the iterator
 * protocol end-to-end.
 */

interface IterStub {
  next: () => { done: boolean; value: unknown };
  return?: unknown;
}

async function runWithIterable(src: string, iter: IterStub): Promise<{ exports: Record<string, unknown> }> {
  const r = compile(src, { fileName: "t.ts" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const imports = buildImports(r.imports, undefined, r.stringPool) as any;
  // Provide getIterable host import that returns a real JS iterable with the
  // injected stub iterator. (Using a host import keeps the compiled Wasm body
  // simple — no function-typed param codegen involved.)
  imports.env = imports.env ?? {};
  imports.env.getIterable = () => {
    const it: { [k: string | symbol]: unknown } = {};
    it[Symbol.iterator] = () => iter;
    return it;
  };
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof imports.setExports === "function") imports.setExports(instance.exports);
  return { exports: instance.exports as Record<string, unknown> };
}

const STUB_HOST = `declare function getIterable(): any;`;

describe("#1347 — for-of IteratorClose on non-callable return", () => {
  it("close-by-throw with non-callable return: original throw wins", async () => {
    // Spec §7.4.6 step 6: when the body throws, IteratorClose returns the
    // original throw — any error from GetMethod / iterator.return() is
    // suppressed. The compiler wraps the throw-path `__iterator_return`
    // call in a nested try/catch_all to drop any exception before
    // re-raising the original.
    const { exports } = await runWithIterable(
      `
      ${STUB_HOST}
      export function test(): number {
        let iterationCount = 0;
        let caughtMessage = "";
        try {
          for (const x of getIterable()) {
            iterationCount += 1;
            throw new Error("user-throw");
          }
        } catch (e: any) {
          caughtMessage = e?.message ?? "";
        }
        return (iterationCount === 1 && caughtMessage.indexOf("user-throw") >= 0) ? 1 : 0;
      }
    `,
      {
        next: () => ({ done: false, value: null }),
        return: "not-callable", // non-callable string
      },
    );
    expect((exports.test as () => number)()).toBe(1);
  });

  it("close-by-break with non-callable return: TypeError propagates", async () => {
    // Spec §7.4.6 step 7 + §7.3.11 GetMethod step 4: GetMethod throws
    // TypeError when `iterator.return` is non-null and non-callable.
    // For close-by-break (non-throw outer completion), the IteratorClose
    // error propagates to the caller.
    const { exports } = await runWithIterable(
      `
      ${STUB_HOST}
      export function test(): number {
        let iterationCount = 0;
        let caught = 0;
        try {
          for (const x of getIterable()) {
            iterationCount += 1;
            break;
          }
        } catch (e: any) {
          caught = 1;
        }
        return (iterationCount === 1 && caught === 1) ? 1 : 0;
      }
    `,
      {
        next: () => ({ done: false, value: null }),
        return: 1, // non-callable number
      },
    );
    expect((exports.test as () => number)()).toBe(1);
  });

  it("regression guard: callable return is still called once on break", async () => {
    let returnCount = 0;
    const { exports } = await runWithIterable(
      `
      ${STUB_HOST}
      export function test(): number {
        let iterationCount = 0;
        for (const x of getIterable()) {
          iterationCount += 1;
          break;
        }
        return iterationCount;
      }
    `,
      {
        next: () => ({ done: false, value: null }),
        return: () => {
          returnCount += 1;
          return {};
        },
      },
    );
    expect((exports.test as () => number)()).toBe(1);
    expect(returnCount).toBe(1);
  });

  it("regression guard: missing return method is a no-op (no error)", async () => {
    // GetMethod step 3: undefined / null `return` → no-op.
    const { exports } = await runWithIterable(
      `
      ${STUB_HOST}
      export function test(): number {
        let iterationCount = 0;
        for (const x of getIterable()) {
          iterationCount += 1;
          break;
        }
        return iterationCount;
      }
    `,
      {
        next: () => ({ done: false, value: null }),
        // no `return` property at all
      },
    );
    expect((exports.test as () => number)()).toBe(1);
  });

  it("regression guard: throw-path with callable return that itself throws is suppressed", async () => {
    // Spec §7.4.6 step 6: when outer is throw, ANY error from IteratorClose
    // is suppressed — including errors from calling iterator.return().
    const { exports } = await runWithIterable(
      `
      ${STUB_HOST}
      export function test(): number {
        let iterationCount = 0;
        let caughtMessage = "";
        try {
          for (const x of getIterable()) {
            iterationCount += 1;
            throw new Error("body-throw");
          }
        } catch (e: any) {
          caughtMessage = e?.message ?? "";
        }
        return (iterationCount === 1 && caughtMessage.indexOf("body-throw") >= 0) ? 1 : 0;
      }
    `,
      {
        next: () => ({ done: false, value: null }),
        return: () => {
          throw new Error("close-throw"); // suppressed per spec
        },
      },
    );
    expect((exports.test as () => number)()).toBe(1);
  });
});
