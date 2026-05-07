// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1319 — `Cannot convert object to primitive value` cluster.
//
// `_hostToPrimitive` in src/runtime.ts implements ECMA-262 §7.1.1 OrdinaryToPrimitive:
// it walks Symbol.toPrimitive → valueOf → toString and throws TypeError if no chain
// returns a primitive. That matches the spec — but the spec assumes the operand
// inherits Object.prototype.toString. WasmGC structs have a null prototype, so a
// user class that omits all three methods (e.g. our test262 preamble's Test262Error)
// previously fell off the end and threw, even though the same shape as a plain JS
// object — `String({})` — V8 handles by inheriting Object.prototype.toString and
// producing "[object Object]".
//
// The fix mirrors the existing fallback in `_toPrimitiveSync` (line ~477):
// before throwing, if `raw` is a wasm-struct, return "[object Object]" — matches
// what V8 would produce for an ordinary {}.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<Record<string, Function>> {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed:\n${r.errors.map((e) => `  L${e.line}:${e.column} ${e.message}`).join("\n")}`);
  }
  new WebAssembly.Module(r.binary);
  const imports: any = buildImports(r.imports, undefined, r.stringPool);
  const inst = await WebAssembly.instantiate(r.binary, imports);
  if (typeof imports.setExports === "function") imports.setExports(inst.instance.exports);
  return inst.instance.exports as Record<string, Function>;
}

describe("#1319 — ToPrimitive on wasm-structs without valueOf/toString/Symbol.toPrimitive", () => {
  /**
   * The headline test262 cluster: a class with NO conversion methods (the
   * shape of `Test262Error` in our preamble). Previously
   * `_hostToPrimitive(testError, "string")` threw because the proxy yields
   * undefined for Symbol.toPrimitive / valueOf / toString and our runtime
   * has no Object.prototype.toString fallback.
   */
  it("Math.floor on a no-method class instance does not throw 'Cannot convert object'", async () => {
    const exports = await run(`
      class Bare {
        x: number = 1;
      }
      export function test(): number {
        const b = new Bare();
        // Forces ToPrimitive("number") via codegen's ref→f64 path.
        return Math.floor((b as any) - 0);
      }
    `);
    // [object Object] coerces to NaN under JS Number(); Math.floor(NaN) === NaN.
    // Either NaN or 0 is acceptable — what matters is that the call does not
    // throw "Cannot convert object to primitive value".
    expect(() => exports.test!()).not.toThrow();
  });

  /**
   * A class WITH a defined valueOf must still be invoked — the new wasm-struct
   * fallback only fires when no chain matched.
   */
  it("class with valueOf is invoked correctly (regression guard for fix)", async () => {
    const exports = await run(`
      class Boxed {
        v: number;
        constructor(v: number) { this.v = v; }
        valueOf(): number { return this.v; }
      }
      export function test(): number {
        const b = new Boxed(42);
        return ((b as any) - 0) + 1;
      }
    `);
    expect(exports.test!()).toBe(43);
  });

  /**
   * A class WITH Symbol.toPrimitive must still go through that path.
   */
  it("class with Symbol.toPrimitive is invoked correctly (regression guard)", async () => {
    const exports = await run(`
      class Coerce {
        [Symbol.toPrimitive](hint: string): any {
          return hint === "number" ? 7 : "STR";
        }
      }
      export function test_num(): number {
        return ((new Coerce() as any) - 0) + 100;
      }
      export function test_str(): string {
        return \`got \${new Coerce()}\`;
      }
      export function test(): number { return 1; }
    `);
    expect(exports.test_num!()).toBe(107);
    expect(exports.test_str!()).toBe("got STR");
  });
});
