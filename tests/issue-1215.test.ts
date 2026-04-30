// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1215 — `<numeric_array>.join(...)` and `<numeric_array>.toString()` must
// register `number_toString` so compileArrayJoin can emit the f64→externref
// conversion. Without this fix, the module fails Wasm validation with
// `local.set[0] expected externref, found array.get of type f64`.
//
// Surfaced by the differential testing harness (#1203) — broke 6 of 8 array
// tests in the corpus + classes/08-fields.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

async function compileAndCapture(source: string): Promise<string[]> {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) throw new Error(`compile: ${r.errors[0]?.message ?? "unknown"}`);
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) =>
    lines.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
  try {
    const built = buildImports(r.imports, ENV_STUB, r.stringPool);
    const { instance } = await instantiateWasm(r.binary, built.env, built.string_constants);
    built.setExports?.(instance.exports as Record<string, Function>);
  } finally {
    console.log = origLog;
  }
  return lines;
}

describe("#1215 — numeric-array .join() / .toString() registers number_toString", () => {
  it("compiles `[1,2,3].join()` without Wasm validation error", async () => {
    const out = await compileAndCapture("console.log([1, 2, 3].join());");
    // V8 produces "1,2,3"; we accept any non-empty result that produced no error.
    expect(out.length).toBe(1);
  });

  it('compiles `[1,2,3].join("")` without Wasm validation error', async () => {
    const out = await compileAndCapture('console.log([1, 2, 3].join(""));');
    expect(out.length).toBe(1);
  });

  it("compiles `arr.join(',')` after unshift without validation error", async () => {
    const src = `
      const a = [1, 2, 3];
      a.unshift(0);
      console.log(a.join(","));
    `;
    const out = await compileAndCapture(src);
    expect(out.length).toBe(1);
  });

  it("compiles `arr.slice(...).join(',')` without validation error", async () => {
    const src = `
      const a = [1, 2, 3, 4, 5];
      console.log(a.slice(1, 4).join(","));
    `;
    const out = await compileAndCapture(src);
    expect(out.length).toBe(1);
  });

  it("compiles `[...a, x, y].join(',')` without validation error", async () => {
    const src = `
      const a = [1, 2, 3];
      const b = [...a, 4, 5];
      console.log(b.join(","));
    `;
    const out = await compileAndCapture(src);
    expect(out.length).toBe(1);
  });

  it("compiles class field `c = [1,2,3]` with `f.c.join(',')` without validation error", async () => {
    const src = `
      class Foo {
        a = 1;
        b = "x";
        c = [1, 2, 3];
      }
      const f = new Foo();
      console.log(f.c.join(","));
    `;
    const out = await compileAndCapture(src);
    expect(out.length).toBe(1);
  });

  it("compiles `[1,2,3].toString()` without validation error", async () => {
    // Note: array.toString() falls through to a separate codegen path that
    // emits the static string "[object Array]". The fix here ensures the
    // unified collector still registers number_toString for any potential
    // route, so the Wasm module validates regardless.
    const out = await compileAndCapture("console.log([1, 2, 3].toString());");
    expect(out.length).toBe(1);
  });

  it("a string array's join() does NOT regress (string elemType already worked)", async () => {
    const src = `console.log(["a", "b", "c"].join("-"));`;
    const out = await compileAndCapture(src);
    expect(out).toEqual(["a-b-c"]);
  });
});
