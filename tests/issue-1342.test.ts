// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #1342 — Boolean wrapper coercion + Symbol.keyFor undefined return.
 *
 * Two related fixes:
 *
 * 1. **Boolean.prototype.METHOD.call(primitive)** — primitive booleans (i32)
 *    box through `__box_number` to Number externref before reaching the host
 *    `__proto_method_call` shim. `Boolean.prototype.toString.call(true)`
 *    therefore arrived as `Boolean.prototype.toString.call(1)`, which V8
 *    rejects with "requires that 'this' be a Boolean". Spec §20.3.3.2's
 *    `ToBooleanthisValue` accepts both Boolean primitives and wrappers, so
 *    we coerce numeric receivers back to Boolean before the dispatch call.
 *
 * 2. **Symbol.keyFor on a non-registered symbol** — runtime impl previously
 *    coerced `undefined` to `null` via `?? null`, breaking `Symbol.keyFor(s)
 *    === undefined` checks (§20.4.2.6).
 */
async function run(src: string): Promise<{ exports: Record<string, unknown> }> {
  const r = compile(src, { fileName: "test.ts" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return { exports: instance.exports as Record<string, unknown> };
}

describe("#1342 — Boolean wrapper coercion + Symbol.keyFor", () => {
  it("Boolean.prototype.toString.call(true) returns 'true'", async () => {
    const { exports } = await run(`
      export function test(): string {
        return Boolean.prototype.toString.call(true);
      }
    `);
    expect((exports.test as () => string)()).toBe("true");
  });

  it("Boolean.prototype.toString.call(false) returns 'false'", async () => {
    const { exports } = await run(`
      export function test(): string {
        return Boolean.prototype.toString.call(false);
      }
    `);
    expect((exports.test as () => string)()).toBe("false");
  });

  it("Boolean.prototype.toString.call(new Boolean(true)) returns 'true'", async () => {
    const { exports } = await run(`
      export function test(): string {
        return Boolean.prototype.toString.call(new Boolean(true));
      }
    `);
    expect((exports.test as () => string)()).toBe("true");
  });

  it("Boolean.prototype.toString.call(undefined) throws TypeError", async () => {
    const { exports } = await run(`
      export function test(): string {
        try {
          return Boolean.prototype.toString.call(undefined);
        } catch (e) {
          return (e instanceof TypeError) ? "TypeError" : "Wrong";
        }
      }
    `);
    expect((exports.test as () => string)()).toBe("TypeError");
  });

  it("Symbol.keyFor returns undefined for non-registered symbols (not null)", async () => {
    const { exports } = await run(`
      export function test(): boolean {
        const s = Symbol("not-registered");
        return Symbol.keyFor(s) === undefined;
      }
    `);
    // Wasm boolean returns surface as i32 (1) to JS host
    expect((exports.test as () => number)()).toBe(1);
  });

  it("Symbol.for returns the same symbol for the same key", async () => {
    const { exports } = await run(`
      export function test(): boolean {
        return Symbol.for("k") === Symbol.for("k");
      }
    `);
    // Wasm boolean returns surface as i32 (1) to JS host
    expect((exports.test as () => number)()).toBe(1);
  });
});
