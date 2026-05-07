// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #1306 — `mws[idx](c, next)` on a closure-typed array compiles to `ref.null
 * extern; drop`, dropping the call.
 *
 * Two `compileCallExpression` fallback paths inside the
 * `ts.isElementAccessExpression(expr.expression)` branch (calls.ts:5927)
 * previously ended in `ref.null.extern`:
 *   1. Resolved-but-unmatched-method (line 6371-6386)
 *   2. Unresolved-index (line 6389-6409)
 *
 * Neither handled the case where the receiver is a vec/array of values whose
 * element type has TS call signatures. The fix adds a new helper
 * `compileCallableElementAccessCall` (calls-closures.ts) that loads the
 * element via the existing element-access codegen, unboxes the externref
 * to a `__fn_wrap_N_struct` ref, and dispatches via `call_ref`.
 *
 * Mirrors the externref-field branch of `compileCallablePropertyCall`
 * (calls-closures.ts:500-560).
 */
async function run(src: string): Promise<{ exports: Record<string, unknown> }> {
  const r = compile(src, { fileName: "test.ts" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return { exports: instance.exports as Record<string, unknown> };
}

describe("#1306 — element-access call on callable array dispatches via call_ref", () => {
  it("literal index: fns[0](args)", async () => {
    const { exports } = await run(`
      export function test(): string {
        const fns: ((s: string) => string)[] = [(s) => s + "!"];
        return fns[0]("hi");
      }
    `);
    expect((exports.test as () => string)()).toBe("hi!");
  });

  it("const-bound index: const I = 1; fns[I](args)", async () => {
    const { exports } = await run(`
      export function test(): string {
        const fns: ((s: string) => string)[] = [(s) => s + "!", (s) => s + "?"];
        const i = 1;
        return fns[i]("hi");
      }
    `);
    expect((exports.test as () => string)()).toBe("hi?");
  });

  it("runtime index: for (i=0; i<n; i++) acc += fns[i](x)", async () => {
    // The central #1306 case — runtime variable index. Pre-fix this dropped
    // every iteration's call to `ref.null extern`, so `acc` stayed `""`.
    const { exports } = await run(`
      export function test(): string {
        const fns: ((s: string) => string)[] = [(s) => s + "A", (s) => s + "B", (s) => s + "C"];
        let acc = "";
        for (let i = 0; i < fns.length; i++) {
          acc = acc + fns[i]("x");
        }
        return acc;
      }
    `);
    expect((exports.test as () => string)()).toBe("xAxBxC");
  });

  it("two-arg call through array element: mws[i](c, term)", async () => {
    // Mirrors the middleware-compose dispatch shape (Mw = (c, n) => string),
    // but with `term` as a top-level function — sidesteps the orthogonal
    // self-recursive function-as-arg bug that blocks the full Tier 5c case.
    const { exports } = await run(`
      type N = () => string;
      type Mw = (c: number, next: N) => string;

      function term(): string { return "end"; }

      function call0(mws: Mw[]): string {
        return mws[0](0, term);
      }

      export function test(): string {
        const mws: Mw[] = [(c, n: N) => "[A]" + n()];
        return call0(mws);
      }
    `);
    expect((exports.test as () => string)()).toBe("[A]end");
  });

  it("dispatch picks the right element by runtime index", async () => {
    const { exports } = await run(`
      export function test(): string {
        const fns: ((s: string) => string)[] = [
          (s) => "first:" + s,
          (s) => "second:" + s,
          (s) => "third:" + s,
        ];
        let i = 2;
        return fns[i]("ok");
      }
    `);
    expect((exports.test as () => string)()).toBe("third:ok");
  });

  it("call signature with multiple args dispatches each element", async () => {
    const { exports } = await run(`
      type Op = (a: number, b: number) => number;
      export function test(): number {
        const ops: Op[] = [(a, b) => a + b, (a, b) => a - b, (a, b) => a * b];
        let acc = 0;
        for (let i = 0; i < ops.length; i++) {
          acc = acc + ops[i](10, 3);
        }
        return acc; // (10+3) + (10-3) + (10*3) = 13 + 7 + 30 = 50
      }
    `);
    expect((exports.test as () => number)()).toBe(50);
  });

  it("compilation doesn't regress for native primitive arrays", async () => {
    // Sanity guard: arrays with no call-signature element type must still
    // compile via the existing fallback (helper returns undefined).
    const { exports } = await run(`
      export function test(): number {
        const xs: number[] = [1, 2, 3];
        // String element access on a number[] — shouldn't try to dispatch via call_ref
        return xs.length;
      }
    `);
    expect((exports.test as () => number)()).toBe(3);
  });
});
