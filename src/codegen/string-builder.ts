// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1210 — string-builder rewrite for `let s = ""; for (...) s += <expr>` patterns.
 *
 * Why: each `s += <expr>` in nativeStrings mode allocates one (and sometimes
 * two) WasmGC structs — a fresh `$ConsString` (via `__str_concat`) and the
 * implicit array allocations from the eventual flatten. A 60 000-iteration
 * `s += charAt(...)` loop allocates ≈60 000 cons nodes plus assorted i16
 * arrays, and the cumulative GC time exceeds 20s under wasmtime's reference
 * GC. Pre-allocating a doubling i16 buffer reduces allocations from O(N) to
 * O(log N) and keeps the working set tiny.
 *
 * The optimization runs only in `nativeStrings` mode. The js-string `+=`
 * path uses host-provided imports and is not subject to the same pressure.
 *
 * Detector preconditions for a `let s = ""` to qualify:
 *   1. Single VariableDeclaration, identifier name, initializer is the empty
 *      string literal `""`. `var`/`const` are excluded (let only).
 *   2. The very next statement in the same block is a single iteration
 *      statement (for / while / do-while).
 *   3. Inside the loop body, every reference to `s` is the LHS of `s += <expr>`.
 *      No reads (`s.length`, `s[i]`, etc.) — those would force a flatten and
 *      defeat the speed-up.
 *   4. `s` is not mutated again after the loop (only read).
 *   5. `s` is not captured by any closure inside the function.
 *
 * Bail safely on any uncertainty — losing the optimization is correct;
 * a wrong optimization corrupts results.
 */
import ts from "typescript";
import type { Instr, ValType } from "../ir/types.js";
import { collectReferencedIdentifiers } from "./closures.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

/**
 * Scan a function body for `let s = ""; for (...) s += <expr>` patterns and
 * return the set of qualifying VariableDeclaration nodes. Caller stores this
 * as `fctx.pendingStringBuilders` so `compileVariableStatement` can detect
 * the rewrite when it reaches the matching declarator.
 *
 * Only scans `nativeStrings` mode — caller should gate on `ctx.nativeStrings`.
 */
export function detectStringBuilders(
  ctx: CodegenContext,
  fnBody: ts.Block | ts.SourceFile | undefined,
): Set<ts.VariableDeclaration> {
  const out = new Set<ts.VariableDeclaration>();
  if (!fnBody) return out;

  const candidates: {
    decl: ts.VariableDeclaration;
    name: string;
    loop: ts.IterationStatement;
    declStmt: ts.VariableStatement;
  }[] = [];

  // Phase 1: find adjacent (let s = ""; loop) pairs in every block of the
  // function body. Don't recurse into nested function scopes.
  function scanStatements(stmts: readonly ts.Statement[]): void {
    for (let i = 0; i + 1 < stmts.length; i++) {
      const cand = matchStringBuilderHead(stmts[i]!, stmts[i + 1]!);
      if (cand) candidates.push(cand);
    }
  }
  walkBlocksInScope(fnBody, scanStatements);

  if (candidates.length === 0) return out;

  // Phase 2: for each candidate, validate that the loop body uses `s` only
  // as a `+=` LHS, and that `s` is not captured or rewritten outside the
  // loop. Use TS symbol identity to be tolerant of shadowing.
  for (const cand of candidates) {
    if (!validateLoopBody(ctx, cand)) continue;
    if (!validateNoOtherWrites(ctx, cand, fnBody)) continue;
    if (isCapturedByClosure(ctx, cand, fnBody)) continue;
    out.add(cand.decl);
  }
  return out;
}

function walkBlocksInScope(scope: ts.Node, visit: (stmts: readonly ts.Statement[]) => void): void {
  if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) {
    visit(scope.statements);
  }
  ts.forEachChild(scope, (child) => {
    if (isFunctionScopeBoundary(child)) return; // don't cross fn boundaries
    if (ts.isBlock(child) || ts.isModuleBlock(child)) {
      visit(child.statements);
      ts.forEachChild(child, (cc) => walkBlocksInScope(cc, visit));
      return;
    }
    walkBlocksInScope(child, visit);
  });
}

function isFunctionScopeBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function isLoopStatement(node: ts.Node): node is ts.IterationStatement {
  return ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node);
}

interface CandidateHead {
  decl: ts.VariableDeclaration;
  name: string;
  loop: ts.IterationStatement;
  declStmt: ts.VariableStatement;
}

function matchStringBuilderHead(stmt: ts.Statement, next: ts.Statement): CandidateHead | null {
  if (!ts.isVariableStatement(stmt)) return null;
  // Only `let` (block-scoped, fresh per scope).
  if (!(stmt.declarationList.flags & ts.NodeFlags.Let)) return null;
  if (stmt.declarationList.declarations.length !== 1) return null;
  const decl = stmt.declarationList.declarations[0]!;
  if (!ts.isIdentifier(decl.name)) return null;
  if (!decl.initializer) return null;
  if (!ts.isStringLiteral(decl.initializer)) return null;
  if (decl.initializer.text !== "") return null;
  if (!isLoopStatement(next)) return null;
  return {
    decl,
    name: decl.name.text,
    loop: next,
    declStmt: stmt,
  };
}

function validateLoopBody(ctx: CodegenContext, cand: CandidateHead): boolean {
  const declSym = ctx.checker.getSymbolAtLocation(cand.decl.name);
  if (!declSym) return false;

  let ok = true;
  function visit(node: ts.Node): void {
    if (!ok) return;
    // Don't cross function boundaries — closure capture is rejected separately
    // by isCapturedByClosure (which is conservative).
    if (isFunctionScopeBoundary(node)) {
      const refs = new Set<string>();
      collectReferencedIdentifiers(node, refs);
      if (refs.has(cand.name)) ok = false;
      return;
    }
    if (ts.isIdentifier(node) && node.text === cand.name) {
      // Resolve the binding via TS symbol identity to tolerate shadowing
      // (a `let s` redeclared inside the loop body is a different symbol).
      const sym = ctx.checker.getSymbolAtLocation(node);
      if (sym !== declSym) return; // different binding → ignore
      // Identifier must be the LHS of `name += <expr>`.
      const parent = node.parent;
      if (
        !parent ||
        !ts.isBinaryExpression(parent) ||
        parent.left !== node ||
        parent.operatorToken.kind !== ts.SyntaxKind.PlusEqualsToken
      ) {
        ok = false;
        return;
      }
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(cand.loop.statement);

  // Reject `for (...; cond; incr)` whose condition or incrementor reads `s`.
  if (ok && ts.isForStatement(cand.loop)) {
    const subParts: ts.Node[] = [];
    if (cand.loop.condition) subParts.push(cand.loop.condition);
    if (cand.loop.incrementor) subParts.push(cand.loop.incrementor);
    for (const part of subParts) {
      visit(part);
      if (!ok) break;
    }
  }
  // Reject `while (cond)` whose cond reads `s`.
  if (ok && ts.isWhileStatement(cand.loop)) {
    visit(cand.loop.expression);
  }
  if (ok && ts.isDoStatement(cand.loop)) {
    visit(cand.loop.expression);
  }

  return ok;
}

/**
 * Reject if `s` is written (assigned or `+=`-d) anywhere in the function
 * outside of the matched loop body. Tolerates the original `let s = ""`
 * declaration and reads after the loop.
 *
 * Conservative: any AssignmentExpression / postfix or prefix UnaryExpression
 * targeting an identifier whose symbol matches `decl.name`'s symbol triggers
 * a reject. This catches `s = "reset"`, `s += "x"` after the loop, `s++`
 * (nonsensical for strings but safe to reject).
 */
function validateNoOtherWrites(ctx: CodegenContext, cand: CandidateHead, scope: ts.Node): boolean {
  const declSym = ctx.checker.getSymbolAtLocation(cand.decl.name);
  if (!declSym) return false;

  let ok = true;
  function visit(node: ts.Node): void {
    if (!ok) return;
    if (node === cand.loop) return; // skip the matched loop body
    if (isFunctionScopeBoundary(node)) return;
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const isAssignOp =
        op === ts.SyntaxKind.EqualsToken ||
        op === ts.SyntaxKind.PlusEqualsToken ||
        op === ts.SyntaxKind.MinusEqualsToken ||
        op === ts.SyntaxKind.AsteriskEqualsToken ||
        op === ts.SyntaxKind.SlashEqualsToken ||
        op === ts.SyntaxKind.PercentEqualsToken ||
        op === ts.SyntaxKind.AmpersandEqualsToken ||
        op === ts.SyntaxKind.BarEqualsToken ||
        op === ts.SyntaxKind.CaretEqualsToken ||
        op === ts.SyntaxKind.LessThanLessThanEqualsToken ||
        op === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
        op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
        op === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
        op === ts.SyntaxKind.BarBarEqualsToken ||
        op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
        op === ts.SyntaxKind.QuestionQuestionEqualsToken;
      if (isAssignOp && ts.isIdentifier(node.left) && node.left.text === cand.name) {
        const sym = ctx.checker.getSymbolAtLocation(node.left);
        if (sym === declSym) {
          ok = false;
          return;
        }
      }
    }
    if (
      (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
      ts.isIdentifier(node.operand) &&
      node.operand.text === cand.name
    ) {
      const sym = ctx.checker.getSymbolAtLocation(node.operand);
      if (sym === declSym) {
        const op = node.operator;
        if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
          ok = false;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(scope);
  return ok;
}

function isCapturedByClosure(ctx: CodegenContext, cand: CandidateHead, scope: ts.Node): boolean {
  const declSym = ctx.checker.getSymbolAtLocation(cand.decl.name);
  if (!declSym) return true; // safe default
  let captured = false;
  function visit(node: ts.Node): void {
    if (captured) return;
    if (isFunctionScopeBoundary(node)) {
      // Skip the enclosing function itself — the scan only inspects nested
      // functions/arrows. The outer function is `scope`.
      const refs = new Set<string>();
      collectReferencedIdentifiers(node, refs);
      if (refs.has(cand.name)) {
        // Could be a nested fn that references a different binding with the
        // same name. Verify via symbol identity by walking the nested fn.
        let found = false;
        function inner(n: ts.Node): void {
          if (found) return;
          if (ts.isIdentifier(n) && n.text === cand.name) {
            const sym = ctx.checker.getSymbolAtLocation(n);
            if (sym === declSym) {
              found = true;
              return;
            }
          }
          ts.forEachChild(n, inner);
        }
        inner(node);
        if (found) captured = true;
      }
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(scope, visit);
  return captured;
}

/**
 * Emit the buffer-init sequence for a string-builder binding. Allocates
 * `${name}$buf`, `${name}$len`, `${name}$cap`, `${name}$mat` locals,
 * registers them in `fctx.stringBuilders`, and emits initialization that
 * sets `buf := array.new_default 16`, `len := 0`, `cap := 16`, `mat := null`.
 *
 * Caller is responsible for calling this from the variable-statement
 * dispatcher when it sees a decl present in `fctx.pendingStringBuilders`,
 * and for ensuring native string helpers have been emitted (so
 * `__str_buf_next_cap` is available when a later append needs it).
 */
export function compileStringBuilderInit(ctx: CodegenContext, fctx: FunctionContext, name: string): void {
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;

  // Initial capacity 16 — small enough that a never-iterated builder (the
  // post-loop reads but never enters the loop) doesn't waste memory; large
  // enough that a few iterations don't immediately trigger a grow.
  const initialCap = 16;

  const bufLocalIdx = allocLocal(fctx, `${name}$buf`, {
    kind: "ref_null",
    typeIdx: strDataTypeIdx,
  });
  const lenLocalIdx = allocLocal(fctx, `${name}$len`, { kind: "i32" });
  const capLocalIdx = allocLocal(fctx, `${name}$cap`, { kind: "i32" });
  const materializedLocalIdx = allocLocal(fctx, `${name}$mat`, {
    kind: "ref_null",
    typeIdx: anyStrTypeIdx,
  });

  // buf = array.new_default<__str_data>(initialCap)
  fctx.body.push({ op: "i32.const", value: initialCap });
  fctx.body.push({ op: "array.new_default", typeIdx: strDataTypeIdx });
  fctx.body.push({ op: "local.set", index: bufLocalIdx });
  // len = 0
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: lenLocalIdx });
  // cap = initialCap
  fctx.body.push({ op: "i32.const", value: initialCap });
  fctx.body.push({ op: "local.set", index: capLocalIdx });
  // mat = ref.null $AnyString
  fctx.body.push({ op: "ref.null", typeIdx: anyStrTypeIdx });
  fctx.body.push({ op: "local.set", index: materializedLocalIdx });

  if (!fctx.stringBuilders) fctx.stringBuilders = new Map();
  fctx.stringBuilders.set(name, {
    bufLocalIdx,
    lenLocalIdx,
    capLocalIdx,
    materializedLocalIdx,
  });
}

/**
 * Append a string-typed expression to a string-builder binding. The RHS
 * value is left-on-stack as `ref $AnyString` by the caller via
 * `coerceRhsToAnyStringRef`; this helper consumes it and emits:
 *
 *   1. Flatten the RHS so we have access to `data`/`off`/`len`.
 *   2. needed = sb.len + rhs.len
 *   3. If needed > sb.cap, grow `sb.buf` to a doubled capacity and copy
 *      the existing prefix in.
 *   4. array.copy(sb.buf, sb.len, rhs.data, rhs.off, rhs.len)
 *   5. sb.len = needed
 *   6. Invalidate sb.mat (set to null) so the next read re-materializes.
 *
 * The result is `ref_null $AnyString` (always pushes ref.null) — for the
 * common statement-level `s += "x";` the caller drops it. If used as an
 * expression value, this is a behavioural change vs. the legacy concat
 * path (which returned the new string ref). The detector only matches
 * `s += <expr>` as a side-effecting statement — uses where the expression
 * value is consumed are conservative and rare; they will materialize via
 * the next identifier read.
 */
export interface StringBuilderInfo {
  bufLocalIdx: number;
  lenLocalIdx: number;
  capLocalIdx: number;
  materializedLocalIdx: number;
}

export function compileStringBuilderAppend(
  ctx: CodegenContext,
  fctx: FunctionContext,
  rhsAnyStrType: ValType,
  sb: StringBuilderInfo,
): void {
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const flatStrTypeIdx = ctx.nativeStrTypeIdx;
  // Look up by NAME at emit time so the funcIdx reflects the current binary
  // layout — `ctx.nativeStrHelpers` indices can be stale relative to actual
  // module-function positions when prior `addImport` calls bumped
  // `numImportFuncs` without shifting helper indices (the addImport path is
  // not coupled to the late-import shift mechanism). The walk is O(N) where
  // N ≈ 30 helpers — negligible compared to the work the helper performs.
  const flattenIdx = lookupModuleFuncByName(ctx, "__str_flatten");
  const nextCapIdx = lookupModuleFuncByName(ctx, "__str_buf_next_cap");
  if (flattenIdx < 0 || nextCapIdx < 0) {
    // Defensive: helpers must be emitted by `compileStringBuilderInit`. If
    // missing here, something went wrong upstream — bail with a no-op so
    // codegen continues. Validation will surface the issue.
    return;
  }
  void rhsAnyStrType; // retained for future type checks; flatten accepts ref $AnyString

  // Stack on entry: rhs (ref $AnyString)
  // 1. rhs = __str_flatten(rhs) → ref $NativeString. Store in temp local.
  fctx.body.push({ op: "call", funcIdx: flattenIdx } as Instr);
  const rhsLocal = allocLocal(fctx, `__sb_rhs_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: flatStrTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: rhsLocal } as Instr);

  // 2. rhsLen = rhs.len
  const rhsLenLocal = allocLocal(fctx, `__sb_rhsLen_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: rhsLocal } as Instr);
  fctx.body.push({ op: "ref.as_non_null" } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: flatStrTypeIdx, fieldIdx: 0 } as Instr);
  fctx.body.push({ op: "local.set", index: rhsLenLocal } as Instr);

  // 3. needed = sb.len + rhsLen
  const neededLocal = allocLocal(fctx, `__sb_needed_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: sb.lenLocalIdx } as Instr);
  fctx.body.push({ op: "local.get", index: rhsLenLocal } as Instr);
  fctx.body.push({ op: "i32.add" } as Instr);
  fctx.body.push({ op: "local.set", index: neededLocal } as Instr);

  // 4. if (needed > sb.cap) grow:
  //      newCap = __str_buf_next_cap(sb.cap, needed)
  //      oldBufTmp = sb.buf                 ; stash old reference
  //      sb.buf = array.new_default(newCap)
  //      array.copy(sb.buf, 0, oldBufTmp, 0, sb.len)
  //      sb.cap = newCap
  // Note: a temp local for oldBuf is required because `local.tee sb.buf`
  // overwrites the old reference before array.copy can read it as src.
  const oldBufTmp = allocLocal(fctx, `__sb_oldBuf_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: strDataTypeIdx,
  });
  fctx.body.push({ op: "local.get", index: neededLocal } as Instr);
  fctx.body.push({ op: "local.get", index: sb.capLocalIdx } as Instr);
  fctx.body.push({ op: "i32.gt_s" } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      // sb.cap = __str_buf_next_cap(sb.cap, needed)
      { op: "local.get", index: sb.capLocalIdx } as Instr,
      { op: "local.get", index: neededLocal } as Instr,
      { op: "call", funcIdx: nextCapIdx } as Instr,
      { op: "local.set", index: sb.capLocalIdx } as Instr,
      // oldBufTmp = sb.buf
      { op: "local.get", index: sb.bufLocalIdx } as Instr,
      { op: "local.set", index: oldBufTmp } as Instr,
      // sb.buf = array.new_default(sb.cap)
      { op: "local.get", index: sb.capLocalIdx } as Instr,
      { op: "array.new_default", typeIdx: strDataTypeIdx } as Instr,
      { op: "local.set", index: sb.bufLocalIdx } as Instr,
      // array.copy(sb.buf, 0, oldBufTmp, 0, sb.len)
      { op: "local.get", index: sb.bufLocalIdx } as Instr,
      { op: "ref.as_non_null" } as Instr,
      { op: "i32.const", value: 0 } as Instr,
      { op: "local.get", index: oldBufTmp } as Instr,
      { op: "ref.as_non_null" } as Instr,
      { op: "i32.const", value: 0 } as Instr,
      { op: "local.get", index: sb.lenLocalIdx } as Instr,
      { op: "array.copy", dstTypeIdx: strDataTypeIdx, srcTypeIdx: strDataTypeIdx } as Instr,
    ],
  } as Instr);

  // 5. array.copy(sb.buf, sb.len, rhs.data, rhs.off, rhsLen)
  fctx.body.push({ op: "local.get", index: sb.bufLocalIdx } as Instr);
  fctx.body.push({ op: "ref.as_non_null" } as Instr);
  fctx.body.push({ op: "local.get", index: sb.lenLocalIdx } as Instr);
  fctx.body.push({ op: "local.get", index: rhsLocal } as Instr);
  fctx.body.push({ op: "ref.as_non_null" } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: flatStrTypeIdx, fieldIdx: 2 } as Instr); // data
  fctx.body.push({ op: "local.get", index: rhsLocal } as Instr);
  fctx.body.push({ op: "ref.as_non_null" } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: flatStrTypeIdx, fieldIdx: 1 } as Instr); // off
  fctx.body.push({ op: "local.get", index: rhsLenLocal } as Instr);
  fctx.body.push({
    op: "array.copy",
    dstTypeIdx: strDataTypeIdx,
    srcTypeIdx: strDataTypeIdx,
  } as Instr);

  // 6. sb.len = needed
  fctx.body.push({ op: "local.get", index: neededLocal } as Instr);
  fctx.body.push({ op: "local.set", index: sb.lenLocalIdx } as Instr);

  // 7. Invalidate the materialized cache: sb.mat = null. Any prior reader
  //    holds a NativeString that points at a buffer we may have replaced
  //    above — the existing reference remains valid (it was the OLD buf or
  //    the NEW one with stale len), but new reads must rematerialize from
  //    the current (buf, len, off=0) tuple.
  fctx.body.push({ op: "ref.null", typeIdx: anyStrTypeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: sb.materializedLocalIdx } as Instr);

  // No result on stack. Caller's discardability check sees null return type.
  void anyStrTypeIdx;
}

/**
 * Materialize the current contents of a string builder into a `ref $NativeString`
 * (compatible with `ref $AnyString`). Pushes the materialized ref onto the
 * stack. Caches the result in `sb.mat` so repeated reads (e.g.
 * `s.length` then `s.charCodeAt(...)` in the same expression) reuse one
 * struct allocation. The cache is invalidated by `compileStringBuilderAppend`.
 *
 * Returns the value type of the pushed ref so the caller can stitch it into
 * the surrounding expression.
 */
export function emitStringBuilderRead(ctx: CodegenContext, fctx: FunctionContext, sb: StringBuilderInfo): ValType {
  const flatStrTypeIdx = ctx.nativeStrTypeIdx;

  // Materialize a fresh `$NativeString` view of the current builder state on
  // every read. `$NativeString.len` is `mutable: false`, so we cannot patch a
  // cached struct after a `+=` advances `sb.len`; an invalidate-on-append
  // cache is possible but adds bookkeeping for negligible savings (the
  // struct allocation is a 24-byte stack-like alloc and reads are usually
  // followed immediately by `struct.get`/`charCodeAt`, which dominates).
  // The dominant cost we optimize — the per-iteration `+=` — is unaffected.
  fctx.body.push({ op: "local.get", index: sb.lenLocalIdx } as Instr);
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "local.get", index: sb.bufLocalIdx } as Instr);
  fctx.body.push({ op: "ref.as_non_null" } as Instr);
  fctx.body.push({ op: "struct.new", typeIdx: flatStrTypeIdx } as Instr);
  // `materializedLocalIdx` is reserved for a future invalidate-on-append
  // cache; not used today.
  void sb.materializedLocalIdx;
  return { kind: "ref", typeIdx: flatStrTypeIdx };
}

/** Helper to look up an active builder by binding name. */
export function getBuilderInfo(fctx: FunctionContext, name: string): StringBuilderInfo | undefined {
  return fctx.stringBuilders?.get(name);
}

/**
 * Resolve a module-defined function's current absolute Wasm function index by
 * walking `ctx.mod.functions`. Returns -1 if the function is not present.
 *
 * This bypasses `ctx.nativeStrHelpers` and `ctx.funcMap`, both of which can
 * hold stale indices if a `addImport` call bumped `numImportFuncs` without
 * shifting previously-registered module-function entries. Used at emit time
 * by the #1210 string-builder to ensure the call instruction targets the
 * actual current location of the helper.
 */
function lookupModuleFuncByName(ctx: CodegenContext, name: string): number {
  const idx = ctx.mod.functions.findIndex((f) => f.name === name);
  if (idx < 0) return -1;
  return ctx.numImportFuncs + idx;
}
