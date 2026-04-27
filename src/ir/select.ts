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
//
// Slice 4 (#1169d) — class instances accepted in OUTER functions:
//   - The selector recognises `TypeReferenceNode` referring to a class
//     declared in the same compilation unit. Functions whose params /
//     return are class-typed pass the type gate.
//   - `isPhase1Expr` accepts `NewExpression` (Identifier callee naming a
//     local class), `PropertyAccessExpression` on a (potentially) class
//     receiver, and `CallExpression` whose callee is a property-access on
//     a class receiver (method call).
//   - Statement-position `<obj>.<field> = <expr>` is allowed (in addition
//     to bare call expressions and the existing var-decl / if shapes).
//   - The selector accepts these shapes structurally; the actual
//     class-vs-non-class dispatch happens at the AST→IR lowering layer,
//     where the class registry is consulted to validate that the receiver
//     IS in fact a known class. If not, the lowerer throws and the
//     function falls back to legacy.
//   - Class methods themselves (and constructors) are NOT claimed in
//     slice 4 — they remain on the legacy class-bodies path. The
//     selector only scans top-level `ts.FunctionDeclaration` nodes.
//   - The call-graph closure tolerates calls into class constructors /
//     methods because those are LEGACY-compiled with stable signatures
//     before the IR runs (allocated by `collectClassDeclaration`). The
//     `localClasses` set drives that exemption.

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

  // Slice 4 (#1169d): scan classes declared in this compilation unit.
  // Their names participate in:
  //   - param/return type recognition (a TypeReferenceNode pointing to a
  //     local class is a valid IR-claimable type, like primitives).
  //   - the call-graph closure: `new <className>(...)` and
  //     `instance.method(...)` are NOT external calls because the legacy
  //     `collectClassDeclaration` pass has registered constructors and
  //     methods with stable signatures before the IR runs.
  const localClasses = collectLocalClasses(sourceFile);

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
    if (isIrClaimable(stmt, typeMap, localClasses)) {
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
  const { callers, callees, hasExternalCall } = buildLocalCallGraph(declByName, localClasses);

  const claimed = new Set(individuallyClaimed);
  // Immediately drop functions that call non-local identifier functions
  // (e.g. parseInt, String, Number, isNaN). from-ast.ts throws for unknown
  // callees; the call-graph closure only tracks local edges so external
  // calls slipped through — catching them here prevents compile_errors.
  for (const name of [...claimed]) {
    if (hasExternalCall.has(name)) claimed.delete(name);
  }

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

function isIrClaimable(
  fn: ts.FunctionDeclaration,
  typeMap: TypeMap | undefined,
  localClasses: ReadonlySet<string>,
): boolean {
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
  return isPhase1StatementList(body.statements, scope, localClasses);
}

/**
 * Resolve a param's type. Explicit TS annotation wins (must be number /
 * boolean / string). Otherwise, the TypeMap entry's lattice type must be a
 * concrete primitive.
 *
 * #1169a — slice 1 widens the resolver to recognise `string`. The set of
 * call sites still treats the result as a null-vs-non-null discriminator,
 * so adding a third positive value is backward-compatible.
 */
type ResolvedKind = "f64" | "bool" | "string" | "object" | null;

function resolveParamType(p: ts.ParameterDeclaration, mapped: LatticeType | undefined): ResolvedKind {
  if (p.type) {
    if (p.type.kind === ts.SyntaxKind.NumberKeyword) return "f64";
    if (p.type.kind === ts.SyntaxKind.BooleanKeyword) return "bool";
    if (p.type.kind === ts.SyntaxKind.StringKeyword) return "string";
    // Slice 2 (#1169b) — accept TypeLiteral / TypeReference at the
    // selector level. The actual shape resolution happens in
    // codegen/index.ts:resolvePositionType, which materializes an
    // IrType.object via `objectIrTypeFromTsType`. If shape resolution
    // fails (e.g. callable type, methods, etc.), the override map is
    // populated with a placeholder and the function falls back to
    // legacy via the `safeSelection` filter.
    if (ts.isTypeLiteralNode(p.type) || ts.isTypeReferenceNode(p.type)) return "object";
    return null;
  }
  if (mapped?.kind === "f64") return "f64";
  if (mapped?.kind === "bool") return "bool";
  if (mapped?.kind === "string") return "string";
  if (mapped?.kind === "object") return "object";
  return null;
}

function resolveReturnType(fn: ts.FunctionDeclaration, mapped: LatticeType | undefined): ResolvedKind {
  if (fn.type) {
    if (fn.type.kind === ts.SyntaxKind.NumberKeyword) return "f64";
    if (fn.type.kind === ts.SyntaxKind.BooleanKeyword) return "bool";
    if (fn.type.kind === ts.SyntaxKind.StringKeyword) return "string";
    if (ts.isTypeLiteralNode(fn.type) || ts.isTypeReferenceNode(fn.type)) return "object";
    return null;
  }
  if (mapped?.kind === "f64") return "f64";
  if (mapped?.kind === "bool") return "bool";
  if (mapped?.kind === "string") return "string";
  if (mapped?.kind === "object") return "object";
  return null;
}

// ---------------------------------------------------------------------------
// Shape check
// ---------------------------------------------------------------------------

function isPhase1StatementList(
  stmts: ReadonlyArray<ts.Statement>,
  scope: Set<string>,
  localClasses: ReadonlySet<string>,
): boolean {
  if (stmts.length < 1) return false;
  for (let i = 0; i < stmts.length - 1; i++) {
    const s = stmts[i]!;
    // Phase 1: VariableStatements before the tail.
    if (ts.isVariableStatement(s)) {
      if (!isPhase1VarDecl(s, scope, localClasses)) return false;
      continue;
    }
    // Slice 3 (#1169c): nested function declaration. Treated like a
    // const-bound arrow — the name enters scope, the body is shape-
    // checked recursively, self-reference is rejected (no slice-3
    // self-recursive nested funcs).
    if (ts.isFunctionDeclaration(s)) {
      if (!isPhase1NestedFunc(s, scope, localClasses)) return false;
      continue;
    }
    // Slice 3 (#1169c): bare call expression statement (drop the result).
    // Lets `inc(); inc(); inc();` patterns work for closures with side
    // effects through ref-cell captures.
    //
    // Slice 4 (#1169d): also accept assignment expressions whose LHS is
    // a property-access on a (presumably class) receiver — i.e.
    // `obj.field = expr;`. The lowerer enforces the receiver IS a class
    // shape; if not, the function falls back to legacy.
    if (ts.isExpressionStatement(s)) {
      if (ts.isCallExpression(s.expression)) {
        if (!isPhase1Expr(s.expression, scope, localClasses)) return false;
        continue;
      }
      if (
        ts.isBinaryExpression(s.expression) &&
        s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(s.expression.left)
      ) {
        // LHS: <expr>.<id> — receiver expr must be Phase-1, prop must be Identifier.
        if (!ts.isIdentifier(s.expression.left.name)) return false;
        if (!isPhase1Expr(s.expression.left.expression, scope, localClasses)) return false;
        // RHS: any Phase-1 expression.
        if (!isPhase1Expr(s.expression.right, scope, localClasses)) return false;
        continue;
      }
      return false;
    }
    // Phase 2 extension: an `if (cond) <tail>` with NO else and the rest
    // of the statements forming a tail. This is the classic early-return
    // pattern: `if (base) return x; <recursive body>`. We structurally
    // reinterpret as `if (cond) <tail> else { <rest> }`.
    if (ts.isIfStatement(s) && !s.elseStatement) {
      if (!isPhase1Expr(s.expression, scope, localClasses)) return false;
      if (!isPhase1Tail(s.thenStatement, new Set(scope), localClasses)) return false;
      const rest = stmts.slice(i + 1);
      return isPhase1StatementList(rest, new Set(scope), localClasses);
    }
    // Slice 6 (#1169e) — for-of statement acceptance is gated OFF until
    // the AST→IR bridge in `from-ast.ts` lands (`lowerForOfStatement` +
    // slot-binding plumbing) and `integration.ts` exposes `resolveVec`.
    // The IR nodes / builder / lowerer / passes ARE in place (see
    // `nodes.ts`, `builder.ts`, `lower.ts`, `passes/*`) but no emitter
    // produces `forof.vec` / `slot.*` / `vec.*` instrs yet, so claiming a
    // for-of here would land in the lowerer's "unexpected statement"
    // branch and leak a noisy IR-fallback error. Re-enable once the
    // bridge work ships.
    return false;
  }
  return isPhase1Tail(stmts[stmts.length - 1]!, scope, localClasses);
}

function isPhase1Tail(stmt: ts.Statement, scope: Set<string>, localClasses: ReadonlySet<string>): boolean {
  if (ts.isReturnStatement(stmt)) {
    if (!stmt.expression) return false;
    return isPhase1Expr(stmt.expression, scope, localClasses);
  }
  if (ts.isBlock(stmt)) {
    return isPhase1StatementList(stmt.statements, new Set(scope), localClasses);
  }
  if (ts.isIfStatement(stmt)) {
    if (!stmt.elseStatement) return false;
    if (!isPhase1Expr(stmt.expression, scope, localClasses)) return false;
    if (!isPhase1Tail(stmt.thenStatement, new Set(scope), localClasses)) return false;
    if (!isPhase1Tail(stmt.elseStatement, new Set(scope), localClasses)) return false;
    return true;
  }
  return false;
}

function isPhase1VarDecl(stmt: ts.VariableStatement, scope: Set<string>, localClasses: ReadonlySet<string>): boolean {
  const flags = stmt.declarationList.flags;
  if (!(flags & ts.NodeFlags.Let) && !(flags & ts.NodeFlags.Const)) return false;
  if (stmt.modifiers && stmt.modifiers.length > 0) return false;
  const isConst = !!(flags & ts.NodeFlags.Const);
  for (const d of stmt.declarationList.declarations) {
    if (!ts.isIdentifier(d.name)) return false;
    if (scope.has(d.name.text)) return false;
    if (!d.initializer) return false;
    // Slice 3 (#1169c): closure-literal initializer. Only accepted for
    // `const` (no `let` arrow rebinding in slice 3). The closure
    // shape-check enforces the slice-3 surface (every param + return
    // annotated, body is a Phase-1 tail, no generator/async/named).
    if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) {
      if (!isConst) return false;
      // Permit an explicit closure type annotation (like `: (n: number) => number`)
      // — it's a shape-only signal, not a primitive type. Since the IR doesn't
      // syntactically check the annotation against the body, just accept any
      // annotation (the lowerer enforces semantic match).
      if (!isPhase1ClosureLiteral(d.initializer, scope, localClasses)) return false;
      scope.add(d.name.text);
      continue;
    }
    if (d.type && !isPhase1TypeNode(d.type)) return false;
    if (!isPhase1Expr(d.initializer, scope, localClasses)) return false;
    scope.add(d.name.text);
  }
  return true;
}

/**
 * Slice 3 (#1169c): shape-check a nested `function inner() {...}`
 * declaration inside an outer body. Adds the inner's name to the outer
 * scope on success so subsequent statements / sibling closures can
 * reference it by name.
 */
function isPhase1NestedFunc(
  fn: ts.FunctionDeclaration,
  scope: Set<string>,
  localClasses: ReadonlySet<string>,
): boolean {
  if (!fn.name) return false;
  if (fn.asteriskToken) return false; // generator
  if (
    fn.modifiers &&
    fn.modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword || m.kind === ts.SyntaxKind.ExportKeyword)
  ) {
    return false;
  }
  if (fn.typeParameters && fn.typeParameters.length > 0) return false;
  if (scope.has(fn.name.text)) return false; // shadowing — defer

  // Every param + return must have an explicit primitive / object
  // annotation. Slice 3 doesn't run propagation across closure
  // boundaries, so propagation overrides aren't applicable.
  if (!fn.type || annotationToResolvedKind(fn.type) === null) return false;

  const closureScope = new Set(scope);
  for (const p of fn.parameters) {
    if (!ts.isIdentifier(p.name)) return false;
    if (p.questionToken || p.dotDotDotToken || p.initializer) return false;
    if (!p.type || annotationToResolvedKind(p.type) === null) return false;
    if (closureScope.has(p.name.text)) return false;
    closureScope.add(p.name.text);
  }

  // Reject self-reference syntactically — slice 3 doesn't yet support
  // recursive nested funcs (would need a closure-name binding inside
  // the lifted body).
  if (!fn.body) return false;
  if (bodyReferencesIdentifier(fn.body, fn.name.text)) return false;
  if (!isPhase1StatementList(fn.body.statements, closureScope, localClasses)) return false;

  // Add the nested function name to the OUTER scope.
  scope.add(fn.name.text);
  return true;
}

/**
 * Slice 3 (#1169c): shape-check an arrow / function-expression
 * initializer used as a `const` closure binding.
 */
function isPhase1ClosureLiteral(
  expr: ts.ArrowFunction | ts.FunctionExpression,
  scope: ReadonlySet<string>,
  localClasses: ReadonlySet<string>,
): boolean {
  if (ts.isFunctionExpression(expr) && expr.name) return false; // named func expr — defer
  if ("asteriskToken" in expr && expr.asteriskToken) return false; // generator
  if (expr.modifiers && expr.modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return false;
  if (expr.typeParameters && expr.typeParameters.length > 0) return false;

  if (!expr.type || annotationToResolvedKind(expr.type) === null) return false;

  const inner = new Set(scope);
  for (const p of expr.parameters) {
    if (!ts.isIdentifier(p.name)) return false;
    if (p.questionToken || p.dotDotDotToken || p.initializer) return false;
    if (!p.type || annotationToResolvedKind(p.type) === null) return false;
    if (inner.has(p.name.text)) return false;
    inner.add(p.name.text);
  }

  // ArrowFunction with concise body: must be a Phase-1 expression.
  // ArrowFunction / FunctionExpression with block body: Phase-1 tail
  // statement list.
  if (ts.isArrowFunction(expr) && !ts.isBlock(expr.body)) {
    return isPhase1Expr(expr.body, inner, localClasses);
  }
  if (!ts.isBlock(expr.body)) return false;
  return isPhase1StatementList(expr.body.statements, inner, localClasses);
}

/**
 * Resolve a TypeNode annotation to one of the slice-1+2 ResolvedKinds.
 * Returns `null` for anything outside that surface. Local helper for
 * the closure shape checks; mirrors `resolveParamType`'s annotation
 * arm but without the propagation-fallback path.
 */
function annotationToResolvedKind(node: ts.TypeNode): ResolvedKind {
  if (node.kind === ts.SyntaxKind.NumberKeyword) return "f64";
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return "bool";
  if (node.kind === ts.SyntaxKind.StringKeyword) return "string";
  if (ts.isTypeLiteralNode(node) || ts.isTypeReferenceNode(node)) return "object";
  return null;
}

/**
 * Recursive scan: does any identifier reference inside `body` resolve
 * to `name`? Walks into nested expressions but stops at function-like
 * boundaries (those have their own analyses run when they're lowered).
 *
 * Used by `isPhase1NestedFunc` to reject self-recursive nested funcs.
 */
function bodyReferencesIdentifier(body: ts.Block, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === name) {
      found = true;
      return;
    }
    if (
      node !== body &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessor(node) ||
        ts.isSetAccessor(node))
    ) {
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return found;
}

function isPhase1TypeNode(node: ts.TypeNode): boolean {
  return (
    node.kind === ts.SyntaxKind.NumberKeyword ||
    node.kind === ts.SyntaxKind.BooleanKeyword ||
    node.kind === ts.SyntaxKind.StringKeyword
  );
}

function isPhase1Expr(expr: ts.Expression, scope: ReadonlySet<string>, localClasses: ReadonlySet<string>): boolean {
  if (ts.isParenthesizedExpression(expr)) return isPhase1Expr(expr.expression, scope, localClasses);
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
    return isPhase1Expr(expr.operand, scope, localClasses);
  }
  if (ts.isBinaryExpression(expr)) {
    if (!isPhase1BinaryOp(expr.operatorToken.kind)) return false;
    return isPhase1Expr(expr.left, scope, localClasses) && isPhase1Expr(expr.right, scope, localClasses);
  }
  if (ts.isConditionalExpression(expr)) {
    return (
      isPhase1Expr(expr.condition, scope, localClasses) &&
      isPhase1Expr(expr.whenTrue, scope, localClasses) &&
      isPhase1Expr(expr.whenFalse, scope, localClasses)
    );
  }
  if (ts.isCallExpression(expr)) {
    // Slice 4 (#1169d): accept method calls — `<recv>.<methodName>(...)`.
    // The receiver must itself be a Phase-1 expression; the lowerer
    // enforces that the receiver is a class instance whose shape carries
    // `methodName`. If not, the function falls back to legacy.
    if (ts.isPropertyAccessExpression(expr.expression)) {
      if (!ts.isIdentifier(expr.expression.name)) return false;
      if (!isPhase1Expr(expr.expression.expression, scope, localClasses)) return false;
      for (const arg of expr.arguments) {
        if (!isPhase1Expr(arg, scope, localClasses)) return false;
      }
      return true;
    }
    if (!ts.isIdentifier(expr.expression)) return false;
    for (const arg of expr.arguments) {
      if (!isPhase1Expr(arg, scope, localClasses)) return false;
    }
    return true;
  }
  // Slice 4 (#1169d): NewExpression. Callee must be an Identifier
  // naming a class declared in the same compilation unit; args are
  // Phase-1 expressions. The lowerer validates the constructor's
  // signature against the args. ParenthesizedExpression callees and
  // generic type-args are rejected at the lowering layer.
  if (ts.isNewExpression(expr)) {
    if (!ts.isIdentifier(expr.expression)) return false;
    if (!localClasses.has(expr.expression.text)) return false;
    if (expr.typeArguments && expr.typeArguments.length > 0) return false; // defer generics
    if (!expr.arguments) return true;
    for (const arg of expr.arguments) {
      if (!isPhase1Expr(arg, scope, localClasses)) return false;
    }
    return true;
  }
  // Slice 1: `typeof <expr>` is claimable when its operand is a Phase-1
  // expression. The resulting value is a string tag ("number" / "boolean" /
  // "string" / …); downstream it only composes with `isPhase1BinaryOp`'s
  // new string-equality form.
  if (ts.isTypeOfExpression(expr)) {
    return isPhase1Expr(expr.expression, scope, localClasses);
  }
  // Slice 1 (#1169a): no-substitution template literals are equivalent to a
  // string literal at the AST level (`\`hello\``).
  if (expr.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) return true;
  // Slice 1: template expressions with substitutions, where every
  // substitution is itself a Phase-1 expression. Type compatibility
  // (each sub must produce a string in slice 1) is enforced later in
  // from-ast — accepting the shape here is shape-only acceptance.
  if (ts.isTemplateExpression(expr)) {
    for (const span of expr.templateSpans) {
      if (!isPhase1Expr(span.expression, scope, localClasses)) return false;
    }
    return true;
  }
  // Slice 2 (#1169b) — plain "data" object literals. The acceptance
  // helper rejects spread, methods, getters/setters, computed keys,
  // and duplicate keys. Initializers must themselves be Phase-1
  // claimable, so nested objects compose recursively.
  if (ts.isObjectLiteralExpression(expr)) {
    return isPhase1ObjectLiteral(expr, scope, localClasses);
  }
  // Slices 1+2 — property access. Slice 1 accepts `<string>.length`
  // syntactically; slice 2 broadens to any Identifier-named property,
  // with the lowerer enforcing receiver IrType (string→.length only,
  // object→named field). The selector accepts the shape only —
  // type checks happen at lowering time.
  //
  // Slice 4 (#1169d): same shape covers `<recv>.<fieldName>` on a
  // class instance (recv is Phase-1; lowerer dispatches by the recv's
  // resolved IrType).
  if (ts.isPropertyAccessExpression(expr)) {
    if (!ts.isIdentifier(expr.name)) return false;
    return isPhase1Expr(expr.expression, scope, localClasses);
  }
  // Slice 2 — element access with a literal string key (sugar for
  // property access on a known shape). Numeric/computed keys are
  // out of scope and rejected here so the function falls back to
  // legacy.
  if (ts.isElementAccessExpression(expr)) {
    const arg = expr.argumentExpression;
    if (!ts.isStringLiteral(arg) && arg.kind !== ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
      return false;
    }
    return isPhase1Expr(expr.expression, scope, localClasses);
  }
  return false;
}

/**
 * Slice-2 acceptance check for object literals. Accepts only "plain data"
 * literals: PropertyAssignment / ShorthandPropertyAssignment with
 * Identifier / StringLiteral / NumericLiteral keys and Phase-1-claimable
 * initializers. Rejects spread, methods, accessors, computed keys, and
 * duplicate keys (last-write-wins is JS spec; deferred to a later slice).
 */
function isPhase1ObjectLiteral(
  expr: ts.ObjectLiteralExpression,
  scope: ReadonlySet<string>,
  localClasses: ReadonlySet<string>,
): boolean {
  // Empty literals get rejected by the codegen side (zero-property
  // objects don't form a usable IrType.object shape) — but accepting
  // them at the selector level wouldn't cause a regression: the
  // overrides pass would skip them when shape resolution failed.
  if (expr.properties.length === 0) return false;

  const seen = new Set<string>();
  for (const prop of expr.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const name = phase1PropertyName(prop.name);
      if (name === null) return false;
      if (seen.has(name)) return false; // duplicate key — defer
      seen.add(name);
      if (!isPhase1Expr(prop.initializer, scope, localClasses)) return false;
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      const name = prop.name.text;
      if (seen.has(name)) return false;
      if (!scope.has(name)) return false;
      seen.add(name);
      continue;
    }
    // SpreadAssignment, MethodDeclaration, GetAccessorDeclaration,
    // SetAccessorDeclaration → reject.
    return false;
  }
  return true;
}

/**
 * Resolve an object literal property name to a string. Identifier and
 * StringLiteral keys produce their text. NumericLiteral keys produce the
 * canonical JS toString of the number. ComputedPropertyName always
 * returns null — slice 2 doesn't see through computed keys, even when
 * the key expression is itself a string literal.
 */
function phase1PropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text; // matches JS — `{ 0: x }` → "0"
  return null;
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

function buildLocalCallGraph(
  decls: ReadonlyMap<string, ts.FunctionDeclaration>,
  localClasses: ReadonlySet<string>,
): {
  callers: Map<string, Set<string>>;
  callees: Map<string, Set<string>>;
  hasExternalCall: Set<string>;
} {
  const callers = new Map<string, Set<string>>();
  const callees = new Map<string, Set<string>>();
  const hasExternalCall = new Set<string>();
  for (const name of decls.keys()) {
    callers.set(name, new Set());
    callees.set(name, new Set());
  }
  for (const [callerName, fn] of decls) {
    if (!fn.body) continue;
    // Slice 3 (#1169c): collect names introduced INSIDE this outer's
    // body that belong to nested function decls or closure bindings.
    // Calls to these names are intra-function (handled by the IR's
    // closure dispatch, not the legacy call-graph), so they must NOT
    // mark the outer as having an external call.
    const localBindings = collectLocalClosureBindings(fn);

    const visit = (node: ts.Node): void => {
      if (node !== fn && isFunctionLike(node)) return;
      // Slice 4 (#1169d): `new <className>(...)` is NOT a function-style
      // call; it dispatches to a legacy-compiled constructor with a
      // stable signature. Walk into the args (which may contain real
      // calls), but don't mark the outer as having an external call.
      if (ts.isNewExpression(node)) {
        if (ts.isIdentifier(node.expression) && localClasses.has(node.expression.text)) {
          if (node.arguments) {
            for (const a of node.arguments) visit(a);
          }
          return;
        }
        // Unknown constructor → external. Fall through to default
        // ts.forEachChild walking + the CallExpression branch below
        // doesn't reach here, so we mark it explicitly.
        hasExternalCall.add(callerName);
        if (node.arguments) {
          for (const a of node.arguments) visit(a);
        }
        return;
      }
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression)) {
          const callee = node.expression.text;
          if (decls.has(callee)) {
            callees.get(callerName)!.add(callee);
            callers.get(callee)!.add(callerName);
          } else if (localBindings.has(callee)) {
            // Slice 3: closure / nested-fn binding within this outer.
            // Intra-function call, dispatched by the IR lowerer.
          } else {
            // Call to a non-local identifier (e.g. parseInt, String, Number).
            // from-ast.ts throws for unknown callees so we must exclude this
            // function from the IR path.
            hasExternalCall.add(callerName);
          }
        } else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name)) {
          // Slice 4 (#1169d): `<recv>.<methodName>(...)`. The lowerer
          // will validate that the receiver is a known class instance
          // and dispatch to a legacy-compiled method. We don't mark
          // this as external — the legacy method's signature is stable
          // because class methods aren't IR-claimed in slice 4.
          //
          // Walk into the receiver and args to catch real external calls
          // nested inside.
          visit(node.expression.expression);
          for (const a of node.arguments) visit(a);
          return;
        } else {
          // Member-expression or computed call: Array.from(...), Math.trunc(...),
          // arr[Symbol.iterator](), obj.method(), etc.  The IR path cannot lower
          // these — exclude the enclosing function from the IR claim set.
          hasExternalCall.add(callerName);
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn.body, visit);
  }
  return { callers, callees, hasExternalCall };
}

/**
 * Slice 4 (#1169d): scan the source file for class declarations. The
 * resulting set drives:
 *   - param/return type acceptance (a TypeReferenceNode that resolves
 *     statically to one of these names is a valid IR position type),
 *   - `new <className>(...)` shape acceptance,
 *   - call-graph closure exemption for `new <className>(...)` and
 *     `instance.method(...)` calls.
 *
 * Only top-level `ts.ClassDeclaration` nodes are collected. Class
 * expressions assigned to `const` or class declarations nested inside
 * another function body are out of slice 4 scope (the legacy
 * `collectClassDeclaration` pass handles them, but the IR selector
 * doesn't accept their use). Anonymous classes (no `name`) are skipped.
 */
function collectLocalClasses(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (ts.isClassDeclaration(stmt) && stmt.name) {
      names.add(stmt.name.text);
    }
  }
  return names;
}

/**
 * Slice 3 (#1169c): collect every identifier name introduced inside the
 * outer function's top-level body as a nested function decl or as a
 * `const`-bound arrow / function-expression. Calls to these names are
 * intra-function (handled by the IR's closure dispatch) and must not be
 * flagged as external by the call-graph builder.
 *
 * Walks only the OUTER body — nested closures' own bindings are
 * captured at lift time, not visible here.
 */
function collectLocalClosureBindings(fn: ts.FunctionDeclaration): Set<string> {
  const names = new Set<string>();
  if (!fn.body) return names;
  // Top-level walk: only direct children of the outer body. Nested
  // bindings inside an `if` arm or another function-like don't escape
  // their lexical scope, so they don't shadow the call-graph path.
  // For simplicity we include any nested function decl and any const
  // arrow init found at any nesting level within the outer body — the
  // worst case is a false negative on the external-call check, which
  // would just mean the outer falls back to legacy.
  const visit = (node: ts.Node): void => {
    if (node !== fn && isFunctionLike(node)) return;
    if (ts.isFunctionDeclaration(node) && node !== fn && node.name) {
      names.add(node.name.text);
    }
    if (ts.isVariableStatement(node)) {
      const isConst = !!(node.declarationList.flags & ts.NodeFlags.Const);
      if (isConst) {
        for (const d of node.declarationList.declarations) {
          if (
            ts.isIdentifier(d.name) &&
            d.initializer &&
            (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
          ) {
            names.add(d.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return names;
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
