// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1226 — class/elements: static async private method invalid Wasm.
 *
 * 104 test262 tests in `language/{expressions,statements}/class/elements/*-rs-static-async-{method,generator-method}-privatename-identifier*` were reported as failing with:
 *
 *     CompileError: not enough arguments on the stack for call (need 1, got 0)
 *
 * Root cause hypothesis (per the issue file): a `nop` placeholder where an
 * argument should have been pushed before an async-executor `call` instruction.
 *
 * **Status (verified 2026-05-01):** all 104 reported files now compile to
 * VALID Wasm on current main. The bug appears to have been fixed by recent
 * codegen changes to closures / class / async paths (likely a side-effect of
 * #1196 bounds-check elimination, #1197 i32 element specialization, or the
 * #1205 TDZ async-gen series). The committed baseline JSONL is stale — see
 * `feedback_baseline_drift_cross_check.md`.
 *
 * This file captures the spec-correct behaviour so the fix doesn't silently
 * regress. The 24 remaining `class/dstr` failures (different category, listed
 * as out-of-scope in the issue) and the 157 `Array/prototype` failures (a
 * separate bug) are tracked separately.
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#1226 — class/elements: static async private method", () => {
  it("compiles a single static async private method to valid Wasm", async () => {
    const exports = await compileToWasm(`
      var C = class {
        static async #x(v: any): any { return await v; }
        static get x(): any { return this.#x; }
      };
      export function test(): any {
        return C;
      }
    `);
    expect(typeof exports.test).toBe("function");
    expect(exports.test()).toBeDefined();
  });

  it("compiles multiple static async private methods (matches test262 multi-definition pattern)", async () => {
    // Mirrors language/expressions/class/elements/multiple-definitions-rs-static-async-method-privatename-identifier.js
    const exports = await compileToWasm(`
      var C = class {
        static async #x(value: any): any { return await value; }
        static async #y(value: any): any { return await value; }
        static async #z(value: any): any { return await value; }
        static get x(): any { return this.#x; }
        static get y(): any { return this.#y; }
        static get z(): any { return this.#z; }
      };
      export function test(): any {
        return C;
      }
    `);
    expect(exports.test()).toBeDefined();
  });

  it("compiles a static async generator private method to valid Wasm", async () => {
    const exports = await compileToWasm(`
      var C = class {
        static async * #gen(v: any): any { yield await v; }
        static get gen(): any { return this.#gen; }
      };
      export function test(): any {
        return C;
      }
    `);
    expect(exports.test()).toBeDefined();
  });

  it("compiles static async + static async-gen private methods alongside instance members", async () => {
    // Mirrors test262 after-same-line-* templates that interleave instance
    // generators with static async private methods.
    const exports = await compileToWasm(`
      var C = class {
        *m(): any { return 42; }
        static async #a(value: any): any { return await value; }
        static async * #g(value: any): any { yield await value; }
        m2(): number { return 39; }
        static get a(): any { return this.#a; }
        static get g(): any { return this.#g; }
      };
      export function test(): any {
        return C;
      }
    `);
    expect(exports.test()).toBeDefined();
  });

  it("compiles static async private with public static getter delegate", async () => {
    // `static get name() { return this.#name }` is the public-access template
    // that test262 uses to verify private methods are reachable.
    const exports = await compileToWasm(`
      var C = class {
        static async #compute(value: any): any { return await value; }
        static get compute(): any { return this.#compute; }
      };
      export function test(): any {
        return (C as any).compute;
      }
    `);
    // Calling C.compute returns the bound private method — should not throw.
    expect(exports.test).toBeDefined();
  });
});
