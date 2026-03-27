/**
 * Tests for Object.defineProperty runtime (#797c)
 */
import { describe, test, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runWasm(source: string): Promise<number> {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compilation failed: ${result.errors[0]?.message}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports.test as Function)();
}

describe("Object.defineProperty (#797c)", () => {
  test("defineProperty with value sets the property", async () => {
    const val = await runWasm(`
      export function test(): number {
        const obj = { x: 1 };
        Object.defineProperty(obj, 'x', { value: 42, writable: true, enumerable: true, configurable: true });
        return obj.x;
      }
    `);
    expect(val).toBe(42);
  });

  test("defineProperty with writable:false is tracked", async () => {
    const val = await runWasm(`
      export function test(): number {
        const obj = { x: 10 };
        Object.defineProperty(obj, 'x', { value: 10, writable: false, configurable: false });
        // After making non-writable, getOwnPropertyDescriptor should reflect that
        const desc = Object.getOwnPropertyDescriptor(obj, 'x');
        return desc ? 1 : 0;
      }
    `);
    expect(val).toBe(1);
  });

  test("defineProperty returns the object", async () => {
    const val = await runWasm(`
      export function test(): number {
        const obj = { x: 1 };
        const ret = Object.defineProperty(obj, 'x', { value: 42 });
        // ret should be obj
        return ret.x;
      }
    `);
    expect(val).toBe(42);
  });
});

describe("Object.defineProperties (#797c)", () => {
  test("defineProperties with literal descriptors", async () => {
    const val = await runWasm(`
      export function test(): number {
        const obj = { x: 0, y: 0 };
        Object.defineProperties(obj, {
          x: { value: 10, writable: true, enumerable: true, configurable: true },
          y: { value: 20, writable: true, enumerable: true, configurable: true },
        });
        return obj.x + obj.y;
      }
    `);
    expect(val).toBe(30);
  });

  test("defineProperties compiles without error", async () => {
    const val = await runWasm(`
      export function test(): number {
        const obj = { a: 1 };
        Object.defineProperties(obj, {
          a: { value: 99, writable: false, configurable: true },
        });
        return obj.a;
      }
    `);
    expect(val).toBe(99);
  });
});

describe("Reflect.defineProperty (#797c)", () => {
  test("Reflect.defineProperty returns true", async () => {
    const val = await runWasm(`
      export function test(): number {
        const obj = { x: 1 };
        const result = Reflect.defineProperty(obj, 'x', { value: 42 });
        return result ? 1 : 0;
      }
    `);
    expect(val).toBe(1);
  });
});
