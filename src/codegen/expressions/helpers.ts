// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared utility helpers for expression sub-modules.
 *
 * Contains functions used by multiple expression sub-modules:
 *   - emitThrowString: emit a Wasm throw with a string message
 *   - isEffectivelyVoidReturn: check if a return type is void (incl. async)
 *   - getFuncParamTypes: look up Wasm param types for a function index
 *   - wasmFuncReturnsVoid / wasmFuncTypeReturnsVoid: void-return predicates
 *   - getWasmFuncReturnType: get the actual Wasm return type of a function
 */
import { ts } from "../../ts-api.js";
import { isVoidType, unwrapPromiseType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { getLocalType } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { addStringConstantGlobal, ensureExnTag } from "../registry/imports.js";
import { coerceType, ensureLateImport, flushLateImportShifts, valTypesMatch } from "../shared.js";

/**
 * Emit a Wasm throw instruction with a string error message.
 * This replaces `unreachable` traps so that JS try/catch (and assert.throws)
 * can catch the error instead of getting an uncatchable RuntimeError.
 */
export function emitThrowString(ctx: CodegenContext, fctx: FunctionContext, message: string): void {
  addStringConstantGlobal(ctx, message);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, message));
  const tagIdx = ensureExnTag(ctx);
  fctx.body.push({ op: "throw", tagIdx });
}

/**
 * #1365 — Resolve the class struct that declared a `#name` PrivateIdentifier.
 *
 * Per ES2022 §15.7, a private name is lexically scoped to the class body that
 * declares it. To brand-check `obj.#x`, we need to know which class struct
 * to test the receiver against.
 *
 * Strategy: walk up `node.parent` from the PrivateIdentifier to find the
 * enclosing class declaration whose body declared `#x`. The TS parser
 * preserves `parent` links via `setParentNodes`. If multiple nested classes
 * each declare `#x`, the innermost wins (lexical shadowing — same as
 * regular variable scope).
 *
 * Returns `undefined` when:
 *   - The PrivateIdentifier isn't lexically inside any class (parser will
 *     have already caught this as a syntax error, but defensive).
 *   - The class hasn't been registered with a struct (e.g. external class,
 *     or compilation order issue).
 *
 * Returns the matched class's struct typeIdx and the legacy field name
 * (`__priv_<text>`) so the caller can emit `ref.test` / `ref.cast` /
 * `struct.get` against the right slot.
 */
export function resolveDeclaringClassForPrivateName(
  ctx: CodegenContext,
  node: ts.PrivateIdentifier,
): { className: string; structTypeIdx: number; fieldName: string } | undefined {
  const fieldName = "__priv_" + node.text.slice(1);
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if ((ts.isClassDeclaration(current) || ts.isClassExpression(current)) && current.name) {
      const className = current.name.text;
      const structFields = ctx.structFields.get(className);
      // Only return when this class actually declared the private name —
      // a nested class that doesn't declare `#x` shouldn't shadow the outer.
      if (structFields?.some((f) => f.name === fieldName)) {
        const structTypeIdx = ctx.structMap.get(className);
        if (structTypeIdx !== undefined) {
          return { className, structTypeIdx, fieldName };
        }
      }
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * #1365 — Emit a Wasm throw of a real TypeError INSTANCE (not a bare string).
 *
 * Required for spec-compliant `assert.throws(TypeError, fn)` test262 cases —
 * those check `e instanceof TypeError` on the caught value, which requires
 * the thrown ref to be a real TypeError-tagged externref produced by the
 * `__new_TypeError(message)` host import (registered via the same path
 * `new TypeError(msg)` uses, see `expressions/new-super.ts:1411-1453`).
 *
 * Standalone fallback: if `__new_TypeError` import isn't available, throw
 * the message string instead. The instanceof check won't pass in that
 * mode, but the throw is observable and the caller still aborts.
 */
export function emitThrowTypeError(ctx: CodegenContext, fctx: FunctionContext, message: string): void {
  addStringConstantGlobal(ctx, message);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, message));
  const newTypeErrorIdx = ensureLateImport(ctx, "__new_TypeError", [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (newTypeErrorIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: newTypeErrorIdx });
  }
  // If the import isn't available, the message externref is still on the
  // stack — degrade to throwing a string. Both paths produce the same
  // exception tag.
  const tagIdx = ensureExnTag(ctx);
  fctx.body.push({ op: "throw", tagIdx });
}

/**
 * Check if a TS return type is effectively void for Wasm purposes.
 * For async functions, the TS checker reports `Promise<void>` which is not
 * caught by `isVoidType`. This helper unwraps Promise types for async
 * functions before checking.
 *
 * Use this instead of bare `isVoidType(retType)` at all call-return-type
 * resolution points to prevent emitting `drop` on an empty stack.
 */
export function isEffectivelyVoidReturn(ctx: CodegenContext, retType: ts.Type, funcName?: string): boolean {
  if (isVoidType(retType)) return true;
  // For async functions, unwrap Promise<T> and check if T is void
  if (funcName && ctx.asyncFunctions.has(funcName)) {
    const unwrapped = unwrapPromiseType(retType, ctx.checker);
    if (isVoidType(unwrapped)) return true;
  }
  return false;
}

/**
 * Get parameter types of a Wasm function by its index.
 * Handles both imported functions (index < numImportFuncs) and local functions.
 */
export function getFuncParamTypes(ctx: CodegenContext, funcIdx: number): ValType[] | undefined {
  if (funcIdx < ctx.numImportFuncs) {
    let importFuncCount = 0;
    for (const imp of ctx.mod.imports) {
      if (imp.desc.kind === "func") {
        if (importFuncCount === funcIdx) {
          const typeDef = ctx.mod.types[imp.desc.typeIdx];
          if (typeDef?.kind === "func") return typeDef.params;
          return undefined;
        }
        importFuncCount++;
      }
    }
  } else {
    const localIdx = funcIdx - ctx.numImportFuncs;
    const func = ctx.mod.functions[localIdx];
    if (func) {
      const typeDef = ctx.mod.types[func.typeIdx];
      if (typeDef?.kind === "func") return typeDef.params;
    }
  }
  return undefined;
}

/**
 * Check if a Wasm function (by index) has a void return type by inspecting
 * the actual function type in the module. This is the ground truth for whether
 * a `call` instruction pushes a value onto the stack.
 */
export function wasmFuncReturnsVoid(ctx: CodegenContext, funcIdx: number): boolean {
  if (funcIdx < ctx.numImportFuncs) {
    let importFuncCount = 0;
    for (const imp of ctx.mod.imports) {
      if (imp.desc.kind === "func") {
        if (importFuncCount === funcIdx) {
          const typeDef = ctx.mod.types[imp.desc.typeIdx];
          return !typeDef || typeDef.kind !== "func" || typeDef.results.length === 0;
        }
        importFuncCount++;
      }
    }
    return true; // not found — assume void to be safe
  }
  const localIdx = funcIdx - ctx.numImportFuncs;
  const func = ctx.mod.functions[localIdx];
  if (func) {
    const typeDef = ctx.mod.types[func.typeIdx];
    return !typeDef || typeDef.kind !== "func" || typeDef.results.length === 0;
  }
  return true; // not found — assume void to be safe
}

/** Check whether a function *type* (by type index) has zero results. */
export function wasmFuncTypeReturnsVoid(ctx: CodegenContext, typeIdx: number): boolean {
  const typeDef = ctx.mod.types[typeIdx];
  return !typeDef || typeDef.kind !== "func" || typeDef.results.length === 0;
}

/**
 * Get the actual Wasm return type of a function by inspecting its type definition.
 * Returns undefined if the function has void return or is not found.
 * Use this instead of resolveWasmType(retType) at call sites to avoid mismatches
 * when TS type says 'any' (→ externref) but the Wasm function returns f64/i32.
 */
export function getWasmFuncReturnType(ctx: CodegenContext, funcIdx: number): ValType | undefined {
  if (funcIdx < ctx.numImportFuncs) {
    let importFuncCount = 0;
    for (const imp of ctx.mod.imports) {
      if (imp.desc.kind === "func") {
        if (importFuncCount === funcIdx) {
          const typeDef = ctx.mod.types[imp.desc.typeIdx];
          if (typeDef?.kind === "func" && typeDef.results.length > 0) {
            return typeDef.results[0]!;
          }
          return undefined;
        }
        importFuncCount++;
      }
    }
    return undefined;
  }
  const localIdx = funcIdx - ctx.numImportFuncs;
  const func = ctx.mod.functions[localIdx];
  if (func) {
    const typeDef = ctx.mod.types[func.typeIdx];
    if (typeDef?.kind === "func" && typeDef.results.length > 0) {
      return typeDef.results[0]!;
    }
  }
  return undefined;
}

/**
 * Update a local's declared type to a new type.
 * Used when a variable is reassigned to a value of a different struct type.
 */
export function updateLocalType(fctx: FunctionContext, localIdx: number, newType: ValType): void {
  if (localIdx < fctx.params.length) {
    const param = fctx.params[localIdx];
    if (param) param.type = newType;
  } else {
    const local = fctx.locals[localIdx - fctx.params.length];
    if (local) local.type = newType;
  }
}

/**
 * Widen a local's declared type from ref $X to ref_null $X.
 */
export function widenLocalToNullable(fctx: FunctionContext, localIdx: number): void {
  if (localIdx < fctx.params.length) {
    const param = fctx.params[localIdx];
    if (param && param.type.kind === "ref") {
      param.type = { kind: "ref_null", typeIdx: (param.type as { typeIdx: number }).typeIdx };
    }
  } else {
    const local = fctx.locals[localIdx - fctx.params.length];
    if (local && local.type.kind === "ref") {
      local.type = { kind: "ref_null", typeIdx: (local.type as { typeIdx: number }).typeIdx };
    }
  }
}

/**
 * Emit a local.set with automatic type coercion.
 * If the value on the stack (stackType) doesn't match the local's declared type,
 * inserts coercion instructions before the local.set.
 */
export function emitCoercedLocalSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  localIdx: number,
  stackType: ValType,
): void {
  const localType = getLocalType(fctx, localIdx);
  if (localType && !valTypesMatch(stackType, localType)) {
    const sameRefTypeIdx =
      (stackType.kind === "ref" || stackType.kind === "ref_null") &&
      (localType.kind === "ref" || localType.kind === "ref_null") &&
      (stackType as { typeIdx: number }).typeIdx === (localType as { typeIdx: number }).typeIdx;
    if (sameRefTypeIdx && stackType.kind === "ref_null" && localType.kind === "ref") {
      widenLocalToNullable(fctx, localIdx);
    } else if (sameRefTypeIdx) {
      // ref -> ref_null: subtype, no coercion needed
    } else if (
      (stackType.kind === "ref" || stackType.kind === "ref_null") &&
      (localType.kind === "ref" || localType.kind === "ref_null")
    ) {
      const bodyLenBefore = fctx.body.length;
      coerceType(ctx, fctx, stackType, localType);
      if (fctx.body.length === bodyLenBefore) {
        updateLocalType(fctx, localIdx, stackType);
      }
    } else {
      coerceType(ctx, fctx, stackType, localType);
    }
  }
  fctx.body.push({ op: "local.set", index: localIdx });
}
