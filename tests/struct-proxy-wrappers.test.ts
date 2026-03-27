/**
 * Tests for JS proxy wrappers for WasmGC structs.
 *
 * WasmGC structs are opaque to JS — property access returns undefined,
 * Object.keys() returns [], JSON.stringify() returns "{}".
 * The compiler emits __sget_* exports for individual field access and
 * __struct_field_names for field name discovery, enabling the runtime
 * to make structs behave like regular JS objects.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function instantiate(src: string) {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors.map(e => e.message).join("\n"));
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as any);
  if (imports.setExports) imports.setExports(instance.exports as any);
  return instance.exports as Record<string, Function>;
}

describe("struct proxy wrappers", () => {
  it("exports __struct_field_names function", async () => {
    const exports = await instantiate(`
      interface Point { x: number; y: number; }
      function makePoint(): Point { return { x: 1, y: 2 }; }
      export function getPoint(): any { return makePoint(); }
    `);
    expect(typeof exports.__struct_field_names).toBe("function");
  });

  it("__struct_field_names returns comma-separated field names", async () => {
    const exports = await instantiate(`
      interface Point { x: number; y: number; label: string; }
      function makePoint(): Point { return { x: 10, y: 20, label: "hi" }; }
      export function getPoint(): any { return makePoint(); }
    `);
    const p = exports.getPoint();
    const csv = exports.__struct_field_names(p);
    expect(csv).toBe("x,y,label");
  });

  it("__sget_* exports read field values", async () => {
    const exports = await instantiate(`
      interface Data { name: string; value: number; flag: boolean; }
      function makeData(): Data { return { name: "test", value: 42, flag: true }; }
      export function getData(): any { return makeData(); }
    `);
    const d = exports.getData();
    expect((exports as any).__sget_name(d)).toBe("test");
    expect((exports as any).__sget_value(d)).toBe(42);
    // boolean is stored as i32 (0/1)
    expect((exports as any).__sget_flag(d)).toBe(1);
  });

  it("__struct_field_names returns null for non-struct values", async () => {
    const exports = await instantiate(`
      interface Point { x: number; }
      function makePoint(): Point { return { x: 1 }; }
      export function getPoint(): any { return makePoint(); }
    `);
    // Pass a non-struct value (string)
    const result = exports.__struct_field_names("hello");
    expect(result).toBeNull();
  });

  it("JSON.stringify works on WasmGC structs via runtime", async () => {
    const exports = await instantiate(`
      interface Config { host: string; port: number; }
      function makeConfig(): Config { return { host: "localhost", port: 8080 }; }
      export function getJson(): string {
        const c = makeConfig();
        return JSON.stringify(c);
      }
    `);
    const json = exports.getJson() as unknown as string;
    const parsed = JSON.parse(json);
    expect(parsed).toEqual({ host: "localhost", port: 8080 });
  });

  it("handles multiple struct types in the same module", async () => {
    const exports = await instantiate(`
      interface Point { x: number; y: number; }
      interface Color { r: number; g: number; b: number; }
      function makePoint(): Point { return { x: 1, y: 2 }; }
      function makeColor(): Color { return { r: 255, g: 128, b: 0 }; }
      export function getPoint(): any { return makePoint(); }
      export function getColor(): any { return makeColor(); }
    `);
    const p = exports.getPoint();
    const c = exports.getColor();

    const pNames = exports.__struct_field_names(p);
    const cNames = exports.__struct_field_names(c);

    expect(pNames).toBe("x,y");
    expect(cNames).toBe("r,g,b");
  });

  it("handles nested struct types", async () => {
    const exports = await instantiate(`
      interface Inner { value: number; }
      interface Outer { inner: Inner; name: string; }
      function make(): Outer {
        return { inner: { value: 42 }, name: "test" };
      }
      export function getOuter(): any { return make(); }
    `);
    const o = exports.getOuter();
    const names = exports.__struct_field_names(o);
    expect(names).toBe("inner,name");

    // Access the nested struct
    const inner = (exports as any).__sget_inner(o);
    expect(inner).toBeDefined();
    const innerNames = exports.__struct_field_names(inner);
    expect(innerNames).toBe("value");
    expect((exports as any).__sget_value(inner)).toBe(42);
  });

  it("JSON.stringify handles nested WasmGC structs recursively", async () => {
    const exports = await instantiate(`
      interface Inner { value: number; }
      interface Outer { inner: Inner; label: string; }
      function make(): Outer {
        return { inner: { value: 99 }, label: "nested" };
      }
      export function getJson(): string {
        return JSON.stringify(make());
      }
    `);
    const json = exports.getJson() as unknown as string;
    const parsed = JSON.parse(json);
    expect(parsed).toEqual({ inner: { value: 99 }, label: "nested" });
  });
});
