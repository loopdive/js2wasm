// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Import/global registry ownership for the backend.
 *
 * This module owns low-level Wasm import registration plus the global-index
 * fixups required when late import globals are inserted during codegen.
 */
import type { Import, Instr, TagDef } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { addFuncType } from "./types.js";

export function addImport(ctx: CodegenContext, module: string, name: string, desc: Import["desc"]): void {
  ctx.mod.imports.push({ module, name, desc });
  if (desc.kind === "func") {
    ctx.funcMap.set(name, ctx.numImportFuncs);
    ctx.numImportFuncs++;
  }
  if (desc.kind === "global") {
    ctx.numImportGlobals++;
  }
}

/**
 * Register a string literal as a global import from the "string_constants"
 * namespace and repair already-compiled module-global references if needed.
 *
 * In `nativeStrings` mode (auto-on for `--target wasi`), no JS host runtime
 * exists to satisfy the import, so we skip the import and just record the
 * string in `stringGlobalMap` with the sentinel `-1` (the same convention
 * used by `collectStringLiterals` finalize). Call sites that materialize a
 * string constant onto the stack must check the sentinel and use the native
 * string path (`compileNativeStringLiteral` + `extern.convert_any` for the
 * externref-typed throw payload) instead of `global.get`. (#1174)
 */
export function addStringConstantGlobal(ctx: CodegenContext, value: string): void {
  if (ctx.stringGlobalMap.has(value)) return;

  if (ctx.nativeStrings) {
    // Sentinel: no host import, materialize inline at use sites.
    ctx.stringGlobalMap.set(value, -1);
    ctx.stringLiteralMap.set(value, `__str_${ctx.stringLiteralCounter}`);
    ctx.stringLiteralValues.set(`__str_${ctx.stringLiteralCounter}`, value);
    ctx.stringLiteralCounter++;
    ctx.mod.stringPool.push(value);
    return;
  }

  const hasModuleGlobals = ctx.mod.globals.length > 0 || ctx.mod.functions.length > 0;
  const oldNumImportGlobals = ctx.numImportGlobals;

  const globalIdx = ctx.numImportGlobals;
  addImport(ctx, "string_constants", value, {
    kind: "global",
    type: { kind: "externref" },
    mutable: false,
  });
  ctx.stringGlobalMap.set(value, globalIdx);
  ctx.stringLiteralMap.set(value, `__str_${ctx.stringLiteralCounter}`);
  ctx.stringLiteralValues.set(`__str_${ctx.stringLiteralCounter}`, value);
  ctx.stringLiteralCounter++;
  ctx.mod.stringPool.push(value);

  if (hasModuleGlobals) {
    fixupModuleGlobalIndices(ctx, oldNumImportGlobals, 1);
  }
}

/** Return the absolute Wasm global index for a new module-defined global. */
export function nextModuleGlobalIdx(ctx: CodegenContext): number {
  return ctx.numImportGlobals + ctx.mod.globals.length;
}

/** Convert an absolute Wasm global index to a local module-globals array index. */
export function localGlobalIdx(ctx: CodegenContext, absIdx: number): number {
  return absIdx - ctx.numImportGlobals;
}

/**
 * Lazily register the exception tag used by throw/try-catch.
 * The tag has signature (externref) — all thrown values are externref.
 */
export function ensureExnTag(ctx: CodegenContext): number {
  if (ctx.exnTagIdx >= 0) return ctx.exnTagIdx;
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], []);
  const tagDef: TagDef = { name: "__exn", typeIdx };
  ctx.exnTagIdx = ctx.mod.tags.length;
  ctx.mod.tags.push(tagDef);
  return ctx.exnTagIdx;
}

/**
 * Fix up module-global absolute indices in all compiled function bodies when
 * new import globals are inserted after module globals already exist.
 */
function fixupModuleGlobalIndices(ctx: CodegenContext, threshold: number, delta: number): void {
  // The `shifted` set tracks every Instr[] we've already adjusted in THIS call
  // so that no body is shifted twice. Tracking happens inside `shiftGlobalIndices`
  // so the guard covers BOTH top-level entries AND nested bodies reached via
  // recursion (if/then/else, block.body, try.catches). The previous version
  // only added top-level entries to the set, which let recursively-shifted
  // bodies be re-shifted via duplicate `savedBodies` entries — a leak that
  // accumulates whenever pushBody is paired with `fctx.body = saved` instead
  // of `popBody` (#1303). The compileBitwiseBinaryOp site in lodash-es
  // mergeData reproduced this: a global.get whose final shifted index
  // landed past WRAP_ARY_FLAG and into the externref tail of the global
  // table, so f64.trunc fired against an externref operand. (#1305)
  const shifted = new Set<Instr[]>();
  function shiftGlobalIndices(instrs: Instr[]): void {
    if (shifted.has(instrs)) return;
    shifted.add(instrs);
    for (const instr of instrs) {
      if ((instr.op === "global.get" || instr.op === "global.set") && instr.index >= threshold) {
        instr.index += delta;
      }
      if ("body" in instr && Array.isArray((instr as any).body)) {
        shiftGlobalIndices((instr as any).body);
      }
      if ("then" in instr && Array.isArray((instr as any).then)) {
        shiftGlobalIndices((instr as any).then);
      }
      if ("else" in instr && Array.isArray((instr as any).else)) {
        shiftGlobalIndices((instr as any).else);
      }
      if ("catches" in instr && Array.isArray((instr as any).catches)) {
        for (const c of (instr as any).catches) {
          if (Array.isArray(c.body)) shiftGlobalIndices(c.body);
        }
      }
      if ("catchAll" in instr && Array.isArray((instr as any).catchAll)) {
        shiftGlobalIndices((instr as any).catchAll);
      }
    }
  }

  for (const func of ctx.mod.functions) {
    shiftGlobalIndices(func.body);
  }

  if (ctx.currentFunc) {
    shiftGlobalIndices(ctx.currentFunc.body);
    for (const sb of ctx.currentFunc.savedBodies) {
      shiftGlobalIndices(sb);
    }
  }

  for (const parentFctx of ctx.funcStack) {
    shiftGlobalIndices(parentFctx.body);
    for (const sb of parentFctx.savedBodies) {
      shiftGlobalIndices(sb);
    }
  }

  for (const pb of ctx.parentBodiesStack) {
    shiftGlobalIndices(pb);
  }

  if (ctx.pendingInitBody) {
    shiftGlobalIndices(ctx.pendingInitBody);
  }

  for (const g of ctx.mod.globals) {
    if (g.init) shiftGlobalIndices(g.init);
  }

  function shiftMap(map: Map<string, number>): void {
    for (const [key, idx] of map) {
      if (idx >= threshold) {
        map.set(key, idx + delta);
      }
    }
  }
  shiftMap(ctx.moduleGlobals);
  shiftMap(ctx.capturedGlobals);
  shiftMap(ctx.staticProps);
  shiftMap(ctx.protoGlobals);
  shiftMap(ctx.tdzGlobals);

  for (const entry of ctx.staticInitExprs) {
    if (entry.globalIdx >= threshold) {
      entry.globalIdx += delta;
    }
  }

  if (ctx.symbolCounterGlobalIdx >= threshold) {
    ctx.symbolCounterGlobalIdx += delta;
  }
  if (ctx.wasiBumpPtrGlobalIdx >= threshold) {
    ctx.wasiBumpPtrGlobalIdx += delta;
  }
  if (ctx.argcGlobalIdx >= threshold) {
    ctx.argcGlobalIdx += delta;
  }
  if (ctx.extrasArgvGlobalIdx >= threshold) {
    ctx.extrasArgvGlobalIdx += delta;
  }
}
