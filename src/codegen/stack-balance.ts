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
  WasmFunction,
  BlockType,
  FuncTypeDef,
  TypeDef,
  ValType,
} from "../ir/types.js";

/** Sentinel: the instruction sequence is unreachable (after return/br/throw/unreachable). */
const UNREACHABLE = -999;

/**
 * Check if an instruction is a terminator (makes subsequent code unreachable).
 */
function isTerminator(op: string): boolean {
  return op === "return" || op === "return_call" || op === "return_call_ref" ||
         op === "br" || op === "throw" || op === "rethrow" || op === "unreachable";
}

/**
 * Remove dead code after terminating instructions in a flat instruction body.
 * Recurses into structured blocks (if/block/loop/try).
 * Mutates the body array in place.
 * Returns the number of instructions removed.
 */
function eliminateDeadCode(body: Instr[]): number {
  let removed = 0;

  // First, recurse into structured blocks
  for (const instr of body) {
    if (instr.op === "if") {
      const ifInstr = instr as { op: "if"; then: Instr[]; else?: Instr[] };
      removed += eliminateDeadCode(ifInstr.then);
      if (ifInstr.else) removed += eliminateDeadCode(ifInstr.else);
    } else if (instr.op === "block" || instr.op === "loop") {
      const blockInstr = instr as { op: string; body: Instr[] };
      removed += eliminateDeadCode(blockInstr.body);
    } else if (instr.op === "try") {
      const tryInstr = instr as {
        op: "try"; body: Instr[];
        catches: Array<{ body: Instr[] }>;
        catchAll?: Instr[];
      };
      removed += eliminateDeadCode(tryInstr.body);
      for (const c of tryInstr.catches || []) {
        removed += eliminateDeadCode(c.body);
      }
      if (tryInstr.catchAll) removed += eliminateDeadCode(tryInstr.catchAll);
    }
  }

  // Then, truncate after terminators at this level
  for (let i = 0; i < body.length; i++) {
    if (isTerminator(body[i]!.op)) {
      const deadCount = body.length - (i + 1);
      if (deadCount > 0) {
        body.splice(i + 1, deadCount);
        removed += deadCount;
      }
      break;
    }
    // Don't look inside structured blocks for terminators at this level
    // (their internal terminators don't make the outer code unreachable)
  }

  return removed;
}

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
      op === "i32.wrap_i64" ||
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

    // call_ref: try to determine result from func type
    if (op === "call_ref") {
      const typeIdx = (instr as any).typeIdx;
      if (typeIdx !== undefined) {
        const ft = resolveFuncType(types, typeIdx);
        if (ft && ft.results.length === 1) {
          const rk = ft.results[0]!.kind;
          if (rk === "f64") return "f64";
          if (rk === "i32") return "i32";
          if (rk === "i64") return "i64";
          if (rk === "externref" || rk === "ref_extern") return "externref";
          if (rk === "ref" || rk === "ref_null") return "ref";
        }
      }
      return null;
    }

    // f32 producers
    if (op === "f32.const") return "f32";

    // any.convert_extern produces anyref (a GC ref)
    if (op === "any.convert_extern") return "ref";

    // select preserves operand type -- unknown without further analysis
    if (op === "select") return null;

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
  // Guard: extern.convert_any takes anyref, NOT externref — skip if already externref
  if ((expectedType.kind === "externref" || expectedType.kind === "ref_extern") &&
      produced !== "externref" &&
      (produced === "ref" || produced === "eqref" || produced === "funcref" || produced === "anyref")) {
    body.push({ op: "extern.convert_any" } as Instr);
    return 1;
  }

  // externref → ref/ref_null: any.convert_extern + ref.cast
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
            // Unknown type -- push ref.null.extern as safe default
            body.push({ op: "ref.null.extern" } as Instr);
            break;
        }
      } else {
        // For type-indexed block types, we can't easily determine individual value types.
        // Push ref.null.extern as a safe default (avoids runtime trap).
        body.push({ op: "ref.null.extern" } as Instr);
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
/**
 * Resolve full param types for a function by index.
 */
function getFullParamTypes(mod: WasmModule, funcIdx: number, numImports: number): ValType[] | null {
  if (funcIdx < numImports) {
    let importFuncCount = 0;
    for (const imp of mod.imports) {
      if (imp.desc.kind === "func") {
        if (importFuncCount === funcIdx) {
          const ft = resolveFuncType(mod.types, imp.desc.typeIdx);
          return ft ? ft.params : null;
        }
        importFuncCount++;
      }
    }
    return null;
  }
  const localIdx = funcIdx - numImports;
  const func = mod.functions[localIdx];
  if (!func) return null;
  const ft = resolveFuncType(mod.types, func.typeIdx);
  return ft ? ft.params : null;
}

/**
 * Infer the Wasm type produced by a single instruction, given local/param type info.
 * Returns the ValType or null if unknown.
 */
function inferInstrType(
  instr: Instr,
  localTypes: ValType[],
  globalTypes: ValType[],
  types: TypeDef[],
  mod: WasmModule,
  numImports: number,
): ValType | null {
  const op = instr.op;
  if (op === "local.get" || op === "local.tee") {
    const idx = (instr as any).index as number;
    return localTypes[idx] ?? null;
  }
  if (op === "global.get") {
    const idx = (instr as any).index as number;
    return globalTypes[idx] ?? null;
  }
  if (op === "f64.const" || op === "f64.add" || op === "f64.sub" || op === "f64.mul" ||
      op === "f64.div" || op === "f64.neg" || op === "f64.abs" || op === "f64.floor" ||
      op === "f64.ceil" || op === "f64.trunc" || op === "f64.nearest" || op === "f64.sqrt" ||
      op === "f64.copysign" || op === "f64.min" || op === "f64.max" ||
      op === "f64.convert_i32_s" || op === "f64.convert_i32_u" || op === "f64.convert_i64_s" ||
      op === "f64.promote_f32") {
    return { kind: "f64" };
  }
  if (op === "i32.const" || op === "i32.add" || op === "i32.sub" || op === "i32.mul" ||
      op === "i32.and" || op === "i32.or" || op === "i32.xor" ||
      op === "i32.eqz" || op === "i32.eq" || op === "i32.ne" ||
      op === "i32.lt_s" || op === "i32.le_s" || op === "i32.gt_s" || op === "i32.ge_s" ||
      op === "i32.shl" || op === "i32.shr_s" || op === "i32.shr_u" ||
      op === "i32.trunc_sat_f64_s" || op === "i32.trunc_f64_s" ||
      op === "i32.wrap_i64" ||
      op === "ref.is_null" || op === "ref.test" || op === "ref.eq" ||
      op === "f64.eq" || op === "f64.ne" || op === "f64.lt" || op === "f64.le" ||
      op === "f64.gt" || op === "f64.ge" ||
      op === "i64.eqz" || op === "i64.eq" || op === "i64.ne" ||
      op === "array.len") {
    return { kind: "i32" };
  }
  if (op === "i64.const" || op === "i64.extend_i32_s" || op === "i64.trunc_sat_f64_s") {
    return { kind: "i64" };
  }
  if (op === "ref.null.extern" || op === "extern.convert_any") {
    return { kind: "externref" };
  }
  if (op === "struct.new") {
    const typeIdx = (instr as any).typeIdx as number;
    return { kind: "ref", typeIdx };
  }
  if (op === "struct.get") {
    const typeIdx = (instr as any).typeIdx as number;
    const fieldIdx = (instr as any).fieldIdx as number;
    const td = types[typeIdx];
    if (td?.kind === "struct" && td.fields[fieldIdx]) {
      return td.fields[fieldIdx]!.type;
    }
    return null;
  }
  if (op === "array.get" || op === "array.get_s" || op === "array.get_u") {
    const typeIdx = (instr as any).typeIdx as number;
    const td = types[typeIdx];
    if (td?.kind === "array") return td.element;
    return null;
  }
  if (op === "ref.null") {
    const typeIdx = (instr as any).typeIdx as number;
    return { kind: "ref_null", typeIdx };
  }
  if (op === "ref.cast" || op === "ref.as_non_null") {
    const typeIdx = (instr as any).typeIdx as number;
    if (typeIdx !== undefined) return { kind: "ref", typeIdx };
    return null;
  }
  if (op === "ref.cast_null") {
    const typeIdx = (instr as any).typeIdx as number;
    return { kind: "ref_null", typeIdx };
  }
  if (op === "any.convert_extern") {
    return { kind: "anyref" } as ValType;
  }
  // Compound instructions (if/block/loop/try) produce a value based on blockType
  if (op === "if" || op === "block" || op === "loop" || op === "try") {
    const bt = (instr as any).blockType as BlockType | undefined;
    if (bt && bt.kind === "val") return bt.type;
    if (bt && bt.kind === "type") {
      const ft = resolveFuncType(types, bt.typeIdx);
      if (ft && ft.results.length === 1) return ft.results[0]!;
    }
    return null;
  }

  if (op === "call") {
    const funcIdx = (instr as any).funcIdx as number;
    const pt = getFullParamTypes(mod, funcIdx, numImports);
    // Need result types, not params
    if (funcIdx < numImports) {
      let importFuncCount = 0;
      for (const imp of mod.imports) {
        if (imp.desc.kind === "func") {
          if (importFuncCount === funcIdx) {
            const ft = resolveFuncType(types, imp.desc.typeIdx);
            return ft && ft.results.length === 1 ? ft.results[0]! : null;
          }
          importFuncCount++;
        }
      }
    } else {
      const localFuncIdx = funcIdx - numImports;
      const func = mod.functions[localFuncIdx];
      if (func) {
        const ft = resolveFuncType(types, func.typeIdx);
        return ft && ft.results.length === 1 ? ft.results[0]! : null;
      }
    }
    return null;
  }
  return null;
}

/**
 * Check if a coercion is needed and generate the coercion instruction(s).
 * Returns an array of instructions to insert, or empty if no coercion needed.
 */
function callArgCoercionInstrs(
  actual: ValType,
  expected: ValType,
  boxNumberIdx: number | null,
  unboxNumberIdx: number | null,
): Instr[] {
  // Same type — no coercion
  if (actual.kind === expected.kind) {
    if ((actual.kind === "ref" || actual.kind === "ref_null") &&
        (expected.kind === "ref" || expected.kind === "ref_null")) {
      const actualIdx = (actual as any).typeIdx;
      const expectedIdx = (expected as any).typeIdx;
      if (actualIdx === expectedIdx) return [];
    } else {
      return [];
    }
  }

  // Both externref (possibly different kind strings: "externref" vs "ref_extern") — no coercion
  const actualIsExternref = actual.kind === "externref" || actual.kind === "ref_extern";
  const expectedIsExternref = expected.kind === "externref" || expected.kind === "ref_extern";
  if (actualIsExternref && expectedIsExternref) return [];

  // ref/ref_null → externref: extern.convert_any (lossless, always safe)
  // Note: actual is already guarded to be ref/ref_null/anyref/eqref (never externref)
  // by the actualIsExternref early-return above.
  if ((actual.kind === "ref" || actual.kind === "ref_null" || actual.kind === "anyref" || actual.kind === "eqref") &&
      (expected.kind === "externref" || expected.kind === "ref_extern")) {
    return [{ op: "extern.convert_any" } as Instr];
  }

  // f64 → externref: __box_number
  if (actual.kind === "f64" && expected.kind === "externref" && boxNumberIdx !== null) {
    return [{ op: "call", funcIdx: boxNumberIdx } as unknown as Instr];
  }

  // i32 → externref: f64.convert_i32_s + __box_number
  if (actual.kind === "i32" && expected.kind === "externref" && boxNumberIdx !== null) {
    return [
      { op: "f64.convert_i32_s" } as Instr,
      { op: "call", funcIdx: boxNumberIdx } as unknown as Instr,
    ];
  }

  // i64 → externref: f64.convert_i64_s + __box_number
  if (actual.kind === "i64" && expected.kind === "externref" && boxNumberIdx !== null) {
    return [
      { op: "f64.convert_i64_s" } as unknown as Instr,
      { op: "call", funcIdx: boxNumberIdx } as unknown as Instr,
    ];
  }

  // externref → f64: __unbox_number
  if (actual.kind === "externref" && expected.kind === "f64" && unboxNumberIdx !== null) {
    return [{ op: "call", funcIdx: unboxNumberIdx } as unknown as Instr];
  }

  // ref/ref_null → f64: extern.convert_any + __unbox_number
  if ((actual.kind === "ref" || actual.kind === "ref_null") && expected.kind === "f64" && unboxNumberIdx !== null) {
    return [
      { op: "extern.convert_any" } as Instr,
      { op: "call", funcIdx: unboxNumberIdx } as unknown as Instr,
    ];
  }

  // i64 → i32: i32.wrap_i64
  if (actual.kind === "i64" && expected.kind === "i32") {
    return [{ op: "i32.wrap_i64" } as unknown as Instr];
  }

  // i32 → f64: f64.convert_i32_s
  if (actual.kind === "i32" && expected.kind === "f64") {
    return [{ op: "f64.convert_i32_s" } as Instr];
  }

  // i64 → f64: f64.convert_i64_s
  if (actual.kind === "i64" && expected.kind === "f64") {
    return [{ op: "f64.convert_i64_s" } as unknown as Instr];
  }

  // i32 → i64: i64.extend_i32_s
  if (actual.kind === "i32" && expected.kind === "i64") {
    return [{ op: "i64.extend_i32_s" } as unknown as Instr];
  }

  // externref → ref/ref_null: any.convert_extern + ref.cast_null
  if (actualIsExternref && (expected.kind === "ref" || expected.kind === "ref_null")) {
    const typeIdx = (expected as any).typeIdx;
    if (typeIdx !== undefined) {
      return [
        { op: "any.convert_extern" } as Instr,
        { op: "ref.cast_null", typeIdx } as Instr,
      ];
    }
  }

  // ref/ref_null → i32: extern.convert_any + __unbox_number + i32.trunc_sat_f64_s
  if ((actual.kind === "ref" || actual.kind === "ref_null") && expected.kind === "i32" && unboxNumberIdx !== null) {
    return [
      { op: "extern.convert_any" } as Instr,
      { op: "call", funcIdx: unboxNumberIdx } as unknown as Instr,
      { op: "i32.trunc_sat_f64_s" } as Instr,
    ];
  }

  // externref → i32: __unbox_number + i32.trunc_sat_f64_s
  if (actualIsExternref && expected.kind === "i32" && unboxNumberIdx !== null) {
    return [
      { op: "call", funcIdx: unboxNumberIdx } as unknown as Instr,
      { op: "i32.trunc_sat_f64_s" } as Instr,
    ];
  }

  return [];
}

/**
 * Fix call argument type mismatches in a function body.
 * Walks through the instruction stream and for each call/return_call,
 * checks argument types against expected parameter types and inserts
 * coercion instructions where needed.
 *
 * Only handles the common case where the argument-producing instruction
 * is directly before the call (single-value, no interleaving control flow).
 * For the last argument (top of stack before call), this is always the case
 * in linear instruction streams.
 */
function fixCallArgTypesInBody(
  body: Instr[],
  localTypes: ValType[],
  globalTypes: ValType[],
  types: TypeDef[],
  mod: WasmModule,
  numImports: number,
  sigs: FuncSigInfo,
  boxNumberIdx: number | null,
  unboxNumberIdx: number | null,
): number {
  let fixups = 0;

  // Process nested blocks recursively first
  for (const instr of body) {
    if (instr.op === "if") {
      const ifInstr = instr as any;
      if (ifInstr.then) fixups += fixCallArgTypesInBody(ifInstr.then, localTypes, globalTypes, types, mod, numImports, sigs, boxNumberIdx, unboxNumberIdx);
      if (ifInstr.else) fixups += fixCallArgTypesInBody(ifInstr.else, localTypes, globalTypes, types, mod, numImports, sigs, boxNumberIdx, unboxNumberIdx);
    } else if (instr.op === "block" || instr.op === "loop") {
      const blockInstr = instr as any;
      if (blockInstr.body) fixups += fixCallArgTypesInBody(blockInstr.body, localTypes, globalTypes, types, mod, numImports, sigs, boxNumberIdx, unboxNumberIdx);
    } else if (instr.op === "try") {
      const tryInstr = instr as any;
      if (tryInstr.body) fixups += fixCallArgTypesInBody(tryInstr.body, localTypes, globalTypes, types, mod, numImports, sigs, boxNumberIdx, unboxNumberIdx);
      if (tryInstr.catches) {
        for (const c of tryInstr.catches) {
          if (c.body) fixups += fixCallArgTypesInBody(c.body, localTypes, globalTypes, types, mod, numImports, sigs, boxNumberIdx, unboxNumberIdx);
        }
      }
      if (tryInstr.catchAll) fixups += fixCallArgTypesInBody(tryInstr.catchAll, localTypes, globalTypes, types, mod, numImports, sigs, boxNumberIdx, unboxNumberIdx);
    }
  }

  // Fix call argument type mismatches.
  // Conservative approach: only fix SIMPLE patterns where a value-producing
  // instruction directly precedes the call instruction and produces a type
  // that doesn't match. We walk backward through instructions, tracking
  // stack depth, and only insert coercions for simple value producers
  // (local.get, global.get, struct.new, ref.null, local.tee, call).
  // Complex cases (nested blocks, if expressions) are skipped to avoid
  // breaking stack balance.
  const SIMPLE_PRODUCERS = new Set([
    "local.get", "global.get", "local.tee",
    "struct.new", "ref.null", "struct.get", "array.get",
    "array.get_s", "array.get_u",
    "call", "ref.cast", "ref.cast_null", "ref.as_non_null",
    "array.new_default", "array.new", "array.new_fixed",
    // f64/f32 constants — safe, never used as array/struct indices
    "f64.const", "f32.const",
    // Ref producers — safe, rarely used as sub-expression inputs
    "ref.null.extern", "ref.null.eq", "ref.null.func", "ref.func",
    // i32/i64 constants — safe when directly before call
    "i32.const", "i64.const",
    // i32 arithmetic/comparison — these produce i32 results
    "i32.add", "i32.sub", "i32.mul", "i32.div_s", "i32.div_u",
    "i32.rem_s", "i32.rem_u",
    "i32.and", "i32.or", "i32.xor",
    "i32.shl", "i32.shr_s", "i32.shr_u",
    "i32.eq", "i32.ne",
    "i32.lt_s", "i32.le_s", "i32.gt_s", "i32.ge_s",
    "i32.lt_u", "i32.le_u", "i32.gt_u", "i32.ge_u",
    "i32.eqz", "i32.clz", "i32.wrap_i64",
    "i32.trunc_sat_f64_s", "i32.trunc_sat_f64_u", "i32.trunc_f64_s",
    // i64 arithmetic — these produce i64 results
    "i64.add", "i64.sub", "i64.mul", "i64.div_s", "i64.rem_s",
    "i64.and", "i64.or", "i64.xor",
    "i64.shl", "i64.shr_s", "i64.shr_u",
    "i64.eq", "i64.ne",
    "i64.lt_s", "i64.le_s", "i64.gt_s", "i64.ge_s",
    "i64.eqz", "i64.extend_i32_s", "i64.extend_i32_u",
    "i64.trunc_sat_f64_s", "i64.trunc_f64_s",
    // f64 arithmetic — these produce f64 results
    "f64.add", "f64.sub", "f64.mul", "f64.div",
    "f64.neg", "f64.abs", "f64.floor", "f64.ceil", "f64.trunc",
    "f64.nearest", "f64.sqrt", "f64.copysign", "f64.min", "f64.max",
    "f64.convert_i32_s", "f64.convert_i32_u", "f64.convert_i64_s",
    "f64.promote_f32",
    "f64.eq", "f64.ne", "f64.lt", "f64.le", "f64.gt", "f64.ge",
    // Other type-producing ops
    "ref.is_null", "ref.test", "ref.eq",
    "array.len",
    "any.convert_extern", "extern.convert_any",
  ]);

  for (let ci = 0; ci < body.length; ci++) {
    const callInstr = body[ci]!;
    const isCall = callInstr.op === "call" || callInstr.op === "return_call";
    const isCallRef = callInstr.op === "call_ref";
    if (!isCall && !isCallRef) continue;

    let expectedParams: ValType[] | null;
    if (isCallRef) {
      // call_ref uses a type index to determine the signature
      const typeIdx = (callInstr as any).typeIdx as number;
      const ft = resolveFuncType(types, typeIdx);
      expectedParams = ft ? ft.params : null;
    } else {
      const funcIdx = (callInstr as any).funcIdx as number;
      expectedParams = getFullParamTypes(mod, funcIdx, numImports);
    }
    if (!expectedParams || expectedParams.length === 0) continue;

    const paramCount = expectedParams.length;
    // For call_ref, the funcref is on top of the params stack — skip it
    let argOffset = isCallRef ? -1 : 0;
    let pos = ci - 1;
    const insertions: Array<{ afterPos: number; instrs: Instr[] }> = [];
    // Track whether we've traversed through a sub-expression consumer.
    // When this is true, the backward walk's argOffset may conflate
    // sub-expression inputs with call arguments, so we restrict coercions
    // to only the proven-safe ref→externref pattern.
    let inSubExpr = false;

    while (pos >= 0 && argOffset < paramCount) {
      const instr = body[pos]!;
      const op = instr.op;

      // Stop at control flow boundaries — don't try to trace through
      // blocks, ifs, loops, or try statements
      if (op === "if" || op === "block" || op === "loop" || op === "try" ||
          op === "end" || op === "br" || op === "br_if" || op === "br_table" ||
          op === "return" || op === "throw" || op === "unreachable" ||
          op === "return_call" || op === "return_call_ref") {
        break;
      }

      const delta = instrDelta(instr, types, sigs);
      if (delta === UNREACHABLE) break;

      // Determine if this instruction produces a value we can coerce.
      // "simple producers" with delta >= 1 are the straightforward case.
      // But ops like i32.xor (pop 2, push 1, net -1) also produce a value
      // that becomes a call argument — we handle those too.
      const producesValue = SIMPLE_PRODUCERS.has(op) && inferInstrType(instr, localTypes, globalTypes, types, mod, numImports) !== null;

      if (producesValue && argOffset >= 0) {
        // Check if there are pass-through transformers between this
        // instruction and the call/next producer.
        let effectiveType = inferInstrType(instr, localTypes, globalTypes, types, mod, numImports);
        let insertPos = pos;

        for (let t = pos + 1; t < ci; t++) {
          const tInstr = body[t]!;
          const tDelta = instrDelta(tInstr, types, sigs);
          if (tDelta !== 0) break;
          const tType = inferInstrType(tInstr, localTypes, globalTypes, types, mod, numImports);
          if (tType) effectiveType = tType;
          insertPos = t;
        }

        const paramIdx = paramCount - 1 - argOffset;
        const expectedType = expectedParams[paramIdx]!;

        if (effectiveType && expectedType) {
          const coercion = callArgCoercionInstrs(effectiveType, expectedType, boxNumberIdx, unboxNumberIdx);
          if (coercion.length > 0) {
            // After traversing sub-expressions, the backward walk may confuse
            // sub-expression inputs with call arguments. Only apply the
            // proven-safe ref→externref coercion (extern.convert_any) in
            // that case; other coercions are restricted to positions before
            // any consumer has been traversed.
            const isSafeRefToExtern = coercion.length === 1 &&
              (coercion[0] as any).op === "extern.convert_any";
            if (!inSubExpr || isSafeRefToExtern) {
              insertions.push({ afterPos: insertPos, instrs: coercion });
            }
          }
        }
      }

      // Update argOffset and sub-expression tracking
      if (delta >= 1) {
        argOffset += delta;
      } else if (delta < 0) {
        // For ops that produce a value (like i32.xor: pop 2, push 1),
        // count 1 toward arguments, then account for consumed inputs
        if (producesValue) {
          argOffset += 1; // the produced value is a call argument
          // The remaining -(delta - (-1)) = delta + 1 consumed values
          // come from the stack (sub-expression inputs)
          if (delta < -1) {
            // This is wrong — delta already accounts for net.
            // For pop 2 push 1: delta = -1. We counted +1 for the arg,
            // so we need to also go -2 for consumed inputs = net -1.
            // But argOffset += delta already does net, and we added +1 for
            // the arg. So: argOffset += 1 + delta = 1 + (-1) = 0 for i32.xor.
            // Wait, that's wrong too. Let me think again...
            //
            // Actually: the op contributes 1 value to args (already counted)
            // and consumes (1-delta) inputs from the stack below.
            // For i32.xor: consumes 2 from below, net delta = -1.
            // We want argOffset to go back by 2 (consumed inputs reduce
            // what's available for further call args).
            // argOffset += delta works for non-producing ops.
            // For producing ops: argOffset += 1 (arg) + delta_consumed
            // where delta_consumed = -(consumed) = delta - 1 (since delta = push - pop)
            // So: argOffset += 1 + (delta - 1) = delta. Same as before!
          }
          // Actually argOffset += delta already gives the right net effect:
          // it accounts for 1 push and N pops. We already handled the push
          // (coercion check above), so we just need the net:
          argOffset += delta - 1; // subtract the 1 we already accounted for
        } else {
          argOffset += delta;
        }
        inSubExpr = true;
        if (argOffset < (isCallRef ? -1 : 0)) break;
      }
      // delta === 0: pass-through (ref.as_non_null, extern.convert_any, etc.)
      pos--;
    }

    // Apply insertions in reverse order (so positions don't shift)
    if (insertions.length > 0) {
      for (let k = insertions.length - 1; k >= 0; k--) {
        const { afterPos, instrs } = insertions[k]!;
        body.splice(afterPos + 1, 0, ...instrs);
        ci += instrs.length;
        fixups += instrs.length;
      }
    }
  }

  // struct.new field coercion is handled by fixStructNewFieldCoercion
  // (forward type-stack simulation), called separately from stackBalance.

  return fixups;
}

/**
 * Forward type-stack simulation for struct.new field coercion.
 *
 * Walks the instruction stream forward, maintaining a type stack.
 * When a struct.new is encountered, compares the actual types on the
 * stack with the expected field types. If coercion is needed, saves
 * all field values to temp locals, applies coercions, and re-pushes.
 *
 * This replaces the fragile backward walk which miscalculated positions
 * for compound instructions (if/block/loop/try).
 */
function fixStructNewFieldCoercion(
  func: WasmFunction,
  types: TypeDef[],
  mod: WasmModule,
  numImports: number,
  sigs: FuncSigInfo,
  localTypes: ValType[],
  globalTypes: ValType[],
  boxNumberIdx: number | null,
  unboxNumberIdx: number | null,
): number {
  let fixups = 0;

  function processBody(body: Instr[]): void {
    // First recurse into nested blocks
    for (const instr of body) {
      if (instr.op === "if") {
        const ifInstr = instr as any;
        if (ifInstr.then) processBody(ifInstr.then);
        if (ifInstr.else) processBody(ifInstr.else);
      } else if (instr.op === "block" || instr.op === "loop") {
        const blockInstr = instr as any;
        if (blockInstr.body) processBody(blockInstr.body);
      } else if (instr.op === "try") {
        const tryInstr = instr as any;
        if (tryInstr.body) processBody(tryInstr.body);
        if (tryInstr.catches) {
          for (const c of tryInstr.catches) {
            if (c.body) processBody(c.body);
          }
        }
        if (tryInstr.catchAll) processBody(tryInstr.catchAll);
      }
    }

    // Forward type-stack simulation
    const typeStack: (ValType | null)[] = []; // null = unknown type

    for (let ci = 0; ci < body.length; ci++) {
      const instr = body[ci]!;
      const op = instr.op;

      if (op === "struct.new") {
        const typeIdx = (instr as any).typeIdx as number;
        const typeDef = types[typeIdx];
        if (typeDef?.kind === "struct") {
          const fields = typeDef.fields as Array<{ type: ValType }>;
          const numFields = fields.length;

          if (numFields > 0 && typeStack.length >= numFields) {
            // Check if any field needs coercion
            const fieldTypes: (ValType | null)[] = [];
            for (let fi = 0; fi < numFields; fi++) {
              fieldTypes.push(typeStack[typeStack.length - numFields + fi] ?? null);
            }

            let needsCoercion = false;
            const coercions: Instr[][] = [];
            for (let fi = 0; fi < numFields; fi++) {
              const actual = fieldTypes[fi];
              const expected = fields[fi]!.type;
              if (actual) {
                const c = callArgCoercionInstrs(actual, expected, boxNumberIdx, unboxNumberIdx);
                coercions.push(c);
                if (c.length > 0) needsCoercion = true;
              } else {
                coercions.push([]);
              }
            }

            if (needsCoercion) {
              // Save all N field values to temp locals, coerce, re-push.
              // Allocate temp locals with actual types from the stack.
              const tempLocals: number[] = [];
              const paramCount = resolveFuncType(types, func.typeIdx)?.params.length ?? 0;
              for (let fi = 0; fi < numFields; fi++) {
                const actualType = fieldTypes[fi] ?? fields[fi]!.type;
                const localIdx = paramCount + func.locals.length;
                func.locals.push({ name: `$sn_tmp_${localIdx}`, type: actualType });
                // Update localTypes for future inference
                localTypes.push(actualType);
                tempLocals.push(localIdx);
              }

              // Build the replacement instructions:
              // 1. Save top N values to temps (reverse order: last field = top of stack saved first)
              const saveInstrs: Instr[] = [];
              for (let fi = numFields - 1; fi >= 0; fi--) {
                saveInstrs.push({ op: "local.set", index: tempLocals[fi]! } as unknown as Instr);
              }
              // 2. Re-push each value with coercion
              const restoreInstrs: Instr[] = [];
              for (let fi = 0; fi < numFields; fi++) {
                restoreInstrs.push({ op: "local.get", index: tempLocals[fi]! } as unknown as Instr);
                for (const c of coercions[fi]!) {
                  restoreInstrs.push(c);
                }
              }

              // Insert save+restore before the struct.new
              const insertedInstrs = [...saveInstrs, ...restoreInstrs];
              body.splice(ci, 0, ...insertedInstrs);
              ci += insertedInstrs.length; // skip past inserted + struct.new
              fixups += insertedInstrs.length;
            }
          }

          // Pop N values from type stack, push 1 ref
          for (let i = 0; i < (typeDef.fields as any[]).length; i++) typeStack.pop();
          typeStack.push({ kind: "ref", typeIdx } as ValType);
        }
        continue;
      }

      // Update type stack for other instructions
      updateTypeStack(typeStack, instr, types, sigs, localTypes, globalTypes, mod, numImports);
    }
  }

  processBody(func.body);
  return fixups;
}

/**
 * Update the type stack for a single instruction (forward simulation).
 * Pushes/pops type entries based on the instruction's semantics.
 * Pushes null for unknown types.
 */
function updateTypeStack(
  stack: (ValType | null)[],
  instr: Instr,
  types: TypeDef[],
  sigs: FuncSigInfo,
  localTypes: ValType[],
  globalTypes: ValType[],
  mod: WasmModule,
  numImports: number,
): void {
  const op = instr.op;

  // Terminators: clear the stack (unreachable code follows)
  if (op === "return" || op === "return_call" || op === "return_call_ref" ||
      op === "br" || op === "throw" || op === "rethrow" || op === "unreachable") {
    stack.length = 0;
    return;
  }

  // Push-only: push 1 value, consume 0
  if (op === "local.get") {
    const idx = (instr as any).index as number;
    stack.push(localTypes[idx] ?? null);
    return;
  }
  if (op === "global.get") {
    const idx = (instr as any).index as number;
    stack.push(globalTypes[idx] ?? null);
    return;
  }
  if (op === "f64.const") { stack.push({ kind: "f64" }); return; }
  if (op === "f32.const") { stack.push({ kind: "f32" } as ValType); return; }
  if (op === "i32.const") { stack.push({ kind: "i32" }); return; }
  if (op === "i64.const") { stack.push({ kind: "i64" }); return; }
  if (op === "ref.null") {
    const typeIdx = (instr as any).typeIdx as number;
    stack.push({ kind: "ref_null", typeIdx } as ValType);
    return;
  }
  if (op === "ref.null.extern" || op === "ref.null extern") {
    stack.push({ kind: "externref" } as ValType);
    return;
  }
  if (op === "ref.null.eq") { stack.push({ kind: "eqref" } as ValType); return; }
  if (op === "ref.null.func") { stack.push({ kind: "funcref" } as ValType); return; }
  if (op === "ref.func") { stack.push({ kind: "funcref" } as ValType); return; }
  if (op === "v128.const") { stack.push(null); return; } // v128 type, push unknown
  if (op === "memory.size") { stack.push({ kind: "i32" }); return; }

  // Pop 1, push 0
  if (op === "drop" || op === "local.set" || op === "global.set") {
    stack.pop();
    return;
  }

  // Pop 1, push 1 (type-changing or type-preserving)
  if (op === "local.tee") {
    // Type doesn't change, just peek
    return;
  }
  if (op === "extern.convert_any") {
    stack.pop();
    stack.push({ kind: "externref" } as ValType);
    return;
  }
  if (op === "any.convert_extern") {
    stack.pop();
    stack.push({ kind: "anyref" } as ValType);
    return;
  }
  if (op === "ref.cast" || op === "ref.as_non_null") {
    stack.pop();
    const typeIdx = (instr as any).typeIdx as number;
    if (typeIdx !== undefined) {
      stack.push({ kind: "ref", typeIdx } as ValType);
    } else {
      stack.push(null);
    }
    return;
  }
  if (op === "ref.cast_null") {
    stack.pop();
    const typeIdx = (instr as any).typeIdx as number;
    stack.push({ kind: "ref_null", typeIdx } as ValType);
    return;
  }
  if (op === "ref.is_null" || op === "ref.test" || op === "i32.eqz" || op === "i64.eqz" ||
      op === "i32.clz" || op === "i32.wrap_i64" ||
      op === "i32.trunc_sat_f64_s" || op === "i32.trunc_sat_f64_u" || op === "i32.trunc_f64_s" ||
      op === "array.len") {
    stack.pop();
    stack.push({ kind: "i32" });
    return;
  }
  if (op === "f64.neg" || op === "f64.abs" || op === "f64.floor" || op === "f64.ceil" ||
      op === "f64.trunc" || op === "f64.nearest" || op === "f64.sqrt" ||
      op === "f64.convert_i32_s" || op === "f64.convert_i32_u" || op === "f64.convert_i64_s" ||
      op === "f64.promote_f32") {
    stack.pop();
    stack.push({ kind: "f64" });
    return;
  }
  if (op === "f32.demote_f64") {
    stack.pop();
    stack.push({ kind: "f32" } as ValType);
    return;
  }
  if (op === "i64.extend_i32_s" || op === "i64.extend_i32_u" ||
      op === "i64.trunc_sat_f64_s" || op === "i64.trunc_f64_s") {
    stack.pop();
    stack.push({ kind: "i64" });
    return;
  }

  // Pop 2, push 1
  if (op === "i32.add" || op === "i32.sub" || op === "i32.mul" ||
      op === "i32.div_s" || op === "i32.div_u" || op === "i32.rem_s" || op === "i32.rem_u" ||
      op === "i32.and" || op === "i32.or" || op === "i32.xor" ||
      op === "i32.shl" || op === "i32.shr_s" || op === "i32.shr_u" ||
      op === "i32.eq" || op === "i32.ne" ||
      op === "i32.lt_s" || op === "i32.le_s" || op === "i32.gt_s" || op === "i32.ge_s" ||
      op === "i32.lt_u" || op === "i32.le_u" || op === "i32.gt_u" || op === "i32.ge_u" ||
      op === "ref.eq" ||
      op === "f64.eq" || op === "f64.ne" || op === "f64.lt" || op === "f64.le" ||
      op === "f64.gt" || op === "f64.ge" ||
      op === "i64.eqz" || op === "i64.eq" || op === "i64.ne") {
    stack.pop(); stack.pop();
    stack.push({ kind: "i32" });
    return;
  }
  if (op === "i64.add" || op === "i64.sub" || op === "i64.mul" ||
      op === "i64.div_s" || op === "i64.rem_s" ||
      op === "i64.and" || op === "i64.or" || op === "i64.xor" ||
      op === "i64.shl" || op === "i64.shr_s" || op === "i64.shr_u" ||
      op === "i64.lt_s" || op === "i64.le_s" || op === "i64.gt_s" || op === "i64.ge_s") {
    stack.pop(); stack.pop();
    stack.push({ kind: "i64" });
    return;
  }
  if (op === "f64.add" || op === "f64.sub" || op === "f64.mul" || op === "f64.div" ||
      op === "f64.copysign" || op === "f64.min" || op === "f64.max") {
    stack.pop(); stack.pop();
    stack.push({ kind: "f64" });
    return;
  }

  // select: pop 3, push 1 (type of first operand)
  if (op === "select") {
    stack.pop(); // condition
    stack.pop(); // val2
    const val1 = stack.pop() ?? null;
    stack.push(val1);
    return;
  }

  // struct.get: pop 1 (struct ref), push 1 (field type)
  if (op === "struct.get") {
    stack.pop();
    const typeIdx = (instr as any).typeIdx as number;
    const fieldIdx = (instr as any).fieldIdx as number;
    const td = types[typeIdx];
    if (td?.kind === "struct" && (td as any).fields[fieldIdx]) {
      stack.push((td as any).fields[fieldIdx].type);
    } else {
      stack.push(null);
    }
    return;
  }

  // struct.set: pop 2 (struct ref + value), push 0
  if (op === "struct.set") {
    stack.pop(); stack.pop();
    return;
  }

  // array.get/get_s/get_u: pop 2 (array + index), push 1 (element type)
  if (op === "array.get" || op === "array.get_s" || op === "array.get_u") {
    stack.pop(); stack.pop();
    const typeIdx = (instr as any).typeIdx as number;
    const td = types[typeIdx];
    if (td?.kind === "array") {
      stack.push(td.element);
    } else {
      stack.push(null);
    }
    return;
  }

  // array.set: pop 3
  if (op === "array.set") {
    stack.pop(); stack.pop(); stack.pop();
    return;
  }

  // array.new: pop 2, push 1
  if (op === "array.new") {
    stack.pop(); stack.pop();
    const typeIdx = (instr as any).typeIdx as number;
    stack.push({ kind: "ref", typeIdx } as ValType);
    return;
  }

  // array.new_default: pop 1, push 1
  if (op === "array.new_default") {
    stack.pop();
    const typeIdx = (instr as any).typeIdx as number;
    stack.push({ kind: "ref", typeIdx } as ValType);
    return;
  }

  // array.new_fixed: pop N, push 1
  if (op === "array.new_fixed") {
    const len = (instr as any).length || 0;
    for (let i = 0; i < len; i++) stack.pop();
    const typeIdx = (instr as any).typeIdx as number;
    stack.push({ kind: "ref", typeIdx } as ValType);
    return;
  }

  // array.copy: pop 5, array.fill: pop 4
  if (op === "array.copy") { for (let i = 0; i < 5; i++) stack.pop(); return; }
  if (op === "array.fill") { for (let i = 0; i < 4; i++) stack.pop(); return; }

  // call: pop params, push results
  if (op === "call") {
    const funcIdx = (instr as any).funcIdx as number;
    const sig = sigs.get(funcIdx);
    if (sig) {
      for (let i = 0; i < sig.params; i++) stack.pop();
      if (sig.results > 0) {
        // Try to get actual result type from function signature
        const fIdx = funcIdx - numImports;
        const fn = fIdx >= 0 ? mod.functions[fIdx] : undefined;
        const ft = fn ? resolveFuncType(types, fn.typeIdx) : null;
        if (ft && ft.results.length > 0) {
          for (const r of ft.results) stack.push(r);
        } else {
          // Check import function signatures
          let importFuncIdx = 0;
          let foundImport = false;
          for (const imp of mod.imports) {
            if (imp.desc.kind === "func") {
              if (importFuncIdx === funcIdx) {
                const impFt = resolveFuncType(types, imp.desc.typeIdx);
                if (impFt && impFt.results.length > 0) {
                  for (const r of impFt.results) stack.push(r);
                  foundImport = true;
                }
                break;
              }
              importFuncIdx++;
            }
          }
          if (!foundImport) {
            for (let i = 0; i < sig.results; i++) stack.push(null);
          }
        }
      }
    } else {
      stack.push(null); // unknown
    }
    return;
  }

  // call_ref: pop params + funcref, push results
  if (op === "call_ref") {
    const typeIdx = (instr as any).typeIdx as number;
    const ft = resolveFuncType(types, typeIdx);
    if (ft) {
      stack.pop(); // funcref
      for (let i = 0; i < ft.params.length; i++) stack.pop();
      for (const r of ft.results) stack.push(r);
    } else {
      stack.push(null);
    }
    return;
  }

  // br_if: pop 1 (condition)
  if (op === "br_if") {
    stack.pop();
    return;
  }

  // Structured blocks: external effect based on blockType
  if (op === "if" || op === "block" || op === "loop" || op === "try") {
    const bt = (instr as any).blockType as BlockType | undefined;
    if (op === "if") stack.pop(); // condition

    // Process nested bodies recursively (already done above in processBody)
    // For the type stack, just account for the block's net result
    if (!bt || bt.kind === "empty") {
      // no result
    } else if (bt.kind === "val") {
      stack.push(bt.type);
    } else if (bt.kind === "type") {
      const ft = resolveFuncType(types, bt.typeIdx);
      if (ft) {
        for (let i = 0; i < ft.params.length; i++) stack.pop();
        for (const r of ft.results) stack.push(r);
      } else {
        stack.push(null);
      }
    }
    return;
  }

  // For all other instructions, use instrDelta and push null for unknown types
  const delta = instrDelta(instr, types, sigs);
  if (delta === UNREACHABLE) {
    stack.length = 0;
    return;
  }
  if (delta < 0) {
    for (let i = 0; i < -delta; i++) stack.pop();
  } else if (delta > 0) {
    for (let i = 0; i < delta; i++) stack.push(null);
  }
  // delta === 0: pass-through, no stack change
}

export function stackBalance(mod: WasmModule): number {
  const sigs = buildFuncSigs(mod);
  const tags = mod.tags || [];
  let totalFixups = 0;

  // Count import functions and find __box_number/__unbox_number indices
  let numImports = 0;
  let boxNumberIdx: number | null = null;
  let unboxNumberIdx: number | null = null;
  for (const imp of mod.imports) {
    if (imp.desc.kind === "func") {
      if (imp.name === "__box_number") boxNumberIdx = numImports;
      if (imp.name === "__unbox_number") unboxNumberIdx = numImports;
      numImports++;
    }
  }

  // Build global types array
  const globalTypes: ValType[] = [];
  for (const imp of mod.imports) {
    if (imp.desc.kind === "global") {
      globalTypes.push(imp.desc.type);
    }
  }
  for (const g of mod.globals) {
    globalTypes.push(g.type);
  }

  for (let fi = 0; fi < mod.functions.length; fi++) {
    const func = mod.functions[fi]!;
    // Build local types array (params + locals)
    const ft = resolveFuncType(mod.types, func.typeIdx);
    const localTypes: ValType[] = [];
    if (ft) {
      for (const p of ft.params) localTypes.push(p);
    }
    for (const l of func.locals) localTypes.push(l.type);

    // Eliminate dead code after terminators (throw/return/br/unreachable)
    // V8 tracks stack values even in unreachable code, so dead code that pushes
    // values causes "expected N elements on the stack for fallthru" errors.
    eliminateDeadCode(func.body);

    // Fix local.set type mismatches (e.g., f64 → externref, ref → externref)
    totalFixups += fixLocalSetCoercion(func.body, localTypes, globalTypes, mod.types, mod, numImports, sigs, boxNumberIdx, unboxNumberIdx);

    // Fix call argument type mismatches before other fixups
    totalFixups += fixCallArgTypesInBody(func.body, localTypes, globalTypes, mod.types, mod, numImports, sigs, boxNumberIdx, unboxNumberIdx);

    // Fix struct.new field type mismatches (forward type-stack simulation)
    totalFixups += fixStructNewFieldCoercion(func, mod.types, mod, numImports, sigs, localTypes, globalTypes, boxNumberIdx, unboxNumberIdx);

    // Fix nested structured blocks
    totalFixups += fixBody(func.body, mod.types, sigs, tags);

    // Fix function-level body: the body must produce exactly as many values
    // as the function's result type declares.
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

/**
 * Fix local.set type mismatches in a function body.
 *
 * Walks the instruction stream looking for local.set/local.tee instructions.
 * For each one, infers the type of the value on the stack (by looking at
 * the preceding instruction) and compares it with the local's declared type.
 * If they don't match, inserts coercion instructions.
 *
 * This catches cases where the codegen emits bare local.set without
 * emitCoercedLocalSet (e.g., in destructuring, closures, for-of).
 */
function fixLocalSetCoercion(
  body: Instr[],
  localTypes: ValType[],
  globalTypes: ValType[],
  types: TypeDef[],
  mod: WasmModule,
  numImports: number,
  sigs: FuncSigInfo,
  boxNumberIdx: number | null,
  unboxNumberIdx: number | null,
): number {
  let fixups = 0;

  // Recurse into nested blocks first
  for (const instr of body) {
    if (instr.op === "if") {
      const ifInstr = instr as any;
      if (ifInstr.then) fixups += fixLocalSetCoercion(ifInstr.then, localTypes, globalTypes, types, mod, numImports, sigs, boxNumberIdx, unboxNumberIdx);
      if (ifInstr.else) fixups += fixLocalSetCoercion(ifInstr.else, localTypes, globalTypes, types, mod, numImports, sigs, boxNumberIdx, unboxNumberIdx);
    } else if (instr.op === "block" || instr.op === "loop") {
      const blockInstr = instr as any;
      if (blockInstr.body) fixups += fixLocalSetCoercion(blockInstr.body, localTypes, globalTypes, types, mod, numImports, sigs, boxNumberIdx, unboxNumberIdx);
    } else if (instr.op === "try") {
      const tryInstr = instr as any;
      if (tryInstr.body) fixups += fixLocalSetCoercion(tryInstr.body, localTypes, globalTypes, types, mod, numImports, sigs, boxNumberIdx, unboxNumberIdx);
      if (tryInstr.catches) {
        for (const c of tryInstr.catches) {
          if (c.body) fixups += fixLocalSetCoercion(c.body, localTypes, globalTypes, types, mod, numImports, sigs, boxNumberIdx, unboxNumberIdx);
        }
      }
      if (tryInstr.catchAll) fixups += fixLocalSetCoercion(tryInstr.catchAll, localTypes, globalTypes, types, mod, numImports, sigs, boxNumberIdx, unboxNumberIdx);
    }
  }

  // Now fix local.set/local.tee mismatches in this body
  for (let i = 0; i < body.length; i++) {
    const instr = body[i]!;
    if (instr.op !== "local.set" && instr.op !== "local.tee") continue;

    const localIdx = (instr as any).index as number;
    const localType = localTypes[localIdx];
    if (!localType) continue;

    // Infer the type of the value on the stack by looking at the preceding instruction
    if (i === 0) continue;
    const prev = body[i - 1]!;
    const stackType = inferInstrType(prev, localTypes, globalTypes, types, mod, numImports);
    if (!stackType) continue;

    // Check if coercion is needed
    const coercion = callArgCoercionInstrs(stackType, localType, boxNumberIdx, unboxNumberIdx);
    if (coercion.length > 0) {
      // Insert coercion instructions before the local.set
      body.splice(i, 0, ...coercion);
      i += coercion.length;
      fixups += coercion.length;
    }
  }

  return fixups;
}
