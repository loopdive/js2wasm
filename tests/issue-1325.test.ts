// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1325 — instanceof built-in type-tag registry.
 *
 * Phase 1: static-elimination of `instanceof <BuiltIn>` when the LHS TS type
 * (or stack value type) makes the answer compile-time obvious. This avoids a
 * `__instanceof` host import call in standalone / WASI mode (where the host
 * import is unavailable) and is also a small perf win in JS-host mode.
 *
 * The unit tests for the registry itself live in this file; behavioural tests
 * compile snippets and run them through the JS host's `__instanceof` shim so
 * that the static-resolution path produces the same result as the runtime
 * path would.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import {
  BUILTIN_TYPE_TAGS,
  getBuiltinParent,
  isBuiltinSubtype,
  isBuiltinTypeName,
} from "../src/codegen/builtin-tags.js";

// ── Helper ────────────────────────────────────────────────────────────

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  // The static-elimination path bypasses `__instanceof`; the host-fallback
  // path calls into JS via `buildImports`, which wires `__instanceof` to a
  // real `value instanceof globalThis[ctorName]` lookup.
  const built = buildImports(result.imports, ENV_STUB, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, {
    env: built.env,
    string_constants: built.string_constants,
  });
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]!(...args);
}

// ── Registry unit tests ───────────────────────────────────────────────

describe("#1325 builtin-tags registry", () => {
  it("lists Array, Error, *Error, Map, Set, etc.", () => {
    for (const name of [
      "Array",
      "Error",
      "TypeError",
      "RangeError",
      "SyntaxError",
      "URIError",
      "EvalError",
      "ReferenceError",
      "AggregateError",
      "Map",
      "Set",
      "WeakMap",
      "WeakSet",
      "Date",
      "RegExp",
      "Promise",
      "ArrayBuffer",
    ]) {
      expect(isBuiltinTypeName(name)).toBe(true);
    }
  });

  it("uses negative tag values (so they cannot collide with user class tags)", () => {
    for (const tag of Object.values(BUILTIN_TYPE_TAGS)) {
      expect(tag).toBeLessThan(0);
    }
  });

  it("encodes the *Error → Error parent chain", () => {
    expect(getBuiltinParent("TypeError")).toBe("Error");
    expect(getBuiltinParent("RangeError")).toBe("Error");
    expect(getBuiltinParent("SyntaxError")).toBe("Error");
    expect(getBuiltinParent("URIError")).toBe("Error");
    expect(getBuiltinParent("EvalError")).toBe("Error");
    expect(getBuiltinParent("ReferenceError")).toBe("Error");
    expect(getBuiltinParent("AggregateError")).toBe("Error");
  });

  it("isBuiltinSubtype: TypeError <: Error, Error <: Error", () => {
    expect(isBuiltinSubtype("TypeError", "Error")).toBe(true);
    expect(isBuiltinSubtype("RangeError", "Error")).toBe(true);
    expect(isBuiltinSubtype("Error", "Error")).toBe(true);
    expect(isBuiltinSubtype("SyntaxError", "TypeError")).toBe(false);
    expect(isBuiltinSubtype("Array", "Error")).toBe(false);
    expect(isBuiltinSubtype("Map", "Set")).toBe(false);
  });

  it("isBuiltinSubtype: returns false for unknown names", () => {
    expect(isBuiltinSubtype("Unknown", "Error")).toBe(false);
    expect(isBuiltinSubtype("Error", "Unknown")).toBe(false);
  });

  it("isBuiltinTypeName: rejects non-built-ins", () => {
    expect(isBuiltinTypeName("Foo")).toBe(false);
    expect(isBuiltinTypeName("MyClass")).toBe(false);
    expect(isBuiltinTypeName("")).toBe(false);
  });
});

// ── End-to-end behavioural tests ──────────────────────────────────────

describe("#1325 instanceof BuiltIn — static elimination", () => {
  it("123 instanceof Array → false (primitive numeric LHS, no host call)", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const x: number = 123;
          // TS narrows x to number, so RHS=Array is statically eliminated to false.
          return (x as unknown) instanceof Array ? 1 : 0;
        }
      `,
        "test",
      ),
    ).toBe(0);
  });

  it("user-class instance instanceof Array → false (struct ref vs builtin)", async () => {
    expect(
      await run(
        `
        class Foo {
          x: number;
          constructor(x: number) { this.x = x; }
        }
        export function test(): number {
          const f = new Foo(1);
          return (f as unknown) instanceof Array ? 1 : 0;
        }
      `,
        "test",
      ),
    ).toBe(0);
  });

  it("user-class instance instanceof Error → false", async () => {
    expect(
      await run(
        `
        class Foo {
          x: number;
          constructor(x: number) { this.x = x; }
        }
        export function test(): number {
          const f = new Foo(1);
          return (f as unknown) instanceof Error ? 1 : 0;
        }
      `,
        "test",
      ),
    ).toBe(0);
  });

  it("preserves user-class instanceof user-class (regression check)", async () => {
    // This goes through compileInstanceOf (struct __tag path), NOT
    // compileHostInstanceOf — verifying the static-elimination changes don't
    // disturb the existing path.
    expect(
      await run(
        `
        class Animal { legs: number; constructor(l: number) { this.legs = l; } }
        class Dog extends Animal { name: number; constructor(n: number) { super(4); this.name = n; } }
        export function test(): number {
          const d = new Dog(1);
          let r = 0;
          if (d instanceof Animal) r = r + 1;
          if (d instanceof Dog) r = r + 2;
          return r;
        }
      `,
        "test",
      ),
    ).toBe(3);
  });

  it("new TypeError() instanceof Error → true (host fallback when import present)", async () => {
    // When the LHS TS symbol is "TypeError" the static path SHOULD recognise it
    // and emit i32.const 1. If TS doesn't surface the symbol (which is sometimes
    // the case in this test harness), the host fallback handles it correctly.
    expect(
      await run(
        `
        export function test(): number {
          const e = new TypeError("x");
          return e instanceof Error ? 1 : 0;
        }
      `,
        "test",
      ),
    ).toBe(1);
  });

  it("[] instanceof Array → true via host fallback (regression check)", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const a: unknown[] = [];
          return a instanceof Array ? 1 : 0;
        }
      `,
        "test",
      ),
    ).toBe(1);
  });

  it("{} instanceof Array → false via host fallback (regression check)", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const o: object = {};
          return o instanceof Array ? 1 : 0;
        }
      `,
        "test",
      ),
    ).toBe(0);
  });
});
