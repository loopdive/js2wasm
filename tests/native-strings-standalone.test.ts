import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * Tests for the standalone `nativeStrings` compile option.
 *
 * These verify that native WasmGC strings can be activated independently
 * from fast mode (numbers remain f64, strings use WasmGC arrays).
 * This is the key scenario for non-browser runtimes (WASI, wasmtime, wasmer)
 * that cannot provide wasm:js-string imports.
 *
 * Note: runtime execution tests are in native-strings.test.ts (fast mode).
 * The __str_padStart helper has a pre-existing type error that prevents
 * instantiation of modules with native string helpers, so runtime tests
 * are deferred until that is fixed.
 */

describe("nativeStrings flag (standalone, no fast mode)", () => {

  it("compiles string literals using NativeString types", () => {
    const result = compile(
      `export function test(): string { return "hello"; }`,
      { nativeStrings: true },
    );
    expect(result.success, result.errors.map(e => e.message).join("\n")).toBe(true);
    expect(result.wat).toContain("NativeString");
    expect(result.wat).toContain("__str_data");
    // Must NOT have wasm:js-string or string_constants imports
    expect(result.wat).not.toContain("wasm:js-string");
    expect(result.wat).not.toContain("string_constants");
  });

  it("numbers remain f64 (not i32) when nativeStrings is on without fast", () => {
    const result = compile(
      `export function test(): number { return 42; }`,
      { nativeStrings: true },
    );
    expect(result.success).toBe(true);
    // f64 numbers should be present, not i32
    expect(result.wat).toContain("f64.const");
  });

  it("string and number types coexist correctly", () => {
    const src = `
      export function test(): number {
        const s = "hello";
        return s.length;
      }
    `;
    const result = compile(src, { nativeStrings: true });
    expect(result.success, result.errors.map(e => e.message).join("\n")).toBe(true);
    // String uses native types
    expect(result.wat).toContain("NativeString");
    // Number result is f64
    expect(result.wat).toContain("(result f64)");
  });

  it("auto-enables native strings for WASI target", () => {
    const result = compile(
      `export function test(): string { return "hello"; }`,
      { target: "wasi" },
    );
    expect(result.success, result.errors.map(e => e.message).join("\n")).toBe(true);
    expect(result.wat).toContain("NativeString");
    expect(result.wat).not.toContain("wasm:js-string");
  });

  it("fast mode still enables native strings", () => {
    const result = compile(
      `export function test(): string { return "hello"; }`,
      { fast: true },
    );
    expect(result.success, result.errors.map(e => e.message).join("\n")).toBe(true);
    expect(result.wat).toContain("NativeString");
    expect(result.wat).not.toContain("wasm:js-string");
  });

  it("non-fast non-nativeStrings mode uses externref strings", () => {
    const result = compile(
      `export function test(): string { return "hello"; }`,
    );
    expect(result.success).toBe(true);
    expect(result.wat).toContain("externref");
    expect(result.wat).toContain("string_constants");
    expect(result.wat).not.toContain("NativeString");
  });

  it("string equality compiles without wasm:js-string", () => {
    const src = `
      export function test(): number {
        return "hello" === "world" ? 1 : 0;
      }
    `;
    const result = compile(src, { nativeStrings: true });
    expect(result.success, result.errors.map(e => e.message).join("\n")).toBe(true);
    expect(result.wat).not.toContain("wasm:js-string");
    expect(result.wat).not.toContain("string_constants");
  });

  it("string concatenation compiles without wasm:js-string", () => {
    const src = `
      export function test(): number {
        const a = "hello";
        const b = " world";
        return (a + b).length;
      }
    `;
    const result = compile(src, { nativeStrings: true });
    expect(result.success, result.errors.map(e => e.message).join("\n")).toBe(true);
    expect(result.wat).not.toContain("wasm:js-string");
  });

  it("string methods compile without host imports", () => {
    const src = `
      export function test(): number {
        return "hello world".indexOf("world");
      }
    `;
    const result = compile(src, { nativeStrings: true });
    expect(result.success, result.errors.map(e => e.message).join("\n")).toBe(true);
    expect(result.wat).not.toContain("wasm:js-string");
    expect(result.wat).not.toContain("string_indexOf");
  });

  it("nativeStrings: false explicitly disables even with fast", () => {
    // When nativeStrings is explicitly set to false, it should take
    // precedence over fast mode's default
    const result = compile(
      `export function test(): string { return "hello"; }`,
      { fast: true, nativeStrings: false },
    );
    expect(result.success).toBe(true);
    // Explicitly disabled native strings, so should use externref
    expect(result.wat).not.toContain("NativeString");
    expect(result.wat).toContain("string_constants");
  });

  // Issue #679: string_compare and String_fromCharCode should not be host imports
  // when nativeStrings is true — pure Wasm implementations are used instead.

  it("string comparison (<) compiles without string_compare host import", () => {
    const src = `
      export function test(): boolean {
        const a: string = "apple";
        const b: string = "banana";
        return a < b;
      }
    `;
    const result = compile(src, { nativeStrings: true });
    expect(result.success, result.errors.map(e => e.message).join("\n")).toBe(true);
    // WAT should not contain a string_compare import
    expect(result.wat).not.toContain('"string_compare"');
    // But should contain the native __str_compare helper
    expect(result.wat).toContain("__str_compare");
  });

  it("string comparison (<=, >=) compiles without string_compare host import", () => {
    const src = `
      export function test(): boolean {
        const a: string = "abc";
        const b: string = "abc";
        return a <= b && a >= b;
      }
    `;
    const result = compile(src, { nativeStrings: true });
    expect(result.success, result.errors.map(e => e.message).join("\n")).toBe(true);
    expect(result.wat).not.toContain('"string_compare"');
  });

  it("String.fromCharCode compiles without host import in native mode", () => {
    const src = `
      export function test(): string {
        return String.fromCharCode(65);
      }
    `;
    const result = compile(src, { nativeStrings: true });
    expect(result.success, result.errors.map(e => e.message).join("\n")).toBe(true);
    // WAT should not contain a String_fromCharCode import
    expect(result.wat).not.toContain('"String_fromCharCode"');
    // But should contain the native __str_fromCharCode helper
    expect(result.wat).toContain("__str_fromCharCode");
  });

  it("host mode still registers string_compare import", () => {
    const src = `
      export function test(): boolean {
        const a: string = "apple";
        const b: string = "banana";
        return a < b;
      }
    `;
    const result = compile(src, { nativeStrings: false });
    expect(result.success).toBe(true);
    expect(result.wat).toContain('"string_compare"');
  });

  it("host mode still registers String_fromCharCode import", () => {
    const src = `
      export function test(): string {
        return String.fromCharCode(65);
      }
    `;
    const result = compile(src, { nativeStrings: false });
    expect(result.success).toBe(true);
    expect(result.wat).toContain('"String_fromCharCode"');
  });
});
