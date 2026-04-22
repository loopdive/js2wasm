// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Interprocedural type propagation for the middle-end IR — Phase 2 of
// spec #1131.
//
// What it does
// ============
//
// The Phase 1 selector claims functions whose every param and return has an
// explicit TypeScript `: number` / `: boolean` annotation. That leaves
// recursive numeric kernels like
//
//     function fib(n) {              // no annotation
//       if (n <= 1) return n;
//       return fib(n - 1) + fib(n - 2);
//     }
//     export function run(n: number): number { return fib(n); }
//
// on the legacy path even though `fib` is provably `(number) -> number`:
// the TS checker infers `any` for `n` absent an annotation, and the legacy
// path ends up boxing every recursive call through `__box_number` /
// `__unbox_number`.
//
// This module runs a context-insensitive forward-propagation pass over the
// module's call graph to refine those types before the selector decides
// which functions to route through the IR. The result is a `TypeMap`
// keyed by function name, carrying each function's inferred parameter
// types and return type on a small four-point lattice.
//
// Lattice
// =======
//
//   unknown  ← bottom. No constraint gathered yet; optimistically treated
//              as compatible with any primitive at operator sites.
//   f64      ← number-typed.
//   bool     ← i32 boolean.
//   dynamic  ← top. Definitely not representable as a Phase-1 primitive;
//              rules out IR selection.
//
// Join:   unknown ⊔ X = X           (growth)
//         X ⊔ X = X
//         X ⊔ Y (different concrete primitives) = dynamic
//         X ⊔ dynamic = dynamic    (top is absorbing)
//
// Optimism
// ========
//
// Recursive fixpoint over a lattice that starts at `unknown` would otherwise
// stay at `unknown` forever (`fib(n-1)` calls `fib`, whose return is
// `unknown`, so `fib(n-1) + fib(n-2)` stays `unknown`). We break that
// stalemate by treating `unknown` at arithmetic operator sites as
// f64-compatible: `unknown + unknown → f64`, `unknown - f64 → f64`. This
// is the classic optimistic-start-and-refine pattern — the first iteration
// claims fib returns `f64`, and on the next iteration the call-site
// propagation confirms the claim because the operator evidence is
// transitively stable. If a call site ever produces incompatible operand
// types (e.g. `boolean + number`), the result falls to `dynamic`,
// disqualifying the function from IR selection.
//
// What this file does NOT do
// ==========================
//
// - It does not rewrite the IR. Rewriting happens in `from-ast.ts` /
//   `select.ts` based on the TypeMap returned here.
// - It does not attempt to infer types that cross module boundaries. Any
//   call to a non-local identifier (imports, properties, globals) falls
//   straight to `dynamic`.
// - It does not track locals declared by `let`/`const`. Phase 1's
//   selector allows those only when they're directly derivable from
//   params, and Phase 2 keeps the scope-tracking in propagation limited
//   to parameter identifiers for simplicity. Locals used inside Phase-1
//   functions are already constrained by the selector's shape check.

import ts from "typescript";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type LatticeType =
  | { readonly kind: "unknown" }
  | { readonly kind: "f64" }
  | { readonly kind: "bool" }
  | { readonly kind: "dynamic" };

export interface TypeMapEntry {
  readonly params: readonly LatticeType[];
  readonly returnType: LatticeType;
}

export type TypeMap = ReadonlyMap<string, TypeMapEntry>;

const UNKNOWN: LatticeType = { kind: "unknown" };
const F64: LatticeType = { kind: "f64" };
const BOOL: LatticeType = { kind: "bool" };
const DYNAMIC: LatticeType = { kind: "dynamic" };

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build a TypeMap over every named top-level function declaration in the
 * source file. Unresolvable types stay at `unknown`. Functions that the
 * selector wouldn't claim anyway (missing body, duplicate names, etc.) are
 * omitted.
 *
 * The TypeMap is only consulted by the selector and the AST→IR lowerer;
 * nothing else depends on it, so the cost is paid once per compilation.
 */
export function buildTypeMap(sourceFile: ts.SourceFile, checker: ts.TypeChecker): TypeMap {
  // Collect function declarations keyed by name. We only track top-level
  // named declarations — nested functions / expressions are out of scope.
  const decls = collectFunctionDeclarations(sourceFile);
  if (decls.size === 0) return new Map();

  // Seed: explicit TS annotations + checker-derived signatures.
  const entries = new Map<string, { params: LatticeType[]; returnType: LatticeType }>();
  const seeds = new Map<string, { params: LatticeType[]; returnType: LatticeType }>();
  for (const [name, fn] of decls) {
    const seed = seedFromDeclaration(fn, checker);
    seeds.set(name, seed);
    entries.set(name, {
      params: [...seed.params],
      returnType: seed.returnType,
    });
  }

  // Build the call graph: callerName → list of (calleeName, argExprs).
  // Only CallExpressions whose callee is an Identifier naming a function
  // in our `decls` map count — everything else is out of reach.
  const callGraph = buildCallGraph(decls);

  // Pre-compute the reverse graph for caller-scoped arg propagation.
  // For each callee, remember every (callerName, argExprs) pair calling it.
  type Inbound = { callerName: string; callerParamNames: readonly string[]; argExprs: readonly ts.Expression[] };
  const inbound = new Map<string, Inbound[]>();
  for (const [callerName, sites] of callGraph) {
    const fn = decls.get(callerName)!;
    const callerParamNames = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ""));
    for (const site of sites) {
      if (!decls.has(site.callee)) continue;
      let arr = inbound.get(site.callee);
      if (!arr) {
        arr = [];
        inbound.set(site.callee, arr);
      }
      arr.push({ callerName, callerParamNames, argExprs: site.argExprs });
    }
  }

  // Worklist fixpoint. Cap iteration count to avoid pathological
  // non-termination (join is monotone on a finite lattice, so this is
  // really just a safety valve).
  const MAX_ITERS = 50;
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    let changed = false;
    for (const [name, fn] of decls) {
      const cur = entries.get(name)!;
      const seed = seeds.get(name)!;

      // --- param types ------------------------------------------------
      // Start from seed (TS annotation / checker). For each caller call
      // site, infer each arg expression's type using the CALLER's
      // current param-scope and join it into our param.
      const newParams: LatticeType[] = seed.params.map((t) => t);
      const inboundSites = inbound.get(name) ?? [];
      for (const site of inboundSites) {
        const callerEntry = entries.get(site.callerName);
        if (!callerEntry) continue;
        const callerScope = new Map<string, LatticeType>();
        for (let i = 0; i < site.callerParamNames.length; i++) {
          if (site.callerParamNames[i]) {
            callerScope.set(site.callerParamNames[i]!, callerEntry.params[i] ?? UNKNOWN);
          }
        }
        for (let i = 0; i < newParams.length && i < site.argExprs.length; i++) {
          const argType = inferExpr(site.argExprs[i]!, callerScope, entries);
          newParams[i] = join(newParams[i]!, argType);
        }
      }

      // --- return type ------------------------------------------------
      // Start from seed. Walk the body tracking scope (params + simple
      // `let`/`const` initializers) and for each return statement join
      // its inferred type.
      //
      // Asymmetric join rule: if the seed is already a concrete primitive
      // and the body inference produces `dynamic`, keep the seed. Our
      // expression inference is deliberately narrow (no property access,
      // no method calls, etc.) — a `dynamic` result often just means we
      // couldn't see through the local structure, not that the function
      // is truly dynamic. Explicit annotations / checker-derived types
      // are more authoritative. For functions whose seed is `unknown`,
      // we fall through to the normal join so genuine body evidence
      // (e.g. "returns a string") still surfaces as dynamic.
      const ownScope = new Map<string, LatticeType>();
      for (let i = 0; i < fn.parameters.length; i++) {
        const p = fn.parameters[i]!;
        if (ts.isIdentifier(p.name)) {
          ownScope.set(p.name.text, newParams[i] ?? UNKNOWN);
        }
      }
      let newReturn: LatticeType = seed.returnType;
      if (fn.body) {
        const seedConcrete = seed.returnType.kind === "f64" || seed.returnType.kind === "bool";
        walkBodyForReturns(fn.body, ownScope, entries, (t) => {
          if (seedConcrete && t.kind === "dynamic") return; // keep seed authority
          newReturn = join(newReturn, t);
        });
      }

      // --- detect change ---------------------------------------------
      if (!paramsEqual(cur.params, newParams) || !typesEqual(cur.returnType, newReturn)) {
        entries.set(name, { params: newParams, returnType: newReturn });
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Freeze into the readonly public shape.
  const out = new Map<string, TypeMapEntry>();
  for (const [name, e] of entries) {
    out.set(name, { params: e.params, returnType: e.returnType });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

function seedFromDeclaration(
  fn: ts.FunctionDeclaration,
  checker: ts.TypeChecker,
): { params: LatticeType[]; returnType: LatticeType } {
  const params: LatticeType[] = [];
  for (const p of fn.parameters) {
    params.push(seedParamType(p, checker));
  }
  const returnType = seedReturnType(fn, checker);
  return { params, returnType };
}

function seedParamType(param: ts.ParameterDeclaration, checker: ts.TypeChecker): LatticeType {
  // Rest / destructured / optional / initializer-holding params are
  // out of Phase-2 scope. They'll fall to `dynamic` here so the
  // selector rejects them cleanly.
  if (param.dotDotDotToken || !ts.isIdentifier(param.name)) return DYNAMIC;
  if (param.questionToken || param.initializer) return DYNAMIC;

  // Explicit TS type node wins and is authoritative.
  if (param.type) {
    const t = typeNodeToLattice(param.type);
    if (t !== null) return t;
    return DYNAMIC;
  }

  // No annotation: ask the checker. This covers JSDoc-typed .js files
  // as well as `implicit-any` locals.
  const ty = checker.getTypeAtLocation(param);
  return tsTypeToLattice(ty, checker);
}

function seedReturnType(fn: ts.FunctionDeclaration, checker: ts.TypeChecker): LatticeType {
  if (fn.type) {
    const t = typeNodeToLattice(fn.type);
    if (t !== null) return t;
    return DYNAMIC;
  }
  const sig = checker.getSignatureFromDeclaration(fn);
  if (!sig) return UNKNOWN;
  const ty = sig.getReturnType();
  return tsTypeToLattice(ty, checker);
}

function typeNodeToLattice(node: ts.TypeNode): LatticeType | null {
  switch (node.kind) {
    case ts.SyntaxKind.NumberKeyword:
      return F64;
    case ts.SyntaxKind.BooleanKeyword:
      return BOOL;
    default:
      return null;
  }
}

function tsTypeToLattice(ty: ts.Type, _checker: ts.TypeChecker): LatticeType {
  const flags = ty.getFlags();
  // Order matters — check the concrete categories first so subtypes of
  // `any` (which also has NumberLike flags in some checker paths) are
  // still picked up.
  if (flags & ts.TypeFlags.NumberLike) return F64;
  if (flags & ts.TypeFlags.BooleanLike) return BOOL;
  // Unresolved / implicit-any / never-inferred leaves us at unknown so
  // propagation can still grow the fact.
  if (flags & ts.TypeFlags.Any || flags & ts.TypeFlags.Unknown) return UNKNOWN;
  // Never is unreachable — treat as unknown so it doesn't kill fixpoint.
  if (flags & ts.TypeFlags.Never) return UNKNOWN;
  // Any other concrete category (string, object, union, enum, …) is out
  // of Phase-2 scope.
  return DYNAMIC;
}

// ---------------------------------------------------------------------------
// Call graph
// ---------------------------------------------------------------------------

interface CallSite {
  readonly callee: string;
  readonly argExprs: readonly ts.Expression[];
}

function buildCallGraph(decls: ReadonlyMap<string, ts.FunctionDeclaration>): Map<string, CallSite[]> {
  const graph = new Map<string, CallSite[]>();
  for (const [name, fn] of decls) {
    if (!fn.body) {
      graph.set(name, []);
      continue;
    }
    const sites: CallSite[] = [];
    const visit = (node: ts.Node): void => {
      // Don't descend into nested function-like nodes — those are out
      // of our top-level-call-graph scope.
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessor(node) ||
        ts.isSetAccessor(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)
      ) {
        // Skip nested functions but only AFTER the top-level one. The
        // guard here catches any inner function-like; the outer fn.body
        // is visited directly below.
        if (node !== fn) return;
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = node.expression.text;
        if (decls.has(callee)) {
          sites.push({ callee, argExprs: node.arguments.slice() });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn.body, visit);
    graph.set(name, sites);
  }
  return graph;
}

// ---------------------------------------------------------------------------
// Expression inference
// ---------------------------------------------------------------------------

/**
 * Structural type of an expression, using the given param/local scope and
 * the current TypeMap iteration state for cross-function return types.
 *
 * Conservative for unsupported nodes → `dynamic`.
 */
function inferExpr(
  expr: ts.Expression,
  scope: ReadonlyMap<string, LatticeType>,
  entries: ReadonlyMap<string, { params: LatticeType[]; returnType: LatticeType }>,
): LatticeType {
  if (ts.isParenthesizedExpression(expr)) {
    return inferExpr(expr.expression, scope, entries);
  }
  if (ts.isNumericLiteral(expr)) return F64;
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return BOOL;
  if (ts.isIdentifier(expr)) {
    return scope.get(expr.text) ?? DYNAMIC;
  }
  if (ts.isPrefixUnaryExpression(expr)) {
    const rand = inferExpr(expr.operand, scope, entries);
    switch (expr.operator) {
      case ts.SyntaxKind.MinusToken:
      case ts.SyntaxKind.PlusToken:
        return f64Compatible(rand) ? F64 : DYNAMIC;
      case ts.SyntaxKind.ExclamationToken:
        return boolCompatible(rand) ? BOOL : DYNAMIC;
      default:
        return DYNAMIC;
    }
  }
  if (ts.isBinaryExpression(expr)) {
    const l = inferExpr(expr.left, scope, entries);
    const r = inferExpr(expr.right, scope, entries);
    switch (expr.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken:
      case ts.SyntaxKind.MinusToken:
      case ts.SyntaxKind.AsteriskToken:
      case ts.SyntaxKind.SlashToken:
        return f64Compatible(l) && f64Compatible(r) ? F64 : DYNAMIC;
      case ts.SyntaxKind.LessThanToken:
      case ts.SyntaxKind.LessThanEqualsToken:
      case ts.SyntaxKind.GreaterThanToken:
      case ts.SyntaxKind.GreaterThanEqualsToken:
        return f64Compatible(l) && f64Compatible(r) ? BOOL : DYNAMIC;
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
        // Both sides must inhabit the same primitive class.
        if (f64Compatible(l) && f64Compatible(r)) return BOOL;
        if (boolCompatible(l) && boolCompatible(r)) return BOOL;
        return DYNAMIC;
      case ts.SyntaxKind.AmpersandAmpersandToken:
      case ts.SyntaxKind.BarBarToken:
        return boolCompatible(l) && boolCompatible(r) ? BOOL : DYNAMIC;
      default:
        return DYNAMIC;
    }
  }
  if (ts.isConditionalExpression(expr)) {
    const cond = inferExpr(expr.condition, scope, entries);
    if (!boolCompatible(cond)) return DYNAMIC;
    return join(inferExpr(expr.whenTrue, scope, entries), inferExpr(expr.whenFalse, scope, entries));
  }
  if (ts.isCallExpression(expr)) {
    if (!ts.isIdentifier(expr.expression)) return DYNAMIC;
    const name = expr.expression.text;
    const entry = entries.get(name);
    if (!entry) return DYNAMIC;
    return entry.returnType;
  }
  return DYNAMIC;
}

function f64Compatible(t: LatticeType): boolean {
  return t.kind === "f64" || t.kind === "unknown";
}

function boolCompatible(t: LatticeType): boolean {
  return t.kind === "bool" || t.kind === "unknown";
}

// ---------------------------------------------------------------------------
// Lattice operations
// ---------------------------------------------------------------------------

function join(a: LatticeType, b: LatticeType): LatticeType {
  if (a.kind === "dynamic" || b.kind === "dynamic") return DYNAMIC;
  if (a.kind === "unknown") return b;
  if (b.kind === "unknown") return a;
  if (a.kind === b.kind) return a;
  return DYNAMIC;
}

function typesEqual(a: LatticeType, b: LatticeType): boolean {
  return a.kind === b.kind;
}

function paramsEqual(a: readonly LatticeType[], b: readonly LatticeType[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!typesEqual(a[i]!, b[i]!)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectFunctionDeclarations(sourceFile: ts.SourceFile): Map<string, ts.FunctionDeclaration> {
  const out = new Map<string, ts.FunctionDeclaration>();
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      // Duplicate names are not our problem — the legacy path already
      // errors on them. We simply prefer the first.
      if (!out.has(stmt.name.text)) out.set(stmt.name.text, stmt);
    }
  }
  return out;
}

/**
 * Walk the function body, tracking `let`/`const` declarations into a
 * mutable scope clone and reporting every reachable `return` expression's
 * inferred type via `cb`. Nested function-like nodes are skipped.
 *
 * This is NOT a full CFG analysis — it's a structural walk that treats
 * `if/else`, blocks, and statement sequences as scope-extending without
 * modeling branch-divergent scope state. For Phase-2-claimable functions
 * (enforced by the selector) the shape is narrow enough that this is
 * equivalent to a proper analysis: no reassignment (let/const only,
 * Phase 1 shape rejects later `x = …`), no break/continue, returns
 * only at tails.
 */
function walkBodyForReturns(
  body: ts.Node,
  paramScope: ReadonlyMap<string, LatticeType>,
  entries: ReadonlyMap<string, { params: LatticeType[]; returnType: LatticeType }>,
  cb: (t: LatticeType) => void,
): void {
  const walk = (node: ts.Node, scope: Map<string, LatticeType>): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessor(node) ||
      ts.isSetAccessor(node) ||
      ts.isClassExpression(node) ||
      ts.isClassDeclaration(node)
    ) {
      return;
    }

    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      const childScope = new Map(scope);
      for (const s of node.statements) walk(s, childScope);
      return;
    }

    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        if (!d.initializer) continue;
        const t = inferExpr(d.initializer, scope, entries);
        scope.set(d.name.text, t);
      }
      return;
    }

    if (ts.isReturnStatement(node)) {
      if (!node.expression) return;
      cb(inferExpr(node.expression, scope, entries));
      return;
    }

    if (ts.isIfStatement(node)) {
      walk(node.thenStatement, scope);
      if (node.elseStatement) walk(node.elseStatement, scope);
      return;
    }

    if (ts.isExpressionStatement(node)) {
      return;
    }

    // Default: recurse, propagating scope. For anything we don't
    // specifically recognize, we still visit children so nested
    // `return` statements inside unexpected statement shapes aren't
    // lost.
    ts.forEachChild(node, (child) => walk(child, scope));
  };

  const rootScope = new Map<string, LatticeType>(paramScope);
  // Body of a FunctionDeclaration is a Block. Walk its statements in
  // the root scope so param types are visible.
  ts.forEachChild(body, (child) => walk(child, rootScope));
}

// Exported for tests — let them poke at the lattice without rebuilding
// everything from scratch.
export const _internals = {
  join,
  inferExpr,
  tsTypeToLattice,
  typeNodeToLattice,
};
