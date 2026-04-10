/**
 * Variable declaration statement lowering.
 */
import ts from "typescript";
import { isStringType, isVoidType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { emitGuardedRefCast } from "../type-coercion.js";
import { coerceType, compileExpression, emitCoercedLocalSet, emitUndefined, valTypesMatch } from "../expressions.js";
import { reportError } from "../context/errors.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { localGlobalIdx } from "../registry/imports.js";
import { getOrRegisterVecType } from "../registry/types.js";
import { resolveWasmType } from "../index.js";
import { resolveComputedKeyExpression } from "../literals.js";
import { emitTdzInit } from "./tdz.js";
import { compileObjectDestructuring, compileArrayDestructuring } from "./destructuring.js";

function inferArrayVecType(ctx: CodegenContext, decl: ts.VariableDeclaration): ValType | null {
  if (!ts.isIdentifier(decl.name)) return null;
  const varName = decl.name.text;

  // Walk up to the enclosing function body or source file
  let scope: ts.Node = decl;
  while (
    scope &&
    !ts.isFunctionDeclaration(scope) &&
    !ts.isFunctionExpression(scope) &&
    !ts.isArrowFunction(scope) &&
    !ts.isMethodDeclaration(scope) &&
    !ts.isSourceFile(scope)
  ) {
    scope = scope.parent;
  }
  if (!scope) return null;

  let inferredElemType: ts.Type | null = null;

  function visit(node: ts.Node) {
    if (inferredElemType) return;

    // arr[i] = value
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === varName
    ) {
      const valType = ctx.checker.getTypeAtLocation(node.right);
      if (!(valType.flags & ts.TypeFlags.Any)) {
        inferredElemType = valType;
        return;
      }
    }

    // arr.push(value)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "push" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === varName &&
      node.arguments.length >= 1
    ) {
      const valType = ctx.checker.getTypeAtLocation(node.arguments[0]!);
      if (!(valType.flags & ts.TypeFlags.Any)) {
        inferredElemType = valType;
        return;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(scope);
  if (!inferredElemType) return null;

  // Resolve the inferred element type to a wasm type, then register the vec
  const elemWasm = resolveWasmType(ctx, inferredElemType);
  const elemKey =
    elemWasm.kind === "ref" || elemWasm.kind === "ref_null"
      ? `ref_${(elemWasm as { typeIdx: number }).typeIdx}`
      : elemWasm.kind;
  const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemWasm);
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/** String methods that return a host array (externref) rather than a wasm GC array.
 *  Variables initialized from these calls use externref instead of the GC vec struct
 *  that resolveWasmType would produce for the TS return type (e.g. string[]). */
const HOST_ARRAY_STRING_METHODS = new Set(["split"]);

/** Check if an expression is a string method call that returns a host array (externref). */
function isStringMethodReturningHostArray(ctx: CodegenContext, expr: ts.Expression): boolean {
  // With native strings, split returns a native string array, not externref
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) return false;
  if (!ts.isCallExpression(expr)) return false;
  if (!ts.isPropertyAccessExpression(expr.expression)) return false;
  const method = expr.expression.name.text;
  if (!HOST_ARRAY_STRING_METHODS.has(method)) return false;
  const receiverType = ctx.checker.getTypeAtLocation(expr.expression.expression);
  return isStringType(receiverType);
}

/**
 * Check if an expression is a host Promise call whose result is a real JS Promise.
 * Only matches static Promise methods (resolve/reject/all/race/allSettled/any) and
 * new Promise(). DELIBERATELY OMITS instance methods (.then/.catch/.finally) to
 * prevent cascading type overrides through Promise chains on compiled async functions.
 */
function isPromiseHostCall(_ctx: CodegenContext, expr: ts.Expression): boolean {
  // new Promise(executor)
  if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "Promise") {
    return true;
  }
  if (!ts.isCallExpression(expr)) return false;
  if (!ts.isPropertyAccessExpression(expr.expression)) return false;
  const method = expr.expression.name.text;
  // Static methods: Promise.resolve/reject/all/race/allSettled/any
  if (
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "Promise" &&
    (method === "resolve" ||
      method === "reject" ||
      method === "all" ||
      method === "race" ||
      method === "allSettled" ||
      method === "any")
  ) {
    return true;
  }
  return false;
}

export function compileVariableStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.VariableStatement): void {
  for (const decl of stmt.declarationList.declarations) {
    if (ts.isObjectBindingPattern(decl.name)) {
      compileObjectDestructuring(ctx, fctx, decl);
      continue;
    }

    if (ts.isArrayBindingPattern(decl.name)) {
      compileArrayDestructuring(ctx, fctx, decl);
      continue;
    }

    if (!ts.isIdentifier(decl.name)) {
      reportError(ctx, decl, "Destructuring not supported");
      continue;
    }

    const name = decl.name.text;

    // Track const bindings for runtime enforcement (assignment throws TypeError)
    if (stmt.declarationList.flags & ts.NodeFlags.Const) {
      if (!fctx.constBindings) fctx.constBindings = new Set();
      fctx.constBindings.add(name);
    }

    // Class expression: const C = class { ... } — skip, already handled as class declaration
    if (decl.initializer && ts.isClassExpression(decl.initializer)) {
      continue;
    }

    // For arrow/function expression initializers, compile the expression first
    // to get the actual closure struct ref type (resolveWasmType returns externref
    // for function types, but closures need ref $struct)
    if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
      const actualType = compileExpression(ctx, fctx, decl.initializer);
      const closureType = actualType ?? { kind: "externref" as const };

      // If this is a module-level variable, also store in the module global
      // so other functions can access the closure via global.get.
      const modGlobalIdx = ctx.moduleGlobals.get(name);
      if (modGlobalIdx !== undefined) {
        // Update the global's type to match the actual closure ref type
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, modGlobalIdx)];
        if (globalDef) {
          const nullableType: ValType =
            closureType.kind === "ref"
              ? { kind: "ref_null", typeIdx: (closureType as { typeIdx: number }).typeIdx }
              : closureType;
          globalDef.type = nullableType;
          // Also fix the init expression to match the new type
          if (nullableType.kind === "ref_null") {
            globalDef.init = [{ op: "ref.null", typeIdx: (nullableType as { typeIdx: number }).typeIdx }];
          }
        }
        // Duplicate value on stack: one for the global, one for the local
        const localIdx = allocLocal(fctx, name, closureType);
        fctx.body.push({ op: "local.tee", index: localIdx });
        fctx.body.push({ op: "global.set", index: modGlobalIdx });
        // Set TDZ flag to 1 (initialized)
        emitTdzInit(ctx, fctx, name);
      } else {
        // Reuse pre-hoisted slot if it exists.
        // Do NOT narrow externref → ref: the hoisting pass already emitted
        // __get_undefined() targeting externref; mutating the type causes
        // impossible ref.cast at runtime (#962). Coercion handles it.
        const priorIdx = fctx.localMap.get(name);
        const localIdx =
          priorIdx !== undefined && priorIdx >= fctx.params.length ? priorIdx : allocLocal(fctx, name, closureType);
        if (priorIdx !== undefined && priorIdx >= fctx.params.length) {
          const slot = fctx.locals[priorIdx - fctx.params.length];
          if (slot && slot.type.kind !== "externref") slot.type = closureType;
        }
        emitCoercedLocalSet(ctx, fctx, localIdx, closureType);
      }
      continue;
    }

    // For object literal initializers with computed property names that TS
    // cannot resolve (resulting in 0 type properties), compile the expression
    // first to get the actual struct ref type. Similar to arrow function handling.
    if (
      decl.initializer &&
      ts.isObjectLiteralExpression(decl.initializer) &&
      decl.initializer.properties.some((p) => ts.isPropertyAssignment(p) && p.name && ts.isComputedPropertyName(p.name))
    ) {
      const varType2 = ctx.checker.getTypeAtLocation(decl);
      const tsProps = varType2.getProperties();
      // Only use this path when TS cannot resolve any properties
      // (i.e. all properties are computed and non-resolvable)
      const hasUnresolvedComputed = tsProps.length < decl.initializer.properties.length;
      if (hasUnresolvedComputed) {
        // Check if ALL computed keys can be resolved at compile time.
        // If so, skip this early-out and let ensureComputedPropertyFields + the
        // normal module-global path handle it properly.
        const allComputedResolvable = decl.initializer.properties.every((p) => {
          if (!ts.isPropertyAssignment(p) || !p.name || !ts.isComputedPropertyName(p.name)) return true;
          return resolveComputedKeyExpression(ctx, p.name.expression) !== undefined;
        });
        if (!allComputedResolvable) {
          const actualType = compileExpression(ctx, fctx, decl.initializer);
          const objType = actualType ?? { kind: "externref" as const };
          // Store to module global if available, otherwise local
          const modGlobal = ctx.moduleGlobals.get(name);
          if (modGlobal !== undefined) {
            fctx.body.push({ op: "global.set", index: modGlobal });
            emitTdzInit(ctx, fctx, name);
          } else {
            // Reuse pre-hoisted slot if it exists.
            // Do NOT narrow externref → ref (#962).
            const priorIdx = fctx.localMap.get(name);
            const localIdx =
              priorIdx !== undefined && priorIdx >= fctx.params.length ? priorIdx : allocLocal(fctx, name, objType);
            if (priorIdx !== undefined && priorIdx >= fctx.params.length) {
              const slot = fctx.locals[priorIdx - fctx.params.length];
              if (slot && slot.type.kind !== "externref") slot.type = objType;
            }
            fctx.body.push({ op: "local.set", index: localIdx });
          }
          continue;
        }
        // All computed keys resolvable — fall through to normal path
      }
    }

    // Check if this is a module-level global (already registered)
    const moduleGlobalIdx = ctx.moduleGlobals.get(name);
    if (moduleGlobalIdx !== undefined) {
      // Shape-inferred array-like: compile {} as empty vec struct
      const shapeInfo = ctx.shapeMap.get(name);
      if (shapeInfo && decl.initializer) {
        // Create an empty vec struct: struct.new(length=0, data=array.new_default(4))
        fctx.body.push({ op: "i32.const", value: 0 }); // length = 0
        fctx.body.push({ op: "i32.const", value: 4 }); // initial capacity
        fctx.body.push({ op: "array.new_default", typeIdx: shapeInfo.arrTypeIdx } as Instr);
        fctx.body.push({ op: "struct.new", typeIdx: shapeInfo.vecTypeIdx });
        fctx.body.push({ op: "global.set", index: moduleGlobalIdx });
        // Set TDZ flag to 1 (initialized)
        emitTdzInit(ctx, fctx, name);
        continue;
      }
      // Module global: compile initializer and set global
      if (decl.initializer) {
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleGlobalIdx)];
        const wasmType = globalDef?.type ?? resolveWasmType(ctx, ctx.checker.getTypeAtLocation(decl));
        compileExpression(ctx, fctx, decl.initializer, wasmType);
        // Re-read index: compileExpression may shift globals via addStringConstantGlobal
        const moduleGlobalIdxPost = ctx.moduleGlobals.get(name)!;
        fctx.body.push({ op: "global.set", index: moduleGlobalIdxPost });
      } else {
        // No initializer: `let x;` at module level — in JS, uninitialized
        // variables are `undefined`. For externref globals, emit __get_undefined()
        // so `x === undefined` works correctly (#737).
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleGlobalIdx)];
        if (globalDef?.type.kind === "externref") {
          emitUndefined(ctx, fctx);
          fctx.body.push({ op: "global.set", index: moduleGlobalIdx });
        }
      }
      // Set TDZ flag to 1 (initialized) — even for `let x;` without initializer
      emitTdzInit(ctx, fctx, name);
      continue;
    }

    const varType = ctx.checker.getTypeAtLocation(decl);
    // If the variable is an untyped Array<any> (e.g. `var x = new Array()`),
    // infer the element type from how the variable is used in the function.
    let inferredVecType: ValType | null = null;
    if (varType.flags & ts.TypeFlags.Object) {
      const sym = (varType as ts.TypeReference).symbol ?? (varType as ts.Type).symbol;
      if (sym?.name === "Array") {
        const typeArgs = ctx.checker.getTypeArguments(varType as ts.TypeReference);
        if (typeArgs?.[0] && typeArgs[0].flags & ts.TypeFlags.Any) {
          inferredVecType = inferArrayVecType(ctx, decl);
        }
      }
    }
    // Override type for string methods returning host arrays (e.g. split() returns
    // externref but TS types as string[] which resolveWasmType maps to GC vec struct)
    // Check if this variable has widened properties (empty obj with later prop assignments)
    const widenedStructName = ctx.widenedVarStructMap.get(name);
    const widenedTypeIdx = widenedStructName !== undefined ? ctx.structMap.get(widenedStructName) : undefined;
    const wasmType =
      widenedTypeIdx !== undefined
        ? { kind: "ref_null" as const, typeIdx: widenedTypeIdx }
        : (inferredVecType ??
          (decl.initializer && isStringMethodReturningHostArray(ctx, decl.initializer)
            ? { kind: "externref" as const }
            : decl.initializer && isPromiseHostCall(ctx, decl.initializer)
              ? { kind: "externref" as const }
              : resolveWasmType(ctx, varType)));

    // If this var/let/const was already pre-hoisted at function entry, reuse that slot.
    // For let/const: the pre-pass (hoistLetConstWithTdz) always pre-allocates a slot
    // regardless of whether a TDZ flag is also allocated, so we check only the localMap.
    const existingIdx = fctx.localMap.get(name);
    const isVar = !(decl.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const));
    const isHoistedLetConst = !isVar && existingIdx !== undefined && existingIdx >= fctx.params.length;
    const localIdx =
      (isVar || isHoistedLetConst) && existingIdx !== undefined && existingIdx >= fctx.params.length
        ? existingIdx
        : allocLocal(fctx, name, wasmType);

    // If we reused a pre-hoisted slot but inference found a more precise type
    // (e.g. Array<any> hoisted as vec_externref, but inferred as vec_f64),
    // update the local's type so it matches what the initializer will produce.
    // IMPORTANT: Do NOT retroactively change the type when it would invalidate
    // already-emitted initialization code:
    // - ref/ref_null → primitive: earlier struct.new would become invalid
    // - externref → ref/ref_null: hoisted __get_undefined() can't be cast (#962)
    if ((isVar || isHoistedLetConst) && existingIdx !== undefined && existingIdx >= fctx.params.length) {
      const localSlot = fctx.locals[existingIdx - fctx.params.length];
      if (
        localSlot &&
        (wasmType.kind !== localSlot.type.kind || (wasmType as any).typeIdx !== (localSlot.type as any).typeIdx)
      ) {
        const existingIsRef = localSlot.type.kind === "ref" || localSlot.type.kind === "ref_null";
        const existingIsExternref = localSlot.type.kind === "externref";
        const newIsPrimitive =
          wasmType.kind === "f64" ||
          wasmType.kind === "i32" ||
          wasmType.kind === "i64" ||
          wasmType.kind === "externref";
        const newIsRef = wasmType.kind === "ref" || wasmType.kind === "ref_null";
        if (!(existingIsRef && newIsPrimitive) && !(existingIsExternref && newIsRef)) {
          localSlot.type = wasmType;
        }
      }
    }

    if (decl.initializer) {
      // Check if the variable has a callable type (function reference).
      // If so, compile without an externref hint to preserve the closure ref type.
      const callSigs = varType.getCallSignatures?.();
      const isCallable = callSigs && callSigs.length > 0 && wasmType.kind === "externref";
      let stackType: ValType = wasmType;
      if (isCallable) {
        // Compile without type hint to get the actual closure/ref type
        const actualType = compileExpression(ctx, fctx, decl.initializer);
        const closureType = actualType ?? { kind: "externref" as const };
        // If the result is a closure ref, update the local's type — but not
        // if the local was pre-hoisted as externref (illegal cast, #962).
        if (
          (closureType.kind === "ref" || closureType.kind === "ref_null") &&
          ctx.closureInfoByTypeIdx.has((closureType as { typeIdx: number }).typeIdx)
        ) {
          if (localIdx >= fctx.params.length) {
            const localSlot = fctx.locals[localIdx - fctx.params.length];
            if (localSlot && localSlot.type.kind !== "externref") localSlot.type = closureType;
          }
          stackType = closureType;
        } else if (closureType.kind === "externref" && callSigs!.length > 0) {
          // The initializer returned externref but the type is callable.
          // This happens when a function returns a closure coerced to externref.
          // Find the matching closure info by comparing the TS call signature
          // against registered closure types and unbox (any.convert_extern + ref.cast).
          const sig = callSigs![0]!;
          const sigParamCount = sig.parameters.length;
          const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
          const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
          const sigParamWasmTypes: ValType[] = [];
          for (let i = 0; i < sigParamCount; i++) {
            const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
            sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
          }

          let matchedClosureInfo:
            | { structTypeIdx: number; info: typeof ctx.closureInfoByTypeIdx extends Map<number, infer V> ? V : never }
            | undefined;
          for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
            if (info.paramTypes.length !== sigParamCount) continue;
            if (sigRetWasm === null && info.returnType !== null) continue;
            if (sigRetWasm !== null && info.returnType === null) continue;
            if (sigRetWasm !== null && info.returnType !== null && sigRetWasm.kind !== info.returnType.kind) continue;
            let paramsMatch = true;
            for (let i = 0; i < sigParamCount; i++) {
              if (sigParamWasmTypes[i]!.kind !== info.paramTypes[i]!.kind) {
                paramsMatch = false;
                break;
              }
            }
            if (paramsMatch) {
              matchedClosureInfo = { structTypeIdx: typeIdx, info };
              break;
            }
          }

          if (matchedClosureInfo) {
            // Convert externref back to closure struct ref (guarded to avoid illegal cast)
            fctx.body.push({ op: "any.convert_extern" } as Instr);
            emitGuardedRefCast(fctx, matchedClosureInfo.structTypeIdx);
            const castType: ValType = { kind: "ref_null", typeIdx: matchedClosureInfo.structTypeIdx };
            if (localIdx >= fctx.params.length) {
              const localSlot = fctx.locals[localIdx - fctx.params.length];
              // Do NOT narrow externref → ref (#962)
              if (localSlot && localSlot.type.kind !== "externref") localSlot.type = castType;
            }
            stackType = castType;
          } else {
            stackType = closureType;
          }
        } else {
          stackType = closureType;
        }
      } else {
        const resultType = compileExpression(ctx, fctx, decl.initializer, wasmType);
        stackType = resultType ?? wasmType;
        // Coerce if the expression produced a type that doesn't match the local
        if (resultType && !valTypesMatch(resultType, wasmType)) {
          const bodyLenBeforeCoerce = fctx.body.length;
          coerceType(ctx, fctx, resultType, wasmType);
          // Only update stackType if coercion actually emitted instructions.
          // If coerceType was a no-op (e.g. unrelated struct types), keep
          // the original resultType so emitCoercedLocalSet can detect the
          // mismatch and update the local's declared type accordingly.
          if (fctx.body.length > bodyLenBeforeCoerce) {
            stackType = wasmType; // after coercion, stack is wasmType
          }
        }
      }
      emitCoercedLocalSet(ctx, fctx, localIdx, stackType);
    } else if (wasmType.kind === "externref") {
      // No initializer: `let x;` / `var x;` — in JS, uninitialized variables
      // are `undefined`, not `null`. Emit __get_undefined() so that
      // `x === undefined` works correctly (#737).
      emitUndefined(ctx, fctx);
      fctx.body.push({ op: "local.set", index: localIdx });
    }
    // Set local TDZ flag to 1 (initialized) if this is a hoisted let/const
    emitLocalTdzInit(fctx, name);
  }
}

/**
 * Emit instructions to set a local TDZ flag to 1 (initialized) for a function-level
 * let/const variable. No-op if the variable doesn't have a local TDZ flag.
 */
function emitLocalTdzInit(fctx: FunctionContext, name: string): void {
  const flagIdx = fctx.tdzFlagLocals?.get(name);
  if (flagIdx === undefined) return;
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "local.set", index: flagIdx });
}
