// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * AnyValue boxing/unboxing helpers and wrapper struct types for
 * Number, String, and Boolean object wrappers.
 *
 * Extracted from codegen/index.ts (#1013).
 */
import type { Instr, StructTypeDef, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { nativeStringType } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";
import { registerEnsureAnyHelpers } from "./shared.js";

/**
 * Register the $AnyValue struct type for boxing `any` typed values.
 * The struct has a tag field to distinguish the boxed type at runtime,
 * plus payload fields for each possible value kind.
 *
 * Called lazily — only emitted when the module actually uses `any`-typed values.
 */
export function ensureAnyValueType(ctx: CodegenContext): void {
  if (ctx.anyValueTypeIdx >= 0) return; // already registered
  ctx.anyValueTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "AnyValue",
    fields: [
      { name: "tag", type: { kind: "i32" }, mutable: false },
      { name: "i32val", type: { kind: "i32" }, mutable: false },
      { name: "f64val", type: { kind: "f64" }, mutable: false },
      { name: "refval", type: { kind: "eqref" }, mutable: false },
      { name: "externval", type: { kind: "externref" }, mutable: false },
    ],
  });
}

/**
 * Lazily register wrapper struct types for Number, String, Boolean.
 * Each wrapper is a struct with a single `value` field holding the primitive.
 * Also registers WrapperX_valueOf functions that extract the value.
 * Must be called before resolveWasmType is used for wrapper types.
 */
export function ensureWrapperTypes(ctx: CodegenContext): void {
  if (ctx.wrapperNumberTypeIdx >= 0) return; // already registered

  // $WrapperNumber: struct { value: f64 }
  ctx.wrapperNumberTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "WrapperNumber",
    fields: [{ name: "value", type: { kind: "f64" }, mutable: false }],
  } as StructTypeDef);
  ctx.structMap.set("WrapperNumber", ctx.wrapperNumberTypeIdx);
  ctx.typeIdxToStructName.set(ctx.wrapperNumberTypeIdx, "WrapperNumber");
  ctx.structFields.set("WrapperNumber", [{ name: "value", type: { kind: "f64" }, mutable: false }]);

  // $WrapperString: struct { value: externref }
  ctx.wrapperStringTypeIdx = ctx.mod.types.length;
  const strValType: ValType = ctx.nativeStrings ? nativeStringType(ctx) : { kind: "externref" };
  ctx.mod.types.push({
    kind: "struct",
    name: "WrapperString",
    fields: [{ name: "value", type: strValType, mutable: false }],
  } as StructTypeDef);
  ctx.structMap.set("WrapperString", ctx.wrapperStringTypeIdx);
  ctx.typeIdxToStructName.set(ctx.wrapperStringTypeIdx, "WrapperString");
  ctx.structFields.set("WrapperString", [{ name: "value", type: strValType, mutable: false }]);

  // $WrapperBoolean: struct { value: i32 }
  ctx.wrapperBooleanTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "WrapperBoolean",
    fields: [{ name: "value", type: { kind: "i32" }, mutable: false }],
  } as StructTypeDef);
  ctx.structMap.set("WrapperBoolean", ctx.wrapperBooleanTypeIdx);
  ctx.typeIdxToStructName.set(ctx.wrapperBooleanTypeIdx, "WrapperBoolean");
  ctx.structFields.set("WrapperBoolean", [{ name: "value", type: { kind: "i32" }, mutable: false }]);
}

/**
 * Emit valueOf helper functions for wrapper types.
 * Must be called after all imports are registered (so function indices are stable)
 * but before user functions that call valueOf.
 */
export function emitWrapperValueOfFunctions(ctx: CodegenContext): void {
  if (ctx.wrapperNumberTypeIdx < 0) return;
  if (ctx.funcMap.has("WrapperNumber_valueOf")) return; // already emitted

  const strValType: ValType = ctx.nativeStrings ? nativeStringType(ctx) : { kind: "externref" };

  // WrapperNumber_valueOf(self: ref $WrapperNumber) -> f64
  {
    const funcTypeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "func",
      params: [{ kind: "ref", typeIdx: ctx.wrapperNumberTypeIdx }],
      results: [{ kind: "f64" }],
    });
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.mod.functions.push({
      name: "WrapperNumber_valueOf",
      typeIdx: funcTypeIdx,
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: ctx.wrapperNumberTypeIdx, fieldIdx: 0 },
      ] as Instr[],
      exported: false,
    });
    ctx.funcMap.set("WrapperNumber_valueOf", funcIdx);
  }

  // WrapperString_valueOf(self: ref $WrapperString) -> externref/ref
  {
    const funcTypeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "func",
      params: [{ kind: "ref", typeIdx: ctx.wrapperStringTypeIdx }],
      results: [strValType],
    });
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.mod.functions.push({
      name: "WrapperString_valueOf",
      typeIdx: funcTypeIdx,
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: ctx.wrapperStringTypeIdx, fieldIdx: 0 },
      ] as Instr[],
      exported: false,
    });
    ctx.funcMap.set("WrapperString_valueOf", funcIdx);
  }

  // WrapperBoolean_valueOf(self: ref $WrapperBoolean) -> i32
  {
    const funcTypeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "func",
      params: [{ kind: "ref", typeIdx: ctx.wrapperBooleanTypeIdx }],
      results: [{ kind: "i32" }],
    });
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.mod.functions.push({
      name: "WrapperBoolean_valueOf",
      typeIdx: funcTypeIdx,
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: ctx.wrapperBooleanTypeIdx, fieldIdx: 0 },
      ] as Instr[],
      exported: false,
    });
    ctx.funcMap.set("WrapperBoolean_valueOf", funcIdx);
  }
}

/**
 * Check if a ValType represents a boxed `any` value (ref $AnyValue).
 */
export function isAnyValue(type: ValType, ctx: CodegenContext): boolean {
  return (
    (type.kind === "ref" || type.kind === "ref_null") &&
    (type as { typeIdx: number }).typeIdx === ctx.anyValueTypeIdx &&
    ctx.anyValueTypeIdx >= 0
  );
}

/**
 * Emit inline wasm helper functions for boxing/unboxing `any` values.
 * Called lazily when any-typed operations are first encountered.
 */
export function ensureAnyHelpers(ctx: CodegenContext): void {
  if (ctx.anyHelpersEmitted) return;
  ctx.anyHelpersEmitted = true;

  // Ensure the $AnyValue struct type is registered before emitting helpers
  ensureAnyValueType(ctx);

  const anyTypeIdx = ctx.anyValueTypeIdx;
  const anyRef: ValType = { kind: "ref", typeIdx: anyTypeIdx };
  const anyRefNull: ValType = { kind: "ref_null", typeIdx: anyTypeIdx };

  // Helper to register a helper function
  function addHelper(
    name: string,
    params: ValType[],
    results: ValType[],
    body: Instr[],
    locals?: { name: string; type: ValType }[],
  ): void {
    const typeIdx = addFuncType(ctx, params, results, name);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.mod.functions.push({
      name,
      typeIdx,
      locals: locals ?? [],
      body,
      exported: false,
    });
    ctx.funcMap.set(name, funcIdx);
    ctx.anyHelpers.set(name, funcIdx);
  }

  // ref.null eq — the eq abstract heap type is encoded as byte 0x6d.
  // In signed LEB128 (used by enc.i32), 0x6d = -19 (7-bit two's complement).
  const EQ_HEAP_TYPE = -19; // signed LEB128 → 0x6d → TYPE.eq

  // __any_box_null() -> ref $AnyValue
  // tag=0, i32val=0, f64val=0.0, refval=null, externval=null
  addHelper(
    "__any_box_null",
    [],
    [anyRef],
    [
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "f64.const", value: 0 },
      { op: "ref.null", typeIdx: EQ_HEAP_TYPE },
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx: anyTypeIdx },
    ],
  );

  // __any_box_undefined() -> ref $AnyValue
  // tag=1
  addHelper(
    "__any_box_undefined",
    [],
    [anyRef],
    [
      { op: "i32.const", value: 1 },
      { op: "i32.const", value: 0 },
      { op: "f64.const", value: 0 },
      { op: "ref.null", typeIdx: EQ_HEAP_TYPE },
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx: anyTypeIdx },
    ],
  );

  // __any_box_i32(val: i32) -> ref $AnyValue
  // tag=2, i32val=val, f64val=0.0, refval=null, externval=null
  addHelper(
    "__any_box_i32",
    [{ kind: "i32" }],
    [anyRef],
    [
      { op: "i32.const", value: 2 },
      { op: "local.get", index: 0 },
      { op: "f64.const", value: 0 },
      { op: "ref.null", typeIdx: EQ_HEAP_TYPE },
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx: anyTypeIdx },
    ],
  );

  // __any_box_f64(val: f64) -> ref $AnyValue
  // tag=3, i32val=0, f64val=val, refval=null, externval=null
  addHelper(
    "__any_box_f64",
    [{ kind: "f64" }],
    [anyRef],
    [
      { op: "i32.const", value: 3 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 0 },
      { op: "ref.null", typeIdx: EQ_HEAP_TYPE },
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx: anyTypeIdx },
    ],
  );

  // __any_box_bool(val: i32) -> ref $AnyValue
  // tag=4, i32val=val, f64val=0.0, refval=null, externval=null
  addHelper(
    "__any_box_bool",
    [{ kind: "i32" }],
    [anyRef],
    [
      { op: "i32.const", value: 4 },
      { op: "local.get", index: 0 },
      { op: "f64.const", value: 0 },
      { op: "ref.null", typeIdx: EQ_HEAP_TYPE },
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx: anyTypeIdx },
    ],
  );

  // __any_box_string(val: externref) -> ref $AnyValue
  // tag=5, i32val=0, f64val=0.0, refval=null, externval=val
  addHelper(
    "__any_box_string",
    [{ kind: "externref" }],
    [anyRef],
    [
      { op: "i32.const", value: 5 },
      { op: "i32.const", value: 0 },
      { op: "f64.const", value: 0 },
      { op: "ref.null", typeIdx: EQ_HEAP_TYPE },
      { op: "local.get", index: 0 },
      { op: "struct.new", typeIdx: anyTypeIdx },
    ],
  );

  // __any_box_ref(val: eqref) -> ref $AnyValue
  // tag=6, i32val=0, f64val=0.0, refval=val, externval=null
  addHelper(
    "__any_box_ref",
    [{ kind: "eqref" }],
    [anyRef],
    [
      { op: "i32.const", value: 6 },
      { op: "i32.const", value: 0 },
      { op: "f64.const", value: 0 },
      { op: "local.get", index: 0 },
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx: anyTypeIdx },
    ],
  );

  // __any_unbox_i32(val: ref $AnyValue) -> i32
  // Returns i32val field; if tag==3 (f64), truncate f64val
  addHelper(
    "__any_unbox_i32",
    [anyRefNull],
    [{ kind: "i32" }],
    [
      // Check if tag == 3 (f64 number)
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
      { op: "i32.const", value: 3 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
          { op: "i32.trunc_sat_f64_s" },
        ],
        else: [
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
        ],
      },
    ],
  );

  // __any_unbox_f64(val: ref $AnyValue) -> f64
  // Returns f64val field; if tag==2 (i32 number), convert i32val
  addHelper(
    "__any_unbox_f64",
    [anyRefNull],
    [{ kind: "f64" }],
    [
      // Check if tag == 2 (i32 number)
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
      { op: "i32.const", value: 2 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "f64" } },
        then: [
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
          { op: "f64.convert_i32_s" },
        ],
        else: [
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
        ],
      },
    ],
  );

  // __any_unbox_bool(val: ref $AnyValue) -> i32
  // Truthiness check: tag 4 → i32val, tag 2 → i32val!=0, tag 3 → f64val!=0,
  // tag 0/1 → 0 (null/undefined), tag >= 5 → 1 (truthy object)
  addHelper(
    "__any_unbox_bool",
    [anyRefNull],
    [{ kind: "i32" }],
    [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
      { op: "i32.const", value: 4 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
        ],
        else: [
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
          { op: "i32.const", value: 2 },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: 0 },
              { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
              { op: "i32.const", value: 0 },
              { op: "i32.ne" },
            ],
            else: [
              { op: "local.get", index: 0 },
              { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
              { op: "i32.const", value: 3 },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [
                  { op: "local.get", index: 0 },
                  { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
                  { op: "f64.const", value: 0 },
                  { op: "f64.ne" },
                ],
                else: [
                  { op: "local.get", index: 0 },
                  { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
                  { op: "i32.const", value: 5 },
                  { op: "i32.ge_s" },
                ],
              },
            ],
          },
        ],
      },
    ],
  );

  // __any_unbox_extern(val: ref $AnyValue) -> externref
  // Returns externval field
  addHelper(
    "__any_unbox_extern",
    [anyRefNull],
    [{ kind: "externref" }],
    [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 4 },
    ],
  );

  // ── Phase 2: Runtime dispatch operators ──────────────────────────

  // Helper: get numeric value as f64 from an AnyValue (assumes tag is 2 or 3)
  // Used internally by arithmetic helpers.
  // params: a(0)  locals: tag(1)
  // Returns f64 per JS ToNumber semantics:
  //   tag 0 (null) → 0, tag 1 (undefined) → NaN, tag 2 (i32) → f64(i32val),
  //   tag 3 (f64) → f64val, tag 4 (bool) → f64(i32val)
  addHelper(
    "__any_to_f64",
    [anyRefNull],
    [{ kind: "f64" }],
    [
      // tag = a.tag
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 },
      // if tag == 1 (undefined) → NaN
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 1 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "f64" } },
        then: [{ op: "f64.const", value: NaN }],
        else: [
          // if tag == 2 (i32) or tag == 4 (bool) → convert i32val to f64
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 2 },
          { op: "i32.eq" },
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 4 },
          { op: "i32.eq" },
          { op: "i32.or" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "f64" } },
            then: [
              { op: "local.get", index: 0 },
              { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
              { op: "f64.convert_i32_s" },
            ],
            else: [
              // tag 0 (null) → f64val (0.0), tag 3 (f64) → f64val
              { op: "local.get", index: 0 },
              { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
            ],
          },
        ],
      },
    ],
    [{ name: "tag", type: { kind: "i32" } }],
  );

  const toF64Idx = ctx.funcMap.get("__any_to_f64")!;
  const boxI32Idx = ctx.funcMap.get("__any_box_i32")!;
  const boxF64Idx = ctx.funcMap.get("__any_box_f64")!;

  // __any_add(a: ref $AnyValue, b: ref $AnyValue) -> ref $AnyValue
  // If both are i32 (tag==2): i32.add, box as i32
  // If both are numeric (tag 2 or 3): convert to f64, f64.add, box as f64
  // Otherwise: trap (string concat via any not supported yet for simplicity)
  // params: a(0), b(1)  locals: tagA(2), tagB(3)
  addHelper(
    "__any_add",
    [anyRefNull, anyRefNull],
    [anyRef],
    [
      // tagA = a.tag
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 },
      // tagB = b.tag
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      // if tagA == 2 && tagB == 2 → i32 add
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 2 },
      { op: "i32.eq" },
      { op: "local.get", index: 3 },
      { op: "i32.const", value: 2 },
      { op: "i32.eq" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: anyRef },
        then: [
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
          { op: "local.get", index: 1 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
          { op: "i32.add" },
          { op: "call", funcIdx: boxI32Idx },
        ],
        else: [
          // f64 path: convert both to f64, add, box as f64
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: toF64Idx },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: toF64Idx },
          { op: "f64.add" },
          { op: "call", funcIdx: boxF64Idx },
        ],
      },
    ],
    [
      { name: "tagA", type: { kind: "i32" } },
      { name: "tagB", type: { kind: "i32" } },
    ],
  );

  // Generic numeric binary op helper generator
  function addNumericBinaryHelper(name: string, i32op: "i32.sub" | "i32.mul", f64op: "f64.sub" | "f64.mul"): void {
    addHelper(
      name,
      [anyRefNull, anyRefNull],
      [anyRef],
      [
        // tagA = a.tag
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: 2 },
        // tagB = b.tag
        { op: "local.get", index: 1 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: 3 },
        // if tagA == 2 && tagB == 2 → i32 op
        { op: "local.get", index: 2 },
        { op: "i32.const", value: 2 },
        { op: "i32.eq" },
        { op: "local.get", index: 3 },
        { op: "i32.const", value: 2 },
        { op: "i32.eq" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "val", type: anyRef },
          then: [
            { op: "local.get", index: 0 },
            { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
            { op: "local.get", index: 1 },
            { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
            { op: i32op } as Instr,
            { op: "call", funcIdx: boxI32Idx },
          ],
          else: [
            // f64 path
            { op: "local.get", index: 0 },
            { op: "call", funcIdx: toF64Idx },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: toF64Idx },
            { op: f64op } as Instr,
            { op: "call", funcIdx: boxF64Idx },
          ],
        },
      ],
      [
        { name: "tagA", type: { kind: "i32" } },
        { name: "tagB", type: { kind: "i32" } },
      ],
    );
  }

  addNumericBinaryHelper("__any_sub", "i32.sub", "f64.sub");
  addNumericBinaryHelper("__any_mul", "i32.mul", "f64.mul");

  // __any_div: always use f64 (division can produce fractions)
  addHelper(
    "__any_div",
    [anyRefNull, anyRefNull],
    [anyRef],
    [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: toF64Idx },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: toF64Idx },
      { op: "f64.div" },
      { op: "call", funcIdx: boxF64Idx },
    ],
  );

  // __any_mod: i32.rem_s for i32, otherwise f64 approximation via floor division
  addHelper(
    "__any_mod",
    [anyRefNull, anyRefNull],
    [anyRef],
    [
      // tagA = a.tag
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 },
      // tagB = b.tag
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      // if tagA == 2 && tagB == 2 → i32 rem_s
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 2 },
      { op: "i32.eq" },
      { op: "local.get", index: 3 },
      { op: "i32.const", value: 2 },
      { op: "i32.eq" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: anyRef },
        then: [
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
          { op: "local.get", index: 1 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
          { op: "i32.rem_s" },
          { op: "call", funcIdx: boxI32Idx },
        ],
        else: [
          // f64 path: a - floor(a/b) * b
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: toF64Idx },
          { op: "local.set", index: 4 }, // fA
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: toF64Idx },
          { op: "local.set", index: 5 }, // fB
          // result = fA - floor(fA / fB) * fB
          { op: "local.get", index: 4 },
          { op: "local.get", index: 4 },
          { op: "local.get", index: 5 },
          { op: "f64.div" },
          { op: "f64.floor" },
          { op: "local.get", index: 5 },
          { op: "f64.mul" },
          { op: "f64.sub" },
          { op: "call", funcIdx: boxF64Idx },
        ],
      },
    ],
    [
      { name: "tagA", type: { kind: "i32" } },
      { name: "tagB", type: { kind: "i32" } },
      { name: "fA", type: { kind: "f64" } },
      { name: "fB", type: { kind: "f64" } },
    ],
  );

  // __any_eq(a, b) -> i32
  // Same tag: compare values. Different tag: return 0.
  addHelper(
    "__any_eq",
    [anyRefNull, anyRefNull],
    [{ kind: "i32" }],
    [
      // Fast path: if both refs point to the same AnyValue struct, they are equal.
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "ref.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: 1 }],
        else: [
          // tagA = a.tag
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: 2 },
          // tagB = b.tag
          { op: "local.get", index: 1 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: 3 },
          // if tagA != tagB → 0
          { op: "local.get", index: 2 },
          { op: "local.get", index: 3 },
          { op: "i32.ne" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              // Cross-tag loose equality (§7.2.15):
              // 1. null == undefined (tags 0+1): both tags < 2 → true
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 2 },
              { op: "i32.lt_s" },
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 2 },
              { op: "i32.lt_s" },
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [{ op: "i32.const", value: 1 }],
                else: [
                  // 2. Both tags are numeric-coercible (tags 2,3,4 = i32,f64,bool)?
                  //    §7.2.15 steps 4-5, 8-9: coerce to number and compare
                  //    Check: both tags are in {2,3,4} → tag >= 2 && tag <= 4
                  { op: "local.get", index: 2 },
                  { op: "i32.const", value: 2 },
                  { op: "i32.ge_s" },
                  { op: "local.get", index: 2 },
                  { op: "i32.const", value: 4 },
                  { op: "i32.le_s" },
                  { op: "i32.and" },
                  { op: "local.get", index: 3 },
                  { op: "i32.const", value: 2 },
                  { op: "i32.ge_s" },
                  { op: "local.get", index: 3 },
                  { op: "i32.const", value: 4 },
                  { op: "i32.le_s" },
                  { op: "i32.and" },
                  { op: "i32.and" },
                  {
                    op: "if",
                    blockType: { kind: "val", type: { kind: "i32" } },
                    then: [
                      { op: "local.get", index: 0 },
                      { op: "call", funcIdx: toF64Idx },
                      { op: "local.get", index: 1 },
                      { op: "call", funcIdx: toF64Idx },
                      { op: "f64.eq" },
                    ],
                    else: [{ op: "i32.const", value: 0 }],
                  },
                ],
              },
            ],
            else: [
              // Same tag — compare by tag type
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 2 },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [
                  // i32 eq
                  { op: "local.get", index: 0 },
                  { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
                  { op: "local.get", index: 1 },
                  { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
                  { op: "i32.eq" },
                ],
                else: [
                  { op: "local.get", index: 2 },
                  { op: "i32.const", value: 3 },
                  { op: "i32.eq" },
                  {
                    op: "if",
                    blockType: { kind: "val", type: { kind: "i32" } },
                    then: [
                      // f64 eq
                      { op: "local.get", index: 0 },
                      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
                      { op: "local.get", index: 1 },
                      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
                      { op: "f64.eq" },
                    ],
                    else: [
                      { op: "local.get", index: 2 },
                      { op: "i32.const", value: 4 },
                      { op: "i32.eq" },
                      {
                        op: "if",
                        blockType: { kind: "val", type: { kind: "i32" } },
                        then: [
                          // bool eq (compare i32val)
                          { op: "local.get", index: 0 },
                          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
                          { op: "local.get", index: 1 },
                          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
                          { op: "i32.eq" },
                        ],
                        else: [
                          // tag 6 (ref): compare refval (eqref) with ref.eq
                          { op: "local.get", index: 2 },
                          { op: "i32.const", value: 6 },
                          { op: "i32.eq" },
                          {
                            op: "if",
                            blockType: { kind: "val", type: { kind: "i32" } },
                            then: [
                              { op: "local.get", index: 0 },
                              { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 3 },
                              { op: "local.get", index: 1 },
                              { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 3 },
                              { op: "ref.eq" },
                            ],
                            else: [
                              // null/undefined (tag < 2): both same tag → equal
                              { op: "local.get", index: 2 },
                              { op: "i32.const", value: 2 },
                              { op: "i32.lt_s" },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    [
      { name: "tagA", type: { kind: "i32" } },
      { name: "tagB", type: { kind: "i32" } },
    ],
  );

  // __any_strict_eq(a, b) -> i32
  // Strict equality (===): different tags always return 0 (no cross-type coercion). (#296)
  addHelper(
    "__any_strict_eq",
    [anyRefNull, anyRefNull],
    [{ kind: "i32" }],
    [
      // Fast path: if both refs point to the same AnyValue struct, they are equal.
      // This handles object identity (var b = a) for all tag types.
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "ref.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: 1 }],
        else: [
          // tagA = a.tag
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: 2 },
          // tagB = b.tag
          { op: "local.get", index: 1 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: 3 },
          // if tagA != tagB → 0 (strict: no cross-type coercion)
          { op: "local.get", index: 2 },
          { op: "local.get", index: 3 },
          { op: "i32.ne" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [{ op: "i32.const", value: 0 }],
            else: [
              // Same tag — compare by tag type
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 2 },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [
                  // i32 eq
                  { op: "local.get", index: 0 },
                  { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
                  { op: "local.get", index: 1 },
                  { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
                  { op: "i32.eq" },
                ],
                else: [
                  { op: "local.get", index: 2 },
                  { op: "i32.const", value: 3 },
                  { op: "i32.eq" },
                  {
                    op: "if",
                    blockType: { kind: "val", type: { kind: "i32" } },
                    then: [
                      // f64 eq
                      { op: "local.get", index: 0 },
                      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
                      { op: "local.get", index: 1 },
                      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
                      { op: "f64.eq" },
                    ],
                    else: [
                      { op: "local.get", index: 2 },
                      { op: "i32.const", value: 4 },
                      { op: "i32.eq" },
                      {
                        op: "if",
                        blockType: { kind: "val", type: { kind: "i32" } },
                        then: [
                          // bool eq (compare i32val)
                          { op: "local.get", index: 0 },
                          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
                          { op: "local.get", index: 1 },
                          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
                          { op: "i32.eq" },
                        ],
                        else: [
                          // tag 6 (ref): compare refval (eqref) with ref.eq
                          { op: "local.get", index: 2 },
                          { op: "i32.const", value: 6 },
                          { op: "i32.eq" },
                          {
                            op: "if",
                            blockType: { kind: "val", type: { kind: "i32" } },
                            then: [
                              { op: "local.get", index: 0 },
                              { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 3 },
                              { op: "local.get", index: 1 },
                              { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 3 },
                              { op: "ref.eq" },
                            ],
                            else: [
                              // null/undefined (tag < 2): both same tag → equal
                              // string (tag 5): different AnyValue boxes → not same ref
                              // (string content equality is handled by string-specific codepaths)
                              { op: "local.get", index: 2 },
                              { op: "i32.const", value: 2 },
                              { op: "i32.lt_s" },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    [
      { name: "tagA", type: { kind: "i32" } },
      { name: "tagB", type: { kind: "i32" } },
    ],
  );

  // Comparison helpers: __any_lt, __any_gt, __any_le, __any_ge
  // All use numeric comparison (convert to f64, compare)
  function addComparisonHelper(name: string, f64op: "f64.lt" | "f64.gt" | "f64.le" | "f64.ge"): void {
    addHelper(
      name,
      [anyRefNull, anyRefNull],
      [{ kind: "i32" }],
      [
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: toF64Idx },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: toF64Idx },
        { op: f64op } as Instr,
      ],
    );
  }

  addComparisonHelper("__any_lt", "f64.lt");
  addComparisonHelper("__any_gt", "f64.gt");
  addComparisonHelper("__any_le", "f64.le");
  addComparisonHelper("__any_ge", "f64.ge");

  // __any_neg(a) -> ref $AnyValue
  // Negate numeric value: tag 2 → negate i32, tag 3 → negate f64
  addHelper(
    "__any_neg",
    [anyRefNull],
    [anyRef],
    [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
      { op: "i32.const", value: 2 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: anyRef },
        then: [
          { op: "i32.const", value: 0 },
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
          { op: "i32.sub" },
          { op: "call", funcIdx: boxI32Idx },
        ],
        else: [
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
          { op: "f64.neg" },
          { op: "call", funcIdx: boxF64Idx },
        ],
      },
    ],
  );

  // __any_typeof(a) -> ref $AnyString (native string in fast mode)
  // Returns "number", "string", "boolean", "object", "undefined" as native strings
  // Uses the $AnyString type system (WasmGC native strings)
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
    const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
    const strTypeIdx = ctx.nativeStrTypeIdx;

    // Helper to build a native string literal inline (returns instructions that leave ref $NativeString on stack)
    function nativeStrConstInstrs(value: string): Instr[] {
      const instrs: Instr[] = [];
      // Push len (i32) — field 0
      instrs.push({ op: "i32.const", value: value.length });
      // Push off (i32) = 0 — field 1
      instrs.push({ op: "i32.const", value: 0 });
      // Push each code unit and create array
      for (let i = 0; i < value.length; i++) {
        instrs.push({ op: "i32.const", value: value.charCodeAt(i) });
      }
      instrs.push({ op: "array.new_fixed", typeIdx: strDataTypeIdx, length: value.length });
      instrs.push({ op: "struct.new", typeIdx: strTypeIdx });
      return instrs;
    }

    const anyStrRef: ValType = { kind: "ref", typeIdx: ctx.anyStrTypeIdx };

    addHelper(
      "__any_typeof",
      [anyRefNull],
      [anyStrRef],
      [
        // Check tag and return corresponding string
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: 1 }, // tag in local 1

        // tag == 0 (null) → "object"
        { op: "local.get", index: 1 },
        { op: "i32.const", value: 0 },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: anyStrRef },
          then: nativeStrConstInstrs("object"),
          else: [
            // tag == 1 (undefined) → "undefined"
            { op: "local.get", index: 1 },
            { op: "i32.const", value: 1 },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "val", type: anyStrRef },
              then: nativeStrConstInstrs("undefined"),
              else: [
                // tag == 2 or tag == 3 (i32/f64) → "number"
                { op: "local.get", index: 1 },
                { op: "i32.const", value: 2 },
                { op: "i32.eq" },
                { op: "local.get", index: 1 },
                { op: "i32.const", value: 3 },
                { op: "i32.eq" },
                { op: "i32.or" },
                {
                  op: "if",
                  blockType: { kind: "val", type: anyStrRef },
                  then: nativeStrConstInstrs("number"),
                  else: [
                    // tag == 4 (bool) → "boolean"
                    { op: "local.get", index: 1 },
                    { op: "i32.const", value: 4 },
                    { op: "i32.eq" },
                    {
                      op: "if",
                      blockType: { kind: "val", type: anyStrRef },
                      then: nativeStrConstInstrs("boolean"),
                      else: [
                        // tag == 5 (string/externref) or tag == 6 (gcref) — default to "object"
                        // (In practice tag 5 would be "string" but we don't use it in fast mode)
                        ...nativeStrConstInstrs("object"),
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      [{ name: "tag", type: { kind: "i32" } }],
    );
  }
}

// Register ensureAnyHelpers delegate so expressions.ts and typeof-delete.ts
// can call it via shared.ts without importing index.ts (which depends on them).
registerEnsureAnyHelpers(ensureAnyHelpers);
