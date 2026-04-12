/**
 * Control flow statement lowering: return, if, switch, break, continue, labeled.
 */
import ts from "typescript";
import { isStringType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { popBody, pushBody } from "../context/bodies.js";
import { allocLocal, getLocalType } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { addStringImports, ensureI32Condition, ensureNativeStringHelpers, resolveWasmType } from "../index.js";
import {
  coerceType,
  compileExpression,
  compileStatement,
  ensureAnyHelpers,
  isAnyValue,
  valTypesMatch,
} from "../shared.js";
import { adjustRethrowDepth } from "./shared.js";

function canTailCall(ctx: CodegenContext, fctx: FunctionContext, calleeIdx: number): boolean {
  let calleeTypeIdx: number | undefined;
  if (calleeIdx < ctx.numImportFuncs) {
    // Import function
    const imp = ctx.mod.imports[calleeIdx];
    if (imp?.desc.kind === "func") calleeTypeIdx = imp.desc.typeIdx;
  } else {
    // Local function
    const localIdx = calleeIdx - ctx.numImportFuncs;
    const func = ctx.mod.functions[localIdx];
    if (func) calleeTypeIdx = func.typeIdx;
  }
  if (calleeTypeIdx === undefined) return false;
  const typeDef = ctx.mod.types[calleeTypeIdx];
  if (!typeDef || typeDef.kind !== "func") return false;

  // Parameter count must match — return_call requires the stack to contain
  // exactly the callee's params, so mismatched counts cause "not enough
  // arguments" CE (#822 Work Item 1)
  if (typeDef.params.length !== fctx.params.length) return false;

  // Compare callee results with caller return type
  const calleeResults = typeDef.results;
  if (!fctx.returnType) {
    // Caller is void — callee must also return nothing
    return calleeResults.length === 0;
  }
  // Caller has a return type — callee must return exactly one matching type
  if (calleeResults.length !== 1) return false;
  const calleeRet = calleeResults[0]!;
  const callerRet = fctx.returnType;
  // Exact kind match (we allow ref subtyping — same kind is sufficient)
  if (calleeRet.kind === callerRet.kind) return true;
  // ref/ref_null are compatible for return purposes
  if (
    (calleeRet.kind === "ref" || calleeRet.kind === "ref_null") &&
    (callerRet.kind === "ref" || callerRet.kind === "ref_null")
  )
    return true;
  return false;
}

/**
 * Check if a call_ref with a given type index can be safely converted to return_call_ref.
 */
function canTailCallRef(ctx: CodegenContext, fctx: FunctionContext, typeIdx: number): boolean {
  const typeDef = ctx.mod.types[typeIdx];
  if (!typeDef || typeDef.kind !== "func") return false;

  // Parameter count must match (#822 Work Item 1)
  if (typeDef.params.length !== fctx.params.length) return false;

  const calleeResults = typeDef.results;
  if (!fctx.returnType) return calleeResults.length === 0;
  if (calleeResults.length !== 1) return false;
  const calleeRet = calleeResults[0]!;
  const callerRet = fctx.returnType;
  if (calleeRet.kind === callerRet.kind) return true;
  if (
    (calleeRet.kind === "ref" || calleeRet.kind === "ref_null") &&
    (callerRet.kind === "ref" || callerRet.kind === "ref_null")
  )
    return true;
  return false;
}

export function compileReturnStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.ReturnStatement): void {
  // Inside a generator function, `return expr` should push the return value
  // into the generator buffer (so .next().value sees it), then break out of
  // the body block (not use the wasm `return` opcode, which would skip __create_generator).
  if (fctx.isGenerator) {
    if (stmt.expression) {
      const bufferIdx = fctx.localMap.get("__gen_buffer");
      const resultType = compileExpression(ctx, fctx, stmt.expression);
      if (resultType !== null && bufferIdx !== undefined) {
        // Push the return value into the gen buffer so it appears as the
        // final next() value (#729)
        const tmpLocal = allocLocal(fctx, `__gen_ret_${fctx.locals.length}`, resultType);
        fctx.body.push({ op: "local.set", index: tmpLocal });
        fctx.body.push({ op: "local.get", index: bufferIdx });
        fctx.body.push({ op: "local.get", index: tmpLocal });
        if (resultType.kind === "f64") {
          const pushIdx = ctx.funcMap.get("__gen_push_f64");
          if (pushIdx !== undefined) fctx.body.push({ op: "call", funcIdx: pushIdx });
        } else if (resultType.kind === "i32") {
          const pushIdx = ctx.funcMap.get("__gen_push_i32");
          if (pushIdx !== undefined) fctx.body.push({ op: "call", funcIdx: pushIdx });
        } else {
          const pushIdx = ctx.funcMap.get("__gen_push_ref");
          if (pushIdx !== undefined) fctx.body.push({ op: "call", funcIdx: pushIdx });
        }
      } else if (resultType !== null) {
        fctx.body.push({ op: "drop" });
      }
    }
    // Break out of the generator body block.
    // generatorReturnDepth tracks the correct br depth accounting for
    // nested loops/blocks that wrap the body instructions.
    const genReturnDepth = fctx.generatorReturnDepth ?? fctx.blockDepth;
    fctx.body.push({ op: "br", depth: genReturnDepth });
    return;
  }

  const hasPendingFinally = fctx.finallyStack && fctx.finallyStack.length > 0;

  if (stmt.expression) {
    const exprType = compileExpression(ctx, fctx, stmt.expression, fctx.returnType ?? undefined);
    // Coerce expression result to match function return type if they differ
    if (exprType && fctx.returnType && !valTypesMatch(exprType, fctx.returnType)) {
      coerceType(ctx, fctx, exprType, fctx.returnType);
    }
    // (#585) If the function is void (no return type) but the expression produced
    // a value, drop it — Wasm requires an empty stack before `return` in void funcs.
    if (exprType && !fctx.returnType) {
      fctx.body.push({ op: "drop" });
    }
  } else if (fctx.returnType) {
    // Bare `return;` in a value-returning function — push default value
    if (fctx.returnType.kind === "f64") fctx.body.push({ op: "f64.const", value: 0 });
    else if (fctx.returnType.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
    else if (fctx.returnType.kind === "i64") fctx.body.push({ op: "i64.const", value: 0n });
    else if (fctx.returnType.kind === "externref") fctx.body.push({ op: "ref.null.extern" });
    else if (fctx.returnType.kind === "ref_null") fctx.body.push({ op: "ref.null", typeIdx: fctx.returnType.typeIdx });
    else if (fctx.returnType.kind === "ref") fctx.body.push({ op: "ref.null", typeIdx: fctx.returnType.typeIdx });
  }

  // If inside a try block with a finally clause, save the return value to a
  // temp local, inline the finally instructions, then restore and return.
  // This ensures finally always runs, and if finally contains its own return,
  // that return takes precedence (the subsequent return becomes unreachable).
  if (hasPendingFinally) {
    // Save return value to a temp local (if there is one)
    let retTmpIdx: number | undefined;
    if (fctx.returnType) {
      retTmpIdx = allocLocal(fctx, `__finally_ret_${fctx.locals.length}`, fctx.returnType);
      fctx.body.push({ op: "local.set", index: retTmpIdx });
    }
    // Inline ALL pending finally blocks from innermost to outermost
    for (let i = fctx.finallyStack!.length - 1; i >= 0; i--) {
      fctx.body.push(...fctx.finallyStack![i]!.cloneFinally());
    }
    // Restore return value and emit return
    if (retTmpIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: retTmpIdx });
    }
    fctx.body.push({ op: "return" });
    return;
  }

  // Tail call optimization: if the last instruction is a call or call_ref,
  // replace it with return_call / return_call_ref to eliminate stack growth
  // for recursive and tail-position calls.
  // Guard: only apply when the callee's return type matches the caller's,
  // otherwise return_call produces a type mismatch (e.g., class constructors
  // calling methods with different return types — #839).
  // Tail call optimization: if the last instruction is a call or call_ref,
  // replace it with return_call / return_call_ref to eliminate stack growth
  // for recursive and tail-position calls.
  // Guard: only apply when the callee's return type matches the caller's,
  // otherwise return_call produces a type mismatch (#839).
  const lastInstr = fctx.body[fctx.body.length - 1];
  if (lastInstr && lastInstr.op === "call") {
    const calleeIdx = (lastInstr as any).funcIdx as number;
    if (canTailCall(ctx, fctx, calleeIdx)) {
      (lastInstr as any).op = "return_call";
      return; // return_call implicitly returns — no need for explicit return
    }
  }
  if (lastInstr && lastInstr.op === "call_ref") {
    const typeIdx = (lastInstr as any).typeIdx as number | undefined;
    if (typeIdx !== undefined && canTailCallRef(ctx, fctx, typeIdx)) {
      (lastInstr as any).op = "return_call_ref";
      return;
    }
  }

  fctx.body.push({ op: "return" });
}

/**
 * Detect null-comparison narrowing in an if-condition.
 * Returns the variable name narrowed to non-null and which branch benefits:
 *   - `x !== null` / `x != null` / `null !== x` / `null != x` → narrowed in THEN
 *   - `x === null` / `x == null` / `null === x` / `null == x` → narrowed in ELSE
 * Returns null if the condition is not a null comparison on a simple identifier.
 */
function detectNullNarrowing(expr: ts.Expression): { varName: string; narrowedBranch: "then" | "else" } | null {
  if (!ts.isBinaryExpression(expr)) return null;
  const op = expr.operatorToken.kind;
  const isNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  const isEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
  if (!isNeq && !isEq) return null;

  const rightIsNull =
    expr.right.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(expr.right) && expr.right.text === "undefined");
  const leftIsNull =
    expr.left.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(expr.left) && expr.left.text === "undefined");

  if (!rightIsNull && !leftIsNull) return null;

  const nonNullSide = rightIsNull ? expr.left : expr.right;
  if (!ts.isIdentifier(nonNullSide)) return null;

  return {
    varName: nonNullSide.text,
    narrowedBranch: isNeq ? "then" : "else",
  };
}

/**
 * Detect `typeof x === "string"` / `typeof x === "number"` patterns in if conditions.
 * Returns the variable name, the type literal, and which branch is narrowed.
 */
function detectTypeofNarrowing(
  expr: ts.Expression,
): { varName: string; typeLiteral: string; narrowedBranch: "then" | "else" } | null {
  if (!ts.isBinaryExpression(expr)) return null;
  const op = expr.operatorToken.kind;
  const isEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
  const isNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!isEq && !isNeq) return null;

  let typeofExpr: ts.TypeOfExpression | null = null;
  let stringLiteral: string | null = null;

  if (ts.isTypeOfExpression(expr.left) && ts.isStringLiteral(expr.right)) {
    typeofExpr = expr.left;
    stringLiteral = expr.right.text;
  } else if (ts.isTypeOfExpression(expr.right) && ts.isStringLiteral(expr.left)) {
    typeofExpr = expr.right;
    stringLiteral = expr.left.text;
  }

  if (!typeofExpr || !stringLiteral) return null;

  // Only narrow for simple identifier operands
  const operand = typeofExpr.expression;
  if (!ts.isIdentifier(operand)) return null;

  // Only narrow for "string" and "number" for now
  if (stringLiteral !== "string" && stringLiteral !== "number") return null;

  return {
    varName: operand.text,
    typeLiteral: stringLiteral,
    narrowedBranch: isEq ? "then" : "else",
  };
}

/**
 * Apply typeof narrowing for a branch: allocate a new local of the narrowed type,
 * emit unboxing from the AnyValue local, and remap localMap.
 * Returns the original local index so we can restore it later.
 */
function applyTypeofNarrowing(
  ctx: CodegenContext,
  fctx: FunctionContext,
  varName: string,
  typeLiteral: string,
): { originalLocalIdx: number; narrowedLocalIdx: number } | null {
  const originalLocalIdx = fctx.localMap.get(varName);
  if (originalLocalIdx === undefined) return null;

  // Check that the variable is currently AnyValue typed
  const localType = getLocalType(fctx, originalLocalIdx);
  if (!localType || !isAnyValue(localType, ctx)) return null;

  ensureAnyHelpers(ctx);

  let narrowedType: ValType;
  let unboxHelper: string;

  if (typeLiteral === "number") {
    narrowedType = { kind: "f64" };
    unboxHelper = "__any_unbox_f64";
  } else if (typeLiteral === "string") {
    narrowedType = { kind: "externref" };
    unboxHelper = "__any_unbox_extern";
  } else {
    return null;
  }

  const funcIdx = ctx.funcMap.get(unboxHelper);
  if (funcIdx === undefined) return null;

  // Allocate a new local for the narrowed value
  const narrowedLocalIdx = allocLocal(fctx, `__typeof_${varName}`, narrowedType);

  // Emit unboxing: load original AnyValue, call unbox, store in narrowed local
  fctx.body.push({ op: "local.get", index: originalLocalIdx });
  fctx.body.push({ op: "call", funcIdx });
  fctx.body.push({ op: "local.set", index: narrowedLocalIdx });

  // Remap the variable to use the narrowed local
  fctx.localMap.set(varName, narrowedLocalIdx);

  return { originalLocalIdx, narrowedLocalIdx };
}

export function compileIfStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.IfStatement): void {
  // Detect null-narrowing pattern before compiling the condition
  const narrowing = detectNullNarrowing(stmt.expression);

  // Detect typeof narrowing pattern (typeof x === "string" / "number")
  const typeofNarrowing = detectTypeofNarrowing(stmt.expression);

  // Compile condition
  const condType = compileExpression(ctx, fctx, stmt.expression);
  ensureI32Condition(fctx, condType, ctx);

  // The 'if' instruction adds one label level. Increment break/continue depths
  // so that br instructions emitted inside the if branches target the correct labels.
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth++;
  adjustRethrowDepth(fctx, 1);

  // Save pre-existing narrowed set so we can restore it after each branch
  const savedNarrowedNonNull = fctx.narrowedNonNull ? new Set(fctx.narrowedNonNull) : undefined;

  // Apply narrowing for the then branch
  if (narrowing && narrowing.narrowedBranch === "then") {
    if (!fctx.narrowedNonNull) fctx.narrowedNonNull = new Set();
    fctx.narrowedNonNull.add(narrowing.varName);
  }

  // Compile then branch
  const savedBody = pushBody(fctx);

  // Apply typeof narrowing at start of the appropriate branch
  let typeofNarrowResult: { originalLocalIdx: number; narrowedLocalIdx: number } | null = null;
  if (typeofNarrowing && typeofNarrowing.narrowedBranch === "then") {
    typeofNarrowResult = applyTypeofNarrowing(ctx, fctx, typeofNarrowing.varName, typeofNarrowing.typeLiteral);
  }

  if (ts.isBlock(stmt.thenStatement)) {
    for (const s of stmt.thenStatement.statements) {
      compileStatement(ctx, fctx, s);
    }
  } else {
    compileStatement(ctx, fctx, stmt.thenStatement);
  }
  const thenInstrs = fctx.body;

  // Restore typeof narrowing after then branch
  if (typeofNarrowResult) {
    fctx.localMap.set(typeofNarrowing!.varName, typeofNarrowResult.originalLocalIdx);
  }

  // Restore narrowing before compiling else branch
  fctx.narrowedNonNull = savedNarrowedNonNull ? new Set(savedNarrowedNonNull) : undefined;

  // Apply narrowing for the else branch
  if (narrowing && narrowing.narrowedBranch === "else") {
    if (!fctx.narrowedNonNull) fctx.narrowedNonNull = new Set();
    fctx.narrowedNonNull.add(narrowing.varName);
  }

  // Compile else branch
  let elseInstrs: Instr[] | undefined;
  let typeofNarrowResultElse: { originalLocalIdx: number; narrowedLocalIdx: number } | null = null;
  if (stmt.elseStatement) {
    fctx.body = [];

    // Apply typeof narrowing for else branch
    if (typeofNarrowing && typeofNarrowing.narrowedBranch === "else") {
      typeofNarrowResultElse = applyTypeofNarrowing(ctx, fctx, typeofNarrowing.varName, typeofNarrowing.typeLiteral);
    }

    if (ts.isBlock(stmt.elseStatement)) {
      for (const s of stmt.elseStatement.statements) {
        compileStatement(ctx, fctx, s);
      }
    } else {
      compileStatement(ctx, fctx, stmt.elseStatement);
    }
    elseInstrs = fctx.body;

    // Restore typeof narrowing after else branch
    if (typeofNarrowResultElse) {
      fctx.localMap.set(typeofNarrowing!.varName, typeofNarrowResultElse.originalLocalIdx);
    }
  }

  popBody(fctx, savedBody);

  // Restore original narrowing state (leaving the if block clears narrowing)
  fctx.narrowedNonNull = savedNarrowedNonNull;

  // Restore break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth--;
  adjustRethrowDepth(fctx, -1);

  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: thenInstrs,
    else: elseInstrs,
  });
}

export function compileSwitchStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.SwitchStatement): void {
  // Evaluate the switch expression and save it to a temp local
  const exprType = ctx.checker.getTypeAtLocation(stmt.expression);
  let wasmType = resolveWasmType(ctx, exprType);

  // Detect if the switch discriminant or any case value involves strings (#245).
  // Check both the discriminant type and case expression types, since the
  // discriminant may be `any` while case values are string literals.
  let switchIsString = isStringType(exprType);
  if (!switchIsString) {
    for (const clause of stmt.caseBlock.clauses) {
      if (ts.isCaseClause(clause)) {
        const caseType = ctx.checker.getTypeAtLocation(clause.expression);
        if (isStringType(caseType)) {
          switchIsString = true;
          break;
        }
      }
    }
  }

  // For string switch: use the appropriate string type and comparison
  let strEqFuncIdx: number | undefined;
  if (switchIsString) {
    if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
      // Fast mode: native string comparison
      ensureNativeStringHelpers(ctx);
      const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
      const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
      strEqFuncIdx = equalsIdx;
      wasmType = { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
    } else {
      // Non-fast mode: externref string comparison via wasm:js-string equals
      addStringImports(ctx);
      strEqFuncIdx = ctx.funcMap.get("equals");
      wasmType = { kind: "externref" };
    }
  } else if (wasmType.kind === "externref") {
    // Externref discriminant (non-string): unbox to f64 for numeric comparison
    wasmType = { kind: "f64" };
  }

  const tmpLocalIdx = allocLocal(fctx, `__sw_${fctx.locals.length}`, wasmType);
  compileExpression(ctx, fctx, stmt.expression, wasmType);
  fctx.body.push({ op: "local.set", index: tmpLocalIdx });

  // Use a "target" local to track which clause index to start executing from.
  // Sentinel value = number of clauses means "no match yet".
  const clauses = stmt.caseBlock.clauses;
  const noMatchSentinel = clauses.length;

  const targetLocalIdx = allocLocal(fctx, `__sw_target_${fctx.locals.length}`, { kind: "i32" });
  // Initialize target to sentinel (no match)
  fctx.body.push({ op: "i32.const", value: noMatchSentinel });
  fctx.body.push({ op: "local.set", index: targetLocalIdx });

  // Choose the equality opcode based on the switch expression type
  const eqOp: "f64.eq" | "i32.eq" = wasmType.kind === "i32" ? "i32.eq" : "f64.eq";

  // --- Phase 1: Evaluate all case expressions to find the target clause ---
  // Skip default clauses in this phase; just check case expressions.
  let defaultIdx = -1;
  for (let ci = 0; ci < clauses.length; ci++) {
    const clause = clauses[ci]!;
    if (ts.isDefaultClause(clause)) {
      defaultIdx = ci;
      continue;
    }
    const caseClause = clause as ts.CaseClause;

    // if (target == sentinel) { if (tmp == caseExpr) { target = ci; } }
    // Use pushBody/popBody so the outer body stays reachable for global-index
    // fixups when new string-constant imports are added during case compilation.
    const savedCaseBody = pushBody(fctx);

    fctx.body.push({ op: "local.get", index: tmpLocalIdx });
    if (switchIsString && ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
      const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
      fctx.body.push({ op: "call", funcIdx: flattenIdx });
    }
    compileExpression(ctx, fctx, caseClause.expression, wasmType);
    if (switchIsString && ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
      const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
      fctx.body.push({ op: "call", funcIdx: flattenIdx });
    }
    if (switchIsString && strEqFuncIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: strEqFuncIdx });
    } else {
      fctx.body.push({ op: eqOp });
    }
    // if (comparison result) { target = ci; }
    const setTarget: Instr[] = [
      { op: "i32.const", value: ci },
      { op: "local.set", index: targetLocalIdx },
    ];
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: setTarget,
    });

    const checkBody = fctx.body;
    popBody(fctx, savedCaseBody);

    // Guard: only check if target is still sentinel (no match found yet)
    fctx.body.push({ op: "local.get", index: targetLocalIdx });
    fctx.body.push({ op: "i32.const", value: noMatchSentinel });
    fctx.body.push({ op: "i32.eq" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: checkBody,
    });
  }

  // After checking all cases: if no case matched, fall to default (if present)
  if (defaultIdx >= 0) {
    const setDefault: Instr[] = [
      { op: "i32.const", value: defaultIdx },
      { op: "local.set", index: targetLocalIdx },
    ];
    fctx.body.push({ op: "local.get", index: targetLocalIdx });
    fctx.body.push({ op: "i32.const", value: noMatchSentinel });
    fctx.body.push({ op: "i32.eq" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: setDefault,
    });
  }

  // --- Phase 2: Emit clause bodies with fall-through ---
  // A clause body executes if clauseIndex >= target.
  // We use a "running" local that gets set to 1 once we reach the target
  // and stays 1 for fall-through (until a break resets via br).
  const runningLocalIdx = allocLocal(fctx, `__sw_running_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: runningLocalIdx });

  // Collect instructions for the switch block body
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: block adds 1 nesting level
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth++;
  adjustRethrowDepth(fctx, 1);

  // break from switch => br to outer block (depth 0 from inside the block).
  // Each case body is wrapped in an if (+1 nesting), so break depth = 1.
  const switchBreakIdx = fctx.breakStack.length;
  fctx.breakStack.push(1);

  for (let ci = 0; ci < clauses.length; ci++) {
    const clause = clauses[ci]!;

    // Set running = 1 if this clause is the target
    // if (target == ci) { running = 1; }
    const activateBody: Instr[] = [
      { op: "i32.const", value: 1 },
      { op: "local.set", index: runningLocalIdx },
    ];
    fctx.body.push({ op: "local.get", index: targetLocalIdx });
    fctx.body.push({ op: "i32.const", value: ci });
    fctx.body.push({ op: "i32.eq" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: activateBody,
    });

    // Emit body: if (running) { <statements> }
    // Use pushBody/popBody so the outer body stays reachable for global-index
    // fixups when new string-constant imports are added during case compilation.
    if (clause.statements.length > 0) {
      const savedSwitchBody = pushBody(fctx);

      // Adjust outer entries for the if-wrapping (+1 nesting level).
      for (let i = 0; i < switchBreakIdx; i++) fctx.breakStack[i]!++;
      for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;
      if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth++;
      adjustRethrowDepth(fctx, 1);

      for (const s of clause.statements) {
        compileStatement(ctx, fctx, s);
      }

      // Restore depths after case body compilation
      for (let i = 0; i < switchBreakIdx; i++) fctx.breakStack[i]!--;
      for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
      if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth--;
      adjustRethrowDepth(fctx, -1);

      const bodyInstrs = fctx.body;
      popBody(fctx, savedSwitchBody);

      fctx.body.push({ op: "local.get", index: runningLocalIdx });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: bodyInstrs,
      });
    }
  }

  fctx.breakStack.pop();

  // Restore existing break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth--;
  adjustRethrowDepth(fctx, -1);

  const switchBody = fctx.body;
  popBody(fctx, savedBody);

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: switchBody,
  });
}

/**
 * Destructure a for-of element stored in `elemLocal` into the bindings of a
 * destructuring pattern. Handles both object and array binding patterns with
 * default values.
 */

export function compileLabeledStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.LabeledStatement): void {
  const labelName = stmt.label.text;
  const innerStmt = stmt.statement;

  // If the inner statement is a loop, we just record the label and let the
  // loop push its own break/continue entries. But if the inner statement is
  // a block (e.g. `label: { ... break label; ... }`), we need to wrap it in
  // a Wasm block so that `break label` can exit the entire labeled block.
  const isLoop =
    ts.isWhileStatement(innerStmt) ||
    ts.isDoStatement(innerStmt) ||
    ts.isForStatement(innerStmt) ||
    ts.isForInStatement(innerStmt) ||
    ts.isForOfStatement(innerStmt);

  if (isLoop) {
    // Record the label with the current break/continue stack indices.
    // The inner loop statement will push its own entries, so the label
    // points to the index that will be pushed by the labeled loop.
    const breakIdx = fctx.breakStack.length;
    const continueIdx = fctx.continueStack.length;
    fctx.labelMap.set(labelName, { breakIdx, continueIdx });

    compileStatement(ctx, fctx, innerStmt);

    fctx.labelMap.delete(labelName);
  } else {
    // Non-loop labeled statement: wrap in a Wasm block for break support.
    // Structure:
    //   block $label {
    //     body
    //   }
    const savedBody = pushBody(fctx);

    // Adjust existing break/continue depths: block adds 1 nesting level
    for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
    for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;
    if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth++;
    adjustRethrowDepth(fctx, 1);

    // Push break entry for this labeled block: br 0 exits the block
    const breakIdx = fctx.breakStack.length;
    const continueIdx = fctx.continueStack.length;
    fctx.breakStack.push(0);
    fctx.labelMap.set(labelName, { breakIdx, continueIdx });

    compileStatement(ctx, fctx, innerStmt);

    const bodyInstrs = fctx.body;

    fctx.breakStack.pop();
    fctx.labelMap.delete(labelName);

    // Restore existing break/continue depths
    for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
    for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
    if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth--;
    adjustRethrowDepth(fctx, -1);

    popBody(fctx, savedBody);
    fctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: bodyInstrs,
    });
  }
}

export function compileBreakStatement(_ctx: CodegenContext, fctx: FunctionContext, stmt: ts.BreakStatement): void {
  let breakIdx: number;
  if (stmt.label) {
    const labelName = stmt.label.text;
    const labelInfo = fctx.labelMap.get(labelName);
    if (labelInfo === undefined) return;
    breakIdx = labelInfo.breakIdx;
  } else {
    breakIdx = fctx.breakStack.length - 1;
  }
  const depth = fctx.breakStack[breakIdx];
  if (depth === undefined) return;

  // Inline finally blocks for any try-with-finally that we're breaking out of.
  // A finallyStack entry applies if the break target is outside the try block,
  // i.e. the breakStack index we're targeting is less than the entry's breakStackLen.
  if (fctx.finallyStack) {
    for (let i = fctx.finallyStack.length - 1; i >= 0; i--) {
      const entry = fctx.finallyStack[i]!;
      if (breakIdx < entry.breakStackLen) {
        fctx.body.push(...entry.cloneFinally());
      }
    }
  }

  fctx.body.push({ op: "br", depth });
}

export function compileContinueStatement(
  _ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ContinueStatement,
): void {
  let contIdx: number;
  if (stmt.label) {
    const labelName = stmt.label.text;
    const labelInfo = fctx.labelMap.get(labelName);
    if (labelInfo === undefined) return;
    contIdx = labelInfo.continueIdx;
  } else {
    contIdx = fctx.continueStack.length - 1;
  }
  const depth = fctx.continueStack[contIdx];
  if (depth === undefined) return;

  // Inline finally blocks for any try-with-finally that we're continuing out of.
  if (fctx.finallyStack) {
    for (let i = fctx.finallyStack.length - 1; i >= 0; i--) {
      const entry = fctx.finallyStack[i]!;
      if (contIdx < entry.continueStackLen) {
        fctx.body.push(...entry.cloneFinally());
      }
    }
  }

  fctx.body.push({ op: "br", depth });
}
