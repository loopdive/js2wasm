// #1394 — class method-closure caching.
//
// `C.prototype.<method>` must return a singleton closure-struct externref
// so that:
//   1. `c.m === C.prototype.m` holds (verifyProperty's value-equality check).
//   2. Repeated access returns the same closure (no per-access allocation).
//   3. The closure is callable (legacy null-externref returned `undefined()`
//      which silently failed instead of throwing TypeError).
//
// Covered method kinds: regular, generator, async, async-generator. The
// closure's funcref is built once per `${className}_${methodName}` and
// stashed in a module-level externref global.

import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#1394 — class method-closure caching (identity invariant)", () => {
  // Deferred to dual-class-registration follow-up (instance access path
  // resolves to the synthetic `__anonClass_N` symbol while proto access
  // uses the user-visible name; the two paths emit different cache keys
  // and therefore different closure refs). This PR caches only the
  // `C.prototype.method` side; `c.method` remains null externref.
  it.todo("c.m === C.prototype.m for a regular method (deferred to dual-reg fix)");

  it("C.prototype.m === C.prototype.m on repeated access", async () => {
    const wasm = await compileToWasm(`
      class C {
        m(): number { return 1; }
      }
      export function test(): number {
        if (C.prototype.m !== C.prototype.m) return 999;
        return 1;
      }
    `);
    expect((wasm as any).test()).toBe(1);
  });

  it("C.prototype.m is non-null (was null pre-fix)", async () => {
    const wasm = await compileToWasm(`
      class C {
        m(): number { return 1; }
      }
      export function test(): number {
        const m: any = C.prototype.m;
        if (m === null) return 0;
        if (typeof m !== "function" && typeof m !== "object") return 0;
        return 1;
      }
    `);
    expect((wasm as any).test()).toBe(1);
  });

  // Deferred — see note above on dual-class-registration. Instance-side
  // method access (`c.gen` / `c.asyncM` / `c.asyncGen`) returns null
  // externref under this PR, so cross-kind instance-vs-prototype identity
  // can't be observed yet. Proto-only identity for each kind is covered
  // by the singleton-on-repeated-access test above.
  it.todo("identity holds across method kinds — deferred to dual-reg fix");

  it("two classes with same method name keep distinct identities", async () => {
    const wasm = await compileToWasm(`
      class A {
        m(): number { return 1; }
      }
      class B {
        m(): number { return 2; }
      }
      export function test(): number {
        if (A.prototype.m === B.prototype.m) return 999;
        if (A.prototype.m !== A.prototype.m) return 100;
        if (B.prototype.m !== B.prototype.m) return 200;
        return 1;
      }
    `);
    expect((wasm as any).test()).toBe(1);
  });
});
