/**
 * Tests for Object.freeze/seal/preventExtensions compile-away (#797d)
 */
import { describe, test, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

function compileAndRun(source: string): any {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compilation failed: ${result.errors[0]?.message}`);
  }
  return result;
}

async function runWasm(source: string): Promise<number> {
  const result = compileAndRun(source);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports.test as Function)();
}

describe("Object.freeze compile-away", () => {
  test("Object.freeze returns the object", async () => {
    const val = await runWasm(`
      export function test(): number {
        const obj = { x: 42 };
        const frozen = Object.freeze(obj);
        return frozen.x;
      }
    `);
    expect(val).toBe(42);
  });

  test("Object.isFrozen returns true for frozen objects", async () => {
    const val = await runWasm(`
      export function test(): number {
        const obj = { x: 1 };
        Object.freeze(obj);
        return Object.isFrozen(obj) ? 1 : 0;
      }
    `);
    expect(val).toBe(1);
  });

  test("Object.isFrozen returns false for non-frozen objects", async () => {
    const val = await runWasm(`
      export function test(): number {
        const obj = { x: 1 };
        return Object.isFrozen(obj) ? 1 : 0;
      }
    `);
    expect(val).toBe(0);
  });

  test("Object.isSealed returns true for frozen objects (frozen implies sealed)", async () => {
    const val = await runWasm(`
      export function test(): number {
        const obj = { x: 1 };
        Object.freeze(obj);
        return Object.isSealed(obj) ? 1 : 0;
      }
    `);
    expect(val).toBe(1);
  });

  test("Object.seal marks as sealed", async () => {
    const val = await runWasm(`
      export function test(): number {
        const obj = { x: 1 };
        Object.seal(obj);
        return Object.isSealed(obj) ? 1 : 0;
      }
    `);
    expect(val).toBe(1);
  });

  test("Object.isExtensible returns false after preventExtensions", async () => {
    const val = await runWasm(`
      export function test(): number {
        const obj = { x: 1 };
        Object.preventExtensions(obj);
        return Object.isExtensible(obj) ? 1 : 0;
      }
    `);
    expect(val).toBe(0);
  });

  test("Object.isExtensible returns true for normal objects", async () => {
    const val = await runWasm(`
      export function test(): number {
        const obj = { x: 1 };
        return Object.isExtensible(obj) ? 1 : 0;
      }
    `);
    expect(val).toBe(1);
  });

  test("Object.freeze implies non-extensible", async () => {
    const val = await runWasm(`
      export function test(): number {
        const obj = { x: 1 };
        Object.freeze(obj);
        return Object.isExtensible(obj) ? 1 : 0;
      }
    `);
    expect(val).toBe(0);
  });
});

describe("Object.seal compile-away", () => {
  test("Sealed objects allow property modification", async () => {
    const val = await runWasm(`
      export function test(): number {
        const obj = { x: 10 };
        Object.seal(obj);
        obj.x = 20;
        return obj.x;
      }
    `);
    expect(val).toBe(20);
  });

  test("Object.seal implies non-extensible", async () => {
    const val = await runWasm(`
      export function test(): number {
        const obj = { x: 1 };
        Object.seal(obj);
        return Object.isExtensible(obj) ? 1 : 0;
      }
    `);
    expect(val).toBe(0);
  });
});

describe("Reflect methods", () => {
  test("Reflect.isExtensible returns false after preventExtensions", async () => {
    const val = await runWasm(`
      export function test(): number {
        const obj = { x: 1 };
        Object.preventExtensions(obj);
        return Reflect.isExtensible(obj) ? 1 : 0;
      }
    `);
    expect(val).toBe(0);
  });

  test("Reflect.preventExtensions marks non-extensible", async () => {
    const val = await runWasm(`
      export function test(): number {
        const obj = { x: 1 };
        Reflect.preventExtensions(obj);
        return Object.isExtensible(obj) ? 1 : 0;
      }
    `);
    expect(val).toBe(0);
  });
});
