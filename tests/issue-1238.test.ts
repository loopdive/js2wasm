// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1238 — IR Phase 4 Slice 13b: pseudo-ExternClassInfo registration for
// String + Array.
//
// Phase scope: registry-only. The synthetic `ExternClassInfo` entries
// for `String` and `Array` are populated in `ctx.externClasses` so that
// downstream slices (#1232 String dispatch, #1233 Array dispatch) can
// route receiver-method calls through the existing extern-class
// dispatch path without re-implementing the metadata table.
//
// What this file verifies:
//   1. `ctx.externClasses.has("String")` and `.has("Array")` are true
//      after compilation runs (acceptance criterion 1).
//   2. The synthetic entries carry the correct method/property
//      metadata (slice/charAt/indexOf/etc. for String;
//      push/pop/indexOf/etc. for Array).
//   3. `resolveMethodDispatchTarget(IrType)` correctly maps an
//      `IrType.string` receiver to `"String"` and a vec-shaped
//      `IrType.val<ref_null>` to `"Array"` (the **MLIR-seam dispatch
//      helper**: callers route IrTypes here instead of pattern-matching
//      atom.kind inline).
//   4. **No regression**: existing legacy String/Array method calls
//      compile and run correctly. The IR's `lowerMethodCall` is
//      *unchanged* in this slice — receiver-type widening lives in
//      #1232/#1233.
//
// Note on import resolution: registering `String` / `Array` in the
// extern-class table does NOT cause the compiler to import
// `String_<method>` host functions. The legacy String dispatch
// continues to use `string_<method>` (lowercase) imports
// (`STRING_METHODS` in `src/codegen/index.ts:3058`), and the
// IR's `lowerMethodCall` doesn't yet route string receivers through
// `extern.call`. Both remain true under #1238.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  createCodegenContext,
  registerBuiltinExternClasses,
  resolveMethodDispatchTarget,
} from "../src/codegen/index.js";
import { compile } from "../src/index.js";
import { createEmptyModule } from "../src/ir/types.js";
import type { IrType } from "../src/ir/nodes.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

interface InstantiateResult {
  exports: Record<string, unknown>;
}

async function compileAndInstantiate(source: string, experimentalIR: boolean): Promise<InstantiateResult> {
  const r = compile(source, { experimentalIR });
  if (!r.success) {
    throw new Error(`compile failed (${experimentalIR ? "IR" : "legacy"}): ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, {
    env: built.env,
    string_constants: built.string_constants,
  });
  return { exports: instance.exports as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Registry population — verify pseudo-ExternClassInfo entries land in
// ctx.externClasses for String and Array (#1238 acceptance criteria 1, 2)
// ---------------------------------------------------------------------------

describe("#1238 — pseudo-ExternClassInfo registration", () => {
  /** Build a fresh CodegenContext and run the builtin-extern registration so we
   *  can directly observe `ctx.externClasses` state without going through a
   *  full compile. The TypeChecker stub is empty — `registerBuiltinExternClasses`
   *  does not call back into it. */
  function makeContextWithBuiltinExterns() {
    const mod = createEmptyModule();
    const checker = {} as unknown as ts.TypeChecker;
    const ctx = createCodegenContext(mod, checker);
    registerBuiltinExternClasses(ctx);
    return ctx;
  }

  it("ctx.externClasses.has('String') after registration (acceptance 1)", () => {
    const ctx = makeContextWithBuiltinExterns();
    expect(ctx.externClasses.has("String")).toBe(true);
    const info = ctx.externClasses.get("String")!;
    expect(info.className).toBe("String");
    expect(info.importPrefix).toBe("string");
    // Methods from the spec: slice/charAt/charCodeAt/indexOf/includes/
    // toUpperCase/toLowerCase/trim
    for (const m of ["slice", "charAt", "charCodeAt", "indexOf", "includes", "toUpperCase", "toLowerCase", "trim"]) {
      expect(info.methods.has(m), `String.${m} should be registered`).toBe(true);
    }
    // Property: length
    expect(info.properties.has("length")).toBe(true);
    expect(info.properties.get("length")!.type).toEqual({ kind: "f64" });
    expect(info.properties.get("length")!.readonly).toBe(true);

    // Signature shape: each method's params start with `[receiver, ...args]`
    // (extern-class convention — receiver is `params[0]`). Spot-check
    // String.slice(begin, end): [self, f64, f64] -> externref.
    const slice = info.methods.get("slice")!;
    expect(slice.params).toEqual([{ kind: "externref" }, { kind: "f64" }, { kind: "f64" }]);
    expect(slice.results).toEqual([{ kind: "externref" }]);
    expect(slice.requiredParams).toBe(3); // 1 self + 2 args
  });

  it("ctx.externClasses.has('Array') after registration (acceptance 1)", () => {
    const ctx = makeContextWithBuiltinExterns();
    expect(ctx.externClasses.has("Array")).toBe(true);
    const info = ctx.externClasses.get("Array")!;
    expect(info.className).toBe("Array");
    // Methods from spec: push/pop/indexOf/includes/slice/join
    for (const m of ["push", "pop", "indexOf", "includes", "slice", "join"]) {
      expect(info.methods.has(m), `Array.${m} should be registered`).toBe(true);
    }
    expect(info.properties.has("length")).toBe(true);

    // push returns the new length (f64 in JS). Receiver is externref
    // (the synthetic registry's parametric-vec lowering is deferred to
    // #1233; the metadata records the JS-host fast-path shape).
    const push = info.methods.get("push")!;
    expect(push.params).toEqual([{ kind: "externref" }, { kind: "externref" }]);
    expect(push.results).toEqual([{ kind: "f64" }]);
  });

  it("compiles a trivial program without breaking on the new String/Array registration", async () => {
    // Sanity: registering the extern entries doesn't prevent normal
    // compilation. If the table population had a bug (e.g. duplicate
    // key, malformed signature), this would surface here.
    const source = `
      export function add(x: number, y: number): number { return x + y; }
    `;
    const r = await compileAndInstantiate(source, false);
    expect((r.exports.add as (a: number, b: number) => number)(2, 3)).toBe(5);
  });

  it("compiles a string method call (legacy path unchanged)", async () => {
    // Acceptance criterion 4 — no regression in legacy String method
    // dispatch. The IR's lowerMethodCall does NOT yet route string
    // receivers through extern.call (deferred to #1232), so this
    // function stays on the legacy path and emits `string_slice`-style
    // imports.
    const source = `
      export function takeFirst(s: string): string { return s.slice(0, 1); }
    `;
    const legacy = await compileAndInstantiate(source, false);
    const ir = await compileAndInstantiate(source, true);
    expect((legacy.exports.takeFirst as (s: string) => string)("hello")).toBe("h");
    expect((ir.exports.takeFirst as (s: string) => string)("hello")).toBe("h");
  });

  it("compiles an array method call (legacy path unchanged)", async () => {
    // Acceptance criterion 4 — Array.push / Array.pop still work.
    // Like String, the IR doesn't route vec receivers through
    // extern.call (deferred to #1233). Build + use within the same
    // module so the vec typeIdx stays consistent (cross-module vec
    // passing requires extern boundary coercion which is out of scope
    // here).
    const source = `
      export function pushAndLen(): number {
        const arr: number[] = [10, 20, 30];
        arr.push(99);
        return arr.length;
      }
    `;
    const legacy = await compileAndInstantiate(source, false);
    const ir = await compileAndInstantiate(source, true);
    expect((legacy.exports.pushAndLen as () => number)()).toBe(4);
    expect((ir.exports.pushAndLen as () => number)()).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// resolveMethodDispatchTarget — MLIR-seam dispatch helper
// ---------------------------------------------------------------------------

describe("#1238 — resolveMethodDispatchTarget", () => {
  it("maps IrType.string to 'String'", () => {
    const t: IrType = { kind: "string" };
    expect(resolveMethodDispatchTarget(t)).toBe("String");
  });

  it("maps IrType.val<ref_null> (vec-shaped) to 'Array'", () => {
    // typeIdx is a placeholder — the lookup helper just checks the
    // kind. The actual vec confirmation happens via the lowerer's
    // vec resolver (which knows which typeIdxes are vecs).
    const t: IrType = { kind: "val", val: { kind: "ref_null", typeIdx: 0 } };
    expect(resolveMethodDispatchTarget(t)).toBe("Array");
  });

  it("maps IrType.val<ref> (non-null vec) to 'Array'", () => {
    const t: IrType = { kind: "val", val: { kind: "ref", typeIdx: 0 } };
    expect(resolveMethodDispatchTarget(t)).toBe("Array");
  });

  it("returns null for primitive IrType.val<f64>", () => {
    const t: IrType = { kind: "val", val: { kind: "f64" } };
    expect(resolveMethodDispatchTarget(t)).toBeNull();
  });

  it("returns null for primitive IrType.val<i32>", () => {
    const t: IrType = { kind: "val", val: { kind: "i32" } };
    expect(resolveMethodDispatchTarget(t)).toBeNull();
  });

  it("returns null for IrType.object", () => {
    const t: IrType = {
      kind: "object",
      shape: { fields: [{ name: "x", type: { kind: "val", val: { kind: "f64" } } }] },
    };
    expect(resolveMethodDispatchTarget(t)).toBeNull();
  });

  it("returns null for IrType.union", () => {
    const t: IrType = { kind: "union", members: [{ kind: "f64" }, { kind: "i32" }] };
    expect(resolveMethodDispatchTarget(t)).toBeNull();
  });
});
