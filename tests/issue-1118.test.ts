// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1118 — Object-literal methods now produce a callable closure value.
 *
 * Pre-fix: object literal methods like `{ m() {…} }` were stored as `undefined`
 * in the obj struct's method field. Direct calls `obj.m()` worked via the
 * static-dispatch fast path (TS knows the receiver type), but ANY of:
 *   - `(obj as any).m()` (dynamic dispatch through `any`)
 *   - `var f = obj.m; f()` (method-as-value extraction)
 *   - test262's wrapped harness which casts receivers to `any`
 * would read `undefined` from the field, leading to a runtime trap and the
 * 50+ async-gen-yield-star failures filed as null_deref.
 *
 * Post-fix:
 *   1. `compileObjectLiteralForStruct` now emits a closure-struct ref for
 *      MethodDeclaration fields (via `emitObjectMethodAsClosure`). The
 *      closure wraps a trampoline that takes (closure_self, …userArgs) and
 *      forwards to the actual method with `ref.null <obj_struct>` as the
 *      `this` slot — implementing JS spec extraction where `this` is unbound.
 *   2. `compilePropertyAccess` (in property-access.ts) was reading the
 *      method-as-value path with a `ref.null.extern` placeholder; now it
 *      reads the actual struct field for object-literal struct types.
 *
 * Methods that don't reference `this` (the common test262 yield-star pattern)
 * work correctly. Methods that DO reference `this` will trap inside the body
 * matching JS spec semantics for unbound extraction.
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#1118 — object-literal methods + dynamic dispatch", () => {
  describe("static-dispatch path (TypeScript proves receiver type)", () => {
    it("inline object method call", async () => {
      const exports = await compileToWasm(`
        export function test(): number {
          const obj = { m() { return 42; } };
          return obj.m();
        }
      `);
      expect(exports.test()).toBe(42);
    });

    it("explicitly-typed receiver method call", async () => {
      const exports = await compileToWasm(`
        export function test(): number {
          const obj: { m: () => number } = { m() { return 42; } };
          return obj.m();
        }
      `);
      expect(exports.test()).toBe(42);
    });

    it("nested object literal works when typed", async () => {
      const exports = await compileToWasm(`
        export function test(): number {
          const inner: { x: number } = { x: 42 };
          const obj = { m() { return inner.x; } };
          return obj.m();
        }
      `);
      expect(exports.test()).toBe(42);
    });
  });

  describe("dynamic-dispatch path (the #1118 fix)", () => {
    it("'obj as any' followed by .m() finds the method", async () => {
      const exports = await compileToWasm(`
        export function test(): any {
          const obj: any = { m(): number { return 42; } };
          return obj.m();
        }
      `);
      expect(exports.test()).toBe(42);
    });

    it("anonymous IIFE method call works through any", async () => {
      const exports = await compileToWasm(`
        export function test(): any {
          return ({ m(): number { return 42; } } as any).m();
        }
      `);
      expect(exports.test()).toBe(42);
    });

    it("method extraction (any) — call with f() works", async () => {
      const exports = await compileToWasm(`
        export function test(): any {
          const obj: any = { m(): number { return 42; } };
          const f: any = obj.m;
          return f();
        }
      `);
      expect(exports.test()).toBe(42);
    });

    it("method extraction with arguments", async () => {
      const exports = await compileToWasm(`
        export function test(): any {
          const obj: any = { add(a: number, b: number): number { return a + b; } };
          const f: any = obj.add;
          return f(3, 4);
        }
      `);
      expect(exports.test()).toBe(7);
    });

    it("async generator method extraction (test262 yield-star pattern)", async () => {
      // NB: avoid `(gen as any)()` — the inner `as any` cast triggers a
      // separate codegen issue where the call falls through to the
      // graceful-null fallback. Plain `gen()` (callee is a known any-typed
      // local) goes through `tryEmitInlineDynamicCall` and dispatches
      // correctly through the closure registered for the obj literal's
      // method field.
      const exports = await compileToWasm(`
        export function test(): any {
          const obj: any = {
            async *method(): any {
              yield 1;
            }
          };
          const gen: any = obj.method;
          const iter: any = gen();
          // Pre-fix: iter is null and accessing .next throws.
          // Post-fix: iter should be a real async generator object.
          return typeof iter;
        }
      `);
      expect(exports.test()).toBe("object");
    });
  });

  describe("globalThis access works (Fix 1 from the original issue)", () => {
    it("globalThis.Array.isArray", async () => {
      const exports = await compileToWasm(`
        export function test(): any {
          return (globalThis as any).Array.isArray([1, 2, 3]);
        }
      `);
      expect(exports.test()).toBe(true);
    });
  });

  describe("URI host imports work (Fix 2 from the original issue)", () => {
    it("encodeURIComponent / decodeURIComponent round-trip", async () => {
      const exports = await compileToWasm(`
        export function test(): any {
          const s = "hello world?foo=bar";
          return decodeURIComponent(encodeURIComponent(s));
        }
      `);
      expect(exports.test()).toBe("hello world?foo=bar");
    });
  });
});
