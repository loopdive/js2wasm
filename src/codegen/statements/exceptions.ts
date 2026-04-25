// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Exception handling statement lowering: throw and try-catch.
 */
import ts from "typescript";
import type { Instr } from "../../ir/types.js";
import { popBody, pushBody } from "../context/bodies.js";
import { allocLocal, getLocalType } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { addUnionImports } from "../index.js";
import { addStringConstantGlobal, ensureExnTag } from "../registry/imports.js";
import { coerceType, compileExpression, compileStatement, ensureLateImport, flushLateImportShifts } from "../shared.js";
import { ensureBindingLocals } from "./destructuring.js";
import { adjustRethrowDepth, restoreBlockScopedShadows, saveBlockScopedShadows } from "./shared.js";

/**
 * Walk an Instr tree and bump the `depth` field of `br`/`br_if`/`br_table`
 * instructions by `delta` if their depth equals one of the values in
 * `outerDepths`. Used to retarget cloned finally-body branches when the
 * finally is inserted at a deeper position than where it was compiled
 * (e.g. inside an inner try/catch_all wrapping a catch body — see #993).
 *
 * Internal labels emitted DURING finally compilation (loops/switches inside
 * the finally) push their own depth values onto break/continue stacks; those
 * are NOT in `outerDepths`, so their `br` instructions are left untouched —
 * the relative depth from the br to its internal target is preserved when
 * the whole finally block moves with its labels intact.
 *
 * Note: br_table's `defaultDepth` and per-target depths are also bumped.
 */
function bumpOuterBranchDepths(instrs: Instr[], outerDepths: Set<number>, delta: number): void {
  for (const instr of instrs) {
    const op = (instr as any).op as string;
    if (op === "br" || op === "br_if") {
      const d = (instr as any).depth as number;
      if (outerDepths.has(d)) (instr as any).depth = d + delta;
    } else if (op === "br_table") {
      const targets = (instr as any).targets as number[] | undefined;
      if (Array.isArray(targets)) {
        for (let i = 0; i < targets.length; i++) {
          if (outerDepths.has(targets[i]!)) targets[i] = targets[i]! + delta;
        }
      }
      const dd = (instr as any).defaultDepth;
      if (typeof dd === "number" && outerDepths.has(dd)) (instr as any).defaultDepth = dd + delta;
    }
    // Recurse into nested instr arrays (block/loop/if/try bodies)
    const body = (instr as any).body as Instr[] | undefined;
    if (Array.isArray(body)) bumpOuterBranchDepths(body, outerDepths, delta);
    const elseBody = (instr as any).elseBody as Instr[] | undefined;
    if (Array.isArray(elseBody)) bumpOuterBranchDepths(elseBody, outerDepths, delta);
    const catches = (instr as any).catches as { body: Instr[] }[] | undefined;
    if (Array.isArray(catches)) {
      for (const c of catches) {
        if (Array.isArray(c.body)) bumpOuterBranchDepths(c.body, outerDepths, delta);
      }
    }
    const catchAll = (instr as any).catchAll as Instr[] | undefined;
    if (Array.isArray(catchAll)) bumpOuterBranchDepths(catchAll, outerDepths, delta);
  }
}

function compileExternrefCatchDestructure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.BindingPattern,
  exnLocalIdx: number,
): void {
  // Drop the externref we pushed — we'll use local.get for each property
  fctx.body.push({ op: "drop" });

  if (ts.isObjectBindingPattern(pattern)) {
    // Ensure __extern_get is available
    let getIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);

    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element)) continue;
      const propNameNode = element.propertyName ?? element.name;
      let propNameText: string | undefined;
      if (ts.isIdentifier(propNameNode)) propNameText = propNameNode.text;
      else if (ts.isStringLiteral(propNameNode)) propNameText = propNameNode.text;
      if (!propNameText) continue;

      // Get the local for this binding
      const localName = ts.isIdentifier(element.name) ? element.name.text : undefined;
      if (!localName) continue;
      const localIdx = fctx.localMap.get(localName);
      if (localIdx === undefined) continue;

      addStringConstantGlobal(ctx, propNameText);
      const strGlobalIdx = ctx.stringGlobalMap.get(propNameText);
      if (strGlobalIdx === undefined) continue;

      // Refresh getIdx after potential import shifts
      getIdx = ctx.funcMap.get("__extern_get")!;

      // __extern_get(exnLocal, "propName") -> externref, store to binding local
      fctx.body.push({ op: "local.get", index: exnLocalIdx });
      fctx.body.push({ op: "global.get", index: strGlobalIdx });
      fctx.body.push({ op: "call", funcIdx: getIdx });

      // Coerce externref to the local's declared type if needed
      const localType = getLocalType(fctx, localIdx);
      if (localType && localType.kind !== "externref") {
        coerceType(ctx, fctx, { kind: "externref" }, localType);
      }
      fctx.body.push({ op: "local.set", index: localIdx });
    }
  } else if (ts.isArrayBindingPattern(pattern)) {
    // Array destructuring: use __extern_get(obj, box(index))
    addUnionImports(ctx);
    let getIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    const boxIdx = ctx.funcMap.get("__box_number");

    let idx = 0;
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) {
        idx++;
        continue;
      }
      if (!ts.isBindingElement(element)) {
        idx++;
        continue;
      }

      const localName = ts.isIdentifier(element.name) ? element.name.text : undefined;
      if (!localName) {
        idx++;
        continue;
      }
      const localIdx = fctx.localMap.get(localName);
      if (localIdx === undefined) {
        idx++;
        continue;
      }

      getIdx = ctx.funcMap.get("__extern_get")!;

      // __extern_get(exnLocal, box(index)) -> externref
      fctx.body.push({ op: "local.get", index: exnLocalIdx });
      fctx.body.push({ op: "f64.const", value: idx });
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      }
      fctx.body.push({ op: "call", funcIdx: getIdx });

      const localType = getLocalType(fctx, localIdx);
      if (localType && localType.kind !== "externref") {
        coerceType(ctx, fctx, { kind: "externref" }, localType);
      }
      fctx.body.push({ op: "local.set", index: localIdx });
      idx++;
    }
  }
}

export function compileThrowStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.ThrowStatement): void {
  // Check if this is a rethrow: `throw e` where `e` is the catch variable
  // of an enclosing catch block. If so, emit `rethrow` to preserve the
  // original exception type and stack trace.
  if (
    stmt.expression &&
    ts.isIdentifier(stmt.expression) &&
    fctx.catchRethrowStack &&
    fctx.catchRethrowStack.length > 0
  ) {
    const thrownName = stmt.expression.text;
    // Search from innermost catch outward
    for (let i = fctx.catchRethrowStack.length - 1; i >= 0; i--) {
      const entry = fctx.catchRethrowStack[i]!;
      if (entry.varName === thrownName) {
        fctx.body.push({ op: "rethrow", depth: entry.depth } as any);
        return;
      }
    }
  }

  const tagIdx = ensureExnTag(ctx);

  if (stmt.expression) {
    // Compile the thrown expression — coerce to externref for the exception tag
    const resultType = compileExpression(ctx, fctx, stmt.expression, {
      kind: "externref",
    });
    // If the expression didn't produce externref, coerce it properly
    if (resultType && resultType.kind !== "externref") {
      coerceType(ctx, fctx, resultType, { kind: "externref" });
    } else if (!resultType) {
      // Expression produced no value (void) — push null externref
      fctx.body.push({ op: "ref.null.extern" });
    }
  } else {
    // throw with no expression (unusual but syntactically valid in some contexts)
    fctx.body.push({ op: "ref.null.extern" });
  }

  fctx.body.push({ op: "throw", tagIdx });
}

export function compileTryStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.TryStatement): void {
  const tagIdx = ensureExnTag(ctx);

  // Pre-compile the finally body once so we can clone it into each
  // control-flow path instead of re-compiling the TS statements 2-5 times.
  // This avoids duplicating compilation side-effects and reduces code size
  // variance between insertion points.
  //
  // Depth handling for break/continue/return inside finally (#993):
  // The finally body is inlined inside the try block (which adds 1 label
  // level). So break/continue/return inside finally need depths bumped by
  // +1 vs the outer context. We pre-adjust the depth stacks while compiling
  // finally so that emitted `br` instructions use the correct depth for the
  // primary +1 insertion site (try-body normal exit, catch normal exit,
  // catch_all-only path). For the secondary +2 site (inner try/catch_all
  // wrapping the catch body), we walk the clone and bump br depths by an
  // additional +1 — see `cloneFinallyAtDepth(+2)`.
  let finallyInstrs: Instr[] | null = null;
  // Capture the set of "outer" depth values present in break/continue stacks
  // at the start of finally compilation. Any `br N` in the cloned finally
  // whose N matches one of these (post +1 adjustment) targets an outer label
  // and needs further bumping for +2 insertion sites.
  const outerBreakDepths = new Set<number>();
  if (stmt.finallyBlock) {
    // Pre-adjust break/continue/rethrow depths by +1 because the finally is
    // emitted inside the try block (which adds 1 label level).
    for (let i = 0; i < fctx.breakStack.length; i++) {
      fctx.breakStack[i]!++;
      outerBreakDepths.add(fctx.breakStack[i]!);
    }
    for (let i = 0; i < fctx.continueStack.length; i++) {
      fctx.continueStack[i]!++;
      outerBreakDepths.add(fctx.continueStack[i]!);
    }
    if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth++;
    adjustRethrowDepth(fctx, 1);

    const savedForFinally = pushBody(fctx);
    // Save/restore block-scoped shadows for let/const in the finally block (#817).
    const savedFinallyScope = saveBlockScopedShadows(fctx, stmt.finallyBlock);
    for (const s of stmt.finallyBlock.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedFinallyScope);
    finallyInstrs = fctx.body;
    popBody(fctx, savedForFinally);

    // Restore depths so subsequent try-body compilation increments from the
    // unbumped baseline (lines 201-205 below add their own +1).
    for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
    for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
    if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth--;
    adjustRethrowDepth(fctx, -1);
  }

  /** Return a deep clone of the pre-compiled finally instructions. */
  function cloneFinally(): Instr[] {
    return structuredClone(finallyInstrs!);
  }

  /**
   * Clone the finally instructions and bump `br`/`br_if`/`br_table` depths
   * by `extraDepth` for any branch that targets an outer label (i.e. a depth
   * value present in `outerBreakDepths`). Used for the +2 insertion sites
   * inside the inner try's catch_all that wraps the catch body — those sites
   * are at depth +2 relative to the original outer context, but the cloned
   * finally was compiled at +1.
   */
  function cloneFinallyAtDepth(extraDepth: number): Instr[] {
    const cloned = structuredClone(finallyInstrs!);
    if (extraDepth === 0 || outerBreakDepths.size === 0) return cloned;
    bumpOuterBranchDepths(cloned, outerBreakDepths, extraDepth);
    return cloned;
  }

  // Track finallyInstrs in savedBodies so late import shifts (addUnionImports /
  // flushLateImportShifts) update its function indices during try/catch compilation.
  // Without this, finallyInstrs retains stale pre-shift indices and cloneFinally()
  // produces instructions with wrong call targets.
  if (finallyInstrs) {
    fctx.savedBodies.push(finallyInstrs);
  }

  // Compile the try block body
  const savedBody = pushBody(fctx);

  // Adjust break/continue depths: the try block adds one label level
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth++;
  adjustRethrowDepth(fctx, 1);

  // Push finallyStack entry so return/break/continue inside the try body
  // know to inline the finally instructions before transferring control.
  if (finallyInstrs) {
    if (!fctx.finallyStack) fctx.finallyStack = [];
    fctx.finallyStack.push({
      cloneFinally,
      breakStackLen: fctx.breakStack.length,
      continueStackLen: fctx.continueStack.length,
    });
  }

  // Save/restore block-scoped shadows for let/const in the try block (#817).
  const savedTryScope = saveBlockScopedShadows(fctx, stmt.tryBlock);
  for (const s of stmt.tryBlock.statements) {
    compileStatement(ctx, fctx, s);
  }
  restoreBlockScopedShadows(fctx, savedTryScope);

  // Pop finallyStack before inlining the normal-path finally (avoid double-inline)
  if (finallyInstrs) {
    fctx.finallyStack!.pop();
  }

  // If there's a finally block, inline it at the end of the try body (normal path)
  if (finallyInstrs) {
    fctx.body.push(...cloneFinally());
  }

  const tryBody = fctx.body;

  // Compile catch clause (if present)
  let catches: { tagIdx: number; body: Instr[] }[] = [];
  let catchAllBody: Instr[] | undefined;

  // If there's a finally block but no catch clause, we need a catch_all
  // that runs the finally block and then rethrows the exception.
  if (finallyInstrs && !stmt.catchClause) {
    fctx.body = [];
    fctx.body.push(...cloneFinally());
    fctx.body.push({ op: "rethrow", depth: 0 } as any);
    catchAllBody = fctx.body;
  }

  if (stmt.catchClause) {
    // Allocate the catch variable local (if any) before compiling catch bodies
    // so it's available in both catch $tag and catch_all bodies.
    // Save the previous localMap entry so we can restore it after the catch scope.
    let exnLocalIdx: number | null = null;
    let savedCatchVarIdx: number | undefined;
    if (stmt.catchClause.variableDeclaration && ts.isIdentifier(stmt.catchClause.variableDeclaration.name)) {
      const varName = stmt.catchClause.variableDeclaration.name.text;
      savedCatchVarIdx = fctx.localMap.get(varName);
      exnLocalIdx = allocLocal(fctx, varName, { kind: "externref" });
    } else if (
      stmt.catchClause.variableDeclaration &&
      (ts.isObjectBindingPattern(stmt.catchClause.variableDeclaration.name) ||
        ts.isArrayBindingPattern(stmt.catchClause.variableDeclaration.name))
    ) {
      // Destructuring in catch: `catch ({message})` or `catch ([a, b])`
      // Allocate locals for all binding names so they are in scope
      ensureBindingLocals(ctx, fctx, stmt.catchClause.variableDeclaration.name);
      // Store the exception value in a temp so catch body can reference it
      exnLocalIdx = allocLocal(fctx, `__catch_destruct_${fctx.locals.length}`, { kind: "externref" });
    }

    // Pre-compile the catch clause body once.  When a finally block exists the
    // catch body is placed inside an inner try, so we compile at +1 depth.
    // The resulting instructions are cloned for the catch_all handler.
    //
    // Push the catch variable onto catchRethrowStack so that `throw e` inside
    // the catch body can emit `rethrow` instead of `throw $tag`.
    let catchVarName: string | undefined;
    if (stmt.catchClause.variableDeclaration && ts.isIdentifier(stmt.catchClause.variableDeclaration.name)) {
      catchVarName = stmt.catchClause.variableDeclaration.name.text;
    }

    let catchBodyInstrs: Instr[];
    {
      const prevBody = fctx.body;
      // Track tryBody in savedBodies so late imports during catch body
      // compilation can shift function indices inside it. Without this,
      // tryBody is orphaned and its call instructions get stale indices.
      fctx.savedBodies.push(tryBody);
      fctx.body = [];

      // Push rethrow info: depth starts at 0 (directly inside catch)
      if (catchVarName) {
        if (!fctx.catchRethrowStack) fctx.catchRethrowStack = [];
        fctx.catchRethrowStack.push({ varName: catchVarName, depth: 0 });
      }

      if (finallyInstrs) {
        for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
        for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;
        adjustRethrowDepth(fctx, 1);

        // Push finallyStack so return/break/continue inside catch body also
        // inline the finally instructions before transferring control.
        if (!fctx.finallyStack) fctx.finallyStack = [];
        fctx.finallyStack.push({
          cloneFinally,
          breakStackLen: fctx.breakStack.length,
          continueStackLen: fctx.continueStack.length,
        });
      }

      // Emit catch binding destructuring if the catch variable is a binding pattern
      if (
        exnLocalIdx !== null &&
        stmt.catchClause.variableDeclaration &&
        (ts.isObjectBindingPattern(stmt.catchClause.variableDeclaration.name) ||
          ts.isArrayBindingPattern(stmt.catchClause.variableDeclaration.name))
      ) {
        // Push the caught exception externref, then destructure into binding locals
        fctx.body.push({ op: "local.get", index: exnLocalIdx });
        compileExternrefCatchDestructure(ctx, fctx, stmt.catchClause.variableDeclaration.name, exnLocalIdx);
      }

      // Save/restore block-scoped shadows for let/const in the catch block (#817).
      const savedCatchScope = saveBlockScopedShadows(fctx, stmt.catchClause.block);
      for (const s of stmt.catchClause.block.statements) {
        compileStatement(ctx, fctx, s);
      }
      restoreBlockScopedShadows(fctx, savedCatchScope);
      if (finallyInstrs) {
        // Pop the finallyStack entry we pushed for the catch body
        fctx.finallyStack!.pop();

        for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
        for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
        adjustRethrowDepth(fctx, -1);
      }

      // Pop rethrow info
      if (catchVarName) {
        fctx.catchRethrowStack!.pop();
      }

      catchBodyInstrs = fctx.body;
      fctx.body = prevBody;
      // Remove tryBody from savedBodies (added above for shift tracking)
      const tbIdx = fctx.savedBodies.lastIndexOf(tryBody);
      if (tbIdx >= 0) fctx.savedBodies.splice(tbIdx, 1);
    }

    /** Deep-clone the catch body instructions for reuse in catch_all. */
    function cloneCatchBody(): Instr[] {
      return structuredClone(catchBodyInstrs);
    }

    // Build "catch $exn" body: receives the externref value on the stack
    fctx.body = [];
    if (exnLocalIdx !== null) {
      fctx.body.push({ op: "local.set", index: exnLocalIdx });
    } else {
      fctx.body.push({ op: "drop" });
    }

    if (finallyInstrs) {
      // Wrap catch body in inner try/catch_all so that if the catch body
      // throws, the finally block still executes before the exception
      // propagates.
      // The cloned finally inside the inner catch_all is at +2 depth relative
      // to the original outer context (outer try +1, inner try +1), but the
      // pre-compiled finallyInstrs targets +1. Bump outer branch depths by +1.
      const innerCatchAllBody: Instr[] = [...cloneFinallyAtDepth(1), { op: "rethrow", depth: 0 } as any];

      fctx.body.push({
        op: "try",
        blockType: { kind: "empty" },
        body: catchBodyInstrs,
        catches: [],
        catchAll: innerCatchAllBody,
      } as any);

      // Finally on normal exit path (no exception in catch body) — at +1 depth
      // (the outer try frame), so use the as-compiled clone.
      fctx.body.push(...cloneFinally());
    } else {
      fctx.body.push(...catchBodyInstrs);
    }
    catches = [{ tagIdx, body: fctx.body }];

    // Build "catch_all" body: no value on stack from catch_all itself.
    // Call __get_caught_exception host import to retrieve the foreign JS exception.
    {
      // Track tryBody and catch bodies in savedBodies so late imports
      // (e.g. __get_caught_exception) shift their function indices too.
      fctx.savedBodies.push(tryBody);
      for (const c of catches) fctx.savedBodies.push(c.body);
      fctx.body = [];
      if (exnLocalIdx !== null) {
        const getCaughtIdx = ensureLateImport(ctx, "__get_caught_exception", [], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (getCaughtIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: getCaughtIdx });
          fctx.body.push({ op: "local.set", index: exnLocalIdx });
        }
      }

      if (finallyInstrs) {
        // Same wrapping as catch $exn body above, but with cloned catch body.
        // The cloned finally inside inner catch_all is at +2 depth — bump
        // outer branch depths by +1 (see #993 / cloneFinallyAtDepth above).
        const innerCatchAllBody: Instr[] = [...cloneFinallyAtDepth(1), { op: "rethrow", depth: 0 } as any];

        fctx.body.push({
          op: "try",
          blockType: { kind: "empty" },
          body: cloneCatchBody(),
          catches: [],
          catchAll: innerCatchAllBody,
        } as any);

        fctx.body.push(...cloneFinally());
      } else {
        fctx.body.push(...cloneCatchBody());
      }
      catchAllBody = fctx.body;
      // Remove tryBody and catch bodies from savedBodies (added above)
      for (const c of catches) {
        const ci = fctx.savedBodies.lastIndexOf(c.body);
        if (ci >= 0) fctx.savedBodies.splice(ci, 1);
      }
      const tbIdx2 = fctx.savedBodies.lastIndexOf(tryBody);
      if (tbIdx2 >= 0) fctx.savedBodies.splice(tbIdx2, 1);
    }

    // Restore the previous localMap entry for the catch variable so that
    // variables in outer scopes with the same name are accessible after the
    // catch clause.  (The catch parameter is block-scoped to the catch body.)
    if (stmt.catchClause.variableDeclaration && ts.isIdentifier(stmt.catchClause.variableDeclaration.name)) {
      const varName = stmt.catchClause.variableDeclaration.name.text;
      if (savedCatchVarIdx !== undefined) {
        fctx.localMap.set(varName, savedCatchVarIdx);
      }
    }
  }

  // Remove finallyInstrs from savedBodies now that all cloning is done
  if (finallyInstrs) {
    const fiIdx = fctx.savedBodies.lastIndexOf(finallyInstrs);
    if (fiIdx >= 0) fctx.savedBodies.splice(fiIdx, 1);
  }

  popBody(fctx, savedBody);

  // Restore break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth--;
  adjustRethrowDepth(fctx, -1);

  // Emit the try instruction with catch $tag + catch_all
  fctx.body.push({
    op: "try",
    blockType: { kind: "empty" },
    body: tryBody,
    catches,
    catchAll: catchAllBody,
  });
}

/** Compile a function declaration nested inside another function.
 *  Lifts the function to module level. If it captures outer-scope variables,
 *  uses a closure struct (like arrow closures). Otherwise uses a direct call. */
/**
 * Handle a ClassDeclaration in statement position (inside for loops, if blocks, etc.).
 * Collects the class struct/methods and compiles their bodies immediately.
 */
