import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

// #1388 — Detached static / prototype method extraction.
//
// Pattern that previously failed (target: 273 of 316 test262 fails):
//
//   class C {
//     static async *gen() { yield 1; }   // or instance: async *gen() {...}
//   }
//   const gen = C.gen;                   // or: C.prototype.gen for instance
//   const iter = gen();                  // returned `null` before fix
//   iter.next();                         // → "Cannot read properties of null"
//
// Root cause: `compilePropertyAccess` returned `ref.null.extern` for
// `C.staticMethod` and the generic externref fallthrough for
// `C.prototype.method`. With `gen` bound to a null externref, calling it
// went through the closure-callable dispatch (calls.ts:5380), the
// `any.convert_extern + ref.cast` step on null landed on the cast-fail
// branch, and the call silently returned null.
//
// Fix: emit a proper closure struct (struct.new with a funcref field) via
// `emitFuncRefAsClosure` (static) / `emitObjectMethodAsClosure` (instance,
// for `C.prototype.method`), then `extern.convert_any` to externref so the
// closure-callable dispatch can ref.cast back and call_ref through the
// trampoline.

describe("#1388 — detached class method extraction", () => {
  it("static method, detached call returns the same value as direct call", async () => {
    const exp = await compileToWasm(`
      class C { static method() { return 42; } }
      export function detached(): number {
        const f = C.method;
        return f();
      }
      export function direct(): number {
        return C.method();
      }
    `);
    expect(exp.direct!()).toBe(42);
    expect(exp.detached!()).toBe(42);
  });

  it("static method with arg, detached", async () => {
    const exp = await compileToWasm(`
      class C { static double(x: number) { return x * 2; } }
      export function test(): number {
        const f = C.double;
        return f(21);
      }
    `);
    expect(exp.test!()).toBe(42);
  });

  it("static async generator method, detached + iterator works", async () => {
    const exp = await compileToWasm(`
      class C {
        static async *gen() { yield 1; yield 2; yield 3; }
      }
      export async function sum(): Promise<number> {
        const f = C.gen;
        const it = f();
        let total = 0;
        for (let i = 0; i < 4; i++) {
          const r = await it.next();
          if (r.done) break;
          total += r.value;
        }
        return total;
      }
    `);
    const result = await (exp.sum as () => Promise<number>)();
    expect(result).toBe(6);
  });

  it("class expression with static method, detached", async () => {
    const exp = await compileToWasm(`
      const C = class { static method() { return 7; } };
      export function test(): number {
        const f = C.method;
        return f();
      }
    `);
    expect(exp.test!()).toBe(7);
  });

  it("instance method, detached via prototype", async () => {
    const exp = await compileToWasm(`
      class C { method() { return 99; } }
      export function test(): number {
        const f = C.prototype.method;
        return f();
      }
    `);
    expect(exp.test!()).toBe(99);
  });

  it("instance method with arg, detached via prototype", async () => {
    const exp = await compileToWasm(`
      class C { triple(x: number) { return x * 3; } }
      export function test(): number {
        const f = C.prototype.triple;
        return f(14);
      }
    `);
    expect(exp.test!()).toBe(42);
  });

  it("static method extracted, typeof reports 'function'", async () => {
    const exp = await compileToWasm(`
      class C { static method() { return 1; } }
      export function test(): number {
        const f = C.method;
        return typeof f === 'function' ? 1 : 0;
      }
    `);
    expect(exp.test!()).toBe(1);
  });
});
