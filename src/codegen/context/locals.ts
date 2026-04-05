/**
 * Local-slot allocation helpers.
 *
 * This module owns parameter/local slot bookkeeping and temporary-local reuse.
 */
import type { Instr, ValType } from "../../ir/types.js";
import type { FunctionContext } from "./types.js";
import { walkChildren } from "../walk-instructions.js";

export function allocLocal(fctx: FunctionContext, name: string, type: ValType): number {
  const index = fctx.params.length + fctx.locals.length;
  fctx.locals.push({ name, type });
  fctx.localMap.set(name, index);
  return index;
}

function valTypeKey(type: ValType): string {
  switch (type.kind) {
    case "ref":
      return `ref:${type.typeIdx}`;
    case "ref_null":
      return `ref_null:${type.typeIdx}`;
    default:
      return type.kind;
  }
}

export function allocTempLocal(fctx: FunctionContext, type: ValType): number {
  if (!fctx.tempFreeList) fctx.tempFreeList = new Map();
  const key = valTypeKey(type);
  const bucket = fctx.tempFreeList.get(key);
  if (bucket && bucket.length > 0) {
    return bucket.pop()!;
  }
  return allocLocal(fctx, `__tmp_${fctx.locals.length}`, type);
}

export function releaseTempLocal(fctx: FunctionContext, index: number): void {
  const type = getLocalType(fctx, index);
  if (!type) return;
  if (!fctx.tempFreeList) fctx.tempFreeList = new Map();
  const key = valTypeKey(type);
  let bucket = fctx.tempFreeList.get(key);
  if (!bucket) {
    bucket = [];
    fctx.tempFreeList.set(key, bucket);
  }
  bucket.push(index);
}

export function getLocalType(fctx: FunctionContext, index: number): ValType | undefined {
  if (index < fctx.params.length) return fctx.params[index]!.type;
  const localIdx = index - fctx.params.length;
  return fctx.locals[localIdx]?.type;
}

/**
 * Post-processing pass: eliminate duplicate local declarations.
 *
 * When the same variable name appears more than once in fctx.locals (due to
 * sibling block scopes, try/catch blocks, or for-loops with the same counter
 * name), this merges the duplicates by:
 * 1. Keeping the first occurrence of each name (lowest index)
 * 2. Rewriting all local.get/set/tee instructions that reference duplicate
 *    slots to use the canonical (first) slot instead
 * 3. Compacting fctx.locals to remove the now-unreferenced duplicate entries
 *
 * This handles ALL remaining duplicate local patterns uniformly, regardless
 * of how they were generated (sibling for-loops, try/catch, for-of, etc.).
 */
export function deduplicateLocals(fctx: FunctionContext): void {
  const paramCount = fctx.params.length;
  const n = fctx.locals.length;
  if (n === 0) return;

  // First pass: find which relative indices are duplicates.
  // Only merge locals that share both the same name AND the same type —
  // same-name locals with different types are not interchangeable (#962).
  const nameToFirstRel = new Map<string, number>();
  const isDuplicate = new Uint8Array(n); // 0 = keep, 1 = duplicate

  for (let i = 0; i < n; i++) {
    const local = fctx.locals[i]!;
    const key = local.name + "\0" + valTypeKey(local.type);
    if (nameToFirstRel.has(key)) {
      isDuplicate[i] = 1;
    } else {
      nameToFirstRel.set(key, i);
    }
  }

  if (!isDuplicate.some(Boolean)) return; // nothing to deduplicate

  // Second pass: compute new absolute index for each old relative index.
  // Kept locals are compacted (earlier duplicates shift indices down).
  // Duplicate locals map to the new absolute index of their canonical slot.
  const relToNewAbs = new Int32Array(n).fill(-1);
  let kept = 0;
  for (let i = 0; i < n; i++) {
    if (!isDuplicate[i]) {
      relToNewAbs[i] = paramCount + kept;
      kept++;
    }
  }

  // Build index remap: old absolute → new absolute (omit identity mappings)
  const indexRemap = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const absOld = paramCount + i;
    let absNew: number;
    if (isDuplicate[i]) {
      const local = fctx.locals[i]!;
      const firstRel = nameToFirstRel.get(local.name + "\0" + valTypeKey(local.type))!;
      absNew = relToNewAbs[firstRel]; // canonical slot's new absolute index
    } else {
      absNew = relToNewAbs[i];
    }
    if (absOld !== absNew) indexRemap.set(absOld, absNew);
  }

  if (indexRemap.size > 0) {
    rewriteLocalRefs(fctx.body, indexRemap);
  }

  // Compact locals array: remove duplicate entries
  fctx.locals = fctx.locals.filter((_, i) => !isDuplicate[i]);
}

function rewriteLocalRefs(instrs: Instr[], indexRemap: Map<number, number>): void {
  for (const instr of instrs) {
    const op = instr.op;
    if (op === "local.get" || op === "local.set" || op === "local.tee") {
      const newIdx = indexRemap.get((instr as { index: number }).index);
      if (newIdx !== undefined) (instr as { index: number }).index = newIdx;
    }
    walkChildren(instr, (body) => rewriteLocalRefs(body, indexRemap));
  }
}
