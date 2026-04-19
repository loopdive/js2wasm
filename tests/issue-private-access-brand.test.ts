// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Regression tests for class method .call(nonInstance) brand check.
 *
 * When a class method is invoked via `.call(o)` where `o` is not an instance
 * of the class, the receiver was being cast directly to the method's
 * self-param struct type, so the Wasm trap was uncatchable and
 * `assert.throws(TypeError, ...)` could not intercept it.
 *
 * Fix: emit a `ref.test` guard + catchable TypeError on mismatch before the
 * cast. Matches the ES private-field brand-check semantics from the inner
 * function / inner arrow access patterns in test262
 * `language/expressions/class/elements/private-*-access-on-inner-*.js`.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function runSrc(src: string): Promise<number> {
  const r = compile(src, { fileName: "t.ts" });
  if (!r.success) throw new Error(`CE: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as any).setExports?.(instance.exports);
  return (instance.exports as any).test();
}

describe("class method .call(nonInstance) brand check", () => {
  it("private field access via inner function with wrong receiver throws TypeError", async () => {
    const src = `
      class C {
        #f: string = 'Test262';
        method(): string {
          const self = this;
          function inner(): string { return self.#f; }
          return inner();
        }
      }
      export function test(): number {
        const c = new C();
        if (c.method() !== 'Test262') return 0;
        let threw = 0;
        try {
          const o: any = {};
          (c.method as any).call(o);
        } catch (e: any) {
          threw = 1;
        }
        return threw;
      }
    `;
    expect(await runSrc(src)).toBe(1);
  });

  it("private getter access via inner arrow with wrong receiver throws TypeError", async () => {
    const src = `
      class C {
        get #m(): string { return 'Test262'; }
        method(): string {
          const inner = (): string => this.#m;
          return inner();
        }
      }
      export function test(): number {
        const c = new C();
        if (c.method() !== 'Test262') return 0;
        let threw = 0;
        try {
          const o: any = {};
          (c.method as any).call(o);
        } catch (e: any) {
          threw = 1;
        }
        return threw;
      }
    `;
    expect(await runSrc(src)).toBe(1);
  });

  it("private field access with correct receiver via .call() still works", async () => {
    const src = `
      class C {
        #value: number = 42;
        get(): number { return this.#value; }
      }
      export function test(): number {
        const c1 = new C();
        const c2 = new C();
        const v = (c1.get as any).call(c2);
        return v === 42 ? 1 : 0;
      }
    `;
    expect(await runSrc(src)).toBe(1);
  });

  it("private method access via inner arrow with wrong receiver throws TypeError", async () => {
    const src = `
      class C {
        #m(): string { return 'Test262'; }
        method(): string {
          const inner = (): string => this.#m();
          return inner();
        }
      }
      export function test(): number {
        const c = new C();
        if (c.method() !== 'Test262') return 0;
        let threw = 0;
        try {
          const o: any = {};
          (c.method as any).call(o);
        } catch (e: any) {
          threw = 1;
        }
        return threw;
      }
    `;
    expect(await runSrc(src)).toBe(1);
  });
});
