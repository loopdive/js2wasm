/**
 * Tests for #928 — Unknown failure tests (empty error message)
 *
 * Root cause: generators run their bodies eagerly when created. Tests that
 * expect generators to throw lazily (on first next() call) were getting
 * "unknown failure" because the exception happened at creation time, before
 * assert_throws() was even called.
 *
 * Fix: wrap generator body execution in try/catch. Catch the exception as a
 * "pending throw" and pass it to __create_generator, which defers the throw
 * to the first next() call.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<number | undefined> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(r.errors[0]?.message ?? "compile error");
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  const fn = instance.exports.test as () => number;
  try {
    return fn();
  } catch (e) {
    // Re-wrap Wasm exceptions as JS errors for inspection
    if (e instanceof WebAssembly.Exception) {
      const tag = (instance.exports.__exn_tag ?? instance.exports.__tag) as WebAssembly.Tag;
      if (tag) {
        try {
          const payload = e.getArg(tag, 0);
          if (payload instanceof Error) throw payload;
          throw new Error(String(payload));
        } catch (inner) {
          if (inner !== e) throw inner;
        }
      }
    }
    throw e;
  }
}

describe("#928 — generator pending-throw semantics", () => {
  it("generator with throw before yield: throw deferred to first next()", async () => {
    // Previously: TypeError thrown at creation time → escaped test(), "unknown failure"
    // Now: throw deferred to first next() call → assert_throws catches it → PASS
    const src = `
      export function test(): number {
        var threw = false;
        var iter = function* () {
          throw new TypeError("gen error");
        }();
        // Generator created lazily — no throw yet
        try {
          iter.next(); // First next() should throw
        } catch (e) {
          threw = true;
        }
        if (!threw) return 2; // FAIL: should have thrown
        return 1; // PASS
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("generator with code before throw: code runs on creation, throw deferred", async () => {
    // Pattern from ary-ptrn-rest-id-iter-step-err tests
    const src = `
      export function test(): number {
        var first = 0;
        var second = 0;
        var iter = function* () {
          first = first + 1;     // runs eagerly (buffer-based)
          throw new TypeError(); // stored as pending throw
          second = second + 1;   // unreachable
        }();
        var caught = false;
        try {
          iter.next(); // should throw TypeError
        } catch (e) {
          caught = true;
        }
        if (!caught) return 2;
        if (first !== 1) return 3;   // first should have run
        if (second !== 0) return 4;  // second should NOT have run
        return 1;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("generator with yield then throw: yields work, then throws on next call", async () => {
    // Buffer has values, then pending throw
    const src = `
      export function test(): number {
        var iter = function* () {
          yield 42;
          throw new TypeError("after yield");
        }();
        // First next() should return yielded value
        var r1 = iter.next();
        if (r1.done) return 2;
        // Second next() should throw
        var threw = false;
        try {
          iter.next();
        } catch (e) {
          threw = true;
        }
        if (!threw) return 3;
        return 1;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("elision-step-err pattern: destructuring elision catches generator throw", async () => {
    // Exact pattern from dflt-ary-ptrn-elision-step-err tests
    const src = `
      class Test262Error {
        message: string;
        constructor(msg: string) { this.message = msg; }
      }

      function assert_throws(fn: () => void): number {
        try {
          fn();
          return 0; // did not throw
        } catch (e) {
          return 1; // threw as expected
        }
      }

      export function test(): number {
        var following = 0;
        var iter = function* () {
          throw new Test262Error();
          following = following + 1;
        }();

        var f = function() {
          var arr = iter;
          var tmp = arr;
          // simulate [,] destructuring: advance iterator once
          tmp.next();
        };

        var result = assert_throws(f);
        if (result !== 1) return 2; // should have thrown
        if (following !== 0) return 3; // following should still be 0
        return 1;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("generator throw deferred: subsequent next() after throw returns done", async () => {
    const src = `
      export function test(): number {
        var iter = function* () {
          throw new TypeError("err");
        }();
        // First next() throws
        try { iter.next(); } catch (e) {}
        // Second next() should return done (not throw again)
        var r = iter.next();
        if (!r.done) return 2;
        return 1;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("normal generator still works after fix", async () => {
    // Make sure existing generator functionality isn't broken
    const src = `
      export function test(): number {
        var sum = 0;
        var iter = function* () {
          yield 1;
          yield 2;
          yield 3;
        }();
        var r = iter.next();
        while (!r.done) {
          sum = sum + r.value;
          r = iter.next();
        }
        if (sum !== 6) return 2;
        return 1;
      }
    `;
    expect(await run(src)).toBe(1);
  });
});
