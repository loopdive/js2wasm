/**
 * Tests for JSON.stringify support on WasmGC structs and arrays.
 *
 * Covers:
 * - Basic struct serialization (opaque WasmGC structs converted via exported getters)
 * - Nested structs (recursive conversion)
 * - Arrays of structs (vec wrapper detection and element conversion)
 * - Struct fields containing arrays
 * - JSON.stringify with replacer and space arguments (3-arg support)
 * - Primitive values (numbers, strings, null)
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function instantiate(src: string) {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors.map((e) => e.message).join("\n"));
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as any);
  if ((imports as any).setExports) (imports as any).setExports(instance.exports as any);
  return instance.exports as Record<string, Function>;
}

describe("JSON.stringify on WasmGC structs", () => {
  it("serializes a basic struct", async () => {
    const exports = await instantiate(`
      interface Point { x: number; y: number; }
      export function test(): string {
        const p: Point = { x: 1, y: 2 };
        return JSON.stringify(p);
      }
    `);
    expect(JSON.parse(exports.test() as unknown as string)).toEqual({ x: 1, y: 2 });
  });

  it("serializes nested structs recursively", async () => {
    const exports = await instantiate(`
      interface Inner { value: number; }
      interface Outer { inner: Inner; label: string; }
      export function test(): string {
        return JSON.stringify({ inner: { value: 99 }, label: "nested" } as Outer);
      }
    `);
    expect(JSON.parse(exports.test() as unknown as string)).toEqual({
      inner: { value: 99 },
      label: "nested",
    });
  });

  it("serializes an array of structs", async () => {
    const exports = await instantiate(`
      interface Item { name: string; value: number; }
      export function test(): string {
        return JSON.stringify([{name: "a", value: 1}, {name: "b", value: 2}] as Item[]);
      }
    `);
    const result = JSON.parse(exports.test() as unknown as string);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: "a", value: 1 });
    expect(result[1]).toEqual({ name: "b", value: 2 });
  });

  it("serializes a struct with an array field", async () => {
    const exports = await instantiate(`
      interface Item { name: string; tags: string[]; }
      export function test(): string {
        return JSON.stringify({ name: "x", tags: ["a", "b"] } as Item);
      }
    `);
    const result = JSON.parse(exports.test() as unknown as string);
    expect(result.name).toBe("x");
    expect(result.tags).toEqual(["a", "b"]);
  });

  it("serializes an array of numbers", async () => {
    const exports = await instantiate(`
      export function test(): string {
        return JSON.stringify([1, 2, 3]);
      }
    `);
    expect(JSON.parse(exports.test() as unknown as string)).toEqual([1, 2, 3]);
  });

  it("serializes an empty array", async () => {
    const exports = await instantiate(`
      export function test(): string {
        return JSON.stringify([] as number[]);
      }
    `);
    expect(JSON.parse(exports.test() as unknown as string)).toEqual([]);
  });

  it("supports the space argument for pretty-printing", async () => {
    const exports = await instantiate(`
      export function test(): string {
        return JSON.stringify({a: 1, b: 2}, null, 2);
      }
    `);
    const result = exports.test() as unknown as string;
    expect(result).toContain("\n");
    expect(JSON.parse(result)).toEqual({ a: 1, b: 2 });
  });

  it("serializes primitive values correctly", async () => {
    const exports = await instantiate(`
      export function testNum(): string { return JSON.stringify(42); }
      export function testStr(): string { return JSON.stringify("hello"); }
      export function testNull(): string { return JSON.stringify(null); }
    `);
    expect(exports.testNum()).toBe("42");
    expect(exports.testStr()).toBe('"hello"');
    expect(exports.testNull()).toBe("null");
  });
});
