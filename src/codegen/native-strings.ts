// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native WasmGC string helpers — $AnyString, $FlatString, $ConsString types
 * and ensureNativeStringHelpers which emits the full string runtime.
 *
 * Extracted from codegen/index.ts (#1013).
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ensureLateImport } from "./expressions/late-imports.js";
import { addImport } from "./registry/imports.js";
import { addFuncType, getOrRegisterArrayType, getOrRegisterVecType } from "./registry/types.js";

export function nativeStringType(ctx: CodegenContext): ValType {
  return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
}

/**
 * Build the inline instruction sequence that materializes a string literal as
 * a NativeString (FlatString) struct ref. Mirrors `compileNativeStringLiteral`
 * but returns an `Instr[]` for callers that build instruction streams without
 * a `FunctionContext` (e.g. throw-instr builders that return `Instr[]`).
 */
export function nativeStringLiteralInstrs(ctx: CodegenContext, value: string): Instr[] {
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const instrs: Instr[] = [];
  // len (i32), off (i32) = 0
  instrs.push({ op: "i32.const", value: value.length });
  instrs.push({ op: "i32.const", value: 0 });
  // code units, then array.new_fixed
  for (let i = 0; i < value.length; i++) {
    instrs.push({ op: "i32.const", value: value.charCodeAt(i) });
  }
  instrs.push({ op: "array.new_fixed", typeIdx: strDataTypeIdx, length: value.length });
  // struct.new $NativeString(len, off, data)
  instrs.push({ op: "struct.new", typeIdx: strTypeIdx });
  return instrs;
}

/**
 * Build inline instructions that push a string constant onto the stack as an
 * externref (the type expected by the throw tag and by host imports). In
 * nativeStrings mode, materializes the FlatString struct inline and converts
 * to externref. In legacy mode, emits a plain `global.get` of the
 * `string_constants` import. Both branches require the value to be present
 * in `ctx.stringGlobalMap` — call `addStringConstantGlobal(ctx, value)` first.
 */
export function stringConstantExternrefInstrs(ctx: CodegenContext, value: string): Instr[] {
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
    const instrs = nativeStringLiteralInstrs(ctx, value);
    // ref $NativeString -> externref
    instrs.push({ op: "extern.convert_any" } as Instr);
    return instrs;
  }
  const strIdx = ctx.stringGlobalMap.get(value);
  if (strIdx === undefined || strIdx < 0) {
    // Defensive: caller forgot to register, or sentinel. Push undefined.
    return [{ op: "ref.null.extern" } as Instr];
  }
  return [{ op: "global.get", index: strIdx } as Instr];
}

/**
 * Get the nullable ValType for a string reference (ref null $AnyString).
 */
export function nativeStringTypeNullable(ctx: CodegenContext): ValType {
  return { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
}

/**
 * Get the ValType for a flat string reference (ref $NativeString).
 */
export function flatStringType(ctx: CodegenContext): ValType {
  return { kind: "ref", typeIdx: ctx.nativeStrTypeIdx };
}

/**
 * Emit native string helper functions into the module.
 * Called lazily when string operations are first encountered in fast mode.
 *
 * IMPORTANT: All imports must be registered BEFORE any module functions,
 * because wasm function indices are: imports first, then module functions.
 */
export function ensureNativeStringHelpers(ctx: CodegenContext): void {
  if (ctx.nativeStrHelpersEmitted) return;
  ctx.nativeStrHelpersEmitted = true;

  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx; // NativeString (FlatString) struct type index
  const anyStrTypeIdx = ctx.anyStrTypeIdx; // AnyString base type index
  const consStrTypeIdx = ctx.consStrTypeIdx; // ConsString type index
  // strRef = ref $AnyString — used in all helper function signatures (params and results).
  // All string values in the system can be either FlatString or ConsString.
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const flatStrRef: ValType = { kind: "ref", typeIdx: strTypeIdx }; // ref $NativeString
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };

  // Helper: get the flatten function index (available after flatten is registered)
  const getFlattenIdx = () => ctx.nativeStrHelpers.get("__str_flatten")!;

  /**
   * Wrap a helper body with flatten preambles for string params.
   * For each string param index in `strParamIndices`, adds:
   *   local.get $param → call $__str_flatten → local.set $param
   * This ensures the param (typed ref $AnyString) actually holds a NativeString.
   * Also inserts ref.cast $NativeString before every struct.get $NativeString
   * to satisfy the wasm type checker.
   */
  function wrapBodyWithFlatten(body: Instr[], strParamIndices: number[]): Instr[] {
    // 1. Build flatten preamble
    const preamble: Instr[] = [];
    for (const idx of strParamIndices) {
      preamble.push(
        { op: "local.get", index: idx },
        { op: "call", funcIdx: getFlattenIdx() },
        // flatten returns ref $NativeString which is subtype of ref $AnyString — can store in param
        { op: "local.set", index: idx },
      );
    }

    // 2. Insert ref.cast before every struct.get $NativeString
    const processed: Instr[] = [];
    for (const instr of body) {
      if (instr.op === "struct.get" && (instr as any).typeIdx === strTypeIdx) {
        processed.push({ op: "ref.cast", typeIdx: strTypeIdx });
      }
      // Recurse into if/block/loop bodies
      if (instr.op === "if") {
        const ifInstr = instr as any;
        const newIf: any = { ...ifInstr };
        if (ifInstr.then) newIf.then = wrapBodyWithFlatten(ifInstr.then, []).slice(0); // no preamble for sub-bodies
        if (ifInstr.else) newIf.else = wrapBodyWithFlatten(ifInstr.else, []).slice(0);
        processed.push(newIf);
        continue;
      }
      if (instr.op === "block" || instr.op === "loop") {
        const blockInstr = instr as any;
        const newBlock: any = { ...blockInstr };
        if (blockInstr.body) newBlock.body = wrapBodyWithFlatten(blockInstr.body, []).slice(0);
        processed.push(newBlock);
        continue;
      }
      processed.push(instr);
    }

    return [...preamble, ...processed];
  }

  // ── Step 2: Now add all module functions ─────────────────────────

  // --- $__str_copy_tree(node: ref $AnyString, buf: ref $__str_data, pos: i32) -> i32 ---
  // Iteratively copies rope tree into a flat buffer. Returns next write position.
  //
  // Previously this used self-recursion to traverse the rope tree, which caused
  // a wasm `call stack exhausted` trap on left-leaning ropes built by `text +=
  // expr` patterns over many thousands of iterations (#1178). The deep
  // left-spine of `Cons(Cons(Cons(..., c2), c1), c0)` made one stack frame per
  // cons node.
  //
  // The iterative version uses an explicit worklist of right-children. We
  // descend the leftmost spine (pushing right-children onto the worklist),
  // copy each flat leaf, then pop and resume from the most recently pushed
  // right-child. Stack usage is now O(1); heap usage is O(node.len) for the
  // worklist (overestimate; depth ≤ leaves ≤ len since each leaf has ≥ 1 char).
  {
    // Register the worklist's array type: (array (mut (ref null $AnyString))).
    // Reuses the same registration as `__str_split` (keyed by `ref_<anyStr>`).
    const wlElemKey = `ref_${anyStrTypeIdx}`;
    const wlElemType: ValType = { kind: "ref_null", typeIdx: anyStrTypeIdx };
    const wlArrTypeIdx = getOrRegisterArrayType(ctx, wlElemKey, wlElemType);
    const wlArrRefNull: ValType = { kind: "ref_null", typeIdx: wlArrTypeIdx };

    const typeIdx = addFuncType(ctx, [strRef, strDataRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_copy_tree", funcIdx);

    // params: node(0), buf(1), pos(2)
    // locals:
    //   flat(3): ref_null $NativeString — current flat node being copied
    //   flatOff(4): i32
    //   flatLen(5): i32
    //   cur(6): ref_null $AnyString — current node in the descent
    //   worklist(7): ref_null $AnyString_arr — pending right-children
    //   wlTop(8): i32 — number of items currently on the worklist
    //   nodeLen(9): i32 — node.len (used to size the worklist)
    const FLAT = 3;
    const FLAT_OFF = 4;
    const FLAT_LEN = 5;
    const CUR = 6;
    const WL = 7;
    const WL_TOP = 8;
    const NODE_LEN = 9;

    const body: Instr[] = [
      // Fast path: if node is already a FlatString, copy directly and return.
      { op: "local.get", index: 0 },
      { op: "ref.test", typeIdx: strTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "ref.cast", typeIdx: strTypeIdx },
          { op: "local.set", index: FLAT },

          { op: "local.get", index: FLAT },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // off
          { op: "local.set", index: FLAT_OFF },

          { op: "local.get", index: FLAT },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }, // len
          { op: "local.set", index: FLAT_LEN },

          // array.copy(buf, pos, flat.data, flatOff, flatLen)
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "local.get", index: FLAT },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // data
          { op: "local.get", index: FLAT_OFF },
          { op: "local.get", index: FLAT_LEN },
          { op: "array.copy", dstTypeIdx: strDataTypeIdx, srcTypeIdx: strDataTypeIdx },

          // return pos + flatLen
          { op: "local.get", index: 2 },
          { op: "local.get", index: FLAT_LEN },
          { op: "i32.add" },
          { op: "return" },
        ],
      },

      // Slow path: rope traversal with an explicit worklist of right-children.
      // nodeLen = node.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: NODE_LEN },

      // worklist = array.new_default<ref_null $AnyString>(nodeLen)
      // nodeLen is a safe upper bound on rope depth (≥ 1 char per leaf).
      { op: "local.get", index: NODE_LEN },
      { op: "array.new_default", typeIdx: wlArrTypeIdx },
      { op: "local.set", index: WL },

      // wlTop = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: WL_TOP },

      // cur = node
      { op: "local.get", index: 0 },
      { op: "local.set", index: CUR },

      // Outer loop: descend left, copy a flat segment, pop next right-child.
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // Inner loop: walk left while cur is a ConsString, pushing
              // right-children onto the worklist. Exits when cur is FlatString.
              {
                op: "block",
                blockType: { kind: "empty" },
                body: [
                  {
                    op: "loop",
                    blockType: { kind: "empty" },
                    body: [
                      // if cur is FlatString: br to end of inner block (depth 1)
                      { op: "local.get", index: CUR },
                      { op: "ref.as_non_null" },
                      { op: "ref.test", typeIdx: strTypeIdx },
                      { op: "br_if", depth: 1 },

                      // worklist[wlTop] = (cur as ConsString).right
                      { op: "local.get", index: WL },
                      { op: "ref.as_non_null" },
                      { op: "local.get", index: WL_TOP },
                      { op: "local.get", index: CUR },
                      { op: "ref.as_non_null" },
                      { op: "ref.cast", typeIdx: consStrTypeIdx },
                      { op: "struct.get", typeIdx: consStrTypeIdx, fieldIdx: 2 },
                      { op: "array.set", typeIdx: wlArrTypeIdx },

                      // wlTop++
                      { op: "local.get", index: WL_TOP },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: WL_TOP },

                      // cur = (cur as ConsString).left
                      { op: "local.get", index: CUR },
                      { op: "ref.as_non_null" },
                      { op: "ref.cast", typeIdx: consStrTypeIdx },
                      { op: "struct.get", typeIdx: consStrTypeIdx, fieldIdx: 1 },
                      { op: "local.set", index: CUR },

                      // continue inner loop
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },

              // cur is a FlatString — copy its contents into buf at pos.
              { op: "local.get", index: CUR },
              { op: "ref.as_non_null" },
              { op: "ref.cast", typeIdx: strTypeIdx },
              { op: "local.set", index: FLAT },

              { op: "local.get", index: FLAT },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // off
              { op: "local.set", index: FLAT_OFF },

              { op: "local.get", index: FLAT },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }, // len
              { op: "local.set", index: FLAT_LEN },

              // array.copy(buf, pos, flat.data, flatOff, flatLen)
              { op: "local.get", index: 1 },
              { op: "local.get", index: 2 },
              { op: "local.get", index: FLAT },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // data
              { op: "local.get", index: FLAT_OFF },
              { op: "local.get", index: FLAT_LEN },
              { op: "array.copy", dstTypeIdx: strDataTypeIdx, srcTypeIdx: strDataTypeIdx },

              // pos += flatLen
              { op: "local.get", index: 2 },
              { op: "local.get", index: FLAT_LEN },
              { op: "i32.add" },
              { op: "local.set", index: 2 },

              // if wlTop == 0: br to end of outer block (depth 1) — done
              { op: "local.get", index: WL_TOP },
              { op: "i32.eqz" },
              { op: "br_if", depth: 1 },

              // wlTop--
              { op: "local.get", index: WL_TOP },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "local.set", index: WL_TOP },

              // cur = worklist[wlTop]
              { op: "local.get", index: WL },
              { op: "ref.as_non_null" },
              { op: "local.get", index: WL_TOP },
              { op: "array.get", typeIdx: wlArrTypeIdx },
              { op: "local.set", index: CUR },

              // continue outer loop
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // return pos
      { op: "local.get", index: 2 },
    ];

    ctx.mod.functions.push({
      name: "__str_copy_tree",
      typeIdx,
      locals: [
        { name: "flat", type: { kind: "ref_null", typeIdx: strTypeIdx } },
        { name: "flatOff", type: { kind: "i32" } },
        { name: "flatLen", type: { kind: "i32" } },
        { name: "cur", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
        { name: "worklist", type: wlArrRefNull },
        { name: "wlTop", type: { kind: "i32" } },
        { name: "nodeLen", type: { kind: "i32" } },
      ],
      body,
      exported: false,
    });
  }

  // --- $__str_flatten(s: ref $AnyString) -> ref $NativeString ---
  // If s is already a FlatString, returns it. Otherwise flattens the rope tree.
  {
    const typeIdx = addFuncType(ctx, [strRef], [flatStrRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_flatten", funcIdx);

    const copyTreeIdx = ctx.nativeStrHelpers.get("__str_copy_tree")!;

    // params: s(0)
    // locals: len(1), buf(2)
    const body: Instr[] = [
      // if s is already a FlatString, return it
      { op: "local.get", index: 0 },
      { op: "ref.test", typeIdx: strTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: flatStrRef },
        then: [
          { op: "local.get", index: 0 },
          { op: "ref.cast", typeIdx: strTypeIdx },
        ],
        else: [
          // len = s.len (field 0 of AnyString)
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: 1 },

          // buf = array.new_default(len)
          { op: "local.get", index: 1 },
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "local.set", index: 2 },

          // copy_tree(s, buf, 0)
          { op: "local.get", index: 0 },
          { op: "local.get", index: 2 },
          { op: "i32.const", value: 0 },
          { op: "call", funcIdx: copyTreeIdx },
          { op: "drop" }, // discard returned position

          // return struct.new $NativeString(len, 0, buf)
          { op: "local.get", index: 1 }, // len
          { op: "i32.const", value: 0 }, // off = 0
          { op: "local.get", index: 2 }, // data = buf
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
      },
    ];

    ctx.mod.functions.push({
      name: "__str_flatten",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "buf", type: strDataRef },
      ],
      body,
      exported: false,
    });
  }

  // --- $__str_concat(a: ref $AnyString, b: ref $AnyString) -> ref $AnyString ---
  // For short strings (combined length < 64), copies into a flat string.
  // For longer strings, creates a ConsString node in O(1).
  {
    const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
    const typeIdx = addFuncType(ctx, [strRef, strRef], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_concat", funcIdx);

    // params: a(0), b(1)
    // locals: lenA(2), lenB(3), newLen(4), newArr(5), flatA(6), flatB(7)
    const body: Instr[] = [
      // lenA = a.len (field 0 of AnyString)
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 }, // lenA

      // lenB = b.len (field 0 of AnyString)
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 }, // lenB

      // newLen = lenA + lenB
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.add" },
      { op: "local.set", index: 4 }, // newLen

      // if newLen >= 64, create ConsString (O(1) rope node)
      { op: "local.get", index: 4 },
      { op: "i32.const", value: 64 },
      { op: "i32.ge_u" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          // struct.new $ConsString(newLen, a, b)
          { op: "local.get", index: 4 }, // len = newLen
          { op: "local.get", index: 0 }, // left = a
          { op: "local.get", index: 1 }, // right = b
          { op: "struct.new", typeIdx: consStrTypeIdx },
        ],
        else: [
          // Short string: flatten both sides and copy
          // flatA = flatten(a)
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: flattenIdx },
          { op: "local.set", index: 6 },

          // flatB = flatten(b)
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: flattenIdx },
          { op: "local.set", index: 7 },

          // newArr = array.new_default(newLen)
          { op: "local.get", index: 4 },
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "local.set", index: 5 },

          // array.copy(newArr, 0, flatA.data, flatA.off, lenA)
          { op: "local.get", index: 5 }, // dst
          { op: "ref.as_non_null" },
          { op: "i32.const", value: 0 }, // dstOffset
          { op: "local.get", index: 6 }, // flatA
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // flatA.data
          { op: "local.get", index: 6 }, // flatA
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // flatA.off
          { op: "local.get", index: 2 }, // lenA
          { op: "array.copy", dstTypeIdx: strDataTypeIdx, srcTypeIdx: strDataTypeIdx },

          // array.copy(newArr, lenA, flatB.data, flatB.off, lenB)
          { op: "local.get", index: 5 }, // dst
          { op: "ref.as_non_null" },
          { op: "local.get", index: 2 }, // dstOffset = lenA
          { op: "local.get", index: 7 }, // flatB
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // flatB.data
          { op: "local.get", index: 7 }, // flatB
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // flatB.off
          { op: "local.get", index: 3 }, // lenB
          { op: "array.copy", dstTypeIdx: strDataTypeIdx, srcTypeIdx: strDataTypeIdx },

          // result = struct.new $NativeString(newLen, 0, newArr)
          { op: "local.get", index: 4 }, // len = newLen
          { op: "i32.const", value: 0 }, // off = 0
          { op: "local.get", index: 5 }, // data = newArr
          { op: "ref.as_non_null" },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
      },
    ];

    ctx.mod.functions.push({
      name: "__str_concat",
      typeIdx,
      locals: [
        { name: "lenA", type: { kind: "i32" } },
        { name: "lenB", type: { kind: "i32" } },
        { name: "newLen", type: { kind: "i32" } },
        { name: "newArr", type: { kind: "ref_null", typeIdx: strDataTypeIdx } },
        { name: "flatA", type: { kind: "ref_null", typeIdx: strTypeIdx } },
        { name: "flatB", type: { kind: "ref_null", typeIdx: strTypeIdx } },
      ],
      body,
      exported: false,
    });
  }

  // --- $__str_buf_next_cap(curCap: i32, needed: i32) -> i32 ---
  // Returns a capacity at least as large as `needed`, doubling `curCap` until
  // the requirement is met. Used by the #1210 string-builder rewrite to size
  // the growable i16 buffer with O(log N) reallocations instead of O(N) per
  // `s += <expr>`. If `needed` exceeds INT32 doubling, returns `needed`
  // directly (caller traps on out-of-memory at the array.new_default site).
  {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_buf_next_cap", funcIdx);

    // params: curCap(0), needed(1)
    // Strategy: ensure at least 16 bytes, then double until >= needed.
    const body: Instr[] = [
      // if curCap < 16 then curCap = 16 (ensures starting size)
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 16 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 16 },
          { op: "local.set", index: 0 },
        ],
      },
      // while (curCap < needed) curCap = curCap * 2
      // block { loop { if (curCap >= needed) br outer; curCap *= 2; br inner } }
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if curCap >= needed: br outer (depth 1)
              { op: "local.get", index: 0 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // curCap *= 2
              { op: "local.get", index: 0 },
              { op: "i32.const", value: 1 },
              { op: "i32.shl" },
              { op: "local.set", index: 0 },
              // restart loop
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return curCap
      { op: "local.get", index: 0 },
    ];

    ctx.mod.functions.push({
      name: "__str_buf_next_cap",
      typeIdx,
      locals: [],
      body,
      exported: false,
    });
  }

  // --- $__str_equals(a: ref $NativeString, b: ref $NativeString) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef], [{ kind: "i32" }]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_equals", funcIdx);

    // locals: len(2), i(3), aData(4), bData(5), aOff(6), bOff(7)
    const body: Instr[] = [
      // len = a.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 }, // len

      // if a.len != b.len return 0
      { op: "local.get", index: 2 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "i32.ne" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },

      // aOff = a.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 6 },

      // bOff = b.off
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 7 },

      // aData = a.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 4 },

      // bData = b.data
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 5 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 3 },

      // loop: compare element by element
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= len, break (strings are equal)
              { op: "local.get", index: 3 },
              { op: "local.get", index: 2 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },

              // if aData[aOff + i] != bData[bOff + i], return 0
              { op: "local.get", index: 4 },
              { op: "local.get", index: 6 },
              { op: "local.get", index: 3 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.get", index: 5 },
              { op: "local.get", index: 7 },
              { op: "local.get", index: 3 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "i32.ne" },
              { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },

              // i++
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 3 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // return 1 (equal)
      { op: "i32.const", value: 1 },
    ];

    ctx.mod.functions.push({
      name: "__str_equals",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "aData", type: strDataRef },
        { name: "bData", type: strDataRef },
        { name: "aOff", type: { kind: "i32" } },
        { name: "bOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_compare(a: ref $NativeString, b: ref $NativeString) -> i32 ---
  // Lexicographic comparison: returns -1 (a < b), 0 (a == b), or 1 (a > b)
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef], [{ kind: "i32" }]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_compare", funcIdx);

    // locals: lenA(2), lenB(3), minLen(4), i(5), aData(6), bData(7), aOff(8), bOff(9), ca(10), cb(11)
    const body: Instr[] = [
      // lenA = a.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 },

      // lenB = b.len
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },

      // minLen = min(lenA, lenB)
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.lt_u" },
      { op: "select" },
      { op: "local.set", index: 4 },

      // aOff = a.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 8 },

      // bOff = b.off
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 9 },

      // aData = a.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 6 },

      // bData = b.data
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 7 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 },

      // loop: compare element by element
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= minLen, break (common prefix is equal)
              { op: "local.get", index: 5 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },

              // ca = aData[aOff + i]
              { op: "local.get", index: 6 },
              { op: "local.get", index: 8 },
              { op: "local.get", index: 5 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.set", index: 10 },

              // cb = bData[bOff + i]
              { op: "local.get", index: 7 },
              { op: "local.get", index: 9 },
              { op: "local.get", index: 5 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.set", index: 11 },

              // if ca < cb return -1
              { op: "local.get", index: 10 },
              { op: "local.get", index: 11 },
              { op: "i32.lt_u" },
              { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: -1 }, { op: "return" }] },

              // if ca > cb return 1
              { op: "local.get", index: 10 },
              { op: "local.get", index: 11 },
              { op: "i32.gt_u" },
              { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },

              // i++
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // Common prefix is equal; compare by length
      // if lenA < lenB return -1
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.lt_u" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: -1 }, { op: "return" }] },

      // if lenA > lenB return 1
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.gt_u" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },

      // return 0 (equal)
      { op: "i32.const", value: 0 },
    ];

    ctx.mod.functions.push({
      name: "__str_compare",
      typeIdx,
      locals: [
        { name: "lenA", type: { kind: "i32" } },
        { name: "lenB", type: { kind: "i32" } },
        { name: "minLen", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "aData", type: strDataRef },
        { name: "bData", type: strDataRef },
        { name: "aOff", type: { kind: "i32" } },
        { name: "bOff", type: { kind: "i32" } },
        { name: "ca", type: { kind: "i32" } },
        { name: "cb", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_substring(s: ref $NativeString, start: i32, end: i32) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }, { kind: "i32" }], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_substring", funcIdx);

    // O(1) substring: creates a view sharing the backing array.
    // locals: sOff(3), sLen(4)
    const body: Instr[] = [
      // sOff = s.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 3 },

      // sLen = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },

      // Clamp start: max(0, min(start, sLen))
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.gt_s" },
      { op: "select" },
      { op: "local.tee", index: 1 }, // start = max(0, start)
      { op: "local.get", index: 4 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 4 },
      { op: "i32.lt_s" },
      { op: "select" },
      { op: "local.set", index: 1 }, // start = min(start, sLen)

      // Clamp end: max(0, min(end, sLen))
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.gt_s" },
      { op: "select" },
      { op: "local.tee", index: 2 }, // end = max(0, end)
      { op: "local.get", index: 4 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 4 },
      { op: "i32.lt_s" },
      { op: "select" },
      { op: "local.set", index: 2 }, // end = min(end, sLen)

      // Swap if start > end (JS substring semantics)
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "i32.gt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 },
          { op: "local.get", index: 1 },
          { op: "local.set", index: 2 },
          { op: "local.set", index: 1 },
        ],
      },

      // struct.new(len = end - start, off = sOff + start, s.data)
      { op: "local.get", index: 2 }, // end
      { op: "local.get", index: 1 }, // start
      { op: "i32.sub" }, // len = end - start
      { op: "local.get", index: 3 }, // sOff
      { op: "local.get", index: 1 }, // start
      { op: "i32.add" }, // off = sOff + start
      { op: "local.get", index: 0 }, // s
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // s.data
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    ctx.mod.functions.push({
      name: "__str_substring",
      typeIdx,
      locals: [
        { name: "sOff", type: { kind: "i32" } },
        { name: "sLen", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_charAt(s: ref $NativeString, idx: i32) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_charAt", funcIdx);

    const body: Instr[] = [
      // Bounds check: if idx < 0 || idx >= s.len, return empty string
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "i32.ge_s" },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          // empty string: off=0, len=0, empty array
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
        else: [
          // Single-char string: len=1, off=0, [char]
          { op: "i32.const", value: 1 }, // len
          { op: "i32.const", value: 0 }, // off
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // data
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // off
          { op: "local.get", index: 1 },
          { op: "i32.add" }, // off + idx
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          // Create single-element array
          { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 1 },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
      },
    ];

    ctx.mod.functions.push({
      name: "__str_charAt",
      typeIdx,
      locals: [],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_slice(s: ref $NativeString, start: i32, end: i32) -> ref $NativeString ---
  // Like substring but handles negative indices
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }, { kind: "i32" }], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_slice", funcIdx);

    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    // locals: len (index 3)
    const body: Instr[] = [
      // len = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 }, // len

      // Resolve negative start: if start < 0, start = len + start
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 3 }, // len
          { op: "local.get", index: 1 }, // start (negative)
          { op: "i32.add" },
          { op: "local.set", index: 1 },
        ],
      },
      // Clamp start to >= 0
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 1 },
        ],
      },

      // Resolve negative end: if end < 0, end = len + end
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 3 }, // len
          { op: "local.get", index: 2 }, // end (negative)
          { op: "i32.add" },
          { op: "local.set", index: 2 },
        ],
      },
      // Clamp end to >= 0
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 2 },
        ],
      },

      // Delegate to __str_substring (which handles clamping to len and swapping)
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: substringIdx },
    ];

    ctx.mod.functions.push({
      name: "__str_slice",
      typeIdx,
      locals: [{ name: "len", type: { kind: "i32" } }],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_indexOf(haystack: ref $NativeString, needle: ref $NativeString, fromIndex: i32) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_indexOf", funcIdx);

    // params: haystack(0), needle(1), fromIndex(2)
    // locals: hLen(3), nLen(4), i(5), j(6), hData(7), nData(8), hOff(9), nOff(10)
    const body: Instr[] = [
      // hLen = haystack.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      // nLen = needle.len
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },
      // if nLen == 0, return clamp(fromIndex, 0, hLen)
      { op: "local.get", index: 4 },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: 2 },
          { op: "i32.const", value: 0 },
          { op: "i32.gt_s" },
          { op: "select" },
          { op: "local.tee", index: 5 },
          { op: "local.get", index: 3 },
          { op: "local.get", index: 5 },
          { op: "local.get", index: 3 },
          { op: "i32.lt_s" },
          { op: "select" },
          { op: "return" },
        ],
      },
      // hOff = haystack.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 9 },
      // nOff = needle.off
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 10 },
      // hData = haystack.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 7 },
      // nData = needle.data
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 8 },
      // i = max(fromIndex, 0)
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.gt_s" },
      { op: "select" },
      { op: "local.set", index: 5 },
      // outer loop: scan i from fromIndex to hLen - nLen
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i > hLen - nLen, break
              { op: "local.get", index: 5 },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 4 },
              { op: "i32.sub" },
              { op: "i32.gt_s" },
              { op: "br_if", depth: 1 },
              // j = 0; inner loop to compare needle chars
              { op: "i32.const", value: 0 },
              { op: "local.set", index: 6 },
              {
                op: "block",
                blockType: { kind: "empty" },
                body: [
                  {
                    op: "loop",
                    blockType: { kind: "empty" },
                    body: [
                      // if j >= nLen, match found — return i
                      { op: "local.get", index: 6 },
                      { op: "local.get", index: 4 },
                      { op: "i32.ge_s" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [{ op: "local.get", index: 5 }, { op: "return" }],
                      },
                      // if hData[hOff + i + j] != nData[nOff + j], break inner
                      { op: "local.get", index: 7 },
                      { op: "local.get", index: 9 },
                      { op: "local.get", index: 5 },
                      { op: "i32.add" },
                      { op: "local.get", index: 6 },
                      { op: "i32.add" },
                      { op: "array.get_u", typeIdx: strDataTypeIdx },
                      { op: "local.get", index: 8 },
                      { op: "local.get", index: 10 },
                      { op: "local.get", index: 6 },
                      { op: "i32.add" },
                      { op: "array.get_u", typeIdx: strDataTypeIdx },
                      { op: "i32.ne" },
                      { op: "br_if", depth: 1 },
                      // j++
                      { op: "local.get", index: 6 },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: 6 },
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },
              // i++
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // not found
      { op: "i32.const", value: -1 },
    ];

    ctx.mod.functions.push({
      name: "__str_indexOf",
      typeIdx,
      locals: [
        { name: "hLen", type: { kind: "i32" } },
        { name: "nLen", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "j", type: { kind: "i32" } },
        { name: "hData", type: strDataRef },
        { name: "nData", type: strDataRef },
        { name: "hOff", type: { kind: "i32" } },
        { name: "nOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_lastIndexOf(haystack: ref $NativeString, needle: ref $NativeString, fromIndex: i32) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_lastIndexOf", funcIdx);

    // params: haystack(0), needle(1), fromIndex(2)
    // locals: hLen(3), nLen(4), i(5), j(6), hData(7), nData(8), hOff(9), nOff(10)
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },
      // if nLen == 0, return min(fromIndex, hLen)
      { op: "local.get", index: 4 },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 },
          { op: "local.get", index: 3 },
          { op: "local.get", index: 2 },
          { op: "local.get", index: 3 },
          { op: "i32.lt_s" },
          { op: "select" },
          { op: "return" },
        ],
      },
      // hOff, nOff
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 9 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 10 },
      // hData, nData
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 7 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 8 },
      // i = min(fromIndex, hLen - nLen)
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "local.get", index: 4 },
      { op: "i32.sub" },
      { op: "local.tee", index: 5 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 5 },
      { op: "i32.lt_s" },
      { op: "select" },
      { op: "local.set", index: 5 },
      // reverse scan
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 0 },
              { op: "i32.lt_s" },
              { op: "br_if", depth: 1 },
              { op: "i32.const", value: 0 },
              { op: "local.set", index: 6 },
              {
                op: "block",
                blockType: { kind: "empty" },
                body: [
                  {
                    op: "loop",
                    blockType: { kind: "empty" },
                    body: [
                      { op: "local.get", index: 6 },
                      { op: "local.get", index: 4 },
                      { op: "i32.ge_s" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [{ op: "local.get", index: 5 }, { op: "return" }],
                      },
                      // hData[hOff + i + j]
                      { op: "local.get", index: 7 },
                      { op: "local.get", index: 9 },
                      { op: "local.get", index: 5 },
                      { op: "i32.add" },
                      { op: "local.get", index: 6 },
                      { op: "i32.add" },
                      { op: "array.get_u", typeIdx: strDataTypeIdx },
                      // nData[nOff + j]
                      { op: "local.get", index: 8 },
                      { op: "local.get", index: 10 },
                      { op: "local.get", index: 6 },
                      { op: "i32.add" },
                      { op: "array.get_u", typeIdx: strDataTypeIdx },
                      { op: "i32.ne" },
                      { op: "br_if", depth: 1 },
                      { op: "local.get", index: 6 },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: 6 },
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // not found
      { op: "i32.const", value: -1 },
    ];

    ctx.mod.functions.push({
      name: "__str_lastIndexOf",
      typeIdx,
      locals: [
        { name: "hLen", type: { kind: "i32" } },
        { name: "nLen", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "j", type: { kind: "i32" } },
        { name: "hData", type: strDataRef },
        { name: "nData", type: strDataRef },
        { name: "hOff", type: { kind: "i32" } },
        { name: "nOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_includes(haystack: ref $NativeString, needle: ref $NativeString, fromIndex: i32) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_includes", funcIdx);

    const indexOfIdx = ctx.nativeStrHelpers.get("__str_indexOf")!;

    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: indexOfIdx },
      { op: "i32.const", value: -1 },
      { op: "i32.ne" },
    ];

    ctx.mod.functions.push({
      name: "__str_includes",
      typeIdx,
      locals: [],
      body,
      exported: false,
    });
  }

  // --- $__str_startsWith(s: ref $NativeString, prefix: ref $NativeString, position: i32) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_startsWith", funcIdx);

    // params: s(0), prefix(1), position(2)
    // locals: sLen(3), pLen(4), i(5), sData(6), pData(7), sOff(8), pOff(9)
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },
      // if position + pLen > sLen, return 0
      { op: "local.get", index: 2 },
      { op: "local.get", index: 4 },
      { op: "i32.add" },
      { op: "local.get", index: 3 },
      { op: "i32.gt_s" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
      // sOff, pOff
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 8 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 9 },
      // sData, pData
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 6 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 7 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 },
      // compare loop
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 5 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_s" },
              { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
              // sData[sOff + position + i]
              { op: "local.get", index: 6 },
              { op: "local.get", index: 8 },
              { op: "local.get", index: 2 },
              { op: "i32.add" },
              { op: "local.get", index: 5 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              // pData[pOff + i]
              { op: "local.get", index: 7 },
              { op: "local.get", index: 9 },
              { op: "local.get", index: 5 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "i32.ne" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // mismatch found
      { op: "i32.const", value: 0 },
    ];

    ctx.mod.functions.push({
      name: "__str_startsWith",
      typeIdx,
      locals: [
        { name: "sLen", type: { kind: "i32" } },
        { name: "pLen", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "sData", type: strDataRef },
        { name: "pData", type: strDataRef },
        { name: "sOff", type: { kind: "i32" } },
        { name: "pOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_endsWith(s: ref $NativeString, suffix: ref $NativeString, endPos: i32) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_endsWith", funcIdx);

    // params: s(0), suffix(1), endPos(2)
    // locals: sxLen(3), i(4), sData(5), xData(6), startPos(7), sLen(8), sOff(9), xOff(10)
    const body: Instr[] = [
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      // sLen = s.len; clamp endPos to sLen
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 8 },
      // endPos = min(endPos, sLen)
      { op: "local.get", index: 2 },
      { op: "local.get", index: 8 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 8 },
      { op: "i32.lt_s" },
      { op: "select" },
      { op: "local.set", index: 2 },
      // startPos = endPos - sxLen
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.sub" },
      { op: "local.set", index: 7 },
      // if startPos < 0, return 0
      { op: "local.get", index: 7 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
      // sOff, xOff
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 9 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 10 },
      // sData, xData
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 5 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 6 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 4 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 4 },
              { op: "local.get", index: 3 },
              { op: "i32.ge_s" },
              { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
              // sData[sOff + startPos + i]
              { op: "local.get", index: 5 },
              { op: "local.get", index: 9 },
              { op: "local.get", index: 7 },
              { op: "i32.add" },
              { op: "local.get", index: 4 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              // xData[xOff + i]
              { op: "local.get", index: 6 },
              { op: "local.get", index: 10 },
              { op: "local.get", index: 4 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "i32.ne" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 4 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 4 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "i32.const", value: 0 },
    ];

    ctx.mod.functions.push({
      name: "__str_endsWith",
      typeIdx,
      locals: [
        { name: "sxLen", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "sData", type: strDataRef },
        { name: "xData", type: strDataRef },
        { name: "startPos", type: { kind: "i32" } },
        { name: "sLen", type: { kind: "i32" } },
        { name: "sOff", type: { kind: "i32" } },
        { name: "xOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_isWhitespace(codeUnit: i32) -> i32 (helper, not exported) ---
  // Checks if a WTF-16 code unit is whitespace: 0x09-0x0D, 0x20, 0xA0, 0xFEFF
  {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_isWhitespace", funcIdx);

    const body: Instr[] = [
      // Check ranges: 0x09 <= c <= 0x0D || c == 0x20 || c == 0xA0 || c == 0xFEFF
      // Use a chain of comparisons
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0x20 },
      { op: "i32.eq" },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0x09 },
      { op: "i32.ge_u" },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0x0d },
      { op: "i32.le_u" },
      { op: "i32.and" },
      { op: "i32.or" },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0xa0 },
      { op: "i32.eq" },
      { op: "i32.or" },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0xfeff },
      { op: "i32.eq" },
      { op: "i32.or" },
    ];

    ctx.mod.functions.push({
      name: "__str_isWhitespace",
      typeIdx,
      locals: [],
      body,
      exported: false,
    });
  }

  // --- $__str_trimStart(s: ref $NativeString) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_trimStart", funcIdx);

    const isWsIdx = ctx.nativeStrHelpers.get("__str_isWhitespace")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    // params: s(0)
    // locals: len(1), i(2), sData(3), sOff(4)
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 4 }, // sOff
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 3 }, // sData
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 2 },
      // scan forward while whitespace
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 2 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // sData[sOff + i]
              { op: "local.get", index: 3 },
              { op: "local.get", index: 4 },
              { op: "local.get", index: 2 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "call", funcIdx: isWsIdx },
              { op: "i32.eqz" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 2 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return substring(s, i, len)
      { op: "local.get", index: 0 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: substringIdx },
    ];

    ctx.mod.functions.push({
      name: "__str_trimStart",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "sData", type: strDataRef },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_trimEnd(s: ref $NativeString) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_trimEnd", funcIdx);

    const isWsIdx = ctx.nativeStrHelpers.get("__str_isWhitespace")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    // params: s(0)
    // locals: end(1), sData(2), sOff(3)
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 }, // end = len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 3 }, // sOff
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 2 }, // sData
      // scan backward while whitespace
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 1 },
              { op: "i32.const", value: 0 },
              { op: "i32.le_s" },
              { op: "br_if", depth: 1 },
              // sData[sOff + end - 1]
              { op: "local.get", index: 2 },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 1 },
              { op: "i32.add" },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "call", funcIdx: isWsIdx },
              { op: "i32.eqz" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 1 },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "local.set", index: 1 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return substring(s, 0, end)
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: substringIdx },
    ];

    ctx.mod.functions.push({
      name: "__str_trimEnd",
      typeIdx,
      locals: [
        { name: "end", type: { kind: "i32" } },
        { name: "sData", type: strDataRef },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_trim(s: ref $NativeString) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_trim", funcIdx);

    const trimStartIdx = ctx.nativeStrHelpers.get("__str_trimStart")!;
    const trimEndIdx = ctx.nativeStrHelpers.get("__str_trimEnd")!;

    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: trimStartIdx },
      { op: "call", funcIdx: trimEndIdx },
    ];

    ctx.mod.functions.push({
      name: "__str_trim",
      typeIdx,
      locals: [],
      body,
      exported: false,
    });
  }

  // --- $__str_repeat(s: ref $NativeString, count: i32) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_repeat", funcIdx);

    // params: s(0), count(1)
    // locals: sLen(2), newLen(3), newArr(4), dst(5), srcData(6), copyI(7), sOff(8)
    const body: Instr[] = [
      // sLen = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 },

      // if count <= 0 or sLen == 0, return empty string
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.le_s" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          { op: "i32.const", value: 0 }, // off = 0
          { op: "i32.const", value: 0 }, // len = 0
          { op: "i32.const", value: 0 },
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
        else: [
          { op: "local.get", index: 2 },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: [
              { op: "i32.const", value: 0 }, // off = 0
              { op: "i32.const", value: 0 }, // len = 0
              { op: "i32.const", value: 0 },
              { op: "array.new_default", typeIdx: strDataTypeIdx },
              { op: "struct.new", typeIdx: strTypeIdx },
            ],
            else: [
              // sOff = s.off
              { op: "local.get", index: 0 },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
              { op: "local.set", index: 8 },

              // newLen = sLen * count
              { op: "local.get", index: 2 },
              { op: "local.get", index: 1 },
              { op: "i32.mul" },
              { op: "local.tee", index: 3 },

              // newArr = array.new_default(newLen)
              { op: "array.new_default", typeIdx: strDataTypeIdx },
              { op: "local.set", index: 4 },

              // srcData = s.data
              { op: "local.get", index: 0 },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
              { op: "local.set", index: 6 },

              // dst = 0
              { op: "i32.const", value: 0 },
              { op: "local.set", index: 5 },

              // outer loop: repeat count times
              {
                op: "block",
                blockType: { kind: "empty" },
                body: [
                  {
                    op: "loop",
                    blockType: { kind: "empty" },
                    body: [
                      { op: "local.get", index: 5 },
                      { op: "local.get", index: 3 },
                      { op: "i32.ge_u" },
                      { op: "br_if", depth: 1 },

                      // array.copy newArr[dst..] <- srcData[sOff..sOff+sLen]
                      { op: "local.get", index: 4 }, // dst array
                      { op: "local.get", index: 5 }, // dst offset
                      { op: "local.get", index: 6 }, // src array
                      { op: "local.get", index: 8 }, // src offset = sOff
                      { op: "local.get", index: 2 }, // length = sLen
                      { op: "array.copy", dstTypeIdx: strDataTypeIdx, srcTypeIdx: strDataTypeIdx },

                      // dst += sLen
                      { op: "local.get", index: 5 },
                      { op: "local.get", index: 2 },
                      { op: "i32.add" },
                      { op: "local.set", index: 5 },
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },

              // return struct.new(newLen, 0, newArr)
              { op: "local.get", index: 3 }, // len = newLen
              { op: "i32.const", value: 0 }, // off = 0
              { op: "local.get", index: 4 }, // data = newArr
              { op: "struct.new", typeIdx: strTypeIdx },
            ],
          },
        ],
      },
    ];

    ctx.mod.functions.push({
      name: "__str_repeat",
      typeIdx,
      locals: [
        { name: "sLen", type: { kind: "i32" } },
        { name: "newLen", type: { kind: "i32" } },
        { name: "newArr", type: strDataRef },
        { name: "dst", type: { kind: "i32" } },
        { name: "srcData", type: strDataRef },
        { name: "copyI", type: { kind: "i32" } },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_padStart(s: ref $NativeString, targetLen: i32, padStr: ref $NativeString) -> ref $NativeString ---
  {
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;
    const repeatIdx = ctx.nativeStrHelpers.get("__str_repeat")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }, strRef], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_padStart", funcIdx);

    // params: s(0), targetLen(1), padStr(2)
    // locals: sLen(3), padLen(4), fillLen(5), repeated(6), prefix(7)
    const body: Instr[] = [
      // sLen = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },

      // if sLen >= targetLen, return s
      { op: "local.get", index: 3 },
      { op: "local.get", index: 1 },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [{ op: "local.get", index: 0 }],
        else: [
          // padLen = padStr.len
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: 4 },

          // if padLen == 0, return s
          { op: "local.get", index: 4 },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: [{ op: "local.get", index: 0 }],
            else: [
              // fillLen = targetLen - sLen
              { op: "local.get", index: 1 },
              { op: "local.get", index: 3 },
              { op: "i32.sub" },
              { op: "local.set", index: 5 },

              // repeated = repeat(padStr, ceil(fillLen / padLen))
              { op: "local.get", index: 2 }, // padStr (1st arg)
              { op: "local.get", index: 5 }, // fillLen
              { op: "local.get", index: 4 }, // padLen
              { op: "i32.add" },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "local.get", index: 4 },
              { op: "i32.div_u" }, // count (2nd arg)
              { op: "call", funcIdx: repeatIdx },

              // prefix = repeated.substring(0, fillLen)
              { op: "i32.const", value: 0 },
              { op: "local.get", index: 5 },
              { op: "call", funcIdx: substringIdx },

              // return concat(prefix, s)
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: concatIdx },
            ],
          },
        ],
      },
    ];

    ctx.mod.functions.push({
      name: "__str_padStart",
      typeIdx,
      locals: [
        { name: "sLen", type: { kind: "i32" } },
        { name: "padLen", type: { kind: "i32" } },
        { name: "fillLen", type: { kind: "i32" } },
        { name: "repeated", type: strRef },
        { name: "prefix", type: strRef },
      ],
      body: wrapBodyWithFlatten(body, [0, 2]),
      exported: false,
    });
  }

  // --- $__str_padEnd(s: ref $NativeString, targetLen: i32, padStr: ref $NativeString) -> ref $NativeString ---
  {
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;
    const repeatIdx = ctx.nativeStrHelpers.get("__str_repeat")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }, strRef], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_padEnd", funcIdx);

    // params: s(0), targetLen(1), padStr(2)
    // locals: sLen(3), padLen(4), fillLen(5)
    const body: Instr[] = [
      // sLen = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },

      // if sLen >= targetLen, return s
      { op: "local.get", index: 3 },
      { op: "local.get", index: 1 },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [{ op: "local.get", index: 0 }],
        else: [
          // padLen = padStr.len
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: 4 },

          // if padLen == 0, return s
          { op: "local.get", index: 4 },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: [{ op: "local.get", index: 0 }],
            else: [
              // fillLen = targetLen - sLen
              { op: "local.get", index: 1 },
              { op: "local.get", index: 3 },
              { op: "i32.sub" },
              { op: "local.set", index: 5 },

              // repeated = repeat(padStr, ceil(fillLen / padLen))
              { op: "local.get", index: 2 }, // padStr (1st arg)
              { op: "local.get", index: 5 }, // fillLen
              { op: "local.get", index: 4 }, // padLen
              { op: "i32.add" },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "local.get", index: 4 },
              { op: "i32.div_u" }, // count (2nd arg)
              { op: "call", funcIdx: repeatIdx },

              // suffix = repeated.substring(0, fillLen)
              { op: "i32.const", value: 0 },
              { op: "local.get", index: 5 },
              { op: "call", funcIdx: substringIdx },

              // return concat(s, suffix)
              // stack has: suffix on top. Store it, push s, push suffix back
              { op: "local.set", index: 6 }, // suffix -> local 6
              { op: "local.get", index: 0 }, // s (1st arg to concat)
              { op: "local.get", index: 6 }, // suffix (2nd arg to concat)
              { op: "ref.as_non_null" },
              { op: "call", funcIdx: concatIdx },
            ],
          },
        ],
      },
    ];

    ctx.mod.functions.push({
      name: "__str_padEnd",
      typeIdx,
      locals: [
        { name: "sLen", type: { kind: "i32" } },
        { name: "padLen", type: { kind: "i32" } },
        { name: "fillLen", type: { kind: "i32" } },
        { name: "suffix", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
      ],
      body: wrapBodyWithFlatten(body, [0, 2]),
      exported: false,
    });
  }

  // --- $__str_toLowerCase(s: ref $NativeString) -> ref $NativeString ---
  // ASCII-only: maps A-Z (65-90) to a-z (97-122), copies everything else as-is
  {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_toLowerCase", funcIdx);

    // params: s(0)
    // locals: len(1), srcData(2), newArr(3), i(4), ch(5), sOff(6)
    const body: Instr[] = [
      // len = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 },

      // sOff = s.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 6 },

      // srcData = s.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 2 },

      // newArr = array.new_default(len)
      { op: "local.get", index: 1 },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: 3 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 4 },

      // loop over each code unit
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 4 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },

              // ch = srcData[sOff + i]
              { op: "local.get", index: 2 },
              { op: "local.get", index: 6 },
              { op: "local.get", index: 4 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.set", index: 5 },

              // newArr[i] = (ch >= 65 && ch <= 90) ? ch + 32 : ch
              { op: "local.get", index: 3 },
              { op: "local.get", index: 4 },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 65 },
              { op: "i32.ge_u" },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 90 },
              { op: "i32.le_u" },
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [{ op: "local.get", index: 5 }, { op: "i32.const", value: 32 }, { op: "i32.add" }],
                else: [{ op: "local.get", index: 5 }],
              },
              { op: "array.set", typeIdx: strDataTypeIdx },

              // i++
              { op: "local.get", index: 4 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 4 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // return struct.new(len, 0, newArr)
      { op: "local.get", index: 1 }, // len
      { op: "i32.const", value: 0 }, // off = 0
      { op: "local.get", index: 3 }, // data = newArr
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    ctx.mod.functions.push({
      name: "__str_toLowerCase",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "srcData", type: strDataRef },
        { name: "newArr", type: strDataRef },
        { name: "i", type: { kind: "i32" } },
        { name: "ch", type: { kind: "i32" } },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_toUpperCase(s: ref $NativeString) -> ref $NativeString ---
  // ASCII-only: maps a-z (97-122) to A-Z (65-90), copies everything else as-is
  {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_toUpperCase", funcIdx);

    // params: s(0)
    // locals: len(1), srcData(2), newArr(3), i(4), ch(5), sOff(6)
    const body: Instr[] = [
      // len = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 },

      // sOff = s.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 6 },

      // srcData = s.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 2 },

      // newArr = array.new_default(len)
      { op: "local.get", index: 1 },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: 3 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 4 },

      // loop
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 4 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },

              // ch = srcData[sOff + i]
              { op: "local.get", index: 2 },
              { op: "local.get", index: 6 },
              { op: "local.get", index: 4 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.set", index: 5 },

              // newArr[i] = (ch >= 97 && ch <= 122) ? ch - 32 : ch
              { op: "local.get", index: 3 },
              { op: "local.get", index: 4 },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 97 },
              { op: "i32.ge_u" },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 122 },
              { op: "i32.le_u" },
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [{ op: "local.get", index: 5 }, { op: "i32.const", value: 32 }, { op: "i32.sub" }],
                else: [{ op: "local.get", index: 5 }],
              },
              { op: "array.set", typeIdx: strDataTypeIdx },

              // i++
              { op: "local.get", index: 4 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 4 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // return struct.new(len, 0, newArr)
      { op: "local.get", index: 1 }, // len
      { op: "i32.const", value: 0 }, // off = 0
      { op: "local.get", index: 3 }, // data = newArr
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    ctx.mod.functions.push({
      name: "__str_toUpperCase",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "srcData", type: strDataRef },
        { name: "newArr", type: strDataRef },
        { name: "i", type: { kind: "i32" } },
        { name: "ch", type: { kind: "i32" } },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_replace(s: ref $NativeString, search: ref $NativeString, replacement: ref $NativeString) -> ref $NativeString ---
  // Replaces first occurrence of search with replacement. Pure wasm using indexOf + substring + concat.
  {
    const indexOfIdx = ctx.nativeStrHelpers.get("__str_indexOf")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;

    const typeIdx = addFuncType(ctx, [strRef, strRef, strRef], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_replace", funcIdx);

    // params: s(0), search(1), replacement(2)
    // locals: idx(3), searchLen(4), prefix(5-nullable), suffix(6-nullable)
    const body: Instr[] = [
      // idx = indexOf(s, search, 0)
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "call", funcIdx: indexOfIdx },
      { op: "local.set", index: 3 },

      // if idx == -1, return s unchanged
      { op: "local.get", index: 3 },
      { op: "i32.const", value: -1 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [{ op: "local.get", index: 0 }],
        else: [
          // searchLen = search.len
          { op: "local.get", index: 1 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: 4 },

          // prefix = s.substring(0, idx)
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: 3 },
          { op: "call", funcIdx: substringIdx },
          { op: "local.set", index: 5 },

          // suffix = s.substring(idx + searchLen, MAX)
          { op: "local.get", index: 0 },
          { op: "local.get", index: 3 },
          { op: "local.get", index: 4 },
          { op: "i32.add" },
          { op: "i32.const", value: 0x7fffffff },
          { op: "call", funcIdx: substringIdx },
          { op: "local.set", index: 6 },

          // return concat(concat(prefix, replacement), suffix)
          { op: "local.get", index: 5 },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: concatIdx },
          { op: "local.get", index: 6 },
          { op: "ref.as_non_null" },
          { op: "call", funcIdx: concatIdx },
        ],
      },
    ];

    ctx.mod.functions.push({
      name: "__str_replace",
      typeIdx,
      locals: [
        { name: "idx", type: { kind: "i32" } },
        { name: "searchLen", type: { kind: "i32" } },
        { name: "prefix", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
        { name: "suffix", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1, 2]),
      exported: false,
    });
  }

  // --- $__str_replaceAll(s: ref $NativeString, search: ref $NativeString, replacement: ref $NativeString) -> ref $NativeString ---
  // Replaces ALL occurrences of search with replacement. Pure wasm loop using indexOf + substring + concat.
  {
    const indexOfIdx = ctx.nativeStrHelpers.get("__str_indexOf")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;

    const typeIdx = addFuncType(ctx, [strRef, strRef, strRef], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_replaceAll", funcIdx);

    // params: s(0), search(1), replacement(2)
    // locals: result(3-nullable), pos(4), idx(5), searchLen(6), prefix(7-nullable)
    const body: Instr[] = [
      // searchLen = search.len
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 6 },

      // If searchLen == 0, return s unchanged (avoid infinite loop)
      { op: "local.get", index: 6 },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [{ op: "local.get", index: 0 }],
        else: [
          // Build an empty result string (len=0, off=0, empty array)
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "array.new_default", typeIdx: ctx.nativeStrDataTypeIdx },
          { op: "struct.new", typeIdx: strTypeIdx },
          { op: "local.set", index: 3 },

          // pos = 0
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 4 },

          // loop: find next occurrence
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  // idx = indexOf(s, search, pos)
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: 1 },
                  { op: "local.get", index: 4 },
                  { op: "call", funcIdx: indexOfIdx },
                  { op: "local.set", index: 5 },

                  // if idx == -1, break
                  { op: "local.get", index: 5 },
                  { op: "i32.const", value: -1 },
                  { op: "i32.eq" },
                  { op: "br_if", depth: 1 },

                  // prefix = s.substring(pos, idx)
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: 4 },
                  { op: "local.get", index: 5 },
                  { op: "call", funcIdx: substringIdx },
                  { op: "local.set", index: 7 },

                  // result = concat(result, prefix)
                  { op: "local.get", index: 3 },
                  { op: "ref.as_non_null" },
                  { op: "local.get", index: 7 },
                  { op: "ref.as_non_null" },
                  { op: "call", funcIdx: concatIdx },

                  // result = concat(result, replacement)
                  { op: "local.get", index: 2 },
                  { op: "call", funcIdx: concatIdx },
                  { op: "local.set", index: 3 },

                  // pos = idx + searchLen
                  { op: "local.get", index: 5 },
                  { op: "local.get", index: 6 },
                  { op: "i32.add" },
                  { op: "local.set", index: 4 },

                  // continue loop
                  { op: "br", depth: 0 },
                ],
              },
            ],
          },

          // Append remainder: result = concat(result, s.substring(pos, MAX))
          { op: "local.get", index: 3 },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 4 },
          { op: "i32.const", value: 0x7fffffff },
          { op: "call", funcIdx: substringIdx },
          { op: "ref.as_non_null" },
          { op: "call", funcIdx: concatIdx },
        ],
      },
    ];

    ctx.mod.functions.push({
      name: "__str_replaceAll",
      typeIdx,
      locals: [
        { name: "result", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
        { name: "pos", type: { kind: "i32" } },
        { name: "idx", type: { kind: "i32" } },
        { name: "searchLen", type: { kind: "i32" } },
        { name: "prefix", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1, 2]),
      exported: false,
    });
  }

  // --- $__str_split(s: ref $NativeString, sep: ref $NativeString) -> ref $vec_nstr ---
  // Splits s by sep, returns a native array of native strings.
  {
    // Register native string array type: (array (mut (ref null $AnyString)))
    // Use ref_null so array.new_default can initialize with null.
    // Key must match what resolveWasmType generates for string[] (ref_N).
    const nstrElemKey = `ref_${anyStrTypeIdx}`;
    const nstrElemType: ValType = { kind: "ref_null", typeIdx: anyStrTypeIdx };
    const nstrArrTypeIdx = getOrRegisterArrayType(ctx, nstrElemKey, nstrElemType);
    const nstrVecTypeIdx = getOrRegisterVecType(ctx, nstrElemKey, nstrElemType);
    const nstrVecRef: ValType = { kind: "ref", typeIdx: nstrVecTypeIdx };

    const typeIdx = addFuncType(ctx, [strRef, strRef], [nstrVecRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_split", funcIdx);

    const indexOfIdx = ctx.nativeStrHelpers.get("__str_indexOf")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    // params: s(0), sep(1)
    // locals: sLen(2), sepLen(3), pos(4), idx(5), part(6-nullable),
    //         resultArr(7-nullable), resultLen(8), resultCap(9), newArr(10-nullable)
    const S = 0,
      SEP = 1;
    const SLEN = 2,
      SEPLEN = 3,
      POS = 4,
      IDX = 5,
      PART = 6;
    const RARR = 7,
      RLEN = 8,
      RCAP = 9,
      NEWARR = 10;

    const body: Instr[] = [
      // sLen = s.len
      { op: "local.get", index: S },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: SLEN },

      // sepLen = sep.len
      { op: "local.get", index: SEP },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: SEPLEN },

      // resultArr = array.new_default(8)
      { op: "i32.const", value: 8 },
      { op: "array.new_default", typeIdx: nstrArrTypeIdx },
      { op: "local.set", index: RARR },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: RLEN },
      { op: "i32.const", value: 8 },
      { op: "local.set", index: RCAP },

      // pos = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: POS },

      // Handle empty separator: return array with single element (the whole string)
      { op: "local.get", index: SEPLEN },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // For empty sep, split each character (like JS)
          // But for simplicity and correctness, match JS: "abc".split("") => ["a","b","c"]
          // Realloc if needed for sLen elements
          { op: "local.get", index: SLEN },
          { op: "array.new_default", typeIdx: nstrArrTypeIdx },
          { op: "local.set", index: RARR },
          { op: "local.get", index: SLEN },
          { op: "local.set", index: RCAP },

          // Loop: for each character, create a single-char NativeString
          { op: "i32.const", value: 0 },
          { op: "local.set", index: POS },
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  { op: "local.get", index: POS },
                  { op: "local.get", index: SLEN },
                  { op: "i32.ge_s" },
                  { op: "br_if", depth: 1 },

                  // part = substring(s, pos, pos+1)
                  { op: "local.get", index: S },
                  { op: "local.get", index: POS },
                  { op: "local.get", index: POS },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "call", funcIdx: substringIdx },
                  { op: "local.set", index: PART },

                  // resultArr[pos] = part
                  { op: "local.get", index: RARR },
                  { op: "local.get", index: POS },
                  { op: "local.get", index: PART },
                  { op: "array.set", typeIdx: nstrArrTypeIdx },

                  { op: "local.get", index: POS },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: POS },
                  { op: "br", depth: 0 },
                ] as Instr[],
              },
            ] as Instr[],
          },

          // return struct.new(sLen, resultArr)
          { op: "local.get", index: SLEN },
          { op: "local.get", index: RARR },
          { op: "ref.as_non_null" },
          { op: "struct.new", typeIdx: nstrVecTypeIdx },
          { op: "return" },
        ] as Instr[],
      },

      // Main split loop: find sep occurrences and extract substrings
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // idx = indexOf(s, sep, pos)
              { op: "local.get", index: S },
              { op: "local.get", index: SEP },
              { op: "local.get", index: POS },
              { op: "call", funcIdx: indexOfIdx },
              { op: "local.set", index: IDX },

              // if idx == -1: add final part and break
              { op: "local.get", index: IDX },
              { op: "i32.const", value: -1 },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // part = substring(s, pos, sLen)
                  { op: "local.get", index: S },
                  { op: "local.get", index: POS },
                  { op: "local.get", index: SLEN },
                  { op: "call", funcIdx: substringIdx },
                  { op: "local.set", index: PART },

                  // Grow result if needed
                  { op: "local.get", index: RLEN },
                  { op: "local.get", index: RCAP },
                  { op: "i32.ge_s" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      // newCap = cap * 2
                      { op: "local.get", index: RCAP },
                      { op: "i32.const", value: 2 },
                      { op: "i32.mul" },
                      { op: "local.set", index: RCAP },
                      // newArr = array.new_default(newCap)
                      { op: "local.get", index: RCAP },
                      { op: "array.new_default", typeIdx: nstrArrTypeIdx },
                      { op: "local.set", index: NEWARR },
                      // array.copy(newArr, 0, resultArr, 0, resultLen)
                      { op: "local.get", index: NEWARR },
                      { op: "i32.const", value: 0 },
                      { op: "local.get", index: RARR },
                      { op: "i32.const", value: 0 },
                      { op: "local.get", index: RLEN },
                      { op: "array.copy", dstTypeIdx: nstrArrTypeIdx, srcTypeIdx: nstrArrTypeIdx },
                      { op: "local.get", index: NEWARR },
                      { op: "local.set", index: RARR },
                    ] as Instr[],
                  },

                  // resultArr[resultLen] = part
                  { op: "local.get", index: RARR },
                  { op: "local.get", index: RLEN },
                  { op: "local.get", index: PART },
                  { op: "array.set", typeIdx: nstrArrTypeIdx },
                  { op: "local.get", index: RLEN },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: RLEN },

                  { op: "br", depth: 2 }, // break outer block
                ] as Instr[],
              },

              // Found separator: part = substring(s, pos, idx)
              { op: "local.get", index: S },
              { op: "local.get", index: POS },
              { op: "local.get", index: IDX },
              { op: "call", funcIdx: substringIdx },
              { op: "local.set", index: PART },

              // Grow result if needed
              { op: "local.get", index: RLEN },
              { op: "local.get", index: RCAP },
              { op: "i32.ge_s" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: RCAP },
                  { op: "i32.const", value: 2 },
                  { op: "i32.mul" },
                  { op: "local.set", index: RCAP },
                  { op: "local.get", index: RCAP },
                  { op: "array.new_default", typeIdx: nstrArrTypeIdx },
                  { op: "local.set", index: NEWARR },
                  { op: "local.get", index: NEWARR },
                  { op: "i32.const", value: 0 },
                  { op: "local.get", index: RARR },
                  { op: "i32.const", value: 0 },
                  { op: "local.get", index: RLEN },
                  { op: "array.copy", dstTypeIdx: nstrArrTypeIdx, srcTypeIdx: nstrArrTypeIdx },
                  { op: "local.get", index: NEWARR },
                  { op: "local.set", index: RARR },
                ] as Instr[],
              },

              // resultArr[resultLen] = part
              { op: "local.get", index: RARR },
              { op: "local.get", index: RLEN },
              { op: "local.get", index: PART },
              { op: "array.set", typeIdx: nstrArrTypeIdx },
              { op: "local.get", index: RLEN },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: RLEN },

              // pos = idx + sepLen
              { op: "local.get", index: IDX },
              { op: "local.get", index: SEPLEN },
              { op: "i32.add" },
              { op: "local.set", index: POS },

              { op: "br", depth: 0 }, // continue loop
            ] as Instr[],
          },
        ] as Instr[],
      },

      // return struct.new(resultLen, resultArr)
      { op: "local.get", index: RLEN },
      { op: "local.get", index: RARR },
      { op: "ref.as_non_null" },
      { op: "struct.new", typeIdx: nstrVecTypeIdx },
    ];

    ctx.mod.functions.push({
      name: "__str_split",
      typeIdx,
      locals: [
        { name: "sLen", type: { kind: "i32" } },
        { name: "sepLen", type: { kind: "i32" } },
        { name: "pos", type: { kind: "i32" } },
        { name: "idx", type: { kind: "i32" } },
        { name: "part", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
        { name: "resultArr", type: { kind: "ref_null", typeIdx: nstrArrTypeIdx } },
        { name: "resultLen", type: { kind: "i32" } },
        { name: "resultCap", type: { kind: "i32" } },
        { name: "newArr", type: { kind: "ref_null", typeIdx: nstrArrTypeIdx } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_fromCodePoint(cp: i32) -> ref $NativeString ---
  // Creates a NativeString from a Unicode code point.
  // BMP (cp <= 0xFFFF): 1-element array.
  // Supplementary (cp > 0xFFFF): 2-element surrogate pair.
  {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_fromCodePoint", funcIdx);

    // params: cp(0)
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0xffff },
      { op: "i32.gt_u" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          // Surrogate pair: len=2, off=0, [high, low]
          { op: "i32.const", value: 2 }, // len
          { op: "i32.const", value: 0 }, // off
          // high = ((cp - 0x10000) >> 10) + 0xD800
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 0x10000 },
          { op: "i32.sub" },
          { op: "i32.const", value: 10 },
          { op: "i32.shr_u" },
          { op: "i32.const", value: 0xd800 },
          { op: "i32.add" },
          // low = ((cp - 0x10000) & 0x3FF) + 0xDC00
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 0x10000 },
          { op: "i32.sub" },
          { op: "i32.const", value: 0x3ff },
          { op: "i32.and" },
          { op: "i32.const", value: 0xdc00 },
          { op: "i32.add" },
          { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 2 },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
        else: [
          // BMP: len=1, off=0, [cp]
          { op: "i32.const", value: 1 }, // len
          { op: "i32.const", value: 0 }, // off
          { op: "local.get", index: 0 }, // cp
          { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 1 },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
      } as Instr,
    ];

    ctx.mod.functions.push({
      name: "__str_fromCodePoint",
      typeIdx,
      locals: [],
      body,
      exported: false,
    });
  }
}

export function ensureNativeStringExternBridge(ctx: CodegenContext): void {
  ensureNativeStringHelpers(ctx);
  if (ctx.nativeStrExternBridgeEmitted) return;
  ctx.nativeStrExternBridgeEmitted = true;

  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };

  if (ctx.mod.memories.length === 0) {
    ctx.mod.memories.push({ min: 1 });
    ctx.mod.exports.push({
      name: "__str_mem",
      desc: { kind: "memory", index: 0 },
    });
  }

  const fromMemIdx = ensureLateImport(
    ctx,
    "__str_from_mem",
    [{ kind: "i32" }, { kind: "i32" }],
    [{ kind: "externref" }],
  )!;
  const toMemIdx = ensureLateImport(ctx, "__str_to_mem", [{ kind: "externref" }, { kind: "i32" }], [])!;
  const externLenIdx = ensureLateImport(ctx, "__str_extern_len", [{ kind: "externref" }], [{ kind: "i32" }])!;

  {
    const typeIdx = addFuncType(ctx, [strRef], [{ kind: "externref" }]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_to_extern", funcIdx);
    ctx.funcMap.set("__str_to_extern", funcIdx);

    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 4 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 3 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 2 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 2 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 1 },
              { op: "i32.shl" },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 4 },
              { op: "local.get", index: 2 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "i32.store16", align: 1, offset: 0 },
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 2 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: fromMemIdx },
    ];

    ctx.mod.functions.push({
      name: "__str_to_extern",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "data", type: strDataRef },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body,
      exported: false,
    });
  }

  {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_from_extern", funcIdx);
    ctx.funcMap.set("__str_from_extern", funcIdx);

    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: externLenIdx },
      { op: "local.set", index: 1 },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      { op: "call", funcIdx: toMemIdx },
      { op: "local.get", index: 1 },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 3 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 3 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 2 },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.shl" },
              { op: "i32.load16_u", align: 1, offset: 0 },
              { op: "array.set", typeIdx: strDataTypeIdx },
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 3 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    ctx.mod.functions.push({
      name: "__str_from_extern",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "arr", type: strDataRef },
        { name: "i", type: { kind: "i32" } },
      ],
      body,
      exported: false,
    });
  }
}
