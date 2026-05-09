// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1395 Phase 1 — class identifier as constructor object + static-method
// descriptor.
//
// Before this PR, the bare class identifier `C` resolved to `ref.null.extern`
// because `compileIdentifier` had no case for class names. So
// `Object.getOwnPropertyDescriptor(C, "m")` was effectively
// `Object.getOwnPropertyDescriptor(null, "m")` and returned `null`. This blocked
// ~70 test262 tests in the `language/{statements,expressions}/class/elements/`
// cluster that use `verifyProperty(C, "m", { enumerable: false, configurable: true,
// writable: true })` to check static-method descriptors per ECMA-262 §15.7.1.
//
// Phase 1 emits a `__class_<Name>` singleton global per class (mirror of the
// `__proto_<Name>` singleton from #1047) and registers static-method names
// with `_staticMethodNames` via the new `__register_class_object` host import.
// The runtime's `__getOwnPropertyDescriptor` arm returns the spec descriptor
// when the receiver is in `_staticMethodNames`. JS-host mode is unchanged for
// non-class receivers.
//
// Tests run from the host side and inspect descriptor objects returned from
// wasm — these are real JS objects (host's `Object.getOwnPropertyDescriptor`
// builds them), so flag checks are direct property reads, not wasm-side
// extern_get round-trips.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, jsString } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

async function runTest(source: string, exportName: string): Promise<unknown> {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error("compile failed: " + r.errors.map((e) => e.message).join("\n"));
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, {
    env: built.env,
    string_constants: built.string_constants,
    "wasm:js-string": jsString,
  });
  if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
  const fn = instance.exports[exportName] as () => unknown;
  return fn();
}

describe("#1395 Phase 1 — class identifier as constructor object", () => {
  describe("static-method descriptor", () => {
    it("Object.getOwnPropertyDescriptor(C, 'm') returns the spec descriptor", async () => {
      const src = `
        class C {
          static m() { return 42; }
        }
        export function getDesc(): any {
          return Object.getOwnPropertyDescriptor(C, "m");
        }
      `;
      const desc = (await runTest(src, "getDesc")) as PropertyDescriptor;
      expect(desc).not.toBeNull();
      expect(desc).toBeDefined();
      expect(desc.enumerable).toBe(false);
      expect(desc.configurable).toBe(true);
      expect(desc.writable).toBe(true);
      expect(typeof desc.value).toBe("function");
    });

    it("class identifier `C` is not null at the JS boundary", async () => {
      const src = `
        class C { static m() { return 42; } }
        export function getC(): any { return C; }
      `;
      const c = await runTest(src, "getC");
      expect(c).not.toBeNull();
      expect(c).toBeDefined();
    });

    it("Object.getOwnPropertyNames(C) includes the static method", async () => {
      const src = `
        class C {
          static m() { return 42; }
          static n() { return 7; }
        }
        export function getNames(): any { return Object.getOwnPropertyNames(C); }
      `;
      const names = (await runTest(src, "getNames")) as string[];
      expect(names).toContain("m");
      expect(names).toContain("n");
    });

    it("static method NOT present on prototype (own to constructor only)", async () => {
      const src = `
        class C {
          static m() { return 42; }
          n() { return 7; }
        }
        export function descOnProto(): any {
          return Object.getOwnPropertyDescriptor(C.prototype, "m");
        }
      `;
      // m is static — not on the prototype. Returns undefined per spec.
      const desc = await runTest(src, "descOnProto");
      expect(desc).toBeFalsy();
    });

    it("multiple static methods each get correct descriptors", async () => {
      const src = `
        class C {
          static a() { return 1; }
          static b() { return 2; }
        }
        export function getA(): any { return Object.getOwnPropertyDescriptor(C, "a"); }
        export function getB(): any { return Object.getOwnPropertyDescriptor(C, "b"); }
      `;
      const a = (await runTest(src, "getA")) as PropertyDescriptor;
      expect(a).toBeTruthy();
      expect(a.enumerable).toBe(false);
      expect(a.configurable).toBe(true);
      expect(a.writable).toBe(true);
      const b = (await runTest(src, "getB")) as PropertyDescriptor;
      expect(b).toBeTruthy();
      expect(b.enumerable).toBe(false);
      expect(b.configurable).toBe(true);
      expect(b.writable).toBe(true);
    });

    it("static and instance methods with the same name produce separate descriptors", async () => {
      const src = `
        class C {
          static m() { return 1; }
          m() { return 2; }
        }
        export function staticDesc(): any { return Object.getOwnPropertyDescriptor(C, "m"); }
        export function instanceDesc(): any { return Object.getOwnPropertyDescriptor(C.prototype, "m"); }
      `;
      const s = (await runTest(src, "staticDesc")) as PropertyDescriptor;
      expect(s).toBeTruthy();
      expect(typeof s.value).toBe("function");
      const i = (await runTest(src, "instanceDesc")) as PropertyDescriptor;
      expect(i).toBeTruthy();
      expect(typeof i.value).toBe("function");
      // The two function values must be DIFFERENT bridges (separate methods).
      expect(s.value).not.toBe(i.value);
    });
  });

  describe("regression — instance-method descriptors unchanged", () => {
    it("Object.getOwnPropertyDescriptor(C.prototype, 'm') still returns spec descriptor", async () => {
      const src = `
        class C { m() { return 42; } }
        export function descOnProto(): any {
          return Object.getOwnPropertyDescriptor(C.prototype, "m");
        }
      `;
      const desc = (await runTest(src, "descOnProto")) as PropertyDescriptor;
      expect(desc).toBeTruthy();
      expect(desc.enumerable).toBe(false);
      expect(desc.configurable).toBe(true);
      expect(desc.writable).toBe(true);
      expect(typeof desc.value).toBe("function");
    });

    it("static-method dispatch still works (C.m() returns the value)", async () => {
      const src = `
        class C { static m(): number { return 42; } }
        export function callIt(): number { return C.m(); }
      `;
      expect(await runTest(src, "callIt")).toBe(42);
    });
  });

  describe("edge cases", () => {
    it("class with no static methods does not crash on identifier read", async () => {
      const src = `
        class C { m() { return 42; } }
        export function getC(): any { return C; }
      `;
      const c = await runTest(src, "getC");
      expect(c).not.toBeNull();
      expect(c).toBeDefined();
    });

    it("looking up a non-existent static method returns falsy", async () => {
      const src = `
        class C { static m() { return 42; } }
        export function getNoSuch(): any {
          return Object.getOwnPropertyDescriptor(C, "noSuchMethod");
        }
      `;
      const desc = await runTest(src, "getNoSuch");
      // Runtime returns undefined; the wasm-side wrapping may surface as null
      // at the JS boundary. Either way it's falsy.
      expect(desc).toBeFalsy();
    });
  });
});
