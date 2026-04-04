/**
 * Local-slot allocation helpers.
 *
 * This module owns parameter/local slot bookkeeping and temporary-local reuse.
 */
import type { ValType } from "../../ir/types.js";
import type { FunctionContext } from "./types.js";

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
