import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

/**
 * Helper: compile with fast mode and instantiate, returning the named export.
 * Handles setExports for marshal helpers that need memory access.
 */
async function runFast(source: string, exportName = "test"): Promise<any> {
  const result = compile(source, { fast: true });
  if (!result.success) {
    throw new Error(result.errors.map(e => `L${e.line}: ${e.message}`).join("\n"));
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  if (imports.setExports) {
    imports.setExports(instance.exports as Record<string, Function>);
  }
  return (instance.exports[exportName] as Function)();
}

/**
 * Helper: compile with fast mode, instantiate, and call with args.
 */
async function runFastWithArgs(source: string, args: any[], exportName = "test"): Promise<any> {
  const result = compile(source, { fast: true });
  if (!result.success) {
    throw new Error(result.errors.map(e => `L${e.line}: ${e.message}`).join("\n"));
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  if (imports.setExports) {
    imports.setExports(instance.exports as Record<string, Function>);
  }
  return (instance.exports[exportName] as Function)(...args);
}

describe("fast mode: native strings", () => {
  // ── String literal and identity ──────────────────────────────────

  it("compiles without errors", () => {
    const result = compile(
      `export function test(): string { return "hello"; }`,
      { fast: true },
    );
    expect(result.success, result.errors.map(e => e.message).join("\n")).toBe(true);
  });

  it("WAT contains NativeString struct type", () => {
    const result = compile(
      `export function test(): string { return "hello"; }`,
      { fast: true },
    );
    expect(result.success).toBe(true);
    expect(result.wat).toContain("__str_data");
    expect(result.wat).toContain("NativeString");
    // Should NOT contain string_constants imports (externref globals)
    expect(result.wat).not.toContain("string_constants");
    // Should NOT contain wasm:js-string imports
    expect(result.wat).not.toContain("wasm:js-string");
  });

  it("WAT uses struct.new for string literals", () => {
    const result = compile(
      `export function test(): string { return "hi"; }`,
      { fast: true },
    );
    expect(result.success).toBe(true);
    expect(result.wat).toContain("struct.new");
    expect(result.wat).toContain("array.new_fixed");
  });

  // ── String length ────────────────────────────────────────────────

  it("string length returns correct value", async () => {
    const src = `export function test(): number {
      const s = "hello";
      return s.length;
    }`;
    expect(await runFast(src)).toBe(5);
  });

  it("empty string length is 0", async () => {
    const src = `export function test(): number {
      return "".length;
    }`;
    expect(await runFast(src)).toBe(0);
  });

  // ── charCodeAt ───────────────────────────────────────────────────

  it("charCodeAt returns correct code unit", async () => {
    const src = `export function test(): number {
      return "ABC".charCodeAt(1);
    }`;
    expect(await runFast(src)).toBe(66); // 'B'
  });

  it("charCodeAt index 0", async () => {
    const src = `export function test(): number {
      return "hello".charCodeAt(0);
    }`;
    expect(await runFast(src)).toBe(104); // 'h'
  });

  // ── String concatenation ─────────────────────────────────────────

  it("string concatenation returns correct length", async () => {
    const src = `export function test(): number {
      const a = "hello";
      const b = " world";
      const c = a + b;
      return c.length;
    }`;
    expect(await runFast(src)).toBe(11);
  });

  it("concatenated string has correct charCodeAt", async () => {
    const src = `export function test(): number {
      const s = "AB" + "CD";
      return s.charCodeAt(2);
    }`;
    expect(await runFast(src)).toBe(67); // 'C'
  });

  // ── String equality ──────────────────────────────────────────────

  it("equal strings compare as true", async () => {
    const src = `export function test(): number {
      return "hello" === "hello" ? 1 : 0;
    }`;
    expect(await runFast(src)).toBe(1);
  });

  it("different strings compare as false", async () => {
    const src = `export function test(): number {
      return "hello" === "world" ? 1 : 0;
    }`;
    expect(await runFast(src)).toBe(0);
  });

  it("inequality operator works", async () => {
    const src = `export function test(): number {
      return "a" !== "b" ? 1 : 0;
    }`;
    expect(await runFast(src)).toBe(1);
  });

  it("different-length strings are not equal", async () => {
    const src = `export function test(): number {
      return "ab" === "abc" ? 1 : 0;
    }`;
    expect(await runFast(src)).toBe(0);
  });

  // ── substring ────────────────────────────────────────────────────

  it("substring extracts correct slice", async () => {
    const src = `export function test(): number {
      const s = "hello world";
      const sub = s.substring(6, 11);
      return sub.length;
    }`;
    expect(await runFast(src)).toBe(5);
  });

  it("substring preserves code units", async () => {
    const src = `export function test(): number {
      const s = "ABCDE";
      const sub = s.substring(1, 4);
      return sub.charCodeAt(0);
    }`;
    expect(await runFast(src)).toBe(66); // 'B'
  });

  // ── charAt ───────────────────────────────────────────────────────

  it("charAt returns single-char string", async () => {
    const src = `export function test(): number {
      const s = "hello";
      const ch = s.charAt(1);
      return ch.length;
    }`;
    expect(await runFast(src)).toBe(1);
  });

  it("charAt returns correct character", async () => {
    const src = `export function test(): number {
      const s = "ABCDE";
      const ch = s.charAt(2);
      return ch.charCodeAt(0);
    }`;
    expect(await runFast(src)).toBe(67); // 'C'
  });

  // ── slice ────────────────────────────────────────────────────────

  it("slice with positive indices", async () => {
    const src = `export function test(): number {
      const s = "hello world";
      return s.slice(0, 5).length;
    }`;
    expect(await runFast(src)).toBe(5);
  });

  it("slice with negative index", async () => {
    const src = `export function test(): number {
      const s = "hello";
      return s.slice(-3, 5).length;
    }`;
    expect(await runFast(src)).toBe(3);
  });

  // ── String as function parameter and return ──────────────────────

  it("string parameter and return", async () => {
    const src = `
      function getLength(s: string): number {
        return s.length;
      }
      export function test(): number {
        return getLength("test");
      }
    `;
    expect(await runFast(src)).toBe(4);
  });

  it("string return from function", async () => {
    const src = `
      function greeting(): string {
        return "hi";
      }
      export function test(): number {
        return greeting().length;
      }
    `;
    expect(await runFast(src)).toBe(2);
  });

  // ── Conditional and control flow ─────────────────────────────────

  it("string comparison in conditional", async () => {
    const src = `export function test(): number {
      const s = "yes";
      if (s === "yes") {
        return 1;
      }
      return 0;
    }`;
    expect(await runFast(src)).toBe(1);
  });

  // ── indexOf ────────────────────────────────────────────────────────

  it("indexOf finds substring", async () => {
    const src = `export function test(): number {
      return "hello world".indexOf("world");
    }`;
    expect(await runFast(src)).toBe(6);
  });

  it("indexOf returns -1 for missing substring", async () => {
    const src = `export function test(): number {
      return "hello".indexOf("xyz");
    }`;
    expect(await runFast(src)).toBe(-1);
  });

  it("indexOf with fromIndex", async () => {
    const src = `export function test(): number {
      return "abcabc".indexOf("abc", 1);
    }`;
    expect(await runFast(src)).toBe(3);
  });

  it("indexOf empty string", async () => {
    const src = `export function test(): number {
      return "hello".indexOf("");
    }`;
    expect(await runFast(src)).toBe(0);
  });

  // ── lastIndexOf ─────────────────────────────────────────────────

  it("lastIndexOf finds last occurrence", async () => {
    const src = `export function test(): number {
      return "abcabc".lastIndexOf("abc");
    }`;
    expect(await runFast(src)).toBe(3);
  });

  it("lastIndexOf with fromIndex", async () => {
    const src = `export function test(): number {
      return "abcabc".lastIndexOf("abc", 2);
    }`;
    expect(await runFast(src)).toBe(0);
  });

  it("lastIndexOf returns -1 for missing", async () => {
    const src = `export function test(): number {
      return "hello".lastIndexOf("xyz");
    }`;
    expect(await runFast(src)).toBe(-1);
  });

  // ── includes ──────────────────────────────────────────────────────

  it("includes returns 1 when found", async () => {
    const src = `export function test(): number {
      return "hello world".includes("world") ? 1 : 0;
    }`;
    expect(await runFast(src)).toBe(1);
  });

  it("includes returns 0 when not found", async () => {
    const src = `export function test(): number {
      return "hello".includes("xyz") ? 1 : 0;
    }`;
    expect(await runFast(src)).toBe(0);
  });

  // ── startsWith ────────────────────────────────────────────────────

  it("startsWith returns true for prefix", async () => {
    const src = `export function test(): number {
      return "hello world".startsWith("hello") ? 1 : 0;
    }`;
    expect(await runFast(src)).toBe(1);
  });

  it("startsWith returns false for non-prefix", async () => {
    const src = `export function test(): number {
      return "hello".startsWith("world") ? 1 : 0;
    }`;
    expect(await runFast(src)).toBe(0);
  });

  it("startsWith with position", async () => {
    const src = `export function test(): number {
      return "hello world".startsWith("world", 6) ? 1 : 0;
    }`;
    expect(await runFast(src)).toBe(1);
  });

  // ── endsWith ──────────────────────────────────────────────────────

  it("endsWith returns true for suffix", async () => {
    const src = `export function test(): number {
      return "hello world".endsWith("world") ? 1 : 0;
    }`;
    expect(await runFast(src)).toBe(1);
  });

  it("endsWith returns false for non-suffix", async () => {
    const src = `export function test(): number {
      return "hello world".endsWith("hello") ? 1 : 0;
    }`;
    expect(await runFast(src)).toBe(0);
  });

  // ── trim ──────────────────────────────────────────────────────────

  it("trim removes leading and trailing whitespace", async () => {
    const src = `export function test(): number {
      return "  hello  ".trim().length;
    }`;
    expect(await runFast(src)).toBe(5);
  });

  it("trimStart removes leading whitespace only", async () => {
    const src = `export function test(): number {
      return "  hello  ".trimStart().length;
    }`;
    expect(await runFast(src)).toBe(7);
  });

  it("trimEnd removes trailing whitespace only", async () => {
    const src = `export function test(): number {
      return "  hello  ".trimEnd().length;
    }`;
    expect(await runFast(src)).toBe(7);
  });

  it("trim handles tabs and newlines", async () => {
    const src = String.raw`export function test(): number {
      return "\t\nhello\r\n".trim().length;
    }`;
    expect(await runFast(src)).toBe(5);
  });

  it("trim on already trimmed string", async () => {
    const src = `export function test(): number {
      return "hello".trim().length;
    }`;
    expect(await runFast(src)).toBe(5);
  });

  // ── Existing tests must still pass in non-fast mode ──────────────

  it("non-fast mode still uses externref strings", () => {
    const result = compile(
      `export function test(): string { return "hello"; }`,
    );
    expect(result.success).toBe(true);
    expect(result.wat).toContain("externref");
    expect(result.wat).toContain("string_constants");
  });
});
