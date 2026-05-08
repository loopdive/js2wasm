/**
 * Tests for issue #1364a: instance method descriptors on `C.prototype`.
 *
 * Slice A — instance methods only. Static methods, fields, accessors,
 * generators, private members are deferred to follow-up slices.
 *
 * Before this slice: `Object.getOwnPropertyDescriptor(C.prototype, "m")`
 * returned `undefined` for class methods because the proto's WasmGC
 * struct didn't expose method names as own properties — `verifyProperty`
 * tests under `language/{statements,expressions}/class/elements/`
 * failed at the very first descriptor lookup.
 *
 * Fix: extend `__getOwnPropertyDescriptor` host import (and the codegen
 * fast path) to recognise the `_prototypeMethodNames` allowlist and
 * return a method descriptor with the spec-correct flags
 * (`enumerable: false, configurable: true, writable: true`). Methods
 * resolve to a cached bridge function so repeated reads return the
 * same reference (`assert.sameValue` holds).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runTest(src: string): Promise<unknown> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`compile failed: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as Record<string, () => unknown>).test!();
}

describe("issue #1364a: class instance method descriptors on C.prototype", () => {
  it("getOwnPropertyDescriptor returns a real descriptor (not undefined)", async () => {
    const src = `
class C { m() {} }
export function test(): number {
  const desc = Object.getOwnPropertyDescriptor(C.prototype, "m");
  return desc ? 1 : 0;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("descriptor.enumerable === false (spec §15.7.1.1)", async () => {
    const src = `
class C { m() {} }
export function test(): number {
  const desc = Object.getOwnPropertyDescriptor(C.prototype, "m");
  if (!desc) return 100;
  return (desc as any).enumerable === false ? 1 : 0;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("descriptor.configurable === true", async () => {
    const src = `
class C { m() {} }
export function test(): number {
  const desc = Object.getOwnPropertyDescriptor(C.prototype, "m");
  if (!desc) return 100;
  return (desc as any).configurable === true ? 1 : 0;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("descriptor.writable === true", async () => {
    const src = `
class C { m() {} }
export function test(): number {
  const desc = Object.getOwnPropertyDescriptor(C.prototype, "m");
  if (!desc) return 100;
  return (desc as any).writable === true ? 1 : 0;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("descriptor.value is a function", async () => {
    const src = `
class C { m() {} }
export function test(): number {
  const desc = Object.getOwnPropertyDescriptor(C.prototype, "m");
  if (!desc) return 100;
  return typeof (desc as any).value === "function" ? 1 : 0;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("repeated descriptor reads return the same value reference", async () => {
    // verifyProperty-style assertions like `assert.sameValue(c.m, C.prototype.m)`
    // require referential equality across reads.
    const src = `
class C { m() {} }
export function test(): number {
  const d1 = Object.getOwnPropertyDescriptor(C.prototype, "m");
  const d2 = Object.getOwnPropertyDescriptor(C.prototype, "m");
  if (!d1 || !d2) return 100;
  return (d1 as any).value === (d2 as any).value ? 1 : 0;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("hasOwnProperty.call(C.prototype, 'm') === true", async () => {
    const src = `
class C { m() {} }
export function test(): number {
  return Object.prototype.hasOwnProperty.call(C.prototype, "m") ? 1 : 0;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("Object.keys(C.prototype) is empty (methods are non-enumerable)", async () => {
    const src = `
class C { m() {} n() {} k() {} }
export function test(): number {
  return Object.keys(C.prototype).length === 0 ? 1 : 0;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("multiple methods each have correct descriptors", async () => {
    const src = `
class C { m() {} n() {} k() {} }
export function test(): number {
  const dm = Object.getOwnPropertyDescriptor(C.prototype, "m");
  const dn = Object.getOwnPropertyDescriptor(C.prototype, "n");
  const dk = Object.getOwnPropertyDescriptor(C.prototype, "k");
  if (!dm || !dn || !dk) return 100;
  if ((dm as any).enumerable !== false) return 101;
  if ((dn as any).enumerable !== false) return 102;
  if ((dk as any).enumerable !== false) return 103;
  return 1;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("regression: actual method invocation still works (instance.method())", async () => {
    const src = `
class C { m(): number { return 42; } }
export function test(): number {
  const c = new C();
  return c.m() === 42 ? 1 : 0;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("regression: getOwnPropertyDescriptor on instance fields unchanged", async () => {
    const src = `
class C {
  x: number;
  constructor() { this.x = 5; }
}
export function test(): number {
  const c = new C();
  const d = Object.getOwnPropertyDescriptor(c, "x");
  if (!d) return 100;
  if ((d as any).value !== 5) return 101;
  if ((d as any).enumerable !== true) return 102;
  return 1;
}
`;
    expect(await runTest(src)).toBe(1);
  });

  it("regression: getOwnPropertyDescriptor for unknown method returns falsy (no descriptor)", async () => {
    // The codegen fast path emits `ref.null.extern` for missing properties on
    // a known struct shape, which surfaces as `null` rather than `undefined`
    // on the JS side. That's a pre-existing discrepancy (predates #1364a) and
    // not something this slice changes — both `null` and `undefined` are
    // falsy, so the negative branch in `verifyProperty` works either way.
    const src = `
class C { m() {} }
export function test(): number {
  const d = Object.getOwnPropertyDescriptor(C.prototype, "doesNotExist");
  return d ? 0 : 1;
}
`;
    expect(await runTest(src)).toBe(1);
  });
});
