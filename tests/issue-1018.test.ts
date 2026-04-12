/**
 * Tests for #1018: Object.getOwnPropertyDescriptor returns null for
 * built-in prototype properties.
 *
 * Root cause: Built-in constructors like Date, RegExp, Map, Set, Promise
 * were missing from AMBIENT_BUILTIN_CTORS in index.ts, so compileIdentifier
 * fell through to the graceful fallback emitting ref.null.extern. Accessing
 * .prototype on null then threw a TypeError instead of resolving the real
 * host prototype.
 *
 * Fix: Added missing built-in types to AMBIENT_BUILTIN_CTORS and LIB_GLOBALS
 * so they resolve via global_X host imports (like Object, Array already did).
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<unknown> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (r.setExports) r.setExports(instance.exports as any);
  return (instance.exports as Record<string, CallableFunction>).main?.();
}

describe("#1018 — GOPD on built-in globals returns valid descriptor", () => {
  it("Object.getOwnPropertyDescriptor(Math, 'PI') returns non-null descriptor", async () => {
    const result = await run(`
      export function main(): number {
        const desc = Object.getOwnPropertyDescriptor(Math, "PI");
        return desc != null ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Object.getOwnPropertyDescriptor(Math, 'atan2') returns non-null descriptor", async () => {
    const result = await run(`
      export function main(): number {
        const desc = Object.getOwnPropertyDescriptor(Math, "atan2");
        return desc != null ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Object.getOwnPropertyDescriptor(JSON, 'stringify') returns non-null", async () => {
    const result = await run(`
      export function main(): number {
        const desc = Object.getOwnPropertyDescriptor(JSON, "stringify");
        return desc != null ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  // No regression on user-defined objects
  it("Object.getOwnPropertyDescriptor on user-defined struct still works", async () => {
    const result = await run(`
      export function main(): number {
        const obj = { x: 42 };
        const desc = Object.getOwnPropertyDescriptor(obj, "x");
        return desc != null && desc.value === 42 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });
});

describe("#1018 — Built-in .prototype access resolves to host object", () => {
  it("Date.prototype is accessible (not null)", async () => {
    const result = await run(`
      export function main(): number {
        var p: any = Date.prototype;
        return p !== null && p !== undefined ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("RegExp.prototype is accessible", async () => {
    const result = await run(`
      export function main(): number {
        var p: any = RegExp.prototype;
        return p !== null && p !== undefined ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Map.prototype is accessible", async () => {
    const result = await run(`
      export function main(): number {
        var p: any = Map.prototype;
        return p !== null && p !== undefined ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Set.prototype is accessible", async () => {
    const result = await run(`
      export function main(): number {
        var p: any = Set.prototype;
        return p !== null && p !== undefined ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Promise.prototype is accessible", async () => {
    const result = await run(`
      export function main(): number {
        var p: any = Promise.prototype;
        return p !== null && p !== undefined ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("GOPD on Date.prototype.getDate returns descriptor", async () => {
    const result = await run(`
      export function main(): number {
        var desc: any = Object.getOwnPropertyDescriptor(Date.prototype, "getDate");
        if (desc === undefined || desc === null) return 0;
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("GOPD on RegExp.prototype.test returns descriptor", async () => {
    const result = await run(`
      export function main(): number {
        var desc: any = Object.getOwnPropertyDescriptor(RegExp.prototype, "test");
        if (desc === undefined || desc === null) return 0;
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("GOPD on Map.prototype.get returns descriptor", async () => {
    const result = await run(`
      export function main(): number {
        var desc: any = Object.getOwnPropertyDescriptor(Map.prototype, "get");
        if (desc === undefined || desc === null) return 0;
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  // Shadowing safety — local declarations MUST win over built-in globals
  it("local variable 'let Math = 42' shadows the built-in", async () => {
    const result = await run(`
      export function main(): number {
        let Math = 42;
        return Math as unknown as number;
      }
    `);
    expect(result).toBe(42);
  });
});
