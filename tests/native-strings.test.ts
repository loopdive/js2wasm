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

  // ── repeat ──────────────────────────────────────────────────────────

  it("repeat creates repeated string", async () => {
    const src = `export function test(): number {
      return "ab".repeat(3).length;
    }`;
    expect(await runFast(src)).toBe(6);
  });

  it("repeat preserves code units", async () => {
    const src = `export function test(): number {
      const s = "AB".repeat(2);
      return s.charCodeAt(2);
    }`;
    expect(await runFast(src)).toBe(65); // 'A'
  });

  it("repeat(0) returns empty string", async () => {
    const src = `export function test(): number {
      return "hello".repeat(0).length;
    }`;
    expect(await runFast(src)).toBe(0);
  });

  it("repeat(1) returns same-length string", async () => {
    const src = `export function test(): number {
      return "abc".repeat(1).length;
    }`;
    expect(await runFast(src)).toBe(3);
  });

  // ── padStart ───────────────────────────────────────────────────────

  it("padStart pads with spaces by default", async () => {
    const src = `export function test(): number {
      return "hi".padStart(5).length;
    }`;
    expect(await runFast(src)).toBe(5);
  });

  it("padStart pads with leading spaces", async () => {
    const src = `export function test(): number {
      return "hi".padStart(5).charCodeAt(0);
    }`;
    expect(await runFast(src)).toBe(32); // space
  });

  it("padStart preserves original at end", async () => {
    const src = `export function test(): number {
      return "hi".padStart(5).charCodeAt(3);
    }`;
    expect(await runFast(src)).toBe(104); // 'h'
  });

  it("padStart with custom pad string", async () => {
    const src = `export function test(): number {
      const s = "5".padStart(4, "0");
      return s.charCodeAt(0) * 1000 + s.charCodeAt(1) * 100 + s.charCodeAt(2) * 10 + s.charCodeAt(3);
    }`;
    // "0005" -> charCodes 48,48,48,53 -> 48000+4800+480+53 = 53333
    expect(await runFast(src)).toBe(53333);
  });

  it("padStart no-op when already long enough", async () => {
    const src = `export function test(): number {
      return "hello".padStart(3).length;
    }`;
    expect(await runFast(src)).toBe(5);
  });

  // ── padEnd ─────────────────────────────────────────────────────────

  it("padEnd pads with spaces by default", async () => {
    const src = `export function test(): number {
      return "hi".padEnd(5).length;
    }`;
    expect(await runFast(src)).toBe(5);
  });

  it("padEnd pads at the end", async () => {
    const src = `export function test(): number {
      return "hi".padEnd(5).charCodeAt(4);
    }`;
    expect(await runFast(src)).toBe(32); // space
  });

  it("padEnd with custom pad string", async () => {
    const src = `export function test(): number {
      const s = "1".padEnd(4, "0");
      return s.charCodeAt(0) * 1000 + s.charCodeAt(1) * 100 + s.charCodeAt(2) * 10 + s.charCodeAt(3);
    }`;
    // "1000" -> charCodes 49,48,48,48 -> 49000+4800+480+48 = 54328
    expect(await runFast(src)).toBe(54328);
  });

  it("padEnd no-op when already long enough", async () => {
    const src = `export function test(): number {
      return "hello".padEnd(3).length;
    }`;
    expect(await runFast(src)).toBe(5);
  });

  // ── toLowerCase / toUpperCase ──────────────────────────────────────

  it("toLowerCase converts ASCII uppercase", async () => {
    const src = `export function test(): number {
      const s = "HELLO".toLowerCase();
      return s.charCodeAt(0);
    }`;
    expect(await runFast(src)).toBe(104); // 'h'
  });

  it("toLowerCase preserves length", async () => {
    const src = `export function test(): number {
      return "HELLO".toLowerCase().length;
    }`;
    expect(await runFast(src)).toBe(5);
  });

  it("toLowerCase leaves non-uppercase unchanged", async () => {
    const src = `export function test(): number {
      const s = "hello123".toLowerCase();
      return s.charCodeAt(0);
    }`;
    expect(await runFast(src)).toBe(104); // 'h' (already lowercase)
  });

  it("toUpperCase converts ASCII lowercase", async () => {
    const src = `export function test(): number {
      const s = "hello".toUpperCase();
      return s.charCodeAt(0);
    }`;
    expect(await runFast(src)).toBe(72); // 'H'
  });

  it("toUpperCase preserves length", async () => {
    const src = `export function test(): number {
      return "hello".toUpperCase().length;
    }`;
    expect(await runFast(src)).toBe(5);
  });

  it("toUpperCase leaves non-lowercase unchanged", async () => {
    const src = `export function test(): number {
      const s = "HELLO123".toUpperCase();
      return s.charCodeAt(0);
    }`;
    expect(await runFast(src)).toBe(72); // 'H' (already uppercase)
  });

  // ── replace ─────────────────────────────────────────────────────────

  it("replace first occurrence", async () => {
    const src = `export function test(): number {
      const s = "hello world".replace("world", "there");
      return s.length;
    }`;
    expect(await runFast(src)).toBe(11); // "hello there"
  });

  it("replace preserves correct characters", async () => {
    const src = `export function test(): number {
      const s = "ABCDE".replace("CD", "XY");
      return s.charCodeAt(2) * 100 + s.charCodeAt(3);
    }`;
    // "ABXYE" -> X=88, Y=89 -> 8889
    expect(await runFast(src)).toBe(8889);
  });

  it("replace returns unchanged when not found", async () => {
    const src = `export function test(): number {
      const s = "hello".replace("xyz", "abc");
      return s.length;
    }`;
    expect(await runFast(src)).toBe(5);
  });

  it("replace with longer replacement", async () => {
    const src = `export function test(): number {
      const s = "ab".replace("a", "xyz");
      return s.length;
    }`;
    expect(await runFast(src)).toBe(4); // "xyzb"
  });

  it("replace with empty replacement (deletion)", async () => {
    const src = `export function test(): number {
      const s = "hello".replace("ll", "");
      return s.length;
    }`;
    expect(await runFast(src)).toBe(3); // "heo"
  });

  // ── split ─────────────────────────────────────────────────────────

  it("split by comma", async () => {
    const src = `export function test(): number {
      const parts = "a,b,c".split(",");
      return parts.length;
    }`;
    expect(await runFast(src)).toBe(3);
  });

  it("split returns correct substrings", async () => {
    const src = `export function test(): number {
      const parts = "hello world foo".split(" ");
      return parts[0].length * 100 + parts[1].length * 10 + parts[2].length;
    }`;
    // "hello"=5, "world"=5, "foo"=3 → 553
    expect(await runFast(src)).toBe(553);
  });

  it("split with no match returns single element", async () => {
    const src = `export function test(): number {
      const parts = "hello".split(",");
      return parts.length * 10 + parts[0].length;
    }`;
    // 1 part, length 5 → 15
    expect(await runFast(src)).toBe(15);
  });

  it("split by empty string splits each character", async () => {
    const src = `export function test(): number {
      const chars = "abc".split("");
      return chars.length;
    }`;
    expect(await runFast(src)).toBe(3);
  });

  it("split with multi-char separator", async () => {
    const src = `export function test(): number {
      const parts = "one::two::three".split("::");
      return parts.length;
    }`;
    expect(await runFast(src)).toBe(3);
  });

  it("split preserves empty strings between separators", async () => {
    const src = `export function test(): number {
      const parts = "a,,b".split(",");
      return parts.length * 10 + parts[1].length;
    }`;
    // 3 parts, middle part "" has length 0 → 30
    expect(await runFast(src)).toBe(30);
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

  // ── O(1) substring view tests (offset field) ─────────────────────

  it("substring of substring returns correct result", async () => {
    const src = `export function test(): number {
      const s = "hello world";
      const sub = s.substring(6, 11);  // "world"
      const sub2 = sub.substring(1, 4); // "orl"
      return sub2.length;
    }`;
    expect(await runFast(src)).toBe(3);
  });

  it("substring charCodeAt reads correct offset", async () => {
    const src = `export function test(): number {
      const s = "abcdef";
      const sub = s.substring(2, 5); // "cde"
      return sub.charCodeAt(0); // should be 99 = 'c'
    }`;
    expect(await runFast(src)).toBe(99);
  });

  it("substring charCodeAt at index 1", async () => {
    const src = `export function test(): number {
      const s = "abcdef";
      const sub = s.substring(2, 5); // "cde"
      return sub.charCodeAt(1); // should be 100 = 'd'
    }`;
    expect(await runFast(src)).toBe(100);
  });

  it("substring indexOf works with offset", async () => {
    const src = `export function test(): number {
      const s = "hello world";
      const sub = s.substring(6, 11); // "world"
      return sub.indexOf("rl");
    }`;
    expect(await runFast(src)).toBe(2);
  });

  it("slice creates correct view", async () => {
    const src = `export function test(): number {
      const s = "abcdefgh";
      const sub = s.slice(3, 7); // "defg"
      return sub.charCodeAt(2); // 'f' = 102
    }`;
    expect(await runFast(src)).toBe(102);
  });

  it("trim on substring works", async () => {
    const src = `export function test(): number {
      const s = "hello   world   ";
      const sub = s.substring(5, 16); // "   world   "
      const trimmed = sub.trim(); // "world"
      return trimmed.length;
    }`;
    expect(await runFast(src)).toBe(5);
  });

  it("concat of substrings works", async () => {
    const src = `export function test(): number {
      const s = "hello world";
      const a = s.substring(0, 5);  // "hello"
      const b = s.substring(5, 11); // " world"
      const c = a + b;              // "hello world"
      return c.length;
    }`;
    expect(await runFast(src)).toBe(11);
  });

  it("substring equality works", async () => {
    const src = `export function test(): number {
      const s = "abcabc";
      const a = s.substring(0, 3); // "abc"
      const b = s.substring(3, 6); // "abc"
      return a === b ? 1 : 0;
    }`;
    expect(await runFast(src)).toBe(1);
  });

  it("substring toLowerCase works with offset", async () => {
    const src = `export function test(): number {
      const s = "helloWORLD";
      const sub = s.substring(5, 10); // "WORLD"
      const lower = sub.toLowerCase();
      return lower.charCodeAt(0); // 'w' = 119
    }`;
    expect(await runFast(src)).toBe(119);
  });

  it("substring toUpperCase works with offset", async () => {
    const src = `export function test(): number {
      const s = "HELLOworld";
      const sub = s.substring(5, 10); // "world"
      const upper = sub.toUpperCase();
      return upper.charCodeAt(0); // 'W' = 87
    }`;
    expect(await runFast(src)).toBe(87);
  });

  it("nested slice of slice", async () => {
    const src = `export function test(): number {
      const s = "0123456789";
      const a = s.slice(2, 8);  // "234567"
      const b = a.slice(1, 4);  // "345"
      return b.charCodeAt(0);   // '3' = 51
    }`;
    expect(await runFast(src)).toBe(51);
  });

  it("substring repeat works", async () => {
    const src = `export function test(): number {
      const s = "abcdef";
      const sub = s.substring(0, 2); // "ab"
      const r = sub.repeat(3); // "ababab"
      return r.length;
    }`;
    expect(await runFast(src)).toBe(6);
  });

  it("substring startsWith works with offset", async () => {
    const src = `export function test(): number {
      const s = "hello world";
      const sub = s.substring(6, 11); // "world"
      return sub.startsWith("wor") ? 1 : 0;
    }`;
    expect(await runFast(src)).toBe(1);
  });

  it("substring endsWith works with offset", async () => {
    const src = `export function test(): number {
      const s = "hello world";
      const sub = s.substring(6, 11); // "world"
      return sub.endsWith("rld") ? 1 : 0;
    }`;
    expect(await runFast(src)).toBe(1);
  });
});
