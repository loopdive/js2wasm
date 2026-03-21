/**
 * Stack-balancing fixup pass for Wasm function bodies.
 *
 * Wasm validation requires that all branches of structured control flow
 * (if/else, try/catch, block) leave the stack in a state matching the
 * block's declared type. This pass detects and fixes three classes of
 * mismatches:
 *
 * 1. "expected 0, found N" -- an empty-typed block where a branch leaves
 *    extra values on the stack. Fix: append `drop` instructions.
 *
 * 2. "expected N, found 0" -- a valued block where a branch doesn't
 *    produce a value (typically because it ends in unreachable code like
 *    return/throw/br but the validator still needs balance, OR because
 *    the branch genuinely fails to push a value). Fix: append `unreachable`
 *    (if the branch already has a terminator) or a default value push.
 *
 * 3. "type error in fallthru" -- a branch produces the right number of
 *    values but of the wrong type (e.g., ref instead of externref, or
 *    f64 instead of externref). Fix: insert type coercion instructions
 *    (extern.convert_any, any.convert_extern+ref.cast, etc.).
 *
 * The pass uses a lightweight stack-depth simulation that tracks net
 * pushes/pops through a linear instruction sequence, plus type inference
 * for the last value-producing instruction to detect type mismatches.
 */
import type {
  Instr,
  WasmModule,
  BlockType,
  FuncTypeDef,
  TypeDef,
  ValType,
} from "../ir/types.js";

/** Sentinel: the instruction sequence is unreachable (after return/br/throw/unreachable). */
const UNREACHABLE = -999;

/**
 * Resolve a FuncTypeDef from the module's type table, handling sub/rec wrappers.
 */
function resolveFuncType(types: TypeDef[], typeIdx: number): FuncTypeDef | null {
  const t = types[typeIdx];
  if (!t) return null;
  if (t.kind === "func") return t;
  if (t.kind === "rec") {
    // rec groups contain sub-types; look for the first func type
    for (const sub of t.types) {
      if (sub.kind === "sub" && sub.type.kind === "func") return sub.type;
      if ((sub as any).kind === "func") return sub as any;
    }
  }
  if ((t as any).kind === "sub" && (t as any).type?.kind === "func") {
    return (t as any).type;
  }
  return null;
}

/**
 * Compute the net stack delta for a single instruction.
 * Returns UNREACHABLE for terminators (return, br, throw, unreachable).
 *
 * For structured blocks (if, block, loop, try), returns the delta based
 * on blockType alone (the contents are validated recursively).
 */
function instrDelta(instr: Instr, types: TypeDef[], funcSigs: FuncSigInfo): number {
  const op = instr.op;

  // Terminators -- make subsequent code unreachable
  if (op === "return" || op === "return_call" || op === "return_call_ref" ||
      op === "br" || op === "throw" || op === "rethrow" || op === "unreachable") {
    return UNREACHABLE;
  }

  // Push 1 value
  if (op === "i32.const" || op === "i64.const" || op === "f64.const" || op === "f32.const" ||
      op === "v128.const" ||
      op === "local.get" || op === "global.get" ||
      op === "ref.null" || op === "ref.null.extern" || op === "ref.null.eq" ||
      op === "ref.null.func" || op === "ref.func" ||
      op === "memory.size") {
    return 1;
  }

  // Push 1, pop 1 (net 0)
  if (op === "local.tee" || op === "ref.as_non_null" || op === "ref.cast" ||
      op === "ref.cast_null" ||
      op === "ref.test" || op === "ref.is_null" ||
      op === "i32.eqz" || op === "i64.eqz" ||
      op === "i32.clz" ||
      op === "f64.neg" || op === "f64.abs" || op === "f64.floor" || op === "f64.ceil" ||
      op === "f64.trunc" || op === "f64.nearest" || op === "f64.sqrt" ||
      op === "f64.convert_i32_s" || op === "f64.convert_i32_u" || op === "f64.convert_i64_s" ||
      op === "f64.promote_f32" || op === "f32.demote_f64" ||
      op === "i32.trunc_sat_f64_s" || op === "i32.trunc_sat_f64_u" ||
      op === "i32.trunc_f64_s" ||
      op === "i64.trunc_sat_f64_s" || op === "i64.trunc_f64_s" ||
      op === "i64.extend_i32_s" || op === "i64.extend_i32_u" ||
      op === "any.convert_extern" || op === "extern.convert_any" ||
      op === "array.len" || op === "memory.grow" ||
      op === "v128.not" || op === "v128.any_true" ||
      op === "i8x16.splat" || op === "i16x8.splat" || op === "i32x4.splat" ||
      op === "i64x2.splat" || op === "f32x4.splat" || op === "f64x2.splat" ||
      op === "i8x16.all_true" || op === "i8x16.bitmask" ||
      op === "i16x8.all_true" || op === "i16x8.bitmask" ||
      op === "i32x4.all_true" || op === "i32x4.bitmask" ||
      op === "nop") {
    return 0;
  }

  // Pop 1, push 0
  if (op === "drop" || op === "local.set" || op === "global.set") {
    return -1;
  }

  // Pop 2, push 1 (net -1)
  if (op === "i32.add" || op === "i32.sub" || op === "i32.mul" ||
      op === "i32.div_s" || op === "i32.div_u" || op === "i32.rem_s" || op === "i32.rem_u" ||
      op === "i32.and" || op === "i32.or" || op === "i32.xor" ||
      op === "i32.shl" || op === "i32.shr_s" || op === "i32.shr_u" ||
      op === "i32.eq" || op === "i32.ne" ||
      op === "i32.lt_s" || op === "i32.le_s" || op === "i32.gt_s" || op === "i32.ge_s" ||
      op === "i32.lt_u" || op === "i32.le_u" || op === "i32.gt_u" || op === "i32.ge_u" ||
      op === "i64.add" || op === "i64.sub" || op === "i64.mul" ||
      op === "i64.div_s" || op === "i64.rem_s" ||
      op === "i64.and" || op === "i64.or" || op === "i64.xor" ||
      op === "i64.shl" || op === "i64.shr_s" || op === "i64.shr_u" ||
      op === "i64.eq" || op === "i64.ne" ||
      op === "i64.lt_s" || op === "i64.le_s" || op === "i64.gt_s" || op === "i64.ge_s" ||
      op === "f64.add" || op === "f64.sub" || op === "f64.mul" || op === "f64.div" ||
      op === "f64.eq" || op === "f64.ne" || op === "f64.lt" || op === "f64.le" ||
      op === "f64.gt" || op === "f64.ge" ||
      op === "f64.copysign" || op === "f64.min" || op === "f64.max" ||
      op === "ref.eq") {
    return -1;
  }

  // Pop 1, push 0 (conditional branch)
  if (op === "br_if") return -1;

  // select: pop 3, push 1 (net -2)
  if (op === "select") return -2;

  // struct.new: pop N fields, push 1
  if (op === "struct.new") {
    const typeIdx = (instr as any).typeIdx;
    const t = types[typeIdx];
    if (t && t.kind === "struct") {
      return -(t.fields.length) + 1;
    }
    return 0; // fallback
  }

  // struct.get: pop 1, push 1 (net 0)
  if (op === "struct.get") return 0;

  // struct.set: pop 2, push 0 (net -2)
  if (op === "struct.set") return -2;

  // array.new: pop 2 (value + length), push 1 (net -1)
  if (op === "array.new") return -1;

  // array.new_default: pop 1 (length), push 1 (net 0)
  if (op === "array.new_default") return 0;

  // array.new_fixed: pop N elements, push 1
  if (op === "array.new_fixed") {
    return -((instr as any).length || 0) + 1;
  }

  // array.get/get_s/get_u: pop 2 (array + index), push 1 (net -1)
  if (op === "array.get" || op === "array.get_s" || op === "array.get_u") return -1;

  // array.set: pop 3 (array + index + value), push 0 (net -3)
  if (op === "array.set") return -3;

  // array.copy: pop 5, push 0
  if (op === "array.copy") return -5;

  // array.fill: pop 4, push 0
  if (op === "array.fill") return -4;

  // call: pop params, push results
  if (op === "call") {
    const funcIdx = (instr as any).funcIdx;
    const sig = funcSigs.get(funcIdx);
    if (sig) {
      return -sig.params + sig.results;
    }
    return 0; // fallback: assume balanced
  }

  // call_ref: pop params + 1 (funcref), push results
  if (op === "call_ref") {
    const typeIdx = (instr as any).typeIdx;
    const ft = resolveFuncType(types, typeIdx);
    if (ft) {
      return -(ft.params.length + 1) + ft.results.length;
    }
    return 0;
  }

  // call_indirect: pop params + 1 (table index), push results
  if (op === "call_indirect") {
    const typeIdx = (instr as any).typeIdx;
    const ft = resolveFuncType(types, typeIdx);
    if (ft) {
      return -(ft.params.length + 1) + ft.results.length;
    }
    return 0;
  }

  // Structured blocks: their external stack effect is determined by blockType
  if (op === "if" || op === "block" || op === "loop" || op === "try") {
    const bt = (instr as any).blockType as BlockType;
    if (!bt || bt.kind === "empty") {
      // if also pops the condition (1 value)
      return op === "if" ? -1 : 0;
    }
    if (bt.kind === "val") {
      return op === "if" ? 0 : 1; // if pops 1 (condition), pushes 1 (result)
    }
    if (bt.kind === "type") {
      const ft = resolveFuncType(types, bt.typeIdx);
      if (ft) {
        const netBlock = -ft.params.length + ft.results.length;
        return op === "if" ? netBlock - 1 : netBlock;
      }
    }
    return op === "if" ? -1 : 0;
  }

  // Memory loads: pop 1 (address), push 1 (value) -- net 0
  if (op.endsWith(".load") || op.includes(".load8") || op.includes(".load16") ||
      op.includes(".load32_zero") || op.includes(".load64_zero") ||
      op.includes("_splat")) {
    return 0;
  }

  // Memory stores: pop 2 (address + value) -- net -2
  if (op.endsWith(".store") || op.includes(".store8") || op.includes(".store16")) {
    return -2;
  }

  // SIMD binary ops: pop 2, push 1 (net -1)
  if ((op.startsWith("i8x16.") || op.startsWith("i16x8.") || op.startsWith("i32x4.") ||
       op.startsWith("i64x2.") || op.startsWith("f32x4.") || op.startsWith("f64x2.")) &&
      (op.includes(".add") || op.includes(".sub") || op.includes(".mul") || op.includes(".div") ||
       op.includes(".eq") || op.includes(".ne") || op.includes(".lt") || op.includes(".gt") ||
       op.includes(".min") || op.includes(".max") || op.includes(".shl") || op.includes(".shr"))) {
    return -1;
  }

  // SIMD extract_lane: pop 1, push 1 (net 0)
  if (op.includes("extract_lane")) return 0;

  // SIMD replace_lane: pop 2, push 1 (net -1)
  if (op.includes("replace_lane")) return -1;

  // SIMD shuffle: pop 2, push 1 (net -1)
  if (op === "i8x16.shuffle" || op === "i8x16.swizzle") return -1;

  // SIMD bitselect: pop 3, push 1 (net -2)
  if (op === "v128.bitselect") return -2;

  // SIMD v128 binary: pop 2, push 1 (net -1)
  if (op === "v128.and" || op === "v128.andnot" || op === "v128.or" || op === "v128.xor") {
    return -1;
  }

  // Unknown instruction -- assume balanced (conservative)
  return 0;
}

interface FuncSigInfo {
  get(funcIdx: number): { params: number; results: number; resultType?: string } | undefined;
}

/**
 * Compute the net stack delta for a linear sequence of instructions.
 * Returns UNREACHABLE if the sequence ends in unreachable code.
 */
function sequenceDelta(body: Instr[], types: TypeDef[], sigs: FuncSigInfo): number {
  let delta = 0;
  for (const instr of body) {
    const d = instrDelta(instr, types, sigs);
    if (d === UNREACHABLE) return UNREACHABLE;
    delta += d;
  }
  return delta;
}

/**
 * Get the expected stack delta for a block type.
 */
function blockTypeExpected(bt: BlockType, types: TypeDef[]): number {
  if (bt.kind === "empty") return 0;
  if (bt.kind === "val") return 1;
  if (bt.kind === "type") {
    const ft = resolveFuncType(types, bt.typeIdx);
    if (ft) return -ft.params.length + ft.results.length;
  }
  return 0;
}

/**
 * Infer the type category of the value produced by the last instruction in a sequence.
 * Returns "f64", "i32", "i64", "externref", "ref", "anyref", or null if unknown.
 */
function inferLastType(body: Instr[], types: TypeDef[], sigs: FuncSigInfo): string | null {
  // Walk backwards to find the last value-producing instruction
  for (let i = body.length - 1; i >= 0; i--) {
    const instr = body[i]!;
    const op = instr.op;

    // Skip drops, local.set, global.set (they consume but don't produce)
    if (op === "drop" || op === "local.set" || op === "global.set") continue;

    // f64 producers
    if (op === "f64.const" || op === "f64.add" || op === "f64.sub" || op === "f64.mul" ||
        op === "f64.div" || op === "f64.neg" || op === "f64.abs" || op === "f64.floor" ||
        op === "f64.ceil" || op === "f64.trunc" || op === "f64.nearest" || op === "f64.sqrt" ||
        op === "f64.copysign" || op === "f64.min" || op === "f64.max" ||
        op === "f64.convert_i32_s" || op === "f64.convert_i32_u" || op === "f64.convert_i64_s" ||
        op === "f64.promote_f32") {
      return "f64";
    }

    // i32 producers
    if (op === "i32.const" || op === "i32.add" || op === "i32.sub" || op === "i32.mul" ||
        op === "i32.and" || op === "i32.or" || op === "i32.xor" ||
        op === "i32.eqz" || op === "i32.eq" || op === "i32.ne" ||
        op === "i32.lt_s" || op === "i32.le_s" || op === "i32.gt_s" || op === "i32.ge_s" ||
        op === "i32.shl" || op === "i32.shr_s" || op === "i32.shr_u" ||
        op === "i32.trunc_sat_f64_s" || op === "i32.trunc_f64_s" ||
        op === "ref.is_null" || op === "ref.test" || op === "ref.eq" ||
        op === "f64.eq" || op === "f64.ne" || op === "f64.lt" || op === "f64.le" ||
        op === "f64.gt" || op === "f64.ge" ||
        op === "i64.eqz" || op === "i64.eq" || op === "i64.ne") {
      return "i32";
    }

    // i64 producers
    if (op === "i64.const" || op === "i64.add" || op === "i64.sub" || op === "i64.mul" ||
        op === "i64.and" || op === "i64.or" || op === "i64.xor" ||
        op === "i64.extend_i32_s" || op === "i64.extend_i32_u" ||
        op === "i64.trunc_sat_f64_s" || op === "i64.trunc_f64_s" ||
        op === "i64.shl" || op === "i64.shr_s" || op === "i64.shr_u") {
      return "i64";
    }

    // externref producers
    if (op === "ref.null.extern" || op === "extern.convert_any") {
      return "externref";
    }

    // ref producers (GC refs) -- only include ops that ALWAYS produce ref types
    // Note: struct.get and array.get are excluded because they can return f64/i32/etc
    if (op === "struct.new" || op === "array.new" ||
        op === "array.new_default" || op === "array.new_fixed" ||
        op === "ref.cast" || op === "ref.cast_null" || op === "ref.as_non_null" ||
        op === "any.convert_extern") {
      return "ref";
    }

    // ref.null with typeIdx
    if (op === "ref.null") return "ref";
    if (op === "ref.null.eq") return "eqref";
    if (op === "ref.null.func" || op === "ref.func") return "funcref";

    // local.tee preserves type -- unknown without local type info
    if (op === "local.tee" || op === "local.get" || op === "global.get") return null;

    // call: check result type -- only trust high-confidence type categories
    if (op === "call") {
      const funcIdx = (instr as any).funcIdx;
      const sig = sigs.get(funcIdx);
      if (sig && sig.resultType && (
        sig.resultType === "f64" || sig.resultType === "i32" || sig.resultType === "i64" ||
        sig.resultType === "externref"
      )) {
        return sig.resultType;
      }
      return null;
    }

    // Structured blocks: result is their blockType
    if (op === "if" || op === "block" || op === "loop" || op === "try") {
      const bt = (instr as any).blockType as BlockType;
      if (bt?.kind === "val") {
        const t = bt.type;
        if (t.kind === "f64") return "f64";
        if (t.kind === "i32") return "i32";
        if (t.kind === "i64") return "i64";
        if (t.kind === "externref" || t.kind === "ref_extern") return "externref";
        if (t.kind === "ref" || t.kind === "ref_null") return "ref";
      }
      if (bt?.kind === "empty") continue; // doesn't produce a value
      return null;
    }

    // For anything else, we can't determine the type
    return null;
  }
  return null;
}

/**
 * Check if two type categories are compatible for Wasm validation.
 */
function typesCompatible(produced: string, expected: ValType): boolean {
  if (expected.kind === "externref" || expected.kind === "ref_extern") {
    return produced === "externref";
  }
  if (expected.kind === "f64") return produced === "f64";
  if (expected.kind === "i32") return produced === "i32";
  if (expected.kind === "i64") return produced === "i64";
  if (expected.kind === "f32") return produced === "f32";
  if (expected.kind === "ref" || expected.kind === "ref_null") {
    return produced === "ref" || produced === "eqref";
  }
  if (expected.kind === "anyref") {
    return produced === "ref" || produced === "externref" || produced === "anyref";
  }
  return true; // unknown - assume compatible
}

/**
 * Insert type coercion instructions at the end of a branch body to match the expected type.
 * Returns the number of fixups applied.
 */
function fixBranchType(
  body: Instr[],
  blockType: BlockType,
  types: TypeDef[],
  sigs: FuncSigInfo,
): number {
  if (blockType.kind !== "val") return 0;
  const expectedType = blockType.type;

  const produced = inferLastType(body, types, sigs);
  if (!produced) return 0; // can't determine type - skip

  if (typesCompatible(produced, expectedType)) return 0; // types match

  let fixups = 0;

  // ref/anyref → externref: insert extern.convert_any
  if ((expectedType.kind === "externref" || expectedType.kind === "ref_extern") &&
      (produced === "ref" || produced === "eqref" || produced === "funcref" || produced === "anyref")) {
    body.push({ op: "extern.convert_any" } as Instr);
    return 1;
  }

  // externref → ref/ref_null: insert any.convert_extern + ref.cast
  if ((expectedType.kind === "ref" || expectedType.kind === "ref_null") && produced === "externref") {
    body.push({ op: "any.convert_extern" } as Instr);
    if (expectedType.kind === "ref_null") {
      body.push({ op: "ref.cast_null", typeIdx: expectedType.typeIdx } as unknown as Instr);
    } else {
      body.push({ op: "ref.cast", typeIdx: expectedType.typeIdx } as unknown as Instr);
    }
    return 1;
  }

  // f64 → externref: drop + ref.null.extern (lossy but valid)
  // Better: we can't easily box without import, so use drop + null
  if ((expectedType.kind === "externref" || expectedType.kind === "ref_extern") && produced === "f64") {
    body.push({ op: "drop" });
    body.push({ op: "ref.null.extern" });
    return 1;
  }

  // i32 → externref: drop + ref.null.extern
  if ((expectedType.kind === "externref" || expectedType.kind === "ref_extern") && produced === "i32") {
    body.push({ op: "drop" });
    body.push({ op: "ref.null.extern" });
    return 1;
  }

  // externref → f64: drop + f64.const 0 (lossy but valid)
  if (expectedType.kind === "f64" && produced === "externref") {
    body.push({ op: "drop" });
    body.push({ op: "f64.const", value: 0 });
    return 1;
  }

  // i64 → f64: convert
  if (expectedType.kind === "f64" && produced === "i64") {
    body.push({ op: "f64.convert_i64_s" } as unknown as Instr);
    return 1;
  }

  // ref → f64: drop + f64.const 0 (lossy but valid)
  if (expectedType.kind === "f64" && produced === "ref") {
    body.push({ op: "drop" });
    body.push({ op: "f64.const", value: 0 });
    return 1;
  }

  // i32 → f64: convert
  if (expectedType.kind === "f64" && produced === "i32") {
    body.push({ op: "f64.convert_i32_s" });
    return 1;
  }

  // ref → i32: drop + i32.const 0
  if (expectedType.kind === "i32" && (produced === "ref" || produced === "externref")) {
    body.push({ op: "drop" });
    body.push({ op: "i32.const", value: 0 });
    return 1;
  }

  // externref → ref_null for anyref-like: any.convert_extern
  if (expectedType.kind === "anyref" && produced === "externref") {
    body.push({ op: "any.convert_extern" } as Instr);
    return 1;
  }

  return fixups;
}

/**
 * Fix a branch (instruction body) to match the expected stack delta.
 * Appends drop or default-value instructions as needed.
 * Also fixes type mismatches between branch result and block type.
 * Mutates the body array in place.
 * Returns the number of fixups applied.
 */
function fixBranch(
  body: Instr[],
  expected: number,
  types: TypeDef[],
  sigs: FuncSigInfo,
  blockType: BlockType,
): number {
  const actual = sequenceDelta(body, types, sigs);
  if (actual === UNREACHABLE) return 0; // unreachable branch -- validator accepts anything

  let fixups = 0;

  if (actual > expected) {
    // Too many values -- add drops
    for (let i = 0; i < actual - expected; i++) {
      body.push({ op: "drop" });
      fixups++;
    }
  } else if (actual < expected) {
    // Not enough values -- add default pushes (then unreachable if we can't determine the type)
    // For valued blocks, push a zero/default value for each missing slot
    for (let i = 0; i < expected - actual; i++) {
      if (blockType.kind === "val") {
        const t = blockType.type;
        switch (t.kind) {
          case "i32":
            body.push({ op: "i32.const", value: 0 });
            break;
          case "i64":
            body.push({ op: "i64.const", value: 0n });
            break;
          case "f64":
            body.push({ op: "f64.const", value: 0 });
            break;
          case "f32":
            body.push({ op: "f32.const", value: 0 });
            break;
          case "externref":
            body.push({ op: "ref.null.extern" });
            break;
          case "ref":
          case "ref_null":
            body.push({ op: "ref.null", typeIdx: t.typeIdx });
            break;
          default:
            // Unknown type -- push unreachable to make the validator happy
            body.push({ op: "unreachable" } as Instr);
            break;
        }
      } else {
        // For type-indexed block types, we can't easily determine individual value types.
        // Push unreachable as a last resort.
        body.push({ op: "unreachable" } as Instr);
      }
      fixups++;
    }
  }

  // After fixing count, also fix type mismatches if count is now correct
  if (actual === expected || fixups > 0) {
    // Re-check delta after fixups
    const newDelta = sequenceDelta(body, types, sigs);
    if (newDelta === expected && newDelta > 0) {
      fixups += fixBranchType(body, blockType, types, sigs);
    }
  }

  return fixups;
}

/**
 * Get the number of values a catch clause pushes onto the stack
 * based on the tag's type signature.
 */
function getTagArity(tagIdx: number, tags: Array<{ typeIdx: number }>, types: TypeDef[]): number {
  const tag = tags[tagIdx];
  if (!tag) return 1; // fallback: assume 1 (externref)
  const ft = resolveFuncType(types, tag.typeIdx);
  if (ft) return ft.params.length;
  return 1; // fallback
}

/**
 * Recursively fix stack mismatches in a body of instructions.
 * Returns the total number of fixups applied.
 */
function fixBody(body: Instr[], types: TypeDef[], sigs: FuncSigInfo, tags: Array<{ typeIdx: number }>): number {
  let fixups = 0;

  for (const instr of body) {
    if (instr.op === "if") {
      const ifInstr = instr as { op: "if"; blockType: BlockType; then: Instr[]; else?: Instr[] };
      const expected = blockTypeExpected(ifInstr.blockType, types);

      // Recurse into branches first
      fixups += fixBody(ifInstr.then, types, sigs, tags);
      if (ifInstr.else) {
        fixups += fixBody(ifInstr.else, types, sigs, tags);
      }

      // Fix then branch
      fixups += fixBranch(ifInstr.then, expected, types, sigs, ifInstr.blockType);

      // Fix else branch (or create one if needed for valued blocks)
      if (ifInstr.else) {
        fixups += fixBranch(ifInstr.else, expected, types, sigs, ifInstr.blockType);
      } else if (expected > 0) {
        // Valued block with no else -- need to add an else branch with default values
        ifInstr.else = [];
        fixups += fixBranch(ifInstr.else, expected, types, sigs, ifInstr.blockType);
      }
    } else if (instr.op === "block" || instr.op === "loop") {
      const blockInstr = instr as { op: string; blockType: BlockType; body: Instr[] };
      fixups += fixBody(blockInstr.body, types, sigs, tags);

      const expected = blockTypeExpected(blockInstr.blockType, types);
      fixups += fixBranch(blockInstr.body, expected, types, sigs, blockInstr.blockType);
    } else if (instr.op === "try") {
      const tryInstr = instr as {
        op: "try";
        blockType: BlockType;
        body: Instr[];
        catches: Array<{ tagIdx: number; body: Instr[] }>;
        catchAll?: Instr[];
      };
      const expected = blockTypeExpected(tryInstr.blockType, types);

      // Recurse into all branches
      fixups += fixBody(tryInstr.body, types, sigs, tags);
      for (const c of tryInstr.catches || []) {
        fixups += fixBody(c.body, types, sigs, tags);
      }
      if (tryInstr.catchAll) {
        fixups += fixBody(tryInstr.catchAll, types, sigs, tags);
      }

      // Fix the do body
      fixups += fixBranch(tryInstr.body, expected, types, sigs, tryInstr.blockType);

      // Fix catch bodies. Each catch clause pushes the tag's parameter values
      // onto the stack before the body executes.
      for (const c of tryInstr.catches || []) {
        const tagArity = getTagArity(c.tagIdx, tags, types);
        fixups += fixBranch(c.body, expected - tagArity, types, sigs, tryInstr.blockType);
      }

      // Fix catch_all body (no values pushed by catch_all)
      if (tryInstr.catchAll) {
        fixups += fixBranch(tryInstr.catchAll, expected, types, sigs, tryInstr.blockType);
      }
    }
  }

  return fixups;
}

/**
 * Build a map from function index to its signature (param count, result count).
 * Includes both imported and defined functions.
 */
/**
 * Map a ValType to a type category string for type inference.
 */
function valTypeCategory(vt: ValType): string | undefined {
  switch (vt.kind) {
    case "f64": return "f64";
    case "i32": return "i32";
    case "i64": return "i64";
    case "f32": return "f32";
    case "externref": case "ref_extern": return "externref";
    case "ref": case "ref_null": return "ref";
    case "funcref": return "funcref";
    case "eqref": return "eqref";
    case "anyref": return "anyref";
    default: return undefined;
  }
}

function buildFuncSigs(mod: WasmModule): FuncSigInfo {
  const map = new Map<number, { params: number; results: number; resultType?: string }>();

  // Imported functions come first
  let idx = 0;
  for (const imp of mod.imports) {
    if (imp.desc.kind === "func") {
      const ft = resolveFuncType(mod.types, imp.desc.typeIdx);
      if (ft) {
        const resultType = ft.results.length === 1 ? valTypeCategory(ft.results[0]!) : undefined;
        map.set(idx, { params: ft.params.length, results: ft.results.length, resultType });
      }
      idx++;
    }
  }

  // Then defined functions
  for (const func of mod.functions) {
    const ft = resolveFuncType(mod.types, func.typeIdx);
    if (ft) {
      const resultType = ft.results.length === 1 ? valTypeCategory(ft.results[0]!) : undefined;
      map.set(idx, { params: ft.params.length, results: ft.results.length, resultType });
    }
    idx++;
  }

  return map;
}

/**
 * Run stack-balancing fixups on all function bodies in a WasmModule.
 * Returns the total number of fixups applied.
 */
export function stackBalance(mod: WasmModule): number {
  const sigs = buildFuncSigs(mod);
  const tags = mod.tags || [];
  let totalFixups = 0;
  for (const func of mod.functions) {
    // Fix nested structured blocks first
    totalFixups += fixBody(func.body, mod.types, sigs, tags);

    // Fix function-level body: the body must produce exactly as many values
    // as the function's result type declares.
    const ft = resolveFuncType(mod.types, func.typeIdx);
    if (ft) {
      const expectedResults = ft.results.length;
      // Build a synthetic block type for the function body
      const funcBlockType: BlockType = expectedResults === 0
        ? { kind: "empty" }
        : expectedResults === 1
          ? { kind: "val", type: ft.results[0]! }
          : { kind: "type", typeIdx: func.typeIdx };
      totalFixups += fixBranch(func.body, expectedResults, mod.types, sigs, funcBlockType);
    }
  }
  return totalFixups;
}
