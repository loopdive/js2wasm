/**
 * Issue #998 — Class static-private method line-terminator variants emit
 * argless call/return_call in constructors (121 CE)
 *
 * Root cause: in the `isStaticMethod` call dispatch path, `getFuncParamTypes`
 * was called with a stale `funcIdx` after compiling the receiver expression.
 * When `this` is used in a static method context, `emitUndefined` is called,
 * which triggers `addUnionImports` → `__get_undefined` import insertion →
 * all function indices shift by 1. The stale `funcIdx` then looked up the
 * wrong (import) function's params (returning [] instead of [f64]), so 0
 * arguments were emitted before the call/return_call instruction.
 *
 * Fix: re-resolve `funcIdx` via `ctx.funcMap.get(fullName)` after receiver
 * compilation, before calling `getFuncParamTypes`.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(source: string): Promise<number> {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any).test() as number;
}

function expectValid(name: string, source: string) {
  it(name, () => {
    const result = compile(source, { fileName: "test.ts" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
    }
  });
}

describe("Issue #998: static private method variants — argless call/return_call", () => {
  // Minimal reproduction: static method with private method call, preceded by
  // generator method (which triggers the addUnionImports shift via emitUndefined)
  it("static private method with generator instance method (return_call variant)", async () => {
    const result = await run(`
      var C = class {
        static #$(value: number): number {
          return value;
        }
        *m(): any { return 42; }
        static $(value: number): number {
          return this.#$(value);
        }
      }
      export function test(): number {
        return C.$(1) === 1 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("static private method with async instance method (call variant)", async () => {
    const result = await run(`
      class C {
        static async m(): Promise<number> { return 42; }
        static #x(value: number): number {
          return value / 2;
        }
        static #y(value: number): number {
          return value * 2;
        }
        static x(): number {
          return this.#x(84);
        }
        static y(): number {
          return this.#y(43);
        }
      }
      export function test(): number {
        return C.x() === 42 && C.y() === 86 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("multiple static private methods with special names (#$, #_, #o)", async () => {
    const result = await run(`
      var C = class {
        static #$(value: number): number { return value; }
        static #_(value: number): number { return value * 2; }
        static #o(value: number): number { return value + 1; }
        *m(): any { return 42; }
        static $(value: number): number { return this.#$(value); }
        static _(value: number): number { return this.#_(value); }
        static o(value: number): number { return this.#o(value); }
      }
      export function test(): number {
        return C.$(1) === 1 && C._(2) === 4 && C.o(3) === 4 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("non-return position static private call (call variant, not return_call)", async () => {
    const result = await run(`
      var C = class {
        *m(): any { return 42; }
        static #$(value: number): number { return value; }
        static $(value: number): number {
          const x = this.#$(value);
          return x;
        }
      }
      export function test(): number {
        return C.$(5) === 5 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  // Binary-level validity tests (just check compile + wasm.validate)
  expectValid(
    "static private method after static async method (after-same-line pattern)",
    `
    class C {
      static async m(): Promise<number> { return 42; }
      static #x(value: number): number { return value / 2; }
      static #y(value: number): number { return value * 2; }
      static x(): number { return this.#x(84); }
      static y(): number { return this.#y(43); }
    }
    export function test(): number { return 1; }
  `,
  );

  expectValid(
    "static private method with generator (new-sc-line pattern)",
    `
    var C = class {
      static #$(v: number): number { return v; }
      static #_(v: number): number { return v; }
      *m(): any { return 42; }
      static $(v: number): number { return this.#$(v); }
      static _(v: number): number { return this.#_(v); }
    }
    export function test(): number { return 1; }
  `,
  );

  expectValid(
    "static private method after static async generator (async-gen pattern)",
    `
    class C {
      static async *m(): AsyncGenerator<number> { yield 42; }
      static #x(v: number): number { return v; }
      static x(): number { return this.#x(1); }
    }
    export function test(): number { return 1; }
  `,
  );
});
