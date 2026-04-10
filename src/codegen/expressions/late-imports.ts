/**
 * Late import management and undefined emission utilities.
 *
 * Provides helpers for adding imports after compilation has started
 * (late imports), shifting function indices when imports are added,
 * and emitting the JS `undefined` value.
 */
import type { Instr, ValType } from "../../ir/types.js";
import { addFuncType } from "../registry/types.js";
import { addImport } from "../registry/imports.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { walkInstructions } from "../walk-instructions.js";

/**
 * Shift function indices after a late import addition. This must update all
 * already-compiled function bodies, the current function body, any saved bodies
 * from the savedBody swap pattern, and export descriptors.
 */
export function shiftLateImportIndices(
  ctx: CodegenContext,
  fctx: FunctionContext,
  importsBefore: number,
  added: number,
): void {
  if (added <= 0) return;
  function shiftInstrs(instrs: Instr[]): void {
    walkInstructions(instrs, (instr) => {
      if ("funcIdx" in instr && typeof (instr as any).funcIdx === "number") {
        if ((instr as any).funcIdx >= importsBefore) {
          (instr as any).funcIdx += added;
        }
      }
    });
  }
  // Track which body arrays have been shifted to prevent double-shifting.
  // Using a Set avoids reliance on reference equality between bodies that
  // may be the same logical array referenced from multiple places.
  const shifted = new Set<Instr[]>();
  for (const func of ctx.mod.functions) {
    if (!shifted.has(func.body)) {
      shiftInstrs(func.body);
      shifted.add(func.body);
    }
  }
  // Shift current function body (if not already shifted via mod.functions)
  const curBody = fctx.body;
  if (!shifted.has(curBody)) {
    shiftInstrs(curBody);
    shifted.add(curBody);
  }
  // Shift saved body arrays (if not already shifted)
  for (const sb of fctx.savedBodies) {
    if (shifted.has(sb)) continue;
    shiftInstrs(sb);
    shifted.add(sb);
  }
  // Shift parent function contexts on the funcStack (nested closure compilation)
  for (const parentFctx of ctx.funcStack) {
    if (!shifted.has(parentFctx.body)) {
      shiftInstrs(parentFctx.body);
      shifted.add(parentFctx.body);
    }
    for (const sb of parentFctx.savedBodies) {
      if (!shifted.has(sb)) {
        shiftInstrs(sb);
        shifted.add(sb);
      }
    }
  }
  // Shift parent function bodies on parentBodiesStack.
  // Use the same `shifted` set to avoid double-shifting bodies already
  // handled by the funcStack loop above (funcStack.body and
  // parentBodiesStack entries can be the same array).
  for (const pb of ctx.parentBodiesStack) {
    if (!shifted.has(pb)) {
      shiftInstrs(pb);
      shifted.add(pb);
    }
  }
  // Shift the pending init body (module-level init function compiled before
  // top-level functions, but not yet added to ctx.mod.functions).
  if (ctx.pendingInitBody && !shifted.has(ctx.pendingInitBody)) {
    shiftInstrs(ctx.pendingInitBody);
    shifted.add(ctx.pendingInitBody);
  }
  // Shift funcMap entries for defined functions (not import entries).
  // Defined functions had indices >= importsBefore (before the shift) and need
  // to move up by `added`. Import entries (indices < numImportFuncs after addition)
  // are already correct and must not be shifted.
  // Build set of import function names for fast lookup.
  const importNames = new Set<string>();
  for (const imp of ctx.mod.imports) {
    if (imp.desc.kind === "func") importNames.add(imp.name);
  }
  for (const [name, idx] of ctx.funcMap) {
    if (importNames.has(name)) continue; // skip all imports
    if (idx >= importsBefore) {
      ctx.funcMap.set(name, idx + added);
    }
  }
  // Shift export descriptors
  for (const exp of ctx.mod.exports) {
    if (exp.desc.kind === "func" && exp.desc.index >= importsBefore) {
      exp.desc.index += added;
    }
  }
  // Shift table elements
  for (const elem of ctx.mod.elements) {
    if (elem.funcIndices) {
      for (let i = 0; i < elem.funcIndices.length; i++) {
        if (elem.funcIndices[i]! >= importsBefore) {
          elem.funcIndices[i]! += added;
        }
      }
    }
  }
  // Shift declared func refs
  if (ctx.mod.declaredFuncRefs.length > 0) {
    ctx.mod.declaredFuncRefs = ctx.mod.declaredFuncRefs.map((idx) => (idx >= importsBefore ? idx + added : idx));
  }
}

/**
 * Add a late import if it does not already exist, deferring the index shift.
 * Records ctx.pendingLateImportShift.importsBefore on the first deferred addition
 * so that flushLateImportShifts() can do a single O(B) traversal for all imports
 * added in the batch, instead of O(I*B) for I individual additions.
 * Returns the funcIdx of the import (looked up after addImport).
 */
export function ensureLateImport(
  ctx: CodegenContext,
  name: string,
  paramTypes: ValType[],
  resultTypes: ValType[],
): number | undefined {
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  // Record importsBefore on the FIRST deferred addition in this batch
  if (ctx.pendingLateImportShift === null) {
    ctx.pendingLateImportShift = { importsBefore: ctx.numImportFuncs };
  }
  const typeIdx = addFuncType(ctx, paramTypes, resultTypes);
  addImport(ctx, "env", name, { kind: "func", typeIdx });
  return ctx.funcMap.get(name);
}

/**
 * Flush any pending late import shifts. Performs a single traversal of all
 * function bodies to shift indices, instead of one traversal per import.
 * Must be called after a batch of ensureLateImport() calls before any
 * funcIdx values are used in emitted instructions.
 */
export function flushLateImportShifts(ctx: CodegenContext, fctx: FunctionContext): void {
  const pending = ctx.pendingLateImportShift;
  if (pending === null) return;
  const added = ctx.numImportFuncs - pending.importsBefore;
  ctx.pendingLateImportShift = null;
  if (added <= 0) return;
  shiftLateImportIndices(ctx, fctx, pending.importsBefore, added);
}

/**
 * Ensure the __get_undefined host import exists, returning its funcIdx.
 * This import returns the actual JS `undefined` value as externref,
 * allowing Wasm to distinguish null from undefined at runtime.
 */
export function ensureGetUndefined(ctx: CodegenContext): number | undefined {
  return ensureLateImport(ctx, "__get_undefined", [], [{ kind: "externref" }]);
}

/**
 * Emit instructions that push the JS `undefined` value onto the stack.
 * Uses the __get_undefined host import when available; falls back to
 * ref.null.extern (indistinguishable from null) in standalone mode.
 */
export function emitUndefined(ctx: CodegenContext, fctx: FunctionContext): void {
  const funcIdx = ensureGetUndefined(ctx);
  if (funcIdx !== undefined) {
    flushLateImportShifts(ctx, fctx);
    fctx.body.push({ op: "call", funcIdx });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
}

/**
 * Ensure the __extern_is_undefined host import exists, returning its funcIdx.
 * This import checks if an externref value is JS `undefined` (not null).
 */
export function ensureExternIsUndefinedImport(ctx: CodegenContext): number | undefined {
  return ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
}

/**
 * After dynamically adding a field to a struct type, patch all existing
 * struct.new instructions for that type by inserting a default value
 * instruction immediately before each struct.new.  This ensures the
 * operand count matches the (now larger) field list.
 */
export function patchStructNewForAddedField(
  ctx: CodegenContext,
  fctx: FunctionContext,
  typeIdx: number,
  fieldType: ValType,
): void {
  function defaultInstrFor(ft: ValType): Instr {
    switch (ft.kind) {
      case "f64":
        return { op: "f64.const", value: 0 } as Instr;
      case "i32":
        return { op: "i32.const", value: 0 } as Instr;
      case "externref":
        return { op: "ref.null.extern" };
      case "ref":
      case "ref_null":
        return { op: "ref.null", typeIdx: (ft as { typeIdx: number }).typeIdx };
      default:
        if ((ft as any).kind === "i64") {
          return { op: "i64.const", value: 0n };
        }
        if ((ft as any).kind === "eqref") {
          return { op: "ref.null.eq" };
        }
        return { op: "i32.const", value: 0 } as Instr;
    }
  }

  function patchInstrs(instrs: Instr[]): void {
    for (let i = instrs.length - 1; i >= 0; i--) {
      const instr = instrs[i]!;
      if (instr.op === "struct.new" && (instr as any).typeIdx === typeIdx) {
        // Insert a default value right before the struct.new
        instrs.splice(i, 0, defaultInstrFor(fieldType));
      }
      // Recurse into nested blocks
      if ("body" in instr && Array.isArray((instr as any).body)) {
        patchInstrs((instr as any).body);
      }
      if ("then" in instr && Array.isArray((instr as any).then)) {
        patchInstrs((instr as any).then);
      }
      if ("else" in instr && Array.isArray((instr as any).else)) {
        patchInstrs((instr as any).else);
      }
      if ("catches" in instr && Array.isArray((instr as any).catches)) {
        for (const c of (instr as any).catches) {
          if (Array.isArray(c.body)) patchInstrs(c.body);
        }
      }
      if ("catchAll" in instr && Array.isArray((instr as any).catchAll)) {
        patchInstrs((instr as any).catchAll);
      }
    }
  }

  // Patch all already-compiled function bodies
  const patched = new Set<Instr[]>();
  for (const func of ctx.mod.functions) {
    patchInstrs(func.body);
    patched.add(func.body);
  }
  // Patch current function body (if not already part of mod.functions)
  if (!patched.has(fctx.body)) {
    patchInstrs(fctx.body);
    patched.add(fctx.body);
  }
  // Patch saved bodies from the savedBody swap pattern
  for (const sb of fctx.savedBodies) {
    if (!patched.has(sb)) {
      patchInstrs(sb);
      patched.add(sb);
    }
  }
}
