/**
 * #1047 — public instance fields must not leak onto C.prototype.
 *
 * Root cause: `emitLazyProtoGet` materializes `C.prototype` as a full struct
 * with default values for every instance field; when the JS host wraps that
 * ref via `_wrapForHost`, the Proxy's ownKeys / getOwnPropertyDescriptor
 * traps enumerate `__struct_field_names` and return field names like `"a"`,
 * `"b"` as own properties of the prototype. ES semantics: only method names
 * should be own properties of `C.prototype`.
 *
 * Fix (Option B): the compiler emits a `__register_prototype(proto, csv)`
 * host call inside the lazy-init branch, populating a runtime WeakMap of
 * prototype refs → method-only allowlist. `_wrapForHost` consults this
 * allowlist before falling back to struct-field enumeration.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<unknown> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  return (instance.exports as Record<string, CallableFunction>).main?.();
}

describe("#1047 — instance fields must not leak onto prototype", () => {
  it("public instance field is not own property of prototype", async () => {
    const result = await run(`
      class C { a = 1; b = 42; }
      export function main(): number {
        const aLeaked = Object.prototype.hasOwnProperty.call(C.prototype, "a") ? 1 : 0;
        const bLeaked = Object.prototype.hasOwnProperty.call(C.prototype, "b") ? 1 : 0;
        return aLeaked * 10 + bLeaked;
      }
    `);
    expect(result).toBe(0);
  });

  it("method is own property of prototype, instance field is not", async () => {
    const result = await run(`
      class C { a = 1; foo() { return 7; } }
      export function main(): number {
        const fooOwn = Object.prototype.hasOwnProperty.call(C.prototype, "foo") ? 1 : 0;
        const aOwn = Object.prototype.hasOwnProperty.call(C.prototype, "a") ? 1 : 0;
        return fooOwn * 10 + aOwn;
      }
    `);
    expect(result).toBe(10);
  });

  it("instance has its own instance field", async () => {
    const result = await run(`
      class C { a = 1; foo() { return 7; } }
      export function main(): number {
        const c = new C();
        return Object.prototype.hasOwnProperty.call(c, "a") ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Object.getOwnPropertyNames(C.prototype) excludes instance fields", async () => {
    const result = await run(`
      class C { a = 0; b = 0; foo() {} bar() {} }
      export function main(): number {
        const names = Object.getOwnPropertyNames(C.prototype);
        let hasA = 0, hasB = 0, hasFoo = 0, hasBar = 0;
        for (let i = 0; i < names.length; i++) {
          if (names[i] === "a") hasA = 1;
          if (names[i] === "b") hasB = 1;
          if (names[i] === "foo") hasFoo = 1;
          if (names[i] === "bar") hasBar = 1;
        }
        return hasA * 1000 + hasB * 100 + hasFoo * 10 + hasBar;
      }
    `);
    expect(result).toBe(11);
  });

  it("inherited method is not own property of child prototype", async () => {
    const result = await run(`
      class P { foo() { return 1; } }
      class C extends P { a = 0; bar() { return 2; } }
      export function main(): number {
        const pFooOwn = Object.prototype.hasOwnProperty.call(P.prototype, "foo") ? 1 : 0;
        const cBarOwn = Object.prototype.hasOwnProperty.call(C.prototype, "bar") ? 1 : 0;
        const cFooOwn = Object.prototype.hasOwnProperty.call(C.prototype, "foo") ? 1 : 0;
        const cAOwn = Object.prototype.hasOwnProperty.call(C.prototype, "a") ? 1 : 0;
        return pFooOwn * 1000 + cBarOwn * 100 + cFooOwn * 10 + cAOwn;
      }
    `);
    expect(result).toBe(1100);
  });
});
