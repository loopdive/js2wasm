// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1268 — `obj[runtimeKey] ??= value` returned NaN on index-signature types.
//
// Two bugs surfaced together:
//
// 1. **Module-init filter missing logical-assignment operators**.
//    `src/codegen/declarations.ts` filters top-level expression statements
//    into `ctx.moduleInitStatements` based on whether the binary op is an
//    "assignment". The list of recognised assignment ops included `=`,
//    `+=`, `-=`, ... but NOT `??=`, `||=`, `&&=`. So `d["x"] ??= 42;` at
//    module scope was silently dropped — never reached codegen. Reads of
//    `d["x"]` afterwards returned `undefined` (boxed externref), which
//    `__unbox_number` mapped to NaN.
//
// 2. **`compileElementLogicalAssignment` missing externref fallback**.
//    The function only handled known struct (`obj["fieldName"]`) or vec
//    (`arr[i]`) targets. For an index-signature dict (lowered to
//    externref), the target type check (`arrType.kind !== "ref" &&
//    arrType.kind !== "ref_null"`) hit a `reportError` arm that callers
//    silently swallowed. The plain `obj[key] = val` path already had a
//    `compileExternSetFallback` arm — the parallel `??=` arm was missing.
//
// 3. **Nullish check on externref needs `__extern_is_undefined`**.
//    Host imports return JS `undefined` as a non-null externref (the
//    Wasm type system doesn't conflate `null` and `undefined`). The
//    `??=` check in `emitLogicalAssignmentPattern` used only
//    `ref.is_null`, which missed `undefined`-valued slots. Added the
//    `__extern_is_undefined` host call OR'd with `ref.is_null` for
//    externref-typed targets — same pattern the variable-scope
//    `??=` already uses (`compileLogicalAssignment`).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

interface InstantiateResult {
  exports: Record<string, unknown>;
}

async function compileAndInstantiate(source: string): Promise<InstantiateResult> {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => `L${e.line}:${e.column} ${e.message}`).join(" | ")}`);
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, {
    env: built.env,
    string_constants: built.string_constants,
  });
  return { exports: instance.exports as Record<string, unknown> };
}

describe("#1268 — d[key] ??= value at module scope (acceptance criterion 1)", () => {
  it("missing key — assigns RHS, reads back", async () => {
    const source = `
      type Dict = { [key: string]: number };
      const d: Dict = {};
      d["x"] ??= 42;
      export function run(): number { return d["x"]; }
    `;
    const r = await compileAndInstantiate(source);
    expect((r.exports.run as () => number)()).toBe(42);
  });

  it("existing key with non-null value — keeps existing (??= short-circuits)", async () => {
    // Note: `const d: Dict = { x: 5 }` doesn't populate dict entries —
    // index-signature types compile to an empty struct, and the
    // initializer's named fields aren't propagated. So we set the value
    // explicitly via `d["x"] = 5` before the ??=.
    const source = `
      type Dict = { [key: string]: number };
      const d: Dict = {};
      d["x"] = 5;
      d["x"] ??= 42;
      export function run(): number { return d["x"]; }
    `;
    const r = await compileAndInstantiate(source);
    expect((r.exports.run as () => number)()).toBe(5);
  });
});

describe("#1268 — d[key] ??= value inside a function", () => {
  it("missing key — assigns RHS", async () => {
    const source = `
      type Dict = { [key: string]: number };
      export function run(): number {
        const d: Dict = {};
        d["x"] ??= 42;
        return d["x"];
      }
    `;
    const r = await compileAndInstantiate(source);
    expect((r.exports.run as () => number)()).toBe(42);
  });
});

describe("#1268 — sibling logical-assignment ops on index-signature dicts", () => {
  it("||= on missing key — assigns RHS (existing was undefined → falsy)", async () => {
    const source = `
      type Dict = { [key: string]: number };
      const d: Dict = {};
      d["x"] ||= 42;
      export function run(): number { return d["x"]; }
    `;
    const r = await compileAndInstantiate(source);
    expect((r.exports.run as () => number)()).toBe(42);
  });

  it("||= on existing truthy key — keeps existing", async () => {
    const source = `
      type Dict = { [key: string]: number };
      const d: Dict = {};
      d["x"] = 7;
      d["x"] ||= 42;
      export function run(): number { return d["x"]; }
    `;
    const r = await compileAndInstantiate(source);
    expect((r.exports.run as () => number)()).toBe(7);
  });

  it("&&= on existing truthy key — assigns RHS", async () => {
    const source = `
      type Dict = { [key: string]: number };
      const d: Dict = {};
      d["x"] = 5;
      d["x"] &&= 42;
      export function run(): number { return d["x"]; }
    `;
    const r = await compileAndInstantiate(source);
    expect((r.exports.run as () => number)()).toBe(42);
  });
});

describe("#1268 — runtime-computed key (Hono pattern)", () => {
  it("d[runtimeKey] ??= value with computed string key", async () => {
    const source = `
      type Dict = { [key: string]: number };
      export function run(method: string, defaultValue: number): number {
        const d: Dict = {};
        d[method] ??= defaultValue;
        return d[method];
      }
    `;
    const r = await compileAndInstantiate(source);
    expect((r.exports.run as (m: string, v: number) => number)("GET", 1)).toBe(1);
  });
});

describe("#1268 — module-init filter regression guard", () => {
  it("plain d[key] = value at module scope still works (was already correct)", async () => {
    // Sanity: my fix to declarations.ts adds ??=/||=/&&= to the module-
    // init filter, but mustn't break the existing plain-assign cases.
    const source = `
      type Dict = { [key: string]: number };
      const d: Dict = {};
      d["x"] = 99;
      export function run(): number { return d["x"]; }
    `;
    const r = await compileAndInstantiate(source);
    expect((r.exports.run as () => number)()).toBe(99);
  });
});
