import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { buildImports } from "./helpers.js";

/**
 * Compile TS source to Wasm in fast mode, instantiate it, and return exports.
 * Issue #697: non-class struct type errors caused by widenNonDefaultableTypes
 * not widening block types (if/block/loop) while widening function types.
 */
async function compileFast(source: string) {
  const result = compile(source, { fast: true });
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    );
  }
  const mod = await WebAssembly.compile(result.binary as BufferSource);
  const baseImports = buildImports(result);
  const proxyImports = new Proxy(baseImports, {
    get(target, module: string) {
      if (module in target) {
        return new Proxy(target[module] as Record<string, unknown>, {
          get(inner, field: string) {
            if (field in inner) return inner[field];
            return () => 0;
          },
        });
      }
      return new Proxy({}, { get: () => () => 0 });
    },
  });
  const instance = await WebAssembly.instantiate(mod, proxyImports as WebAssembly.Imports);
  return instance.exports as Record<string, Function>;
}

describe("issue-697: block type widening for non-class structs", () => {
  it("any + any in fast mode (if block type ref vs ref_null)", async () => {
    const exports = await compileFast(`
      export function f(): number {
        const a: any = 1;
        const b: any = 2;
        return a + b;
      }
    `);
    expect(exports.f()).toBe(3);
  });

  it("any - any in fast mode", async () => {
    const exports = await compileFast(`
      export function f(): number {
        const a: any = 5;
        const b: any = 3;
        return a - b;
      }
    `);
    expect(exports.f()).toBe(2);
  });

  it("any * any in fast mode", async () => {
    const exports = await compileFast(`
      export function f(): number {
        const a: any = 6;
        const b: any = 7;
        return a * b;
      }
    `);
    expect(exports.f()).toBe(42);
  });

  it("any == any in fast mode", async () => {
    const exports = await compileFast(`
      export function f(): number {
        const a: any = 42;
        const b: any = 42;
        return a == b ? 1 : 0;
      }
    `);
    expect(exports.f()).toBe(1);
  });

  it("any < any comparison in fast mode", async () => {
    const exports = await compileFast(`
      export function f(): number {
        const a: any = 1;
        const b: any = 2;
        return a < b ? 1 : 0;
      }
    `);
    expect(exports.f()).toBe(1);
  });
});
