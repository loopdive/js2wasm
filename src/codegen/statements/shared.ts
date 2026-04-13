// Copyright (c) 2026 Loopdive GmbH. Licensed under AGPL-3.0.
/**
 * Shared utilities used across all statement sub-modules.
 * No dependencies on other statement sub-modules or on statements.ts itself.
 */
import ts from "typescript";
import type { Instr } from "../../ir/types.js";
import type { FunctionContext } from "../context/types.js";

/**
 * Adjust the depth of all entries in the catchRethrowStack by `delta`.
 * Called wherever breakStack entries are bulk-adjusted for block nesting changes.
 */
export function adjustRethrowDepth(fctx: FunctionContext, delta: number): void {
  if (fctx.catchRethrowStack) {
    for (let i = 0; i < fctx.catchRethrowStack.length; i++) {
      fctx.catchRethrowStack[i]!.depth += delta;
    }
  }
}

/**
 * Collect instructions emitted by `emitFn` into a separate array without
 * appending them to the current `fctx.body`.  This replaces the pervasive
 * "save body / swap / restore" pattern that was duplicated dozens of times.
 */
export function collectInstrs(fctx: FunctionContext, emitFn: () => void): Instr[] {
  const saved = fctx.body;
  // Register saved body so late import shifts can find it (#801).
  // Without this, ensureLateImport/shiftLateImportIndices during emitFn
  // would miss the saved body when updating function indices.
  fctx.savedBodies.push(saved);
  fctx.body = [];
  emitFn();
  const instrs = fctx.body;
  fctx.body = saved;
  fctx.savedBodies.pop();
  return instrs;
}

// ---------------------------------------------------------------------------
// Block scope helpers — used by loops, exceptions, and the dispatcher
// ---------------------------------------------------------------------------

/** Saved state for a block scope: localMap + optional TDZ/const flags */
export interface BlockScopeSave {
  locals: Map<string, number> | null;
  tdzFlags: Map<string, number> | null;
  constBindings: Map<string, boolean> | null;
}

function collectBindingPatternNames(pattern: ts.BindingPattern, names: string[]): void {
  for (const el of pattern.elements) {
    if (ts.isOmittedExpression(el)) continue;
    if (ts.isIdentifier(el.name)) {
      names.push(el.name.text);
    } else if (ts.isObjectBindingPattern(el.name) || ts.isArrayBindingPattern(el.name)) {
      collectBindingPatternNames(el.name, names);
    }
  }
}

/**
 * Collect the names of block-scoped (let/const) variable declarations that
 * are direct children of a block (not nested blocks — those handle their own).
 */
export function collectBlockScopedNames(stmt: ts.Block): string[] {
  const names: string[] = [];
  for (const s of stmt.statements) {
    if (!ts.isVariableStatement(s)) continue;
    const flags = s.declarationList.flags;
    // Only let/const create block-scoped bindings (not var)
    if (!(flags & ts.NodeFlags.Let) && !(flags & ts.NodeFlags.Const)) continue;
    for (const decl of s.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) {
        names.push(decl.name.text);
      }
      // For destructuring patterns, collect all bound names
      else if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
        collectBindingPatternNames(decl.name, names);
      }
    }
  }
  return names;
}

/**
 * Save localMap (and TDZ flag) entries for block-scoped names that shadow
 * existing locals.  Also removes the shadow entries from localMap (and
 * tdzFlagLocals) so that compileVariableStatement will allocate fresh locals.
 * Returns the saved state to restore after the block.
 */
export function saveBlockScopedShadows(fctx: FunctionContext, block: ts.Block): BlockScopeSave | null {
  const blockNames = collectBlockScopedNames(block);
  if (blockNames.length === 0) return null;

  let savedLocals: Map<string, number> | null = null;
  let savedTdz: Map<string, number> | null = null;
  let savedConstBindings: Map<string, boolean> | null = null;
  for (const name of blockNames) {
    if (!savedConstBindings) savedConstBindings = new Map();
    savedConstBindings.set(name, fctx.constBindings?.has(name) ?? false);
    fctx.constBindings?.delete(name);

    const existing = fctx.localMap.get(name);
    if (existing !== undefined) {
      if (!savedLocals) savedLocals = new Map();
      savedLocals.set(name, existing);
      // Remove from localMap so the inner declaration allocates a fresh local
      fctx.localMap.delete(name);
      // Also save and remove any TDZ flag for this name
      if (fctx.tdzFlagLocals) {
        const tdzIdx = fctx.tdzFlagLocals.get(name);
        if (tdzIdx !== undefined) {
          if (!savedTdz) savedTdz = new Map();
          savedTdz.set(name, tdzIdx);
          fctx.tdzFlagLocals.delete(name);
        }
      }
    }
  }
  if (!savedLocals && !savedTdz && !savedConstBindings) return null;
  return { locals: savedLocals, tdzFlags: savedTdz, constBindings: savedConstBindings };
}

/**
 * Restore localMap (and TDZ flag) entries that were saved before entering
 * a block scope.
 */
export function restoreBlockScopedShadows(fctx: FunctionContext, saved: BlockScopeSave | null): void {
  if (!saved) return;
  if (saved.locals) {
    for (const [name, idx] of saved.locals) {
      fctx.localMap.set(name, idx);
    }
  }
  if (saved.tdzFlags) {
    if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
    for (const [name, idx] of saved.tdzFlags) {
      fctx.tdzFlagLocals.set(name, idx);
    }
  }
  if (saved.constBindings) {
    if (!fctx.constBindings) fctx.constBindings = new Set();
    for (const [name, hadConstBinding] of saved.constBindings) {
      if (hadConstBinding) fctx.constBindings.add(name);
      else fctx.constBindings.delete(name);
    }
  }
}
