// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Per-function selector — decides which functions to route through the IR
// path vs. the legacy direct AST→Wasm emission.
//
// Phase 1 (shipped) numeric/bool subset: a function is claimed when
//   - all params are typed `number` or `boolean` via an explicit TS type
//     annotation;
//   - return type is typed `number` or `boolean`;
//   - the function body is a "tail":
//       - zero or more `(let|const) <name> = <expr>;` declarations followed by
//       - either `return <expr>;` OR `if (<expr>) <tail> else <tail>`
//         where both arms are themselves valid tails;
//   - every `<expr>` is composed only of literals, param / local references,
//     and the supported unary / binary / conditional operators.
//
// Phase 2 extensions:
//   - `isPhase1Expr` accepts `CallExpression` whose callee is an Identifier.
//     The callee doesn't need to be resolvable at shape-check time — the
//     call-graph closure below ensures every claimed function's callees are
//     also claimed, and the AST→IR lowerer rejects unknown callees cleanly.
//   - Param / return types may come from a propagated TypeMap
//     (`buildTypeMap` in `./propagate.ts`) instead of an explicit TS
//     annotation. That unlocks recursive numeric kernels like `fib` whose
//     params are untyped in source but provably `number` via caller flow.
//   - After individual claims are collected, a call-graph closure pass
//     drops any function whose local callers OR local callees are not
//     themselves claimed. Rationale: the IR path replaces `typeIdx` on
//     the Wasm function record, so if a legacy-compiled caller already
//     emitted a `call` with the OLD signature, the post-IR module will
//     fail Wasm validation. Closing under both edges guarantees every
//     cross-function call in the module is legacy↔legacy or IR↔IR.

import ts from "typescript";

import type { LatticeType, TypeMap } from "./propagate.js";

export interface IrSelection {
  readonly funcs: ReadonlySet<string>;
}

export interface IrSelectionOptions {
  readonly experimentalIR?: boolean;
}

const EMPTY: IrSelection = { funcs: new Set<string>() };

export function planIrCompilation(
  sourceFile: ts.SourceFile,
  options?: IrSelectionOptions,
  typeMap?: TypeMap,
): IrSelection {
  if (!options?.experimentalIR) return EMPTY;

  // -------------------------------------------------------------------------
  // Step 1: individual per-function claim.
  //
  // A function is individually-claimable iff its shape is Phase-1-compatible
  // AND every param / return resolves to a concrete primitive (f64/bool).
  // Types come either from explicit TS annotations (classic path) or from
  // the TypeMap (propagation path).
  // -------------------------------------------------------------------------
  const individuallyClaimed = new Set<string>();
  const declByName = new Map<string, ts.FunctionDeclaration>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(stmt)) continue;
    if (!stmt.name) continue;
    declByName.set(stmt.name.text, stmt);
    if (isIrClaimable(stmt, typeMap)) {
      individuallyClaimed.add(stmt.name.text);
    }
  }

  if (individuallyClaimed.size === 0) return EMPTY;

  // -------------------------------------------------------------------------
  // Step 2: call-graph closure.
  //
  // Build each function's set of local callers + local callees (restricted
  // to functions declared in this source file). Iteratively remove any
  // claimed function whose any LOCAL caller or any LOCAL callee is not
  // also claimed. Repeat until stable.
  //
  // This safeguards against signature mismatch: the IR path replaces a
  // function's typeIdx after the legacy path has already compiled its
  // callers' bodies. Ensuring both sides of every cross-function edge are
  // on the same side (IR or legacy) avoids cross-signature `call` ops.
  // -------------------------------------------------------------------------
  const { callers, callees } = buildLocalCallGraph(declByName);

  const claimed = new Set(individuallyClaimed);
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of [...claimed]) {
      const myCallers = callers.get(name) ?? new Set<string>();
      const myCallees = callees.get(name) ?? new Set<string>();
      let safe = true;
      for (const c of myCallers) {
        if (!claimed.has(c)) {
          safe = false;
          break;
        }
      }
      if (safe) {
        for (const c of myCallees) {
          if (!claimed.has(c)) {
            safe = false;
            break;
          }
        }
      }
      if (!safe) {
        claimed.delete(name);
        changed = true;
      }
    }
  }

  return { funcs: claimed };
}

// ---------------------------------------------------------------------------
// Individual-claim check
// ---------------------------------------------------------------------------

function isIrClaimable(fn: ts.FunctionDeclaration, typeMap: TypeMap | undefined): boolean {
  if (!fn.name) return false;
  if (fn.typeParameters && fn.typeParameters.length > 0) return false;
  if (fn.modifiers && fn.modifiers.some((m) => m.kind !== ts.SyntaxKind.ExportKeyword)) return false;

  const entry = typeMap?.get(fn.name.text);

  // Return type must resolve to a concrete primitive.
  const returnResolved = resolveReturnType(fn, entry?.returnType);
  if (returnResolved === null) return false;

  // All params must resolve to a concrete primitive.
  const scope = new Set<string>();
  for (let i = 0; i < fn.parameters.length; i++) {
    const p = fn.parameters[i]!;
    if (!ts.isIdentifier(p.name)) return false;
    if (p.questionToken) return false;
    if (p.dotDotDotToken) return false;
    if (p.initializer) return false;
    if (scope.has(p.name.text)) return false;

    const mapped = entry?.params[i];
    const paramResolved = resolveParamType(p, mapped);
    if (paramResolved === null) return false;

    scope.add(p.name.text);
  }

  const body = fn.body;
  if (!body) return false;
  return isPhase1StatementList(body.statements, scope);
}

/**
 * Resolve a param's type. Explicit TS annotation wins (must be number/
 * boolean). Otherwise, the TypeMap entry's lattice type must be a
 * concrete primitive.
 */
function resolveParamType(p: ts.ParameterDeclaration, mapped: LatticeType | undefined): "f64" | "bool" | null {
  if (p.type) {
    if (p.type.kind === ts.SyntaxKind.NumberKeyword) return "f64";
    if (p.type.kind === ts.SyntaxKind.BooleanKeyword) return "bool";
    return null;
  }
  if (mapped?.kind === "f64") return "f64";
  if (mapped?.kind === "bool") return "bool";
  return null;
}

function resolveReturnType(fn: ts.FunctionDeclaration, mapped: LatticeType | undefined): "f64" | "bool" | null {
  if (fn.type) {
    if (fn.type.kind === ts.SyntaxKind.NumberKeyword) return "f64";
    if (fn.type.kind === ts.SyntaxKind.BooleanKeyword) return "bool";
    return null;
  }
  if (mapped?.kind === "f64") return "f64";
  if (mapped?.kind === "bool") return "bool";
  return null;
}

// ---------------------------------------------------------------------------
// Shape check
// ---------------------------------------------------------------------------

function isPhase1StatementList(stmts: ReadonlyArray<ts.Statement>, scope: Set<string>): boolean {
  if (stmts.length < 1) return false;
  for (let i = 0; i < stmts.length - 1; i++) {
    const s = stmts[i]!;
    // Phase 1: VariableStatements before the tail.
    if (ts.isVariableStatement(s)) {
      if (!isPhase1VarDecl(s, scope)) return false;
      continue;
    }
    // Phase 2 extension: an `if (cond) <tail>` with NO else and the rest
    // of the statements forming a tail. This is the classic early-return
    // pattern: `if (base) return x; <recursive body>`. We structurally
    // reinterpret as `if (cond) <tail> else { <rest> }`.
    if (ts.isIfStatement(s) && !s.elseStatement) {
      if (!isPhase1Expr(s.expression, scope)) return false;
      if (!isPhase1Tail(s.thenStatement, new Set(scope))) return false;
      const rest = stmts.slice(i + 1);
      return isPhase1StatementList(rest, new Set(scope));
    }
    return false;
  }
  return isPhase1Tail(stmts[stmts.length - 1]!, scope);
}

function isPhase1Tail(stmt: ts.Statement, scope: Set<string>): boolean {
  if (ts.isReturnStatement(stmt)) {
    if (!stmt.expression) return false;
    return isPhase1Expr(stmt.expression, scope);
  }
  if (ts.isBlock(stmt)) {
    return isPhase1StatementList(stmt.statements, new Set(scope));
  }
  if (ts.isIfStatement(stmt)) {
    if (!stmt.elseStatement) return false;
    if (!isPhase1Expr(stmt.expression, scope)) return false;
    if (!isPhase1Tail(stmt.thenStatement, new Set(scope))) return false;
    if (!isPhase1Tail(stmt.elseStatement, new Set(scope))) return false;
    return true;
  }
  return false;
}

function isPhase1VarDecl(stmt: ts.VariableStatement, scope: Set<string>): boolean {
  const flags = stmt.declarationList.flags;
  if (!(flags & ts.NodeFlags.Let) && !(flags & ts.NodeFlags.Const)) return false;
  if (stmt.modifiers && stmt.modifiers.length > 0) return false;
  for (const d of stmt.declarationList.declarations) {
    if (!ts.isIdentifier(d.name)) return false;
    if (scope.has(d.name.text)) return false;
    if (!d.initializer) return false;
    if (d.type && !isPhase1TypeNode(d.type)) return false;
    if (!isPhase1Expr(d.initializer, scope)) return false;
    scope.add(d.name.text);
  }
  return true;
}

function isPhase1TypeNode(node: ts.TypeNode): boolean {
  return node.kind === ts.SyntaxKind.NumberKeyword || node.kind === ts.SyntaxKind.BooleanKeyword;
}

function isPhase1Expr(expr: ts.Expression, scope: ReadonlySet<string>): boolean {
  if (ts.isParenthesizedExpression(expr)) return isPhase1Expr(expr.expression, scope);
  if (ts.isNumericLiteral(expr)) return true;
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return true;
  // Slice 1 (issue #1168): claim string literals and `null` so that
  // `typeof x === "string"` / `x === null` / `x == null` patterns can
  // compose out of Phase-1 primitives. Actual lowering for non-f64/bool
  // result types is still out of this slice's scope — the selector
  // rejects functions whose return/param types aren't f64/bool via
  // `resolveReturnType` / `resolveParamType`, so accepting the shape
  // here is shape-only acceptance.
  if (ts.isStringLiteral(expr)) return true;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(expr)) {
    // Identifier may name either a param/local (scope) or a function
    // (only valid as the callee of a CallExpression, handled below).
    // A bare identifier that isn't in scope is not a valid Phase-1 expr.
    return scope.has(expr.text);
  }
  if (ts.isPrefixUnaryExpression(expr)) {
    if (!isPhase1PrefixOp(expr.operator)) return false;
    return isPhase1Expr(expr.operand, scope);
  }
  if (ts.isBinaryExpression(expr)) {
    if (!isPhase1BinaryOp(expr.operatorToken.kind)) return false;
    return isPhase1Expr(expr.left, scope) && isPhase1Expr(expr.right, scope);
  }
  if (ts.isConditionalExpression(expr)) {
    return (
      isPhase1Expr(expr.condition, scope) && isPhase1Expr(expr.whenTrue, scope) && isPhase1Expr(expr.whenFalse, scope)
    );
  }
  if (ts.isCallExpression(expr)) {
    if (!ts.isIdentifier(expr.expression)) return false;
    for (const arg of expr.arguments) {
      if (!isPhase1Expr(arg, scope)) return false;
    }
    return true;
  }
  // Slice 1: `typeof <expr>` is claimable when its operand is a Phase-1
  // expression. The resulting value is a string tag ("number" / "boolean" /
  // "string" / …); downstream it only composes with `isPhase1BinaryOp`'s
  // new string-equality form.
  if (ts.isTypeOfExpression(expr)) {
    return isPhase1Expr(expr.expression, scope);
  }
  return false;
}

function isPhase1PrefixOp(op: ts.PrefixUnaryOperator): boolean {
  return op === ts.SyntaxKind.MinusToken || op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.ExclamationToken;
}

function isPhase1BinaryOp(op: ts.SyntaxKind): boolean {
  switch (op) {
    case ts.SyntaxKind.PlusToken:
    case ts.SyntaxKind.MinusToken:
    case ts.SyntaxKind.AsteriskToken:
    case ts.SyntaxKind.SlashToken:
    case ts.SyntaxKind.LessThanToken:
    case ts.SyntaxKind.LessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanToken:
    case ts.SyntaxKind.GreaterThanEqualsToken:
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
    case ts.SyntaxKind.AmpersandAmpersandToken:
    case ts.SyntaxKind.BarBarToken:
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Call graph (local edges only)
// ---------------------------------------------------------------------------

function buildLocalCallGraph(decls: ReadonlyMap<string, ts.FunctionDeclaration>): {
  callers: Map<string, Set<string>>;
  callees: Map<string, Set<string>>;
} {
  const callers = new Map<string, Set<string>>();
  const callees = new Map<string, Set<string>>();
  for (const name of decls.keys()) {
    callers.set(name, new Set());
    callees.set(name, new Set());
  }
  for (const [callerName, fn] of decls) {
    if (!fn.body) continue;
    const visit = (node: ts.Node): void => {
      if (node !== fn && isFunctionLike(node)) return;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = node.expression.text;
        if (decls.has(callee)) {
          callees.get(callerName)!.add(callee);
          callers.get(callee)!.add(callerName);
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn.body, visit);
  }
  return { callers, callees };
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}
