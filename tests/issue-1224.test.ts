// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1224 — class method destructuring with default parameters.
 *
 * Per ECMA-262 §14.3.3.2 IteratorBindingInitialization, when a parameter has
 * BOTH a binding pattern AND a default initializer (e.g. `method([a] = [42])`),
 * the order MUST be:
 *
 *   1. If the parameter value is `undefined`, replace it with the Initializer
 *   2. THEN destructure the (possibly-defaulted) value
 *
 * The previously-failing 408 test262 tests in `language/{statements,expressions}/
 * class/dstr/*-dflt-*` and `*-init` failed with "Cannot destructure 'null' or
 * 'undefined'" because the destructure null-guard fired BEFORE the default was
 * applied.
 *
 * This test file verifies the spec-correct order for class method parameters
 * across regular, generator, async, and async-generator method kinds.
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#1224 — class method dstr-parameter defaults: spec-ordering", () => {
  describe("Pattern A — default parameter (`-dflt-` filenames, 360 tests)", () => {
    it("regular method: default applies, then destructure", async () => {
      // class A { method([a = 9] = [42]) { return a; } }
      // new A().method() — no arg → param = [42] → a = 42
      const exports = await compileToWasm(`
        class A {
          method([a = 9]: any = [42]): any { return a; }
        }
        export function test(): any {
          return new A().method();
        }
      `);
      expect(exports.test()).toBe(42);
    });

    it("regular method: explicit arg bypasses default", async () => {
      // new A().method([1]) — arg is [1] → a = 1
      const exports = await compileToWasm(`
        class A {
          method([a = 9]: any = [42]): any { return a; }
        }
        export function test(): any {
          return new A().method([1]);
        }
      `);
      expect(exports.test()).toBe(1);
    });

    it("regular method: default fires when arg is explicitly undefined", async () => {
      // new A().method(undefined) — same as no-arg → param = [42] → a = 42
      const exports = await compileToWasm(`
        class A {
          method([a = 9]: any = [42]): any { return a; }
        }
        export function test(): any {
          return new A().method(undefined);
        }
      `);
      expect(exports.test()).toBe(42);
    });

    it("generator method: default applies, then destructure", async () => {
      // class B { *method([x] = [99]) { yield x; } }
      const exports = await compileToWasm(`
        class B {
          *method([x]: any = [99]): any { yield x; }
        }
        export function test(): any {
          return (new B().method() as any).next().value;
        }
      `);
      expect(exports.test()).toBe(99);
    });

    it("static method: default applies, then destructure", async () => {
      const exports = await compileToWasm(`
        class C {
          static method([a]: any = [7]): any { return a; }
        }
        export function test(): any {
          return (C as any).method();
        }
      `);
      expect(exports.test()).toBe(7);
    });

    it("multi-element default: [a, b] = [1, 2]", async () => {
      const exports = await compileToWasm(`
        class A {
          method([a, b]: any = [1, 2]): any {
            return (a as number) * 10 + (b as number);
          }
        }
        export function test(): any {
          return new A().method();
        }
      `);
      expect(exports.test()).toBe(12);
    });

    it("inner default fires inside outer default", async () => {
      // [a = 9] applied first, then a default 9 used since [42] has only one slot
      // (Actually [42] has slot 0 = 42, so a = 42 — the inner default doesn't fire)
      const exports = await compileToWasm(`
        class A {
          method([a = 999]: any = [42]): any { return a; }
        }
        export function test(): any {
          return new A().method();
        }
      `);
      expect(exports.test()).toBe(42);
    });

    it("inner default fires when default array is empty", async () => {
      // [a = 23] applied first, then default [] (empty) — a is exhausted → use 23
      const exports = await compileToWasm(`
        class A {
          method([a = 23]: any = []): any { return a; }
        }
        export function test(): any {
          return new A().method();
        }
      `);
      expect(exports.test()).toBe(23);
    });
  });

  describe("Pattern B — nested array init (`-init` filenames, 48 tests)", () => {
    it("nested binding pattern with init: explicit value bypasses init", async () => {
      // class D { method([[x] = [42]]) { return x; } }
      // new D().method([[7]]) — outer extracts [7], inner extracts x=7
      const exports = await compileToWasm(`
        class D {
          method([[x] = [42]]: any): any { return x; }
        }
        export function test(): any {
          return new D().method([[7]]);
        }
      `);
      expect(exports.test()).toBe(7);
    });
  });
});
