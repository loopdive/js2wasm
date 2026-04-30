// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Function body compilation — compileFunctionBody and call-site inlining helpers.
 *
 * Extracted from codegen/index.ts (#1013).
 */
import ts from "typescript";
import { isVoidType, unwrapPromiseType } from "../checker/type-mapper.js";
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import { popBody, pushBody } from "./context/bodies.js";
import { reportError } from "./context/errors.js";
import { allocLocal, deduplicateLocals } from "./context/locals.js";
import { attachSourcePos, getSourcePos } from "./context/source-pos.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import {
  buildDestructureNullThrow,
  destructureParamArray,
  destructureParamObject,
  isNullOrUndefinedLiteral,
} from "./destructuring-params.js";
import {
  cacheStringLiterals,
  hasAsyncModifier,
  hoistLetConstWithTdz,
  hoistVarDeclarations,
  resolveWasmType,
} from "./index.js";
import { ensureExnTag } from "./registry/imports.js";
import { getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import {
  coerceType,
  compileExpression,
  compileStatement,
  ensureLateImport,
  flushLateImportShifts,
  hoistFunctionDeclarations,
  valTypesMatch,
} from "./shared.js";
import { emitArgumentsVecBody } from "./statements/nested-declarations.js";
import { bodyUsesArguments } from "./helpers/body-uses-arguments.js";
import { detectStringBuilders } from "./string-builder.js";

/** Maximum number of instructions for a function body to be considered inlinable */
export const INLINE_MAX_INSTRS = 10;

/** Set of instruction ops that disqualify a function body from inlining */
export const INLINE_DISALLOWED_OPS = new Set([
  "block",
  "loop",
  "if",
  "br",
  "br_if",
  "try",
  "throw",
  "rethrow",
  "unreachable",
  "call",
  "call_ref",
  "call_indirect",
  "return_call",
  "return_call_ref",
  "local.set",
  "local.tee",
]);

/**
 * #1120: Detect locals that should be allocated as `i32` instead of `f64`
 * because every value flowing through them is constrained to a 32-bit
 * signed integer by explicit `| 0` (or other bitwise) coercion.
 *
 * The classic pattern, from the iterative Fibonacci benchmark, is:
 *
 *     let a = 0;
 *     let b = 1;
 *     for (let i = 0; i < n; i++) {
 *       const next = (a + b) | 0;   // every write is ToInt32-coerced
 *       a = b;
 *       b = next;
 *     }
 *
 * Each of `a`, `b`, and `next` only ever holds an int32, so allocating
 * them as f64 forces the compiler into a heavy `f64 -> ToInt32 -> f64`
 * round-trip on every iteration. By proving they are i32 we let the
 * binary-op layer collapse the loop body to native i32 arithmetic.
 *
 * Detection rules (conservative; any rule failing leaves the local as f64):
 *   1. Declared via `let` or `const` (not `var`, not module-global, not param).
 *   2. Initializer is i32-safe (see `isI32SafeExpr`).
 *   3. Every assignment / compound-assignment / increment/decrement to the
 *      local also produces an i32-safe value.
 *
 * The set is fixpoint-iterated because membership of one local can depend
 * on membership of another (e.g. `a = b; b = next;` requires all three
 * to reach the i32 set together).
 */
export function collectI32CoercedLocals(decl: ts.FunctionLikeDeclaration): Set<string> {
  const i32Set = new Set<string>();
  if (!decl.body || !ts.isBlock(decl.body)) return i32Set;

  // Map of candidate name -> initializer + every later mutation
  type Mutation =
    | { kind: "init"; expr: ts.Expression | undefined }
    | { kind: "assign"; expr: ts.Expression }
    | { kind: "compound"; op: ts.SyntaxKind; rhs: ts.Expression }
    | { kind: "incdec" };
  const candidates = new Map<string, Mutation[]>();
  // Names of for-loop counters that the existing detectI32LoopVar already
  // promotes (see statements/loops.ts). We respect those by adding them
  // to i32Set unconditionally so other locals can depend on them.
  const forCounterCandidates = new Set<string>();

  function recordCandidate(name: string, m: Mutation): void {
    let list = candidates.get(name);
    if (!list) {
      list = [];
      candidates.set(name, list);
    }
    list.push(m);
  }

  // Names declared more than once across the function body. Shadowing
  // (e.g. an outer `let y = 2` and a block-scoped `let y`) breaks our
  // by-name candidate model: the hoisting pre-pass and the per-scope
  // codegen would see different types for the same name. Drop these
  // names entirely to keep correctness.
  const shadowedNames = new Set<string>();

  // Pass 1: collect declarations
  function collectDecls(node: ts.Node): void {
    // Skip nested functions — their locals are independent
    if (
      node !== decl &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isAccessor(node) ||
        ts.isConstructorDeclaration(node))
    ) {
      return;
    }
    if (ts.isVariableStatement(node)) {
      const isLetConst = (node.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
      if (isLetConst) {
        for (const v of node.declarationList.declarations) {
          if (ts.isIdentifier(v.name)) {
            const nm = v.name.text;
            if (candidates.has(nm)) {
              shadowedNames.add(nm);
            } else {
              recordCandidate(nm, { kind: "init", expr: v.initializer });
            }
          }
        }
      }
    } else if (ts.isForStatement(node) && node.initializer && ts.isVariableDeclarationList(node.initializer)) {
      const isLetConst = (node.initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
      if (isLetConst) {
        for (const v of node.initializer.declarations) {
          if (ts.isIdentifier(v.name) && v.initializer && ts.isNumericLiteral(v.initializer)) {
            // Loop counter pattern — mark the existing i32 promotion as known.
            const init = Number(v.initializer.text.replace(/_/g, ""));
            if (Number.isInteger(init) && init >= -2147483648 && init <= 2147483647) {
              forCounterCandidates.add(v.name.text);
            }
          }
        }
      }
    }
    ts.forEachChild(node, collectDecls);
  }
  ts.forEachChild(decl.body, collectDecls);

  // Drop shadowed names — they are not safe to promote because the
  // hoist/codegen split would see two scopes with the same name.
  for (const nm of shadowedNames) candidates.delete(nm);

  if (candidates.size === 0 && forCounterCandidates.size === 0) return i32Set;

  // Disqualifications: any candidate whose write we cannot prove i32-safe
  // — destructuring assignment, for-of/for-in iteration, etc.
  const disqualified = new Set<string>();

  /** Walk an AssignmentTarget (LHS of `[…] = …` / `{…} = …`) and disqualify
   * every candidate identifier inside. Destructuring writes opaque
   * element/property values that we cannot structurally prove to fit in
   * int32. */
  function disqualifyFromTarget(target: ts.Expression): void {
    if (ts.isParenthesizedExpression(target)) {
      disqualifyFromTarget(target.expression);
      return;
    }
    if (ts.isIdentifier(target)) {
      if (candidates.has(target.text)) disqualified.add(target.text);
      return;
    }
    if (ts.isArrayLiteralExpression(target)) {
      for (const el of target.elements) {
        if (ts.isOmittedExpression(el)) continue;
        if (ts.isSpreadElement(el)) {
          disqualifyFromTarget(el.expression);
          continue;
        }
        if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          // target with default: `[a = 0] = ...`
          disqualifyFromTarget(el.left);
          continue;
        }
        disqualifyFromTarget(el);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(target)) {
      for (const prop of target.properties) {
        if (ts.isPropertyAssignment(prop)) {
          disqualifyFromTarget(prop.initializer);
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          if (candidates.has(prop.name.text)) disqualified.add(prop.name.text);
        } else if (ts.isSpreadAssignment(prop)) {
          disqualifyFromTarget(prop.expression);
        }
      }
      return;
    }
    // PropertyAccessExpression / ElementAccessExpression: the assignment
    // is into a member, not into a candidate identifier itself.
  }

  // Pass 1.5: scan nested functions for any reference to a candidate.
  // If a candidate is captured by a nested function (regular function /
  // function-expression / arrow / method / accessor / constructor), the
  // closure-construction code uses the candidate's *current* declared
  // type to build the capture struct. Promoting the local to i32
  // afterwards would not retroactively rewrite the read sites inside
  // those nested closures, leading to mid-expression i32 reads in an
  // f64 numeric context — Wasm validation failure (see #1120 regress
  // cases like the `for await` test where a let in the wrapper is
  // captured by an inner async function).
  function collectCaptures(node: ts.Node, insideNested: boolean): void {
    if (
      node !== decl &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isAccessor(node) ||
        ts.isConstructorDeclaration(node))
    ) {
      // Descend, but mark all identifier references inside as "captured".
      ts.forEachChild(node, (child) => collectCaptures(child, true));
      return;
    }
    if (insideNested && ts.isIdentifier(node) && candidates.has(node.text)) {
      disqualified.add(node.text);
    }
    ts.forEachChild(node, (child) => collectCaptures(child, insideNested));
  }
  ts.forEachChild(decl.body, (child) => collectCaptures(child, false));

  // Pass 2: collect every mutation of each candidate
  function collectMutations(node: ts.Node): void {
    if (
      node !== decl &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isAccessor(node) ||
        ts.isConstructorDeclaration(node))
    ) {
      return;
    }

    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      // Destructuring assignment: LHS is an array/object literal pattern.
      if (
        op === ts.SyntaxKind.EqualsToken &&
        (ts.isArrayLiteralExpression(node.left) || ts.isObjectLiteralExpression(node.left))
      ) {
        disqualifyFromTarget(node.left);
      } else if (ts.isIdentifier(node.left)) {
        const name = node.left.text;
        if (op === ts.SyntaxKind.EqualsToken && candidates.has(name)) {
          recordCandidate(name, { kind: "assign", expr: node.right });
        } else if (
          candidates.has(name) &&
          (op === ts.SyntaxKind.PlusEqualsToken ||
            op === ts.SyntaxKind.MinusEqualsToken ||
            op === ts.SyntaxKind.AsteriskEqualsToken ||
            op === ts.SyntaxKind.AmpersandEqualsToken ||
            op === ts.SyntaxKind.BarEqualsToken ||
            op === ts.SyntaxKind.CaretEqualsToken ||
            op === ts.SyntaxKind.LessThanLessThanEqualsToken ||
            op === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
            op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken)
        ) {
          recordCandidate(name, { kind: "compound", op, rhs: node.right });
        }
      }
    }
    // for-of / for-in: writes into the loop variable each iteration with
    // an opaque element/key value. Disqualify any candidate written this
    // way. (For `for (let x of …)` x is a fresh let-decl; not a previously
    // collected candidate.)
    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      const init = node.initializer;
      if (init && ts.isIdentifier(init) && candidates.has(init.text)) {
        disqualified.add(init.text);
      }
      if (init && (ts.isArrayLiteralExpression(init) || ts.isObjectLiteralExpression(init))) {
        disqualifyFromTarget(init);
      }
    }
    if (
      (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand) &&
      candidates.has(node.operand.text)
    ) {
      recordCandidate(node.operand.text, { kind: "incdec" });
    }
    ts.forEachChild(node, collectMutations);
  }
  ts.forEachChild(decl.body, collectMutations);

  // Drop disqualified candidates so they cannot be promoted.
  for (const name of disqualified) {
    candidates.delete(name);
  }

  /**
   * Returns true iff `expr` evaluates to a value whose ToInt32 coercion
   * would be the identity — i.e. the value is already representable as
   * a signed 32-bit integer. This is what lets us promote the receiving
   * local to i32 without changing the program's observable values.
   *
   * Recognised i32-safe forms:
   *   • integer-literal in the i32 range
   *   • a reference to another candidate that is currently in `i32Set`
   *   • a reference to a known for-loop counter (already i32 in codegen)
   *   • any bitwise binary op (`|`, `&`, `^`, `<<`, `>>`, `>>>`) — by
   *     definition produces an int32
   *   • any comparison op (`<`, `<=`, `>`, `>=`) — produces a boolean
   *     (i32 0/1)
   *   • `+`, `-`, `*` of two i32-safe operands (overflow wrap is OK
   *     because the receiving local is i32 and any consumer that
   *     expects f64 will use coerceType to widen)
   *   • unary `-`/`+`/`~` of an i32-safe operand
   *   • a parenthesised / `as`-cast / non-null-asserted i32-safe expr
   */
  // Depth guard: identical to the one in inferNumericReturnTypes — if a
  // candidate's initializer / mutation tree is deeper than this, we
  // conservatively treat it as not-safe rather than recursing further.
  const MAX_I32_SAFE_DEPTH = 64;
  function isI32SafeExpr(expr: ts.Expression | undefined, depth = 0): boolean {
    if (depth > MAX_I32_SAFE_DEPTH) return false;
    if (!expr) return true; // no initializer → 0 (which is i32)
    if (ts.isParenthesizedExpression(expr)) return isI32SafeExpr(expr.expression, depth + 1);
    if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr) || ts.isNonNullExpression(expr)) {
      return isI32SafeExpr(expr.expression, depth + 1);
    }
    if (ts.isNumericLiteral(expr)) {
      const v = Number(expr.text.replace(/_/g, ""));
      return Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
    }
    if (ts.isPrefixUnaryExpression(expr)) {
      const o = expr.operator;
      if (o === ts.SyntaxKind.MinusToken || o === ts.SyntaxKind.PlusToken || o === ts.SyntaxKind.TildeToken) {
        return isI32SafeExpr(expr.operand, depth + 1);
      }
      if (o === ts.SyntaxKind.PlusPlusToken || o === ts.SyntaxKind.MinusMinusToken) {
        return (
          ts.isIdentifier(expr.operand) &&
          (i32Set.has(expr.operand.text) || forCounterCandidates.has(expr.operand.text))
        );
      }
      return false;
    }
    if (ts.isPostfixUnaryExpression(expr)) {
      // x++ / x-- as expression (rare): rely on the operand being i32-safe
      return (
        ts.isIdentifier(expr.operand) && (i32Set.has(expr.operand.text) || forCounterCandidates.has(expr.operand.text))
      );
    }
    if (ts.isIdentifier(expr)) {
      return i32Set.has(expr.text) || forCounterCandidates.has(expr.text);
    }
    if (ts.isBinaryExpression(expr)) {
      const o = expr.operatorToken.kind;
      // Bitwise / shift always produce int32 (signed for all but `>>>` —
      // see #1120 follow-up: `>>>` returns uint32 which can sit above
      // 2^31, so when the receiving local is consumed as f64 the i32
      // promotion would change the observable value. Conservatively
      // exclude `>>>`.
      if (
        o === ts.SyntaxKind.BarToken ||
        o === ts.SyntaxKind.AmpersandToken ||
        o === ts.SyntaxKind.CaretToken ||
        o === ts.SyntaxKind.LessThanLessThanToken ||
        o === ts.SyntaxKind.GreaterThanGreaterThanToken
      ) {
        return true;
      }
      // Comparison → boolean (i32)
      if (
        o === ts.SyntaxKind.LessThanToken ||
        o === ts.SyntaxKind.LessThanEqualsToken ||
        o === ts.SyntaxKind.GreaterThanToken ||
        o === ts.SyntaxKind.GreaterThanEqualsToken
      ) {
        return true;
      }
      // Add/sub/mul: safe if both operands are i32-safe
      if (o === ts.SyntaxKind.PlusToken || o === ts.SyntaxKind.MinusToken || o === ts.SyntaxKind.AsteriskToken) {
        return isI32SafeExpr(expr.left, depth + 1) && isI32SafeExpr(expr.right, depth + 1);
      }
      return false;
    }
    return false;
  }

  /** Compound assignment is i32-safe if RHS is i32-safe (the result wraps to int32 in JS for bitwise/shift compounds, and for +=/-=/*= it requires the local to stay int32 for both the read and the write). */
  function isCompoundI32Safe(op: ts.SyntaxKind, rhs: ts.Expression): boolean {
    // Bitwise compound: always i32
    if (
      op === ts.SyntaxKind.AmpersandEqualsToken ||
      op === ts.SyntaxKind.BarEqualsToken ||
      op === ts.SyntaxKind.CaretEqualsToken ||
      op === ts.SyntaxKind.LessThanLessThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken
    ) {
      return true;
    }
    // Arithmetic compound: needs i32-safe RHS
    if (
      op === ts.SyntaxKind.PlusEqualsToken ||
      op === ts.SyntaxKind.MinusEqualsToken ||
      op === ts.SyntaxKind.AsteriskEqualsToken
    ) {
      return isI32SafeExpr(rhs);
    }
    return false;
  }

  // Initial set: every candidate goes in. We then iteratively remove any
  // that fail the safety check until the set stops shrinking.
  for (const name of candidates.keys()) i32Set.add(name);

  let changed = true;
  let safety = candidates.size + 2;
  while (changed && safety-- > 0) {
    changed = false;
    for (const [name, muts] of candidates) {
      if (!i32Set.has(name)) continue;
      let safe = true;
      for (const m of muts) {
        if (m.kind === "init") {
          if (!isI32SafeExpr(m.expr)) {
            safe = false;
            break;
          }
        } else if (m.kind === "assign") {
          if (!isI32SafeExpr(m.expr)) {
            safe = false;
            break;
          }
        } else if (m.kind === "compound") {
          if (!isCompoundI32Safe(m.op, m.rhs)) {
            safe = false;
            break;
          }
        }
        // incdec is always i32-safe (operand is the local itself, already a candidate)
      }
      if (!safe) {
        i32Set.delete(name);
        changed = true;
      }
    }
  }

  return i32Set;
}

/**
 * After compiling a function, check if it is eligible for call-site inlining.
 * Criteria:
 * - Body has <= INLINE_MAX_INSTRS instructions
 * - No control flow, calls, or local mutations
 * - No extra locals beyond parameters
 * - Not a rest-param or capture function
 */
export function registerInlinableFunction(ctx: CodegenContext, funcName: string, func: WasmFunction): void {
  // Skip functions with rest params or captures
  if (ctx.funcRestParams.has(funcName)) return;
  if (ctx.nestedFuncCaptures.has(funcName)) return;

  const body = func.body;
  if (body.length === 0 || body.length > INLINE_MAX_INSTRS) return;

  // Filter out nop instructions (source position markers)
  const realBody = body.filter((instr) => instr.op !== "nop");
  if (realBody.length === 0 || realBody.length > INLINE_MAX_INSTRS) return;

  // Allow expression-shaped functions to end in a single trailing return.
  const normalizedBody =
    realBody.length > 0 && realBody[realBody.length - 1]?.op === "return" ? realBody.slice(0, -1) : realBody;
  if (normalizedBody.length === 0 || normalizedBody.length > INLINE_MAX_INSTRS) return;

  // Get param count from type definition
  const funcType = ctx.mod.types[func.typeIdx];
  if (!funcType || funcType.kind !== "func") return;
  const paramCount = funcType.params.length;

  // No extra locals beyond params
  if (func.locals.length > 0) return;

  // Check all instructions are safe to inline
  for (const instr of normalizedBody) {
    if (INLINE_DISALLOWED_OPS.has(instr.op)) return;

    // local.get must reference params only (index < paramCount)
    if (instr.op === "local.get") {
      if ((instr as any).index >= paramCount) return;
    }
  }

  // Determine return type from function type
  const returnType = funcType.results.length > 0 ? funcType.results[0]! : null;

  ctx.inlinableFunctions.set(funcName, {
    body: normalizedBody,
    paramCount,
    paramTypes: funcType.params.slice(),
    returnType,
  });
}
export function compileFunctionBody(ctx: CodegenContext, decl: ts.FunctionDeclaration, func: WasmFunction): void {
  const sig = ctx.checker.getSignatureFromDeclaration(decl);
  if (!sig) {
    reportError(ctx, decl, `Cannot resolve signature for function '${func.name}'`);
    return;
  }
  const retType = ctx.checker.getReturnTypeOfSignature(sig);

  // For async functions, unwrap Promise<T> to get T
  const isAsync = ctx.asyncFunctions.has(func.name);
  const isGenerator = ctx.generatorFunctions.has(func.name);
  const effectiveRetType = isAsync ? unwrapPromiseType(retType, ctx.checker) : retType;

  // Use call-site resolved types for generic functions
  const resolved = ctx.genericResolved.get(func.name);

  const restInfo = ctx.funcRestParams.get(func.name);
  const params: { name: string; type: ValType }[] = [];
  for (let i = 0; i < decl.parameters.length; i++) {
    const param = decl.parameters[i]!;
    const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${i}`;
    if (restInfo && i === restInfo.restIndex) {
      // Rest parameter — use the vec struct ref type from the function signature
      params.push({
        name: paramName,
        type: { kind: "ref_null", typeIdx: restInfo.vecTypeIdx },
      });
    } else {
      // Prefer the type already established in the function signature (which
      // may have been inferred from call sites for untyped params).
      const funcType = ctx.mod.types[func.typeIdx];
      const sigParamType = funcType?.kind === "func" ? funcType.params[i] : undefined;
      const paramType =
        resolved?.params[i] ?? sigParamType ?? resolveWasmType(ctx, ctx.checker.getTypeAtLocation(param));
      params.push({ name: paramName, type: paramType });
    }
  }

  let returnType: ValType | null;
  if (isGenerator) {
    // Generator functions return externref (JS Generator object)
    returnType = { kind: "externref" };
  } else if (resolved) {
    returnType = resolved.results.length > 0 ? (resolved.results[0] ?? null) : null;
  } else {
    // Prefer the return type already established in the registered function
    // signature — collectDeclarations may have promoted an implicit-any return
    // to f64 via #1121's numericReturnTypes inference, and the body must
    // match that signature exactly to keep recursive call sites consistent.
    const funcType = ctx.mod.types[func.typeIdx];
    const sigResultType = funcType?.kind === "func" && funcType.results.length > 0 ? funcType.results[0] : undefined;
    if (sigResultType) {
      returnType = sigResultType;
    } else {
      returnType = isVoidType(effectiveRetType) ? null : resolveWasmType(ctx, effectiveRetType);
    }
  }

  // #1120: detect locals that should be promoted to i32 because every
  // value flowing through them is constrained to int32 by `| 0` coercion.
  const i32CoercedLocals = collectI32CoercedLocals(decl);

  const fctx: FunctionContext = {
    name: func.name,
    params,
    locals: [],
    localMap: new Map(),
    returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
    isGenerator,
    i32CoercedLocals: i32CoercedLocals.size > 0 ? i32CoercedLocals : undefined,
  };

  // Register params as locals
  for (let i = 0; i < params.length; i++) {
    fctx.localMap.set(params[i]!.name, i);
  }

  ctx.currentFunc = fctx;

  // Mark function entry with source position
  const funcPos = getSourcePos(ctx, decl);
  if (funcPos) {
    const nop: Instr = { op: "nop" };
    attachSourcePos(nop, funcPos);
    fctx.body.push(nop);
  }

  // Emit default-value initialization for parameters with initializers.
  // For params with constant defaults (#869), the caller already inlined the value,
  // so we skip the check. For expression defaults, check if the caller sent a sentinel.
  const funcOptInfo = ctx.funcOptionalParams.get(func.name);
  for (let i = 0; i < decl.parameters.length; i++) {
    const param = decl.parameters[i]!;
    if (!param.initializer) continue;

    // Skip callee-side check for constant defaults — caller inlined the value (#869)
    const optEntry = funcOptInfo?.find((o) => o.index === i);
    if (optEntry?.constantDefault) continue;

    const paramIdx = i;
    const paramType = params[i]!.type;

    // Pre-ensure `__extern_is_undefined` before the initializer is compiled so
    // any late-import funcIdx shift happens while `fctx.body` (not the soon-to-
    // be-detached `thenInstrs`) is authoritative. Otherwise, a shift triggered
    // later by the check emission would miss `thenInstrs`, leaving stale
    // funcIdx values in its `call` ops.
    if (paramType.kind === "externref") {
      ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
      flushLateImportShifts(ctx, fctx);
    }

    // Per spec §14.3.3.1/§8.4.2: destructuring null/undefined must throw TypeError.
    // If the parameter uses a binding pattern and the default is a literal null/undefined,
    // then when the default fires (arg omitted) we must throw — emit throw in the then-block
    // instead of assigning the default. The destructuring step on explicit values still
    // runs normally (and its own guard handles explicit null/undefined).
    const dstrNullDefault =
      (ts.isObjectBindingPattern(param.name) || ts.isArrayBindingPattern(param.name)) &&
      isNullOrUndefinedLiteral(param.initializer);

    // Build the "then" block: compile default expression, local.set
    const savedBody = pushBody(fctx);
    if (dstrNullDefault) {
      for (const ins of buildDestructureNullThrow(ctx, fctx)) fctx.body.push(ins);
    } else {
      // For destructuring patterns with externref param, force array literals in the
      // default to compile as vec structs (not tuples). TS contextual type from the
      // binding pattern gives a tuple, but the destructure path can't convert tuple
      // externrefs back to vec — they miss ref.test on every known vec type and the
      // __extern_length fallback returns 0, causing array.copy traps for rest elements.
      const isArrayPatternExternref = ts.isArrayBindingPattern(param.name) && paramType.kind === "externref";
      const prevForceVec = (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec;
      if (isArrayPatternExternref) {
        (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec = true;
      }
      let defaultResultType: ValType | null;
      try {
        defaultResultType = compileExpression(ctx, fctx, param.initializer, paramType);
      } finally {
        if (isArrayPatternExternref) {
          (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec = prevForceVec;
        }
      }
      // Coerce if the default expression produced a different type than the param
      if (defaultResultType && !valTypesMatch(defaultResultType, paramType)) {
        coerceType(ctx, fctx, defaultResultType, paramType);
      }
      fctx.body.push({ op: "local.set", index: paramIdx });
    }
    const thenInstrs = fctx.body;
    popBody(fctx, savedBody);

    // Emit the null/zero check + conditional assignment
    if (paramType.kind === "externref") {
      // Per JS spec, parameter defaults fire ONLY when the arg is `undefined`
      // (omitted or explicit), never for `null`. At the Wasm layer, JS null
      // maps to ref.null.extern (ref.is_null=1) while JS undefined is a non-
      // null externref wrapping the JS undefined value. Omitted args are padded
      // by callers with `__get_undefined()` (externref-wrapped undefined), so
      // `__extern_is_undefined` catches both "omitted" and "explicit undefined".
      // Using `ref.is_null` in addition would wrongly fire the default when the
      // caller passed explicit `null` (#1025 / #1021).
      const undefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
      flushLateImportShifts(ctx, fctx);
      fctx.body.push({ op: "local.get", index: paramIdx });
      if (undefIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: undefIdx } as Instr);
      } else {
        // Fallback (standalone mode): ref.is_null is imprecise — treats null
        // as undefined. Preserves pre-#737 behavior when the host import can't
        // be registered.
        fctx.body.push({ op: "ref.is_null" });
      }
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: thenInstrs,
      });
    } else if (paramType.kind === "ref_null" || paramType.kind === "ref") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: thenInstrs,
      });
    } else if (paramType.kind === "i32") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "i32.eqz" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: thenInstrs,
      });
    } else if (paramType.kind === "f64") {
      // Check if the f64 param holds the sentinel sNaN bit pattern (#866).
      // This distinguishes missing args from explicit NaN/0/any other value.
      // Sentinel: 0x7FF00000DEADC0DE (emitted by pushParamSentinel).
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "i64.reinterpret_f64" } as unknown as Instr);
      fctx.body.push({ op: "i64.const", value: 0x7ff00000deadc0den } as unknown as Instr);
      fctx.body.push({ op: "i64.eq" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: thenInstrs,
      });
    }
  }

  // Destructure parameters with binding patterns.
  // When a parameter is declared as e.g. function([x, y, z]) or function({a, b}),
  // the parameter is received as a single value (vec struct or struct ref) and
  // we need to extract the individual bindings into separate locals.
  for (let i = 0; i < decl.parameters.length; i++) {
    const param = decl.parameters[i]!;
    if (ts.isObjectBindingPattern(param.name)) {
      destructureParamObject(ctx, fctx, i, param.name, params[i]!.type);
    } else if (ts.isArrayBindingPattern(param.name)) {
      destructureParamArray(ctx, fctx, i, param.name, params[i]!.type);
    }
  }

  // Set up `arguments` object if the function body references it.
  // We create a vec struct (same as Array) populated from all function parameters.
  // Use externref elements so that all parameter types (numbers, strings, objects)
  // are preserved — matching the closure version in closures.ts (#771).
  if (decl.body && bodyUsesArguments(decl.body)) {
    // Ensure __box_number and __unbox_number are available for mapped arguments sync
    const hasNumericParam = params.some((p) => p.type.kind === "f64" || p.type.kind === "i32");
    if (hasNumericParam) {
      ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
      flushLateImportShifts(ctx, fctx);
    }

    const elemType: ValType = { kind: "externref" };
    const vecTypeIdx = getOrRegisterVecType(ctx, "externref", elemType);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    const vecRef: ValType = { kind: "ref", typeIdx: vecTypeIdx };

    const argsLocal = allocLocal(fctx, "arguments", vecRef);
    const arrTmp = allocLocal(fctx, "__args_arr_tmp", { kind: "ref", typeIdx: arrTypeIdx });

    // Check if all params are simple identifiers (not destructuring patterns).
    // Mapped arguments only applies to simple parameter lists in non-strict mode.
    const allSimpleParams = decl.parameters.every((p) => ts.isIdentifier(p.name) && !p.dotDotDotToken);

    // Set up mapped arguments info for param ↔ arguments sync (#849)
    if (allSimpleParams && params.length > 0) {
      fctx.mappedArgsInfo = {
        argsLocalIdx: argsLocal,
        arrTypeIdx,
        vecTypeIdx,
        paramCount: params.length,
        paramOffset: 0,
        paramTypes: params.map((p) => p.type),
      };
    }

    // Build the arguments vec by concatenating formal params with
    // extras delivered via the __extras_argv global (#1053).
    emitArgumentsVecBody(
      ctx,
      fctx,
      params.map((p) => p.type),
      0,
      { vecTypeIdx, arrTypeIdx, argsLocalIdx: argsLocal, arrTmpIdx: arrTmp },
    );
  }

  if (isGenerator) {
    // Generator function: eagerly evaluate body, collect yields into a JS array,
    // then wrap it with __create_generator to return a Generator-like object.
    // Body is wrapped in try/catch to defer thrown exceptions to first next() (#928).
    const bufferLocal = allocLocal(fctx, "__gen_buffer", { kind: "externref" });
    const pendingThrowLocal = allocLocal(fctx, "__gen_pending_throw", { kind: "externref" });

    // Create buffer: __gen_buffer = __gen_create_buffer()
    const createBufIdx = ctx.funcMap.get("__gen_create_buffer")!;
    fctx.body.push({ op: "call", funcIdx: createBufIdx });
    fctx.body.push({ op: "local.set", index: bufferLocal });
    fctx.body.push({ op: "ref.null.extern" } as unknown as Instr);
    fctx.body.push({ op: "local.set", index: pendingThrowLocal });

    // Wrap the generator body in a block so that `return` statements inside
    // the body can `br` out to the generator creation code instead of
    // using the wasm `return` opcode (which would skip __create_generator).
    // Use pushBody/popBody so the outer body stays reachable for global-index
    // fixups when new string-constant imports are added during body compilation.
    const savedGenBody = pushBody(fctx);

    // Set generator return depth for correct `br` depth in nested contexts
    fctx.generatorReturnDepth = 0;

    // Push a block label level so return can break out
    fctx.blockDepth++;
    for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
    for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;

    if (decl.body) {
      hoistVarDeclarations(ctx, fctx, decl.body.statements);
      hoistLetConstWithTdz(ctx, fctx, decl.body.statements);
      hoistFunctionDeclarations(ctx, fctx, decl.body.statements);
      for (const stmt of decl.body.statements) {
        compileStatement(ctx, fctx, stmt);
      }
    }

    fctx.blockDepth--;
    for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
    for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
    fctx.generatorReturnDepth = undefined;

    // Restore outer body and wrap compiled body in a try/catch(block)
    const bodyInstrs = fctx.body;
    popBody(fctx, savedGenBody);

    // Wrap generator body block in try/catch to capture exceptions as pending throw
    const tagIdx = ensureExnTag(ctx);
    const getCaughtIdx = ctx.funcMap.get("__get_caught_exception");
    const catchBody: Instr[] = [{ op: "local.set", index: pendingThrowLocal } as unknown as Instr];
    const catchAllBody: Instr[] =
      getCaughtIdx !== undefined
        ? [
            { op: "call", funcIdx: getCaughtIdx } as Instr,
            { op: "local.set", index: pendingThrowLocal } as unknown as Instr,
          ]
        : [];
    fctx.body.push({
      op: "try",
      blockType: { kind: "empty" },
      body: [{ op: "block", blockType: { kind: "empty" }, body: bodyInstrs }],
      catches: [{ tagIdx, body: catchBody }],
      catchAll: catchAllBody.length > 0 ? catchAllBody : undefined,
    } as unknown as Instr);

    // Return __create_generator or __create_async_generator depending on async flag.
    // Note: ctx.asyncFunctions excludes async generators (by design), so we check
    // the AST node directly to detect async function* declarations.
    const isAsyncGenerator = hasAsyncModifier(decl);
    const createGenName = isAsyncGenerator ? "__create_async_generator" : "__create_generator";
    const createGenIdx = ctx.funcMap.get(createGenName)!;
    fctx.body.push({ op: "local.get", index: bufferLocal });
    fctx.body.push({ op: "local.get", index: pendingThrowLocal });
    fctx.body.push({ op: "call", funcIdx: createGenIdx });
    // The externref Generator object is now on the stack as the return value
  } else {
    // Compile body statements
    if (decl.body) {
      // #1210: pre-scan for `let s = ""; for (...) s += <expr>` builder patterns.
      // Must run BEFORE hoistLetConstWithTdz so the hoist pass can skip
      // pre-allocating the binding's local — the binding is replaced by a
      // synthetic buffer/len/cap/mat triple set up at declaration time.
      // Only runs in nativeStrings mode (JS-host concat avoids GC pressure).
      if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
        const builders = detectStringBuilders(ctx, decl.body);
        if (builders.size > 0) fctx.pendingStringBuilders = builders;
      }
      // Hoist `var` declarations: pre-allocate locals so variables are accessible
      // even before their declaration site (JS var hoisting semantics).
      hoistVarDeclarations(ctx, fctx, decl.body.statements);
      // Hoist `let`/`const` declarations with TDZ flags so nested functions can
      // capture them. The TDZ flag ensures ReferenceError if accessed before init.
      hoistLetConstWithTdz(ctx, fctx, decl.body.statements);
      // Hoist function declarations: JS semantics require function declarations
      // to be available before their textual position in the enclosing scope.
      hoistFunctionDeclarations(ctx, fctx, decl.body.statements);
      for (const stmt of decl.body.statements) {
        compileStatement(ctx, fctx, stmt);
      }
    }

    // Ensure there's always a valid return value at the end for non-void functions
    if (fctx.returnType) {
      // Check if the last instruction is already a return
      const lastInstr = fctx.body[fctx.body.length - 1];
      if (!lastInstr || lastInstr.op !== "return") {
        // Add a default return value
        if (fctx.returnType.kind === "f64") {
          fctx.body.push({ op: "f64.const", value: 0 });
        } else if (fctx.returnType.kind === "i32") {
          fctx.body.push({ op: "i32.const", value: 0 });
        } else if (fctx.returnType.kind === "externref") {
          fctx.body.push({ op: "ref.null.extern" });
        } else if (fctx.returnType.kind === "ref" || fctx.returnType.kind === "ref_null") {
          fctx.body.push({ op: "ref.null", typeIdx: fctx.returnType.typeIdx });
        }
      }
    }
  }

  cacheStringLiterals(ctx, fctx);
  deduplicateLocals(fctx);
  func.locals = fctx.locals;
  func.body = fctx.body;

  ctx.currentFunc = null;
}

/**
 * Build throw instructions for TypeError when destructuring null/undefined.
 * Per JS spec, destructuring null/undefined must throw TypeError.
 */
