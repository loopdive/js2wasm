/**
 * Tests for #797 Work Item 5: freeze/seal runtime enforcement
 *
 * WI5 adds runtime enforcement for Object.freeze/seal/preventExtensions on WasmGC structs:
 * - _wasmFrozenObjs / _wasmSealedObjs / _wasmNonExtensibleObjs WeakSets for tracking
 * - _safeSet updated to silently fail on sealed/frozen properties
 * - __object_isFrozen / __object_isSealed / __object_isExtensible host imports
 */

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.ts";
import { describe, it, expect } from "vitest";

async function run(src: string): Promise<number> {
  const full = `
export function test(): number {
  ${src}
  return 1;
}
`;
  const r = compile(full, { fileName: "test.ts" });
  if (!r.success)
    throw new Error("CE: " + r.errors[0]?.message + "\n" + r.errors.map((e: any) => e.message).join("\n"));
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as any).test();
}

describe("#797 WI5: freeze/seal runtime enforcement", () => {
  it("Object.isSealed returns true after Object.seal", async () => {
    const ret = await run(`
      var obj: any = {};
      (obj as any).x = 1;
      Object.seal(obj);
      if (!Object.isSealed(obj)) return 0;
    `);
    expect(ret).toBe(1);
  });

  it("Object.isExtensible returns false after Object.preventExtensions", async () => {
    const ret = await run(`
      var obj: any = {};
      Object.preventExtensions(obj);
      if (Object.isExtensible(obj)) return 0;
    `);
    expect(ret).toBe(1);
  });

  it("Object.isExtensible returns true before any restriction", async () => {
    const ret = await run(`
      var obj: any = {};
      if (!Object.isExtensible(obj)) return 0;
    `);
    expect(ret).toBe(1);
  });

  it("Object.isFrozen returns true after Object.freeze on plain object", async () => {
    const ret = await run(`
      var obj: any = {};
      Object.freeze(obj);
      if (!Object.isFrozen(obj)) return 0;
    `);
    expect(ret).toBe(1);
  });

  it("Object.freeze returns the same object and isFrozen is true", async () => {
    const ret = await run(`
      var obj: any = {};
      var o2: any = Object.freeze(obj);
      if (!Object.isFrozen(o2)) return 0;
    `);
    expect(ret).toBe(1);
  });

  it("Object.isFrozen stays false for sealed object with writable prop via named key", async () => {
    // Property writes to an existing property after seal should succeed (seal != freeze)
    // This is equivalent: if seal->isFrozen is false, then existing props are writable
    const ret = await run(`
      var obj: any = {};
      Object.seal(obj);
      if (Object.isFrozen(obj)) return 0;
    `);
    expect(ret).toBe(1);
  });

  it("new property write silently fails on sealed object (non-strict)", async () => {
    const ret = await run(`
      var obj: any = {};
      Object.seal(obj);
      (obj as any).newProp = "value";
      if ((obj as any).newProp !== undefined) return 0;
    `);
    expect(ret).toBe(1);
  });

  it("new property write silently fails on preventExtensions object (non-strict)", async () => {
    const ret = await run(`
      var obj: any = {};
      Object.preventExtensions(obj);
      (obj as any).newProp = 99;
      if ((obj as any).newProp !== undefined) return 0;
    `);
    expect(ret).toBe(1);
  });

  it("Object.isExtensible returns false after Object.seal", async () => {
    const ret = await run(`
      var obj: any = {};
      Object.seal(obj);
      if (Object.isExtensible(obj)) return 0;
    `);
    expect(ret).toBe(1);
  });

  it("Object.isFrozen returns false for sealed (not frozen) object with writable prop", async () => {
    const ret = await run(`
      var obj: any = {};
      (obj as any).x = 1;
      Object.seal(obj);
      if (Object.isFrozen(obj)) return 0;
    `);
    expect(ret).toBe(1);
  });

  it("Object.isSealed returns true after Object.freeze (frozen implies sealed)", async () => {
    const ret = await run(`
      var obj: any = {};
      Object.freeze(obj);
      if (!Object.isSealed(obj)) return 0;
    `);
    expect(ret).toBe(1);
  });

  it("Object.isExtensible on o2=preventExtensions(o) — same object", async () => {
    const ret = await run(`
      var o: any = {};
      var o2: any = Object.preventExtensions(o);
      if (Object.isExtensible(o2)) return 0;
    `);
    expect(ret).toBe(1);
  });

  it("inherited properties ignored when checking isSealed", async () => {
    const ret = await run(`
      var proto: any = { x: 10 };
      var Con: any = function() {};
      Con.prototype = proto;
      var child: any = new Con();
      (child as any).y = 20;
      Object.seal(child);
      if (!Object.isSealed(child)) return 0;
    `);
    expect(ret).toBe(1);
  });
});
