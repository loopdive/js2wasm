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
  it("c.m === C.prototype.m for a regular method", async () => {
    const wasm = await compileToWasm(`
      class C {
        m(): number { return 42; }
      }
      export function test(): number {
        const c = new C();
        const fromInstance = c.m as any;
        const fromProto = C.prototype.m as any;
        if (fromInstance === null) return 100;
        if (fromProto === null) return 200;
        if (fromInstance !== fromProto) return 300;
        return 1;
      }
    `);
    expect((wasm as any).test()).toBe(1);
  });

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

  it("identity holds across method kinds: generator, async, async-gen", async () => {
    const wasm = await compileToWasm(`
      class C {
        *gen(): Generator<number> { yield 1; }
        async asyncM(): Promise<number> { return 1; }
        async *asyncGen(): AsyncGenerator<number> { yield 1; }
      }
      export function test(): number {
        const c = new C();
        if (c.gen !== C.prototype.gen) return 100;
        if (c.asyncM !== C.prototype.asyncM) return 200;
        if (c.asyncGen !== C.prototype.asyncGen) return 300;
        return 1;
      }
    `);
    expect((wasm as any).test()).toBe(1);
  });

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
