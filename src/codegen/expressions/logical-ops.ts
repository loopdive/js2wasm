/**
 * Logical operator compilation: &&, ||, ??, and mapped arguments helpers.
 */
import ts from "typescript";
import type { Instr, ValType } from "../../ir/types.js";
import { pushBody } from "../context/bodies.js";
import { reportError } from "../context/errors.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { ensureI32Condition } from "../index.js";
import { coerceType, compileExpression, valTypesMatch } from "../shared.js";
import { defaultValueInstrs } from "../type-coercion.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";

export function compileLogicalAnd(ctx: CodegenContext, fctx: FunctionContext, expr: ts.BinaryExpression): ValType {
  // JS semantics: a && b → if a is falsy, return a; else return b
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) {
    ensureI32Condition(fctx, leftType, ctx);
    return { kind: "i32" };
  }

  // Save LHS value for JS value semantics, then check truthiness
  const tmp = allocTempLocal(fctx, leftType);
  fctx.body.push({ op: "local.tee", index: tmp });
  ensureI32Condition(fctx, leftType, ctx);

  // Compile RHS in a side buffer to discover its natural type
  const savedBody = pushBody(fctx);
  const rightType = compileExpression(ctx, fctx, expr.right);
  let thenInstrs = fctx.body;
  fctx.body = savedBody;

  // If the RHS is void, push a default value so the if-block has a consistent result.
  // JS coerces undefined to NaN for numbers, null for externref, etc.
  if (!rightType) {
    // RHS produced no value — use the left type as the result and push a default
    // for the then-branch (RHS path). The else-branch returns the LHS value.
    const resultType = leftType;
    thenInstrs.push(...defaultValueInstrs(resultType));
    const elseInstrs: Instr[] = [{ op: "local.get", index: tmp } as Instr];
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: resultType },
      then: thenInstrs,
      else: elseInstrs,
    });
    releaseTempLocal(fctx, tmp);
    return resultType;
  }

  const rType: ValType = rightType;

  // Determine common result type (like conditional expression)
  let resultType: ValType = leftType;
  if (!valTypesMatch(leftType, rType)) {
    if ((leftType.kind === "i32" || leftType.kind === "f64") && (rType.kind === "i32" || rType.kind === "f64")) {
      resultType = { kind: "f64" };
    } else {
      resultType = { kind: "externref" };
    }
  }

  // Coerce then-branch (RHS) to common type if needed
  if (!valTypesMatch(rType, resultType)) {
    const coerceBody: Instr[] = [];
    fctx.body = coerceBody;
    coerceType(ctx, fctx, rType, resultType);
    fctx.body = savedBody;
    thenInstrs = [...thenInstrs, ...coerceBody];
  }

  // Build else-branch (LHS value) with coercion if needed
  let elseInstrs: Instr[] = [{ op: "local.get", index: tmp } as Instr];
  if (!valTypesMatch(leftType, resultType)) {
    const coerceBody: Instr[] = [];
    fctx.body = coerceBody;
    coerceType(ctx, fctx, leftType, resultType);
    fctx.body = savedBody;
    elseInstrs = [...elseInstrs, ...coerceBody];
  }

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultType },
    then: thenInstrs,
    else: elseInstrs,
  });
  releaseTempLocal(fctx, tmp);

  return resultType;
}

export function compileLogicalOr(ctx: CodegenContext, fctx: FunctionContext, expr: ts.BinaryExpression): ValType {
  // JS semantics: a || b → if a is truthy, return a; else return b
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) {
    ensureI32Condition(fctx, leftType, ctx);
    return { kind: "i32" };
  }

  // Save LHS value for JS value semantics, then check truthiness
  const tmp = allocTempLocal(fctx, leftType);
  fctx.body.push({ op: "local.tee", index: tmp });
  ensureI32Condition(fctx, leftType, ctx);

  // Compile RHS in a side buffer to discover its natural type
  const savedBody = pushBody(fctx);
  const rightType = compileExpression(ctx, fctx, expr.right);
  let elseInstrs = fctx.body;
  fctx.body = savedBody;

  // If the RHS is void, push a default value so the if-block has a consistent result.
  if (!rightType) {
    const resultType = leftType;
    elseInstrs.push(...defaultValueInstrs(resultType));
    const thenInstrs: Instr[] = [{ op: "local.get", index: tmp } as Instr];
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: resultType },
      then: thenInstrs,
      else: elseInstrs,
    });
    releaseTempLocal(fctx, tmp);
    return resultType;
  }

  const rType: ValType = rightType;

  // Determine common result type (like conditional expression)
  let resultType: ValType = leftType;
  if (!valTypesMatch(leftType, rType)) {
    if ((leftType.kind === "i32" || leftType.kind === "f64") && (rType.kind === "i32" || rType.kind === "f64")) {
      resultType = { kind: "f64" };
    } else {
      resultType = { kind: "externref" };
    }
  }

  // Build then-branch (LHS value) with coercion if needed
  let thenInstrs: Instr[] = [{ op: "local.get", index: tmp } as Instr];
  if (!valTypesMatch(leftType, resultType)) {
    const coerceBody: Instr[] = [];
    fctx.body = coerceBody;
    coerceType(ctx, fctx, leftType, resultType);
    fctx.body = savedBody;
    thenInstrs = [...thenInstrs, ...coerceBody];
  }

  // Coerce else-branch (RHS) to common type if needed
  if (!valTypesMatch(rType, resultType)) {
    const coerceBody: Instr[] = [];
    fctx.body = coerceBody;
    coerceType(ctx, fctx, rType, resultType);
    fctx.body = savedBody;
    elseInstrs = [...elseInstrs, ...coerceBody];
  }

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultType },
    then: thenInstrs,
    else: elseInstrs,
  });
  releaseTempLocal(fctx, tmp);

  return resultType;
}

/** Nullish coalescing: a ?? b → if a is null, return b, else return a */
export function compileNullishCoalescing(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType {
  // Compile LHS and store in temp
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) {
    reportError(ctx, expr, "Failed to compile nullish coalescing LHS");
    return { kind: "externref" };
  }
  const resultKind: ValType = leftType ?? { kind: "externref" };
  const tmp = allocTempLocal(fctx, resultKind);
  fctx.body.push({ op: "local.tee", index: tmp });

  // If the left side is a value type (i32/f64), it can never be null/undefined — short-circuit
  if (resultKind.kind === "i32" || resultKind.kind === "f64") {
    releaseTempLocal(fctx, tmp);
    return resultKind;
  }

  // Check if null or undefined (JS `??` triggers for both null and undefined)
  // ref.is_null checks for wasm null; __extern_is_undefined checks for JS undefined
  fctx.body.push({ op: "ref.is_null" });
  const isUndefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  if (isUndefIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: tmp });
    if (resultKind.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
    }
    fctx.body.push({ op: "call", funcIdx: isUndefIdx });
    fctx.body.push({ op: "i32.or" } as unknown as Instr);
  }

  // Compile RHS in a side buffer to discover its natural type
  const savedBody = pushBody(fctx);
  const rhsType = compileExpression(ctx, fctx, expr.right);
  let thenInstrs = fctx.body;
  fctx.body = savedBody;

  // If the RHS is void, push a default value so the if-block has a consistent result.
  if (!rhsType) {
    thenInstrs.push(...defaultValueInstrs(resultKind));
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: resultKind },
      then: thenInstrs,
      else: [{ op: "local.get", index: tmp } as Instr],
    });
    releaseTempLocal(fctx, tmp);
    return resultKind;
  }

  const rType = rhsType;

  // Unify types: if LHS and RHS have different wasm types, pick a common type
  if (valTypesMatch(resultKind, rType)) {
    // Types match — use as-is
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: resultKind },
      then: thenInstrs,
      else: [{ op: "local.get", index: tmp } as Instr],
    });
    releaseTempLocal(fctx, tmp);
    return resultKind;
  }

  // Types differ — use externref as the unified type when both sides are
  // different types (e.g., struct ref vs f64). This ensures both branches
  // can produce a compatible wasm type. If the RHS is already externref
  // or a ref type, use externref; if both are numeric but different, prefer f64.
  let unifiedType: ValType;
  if (
    rType.kind === "f64" &&
    (resultKind.kind === "externref" || resultKind.kind === "ref" || resultKind.kind === "ref_null")
  ) {
    unifiedType = { kind: "externref" };
  } else {
    unifiedType = rType;
  }

  // Coerce RHS (then branch) to unified type if needed (usually already matches)
  if (!valTypesMatch(rType, unifiedType)) {
    const coerceRhsBody: Instr[] = [];
    fctx.body = coerceRhsBody;
    coerceType(ctx, fctx, rType, unifiedType);
    fctx.body = savedBody;
    thenInstrs = [...thenInstrs, ...coerceRhsBody];
  }

  // Coerce LHS (else branch) to unified type
  const elseInstrs: Instr[] = [{ op: "local.get", index: tmp } as Instr];
  const coerceLhsBody: Instr[] = [];
  fctx.body = coerceLhsBody;
  coerceType(ctx, fctx, resultKind, unifiedType);
  fctx.body = savedBody;
  elseInstrs.push(...coerceLhsBody);

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: unifiedType },
    then: thenInstrs,
    else: elseInstrs,
  });
  releaseTempLocal(fctx, tmp);

  return unifiedType;
}

/**
 * Emit code to sync a parameter local's value into the mapped arguments array (#849).
 * Called after local.tee for parameter assignments in functions with mapped arguments.
 * The expression result is on the stack; we save it, do the sync, then restore it.
 */
function emitMappedArgParamSync(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramIdx: number,
  resultType: ValType,
): void {
  const info = fctx.mappedArgsInfo;
  if (!info) return;
  // Check if this local index corresponds to a mapped parameter
  const argIndex = paramIdx - info.paramOffset;
  if (argIndex < 0 || argIndex >= info.paramCount) return;

  // Save the expression result (currently on stack from local.tee)
  const tmp = allocLocal(fctx, `__arg_sync_${fctx.locals.length}`, resultType);
  fctx.body.push({ op: "local.set", index: tmp });

  // Build coercion instructions for param → externref
  const paramType = info.paramTypes[argIndex]!;
  const coerceInstrs: Instr[] = [];
  if (paramType.kind === "f64") {
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) {
      coerceInstrs.push({ op: "call", funcIdx: boxIdx } as unknown as Instr);
    }
  } else if (paramType.kind === "i32") {
    coerceInstrs.push({ op: "f64.convert_i32_s" } as unknown as Instr);
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) {
      coerceInstrs.push({ op: "call", funcIdx: boxIdx } as unknown as Instr);
    }
  } else if (paramType.kind === "ref" || paramType.kind === "ref_null") {
    coerceInstrs.push({ op: "extern.convert_any" } as unknown as Instr);
  }
  // externref: no coercion needed

  // Sync param value to arguments backing array (null-guarded)
  fctx.body.push({ op: "local.get", index: info.argsLocalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [] as Instr[],
    else: [
      { op: "local.get", index: info.argsLocalIdx } as Instr,
      { op: "struct.get", typeIdx: info.vecTypeIdx, fieldIdx: 1 } as Instr,
      { op: "i32.const", value: argIndex } as Instr,
      { op: "local.get", index: paramIdx } as Instr,
      ...coerceInstrs,
      { op: "array.set", typeIdx: info.arrTypeIdx } as Instr,
    ],
  });

  // Restore expression result
  fctx.body.push({ op: "local.get", index: tmp });
}

/**
 * Emit code to sync an arguments element write back to the parameter local (#849).
 * Called after array.set in compileElementAssignment when target is the arguments object.
 */
function emitMappedArgReverseSync(
  ctx: CodegenContext,
  fctx: FunctionContext,
  idxLocal: number,
  valLocal: number,
): void {
  const info = fctx.mappedArgsInfo;
  if (!info) return;

  // For each mapped parameter, check if the index matches and sync
  for (let i = 0; i < info.paramCount; i++) {
    const paramType = info.paramTypes[i]!;
    const localIdx = i + info.paramOffset;

    // Build instructions to convert externref value to param type
    const convertInstrs: Instr[] = [];
    convertInstrs.push({ op: "local.get", index: valLocal } as Instr);
    if (paramType.kind === "f64") {
      const unboxIdx = ctx.funcMap.get("__unbox_number");
      if (unboxIdx !== undefined) {
        convertInstrs.push({ op: "call", funcIdx: unboxIdx } as unknown as Instr);
      }
    } else if (paramType.kind === "i32") {
      const unboxIdx = ctx.funcMap.get("__unbox_number");
      if (unboxIdx !== undefined) {
        convertInstrs.push({ op: "call", funcIdx: unboxIdx } as unknown as Instr);
      }
      convertInstrs.push({ op: "i32.trunc_sat_f64_s" } as unknown as Instr);
    } else if (paramType.kind === "ref" || paramType.kind === "ref_null") {
      convertInstrs.push({ op: "any.convert_extern" } as unknown as Instr);
      if (paramType.kind === "ref") {
        convertInstrs.push({ op: "ref.cast", typeIdx: (paramType as any).typeIdx } as unknown as Instr);
      }
    }
    // externref → externref: just local.get valLocal (already in convertInstrs)

    fctx.body.push({ op: "local.get", index: idxLocal });
    fctx.body.push({ op: "i32.const", value: i });
    fctx.body.push({ op: "i32.eq" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [...convertInstrs, { op: "local.set", index: localIdx } as Instr],
      else: [] as Instr[],
    });
  }
}

export { emitMappedArgParamSync, emitMappedArgReverseSync };
