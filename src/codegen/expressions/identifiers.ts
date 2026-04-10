/**
 * Identifier resolution, TDZ analysis, and instanceof handling.
 */
import ts from "typescript";
import { isBooleanType, isHeterogeneousUnion, isNumberType, isStringType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import {
  addFuncType,
  addImport,
  addStringConstantGlobal,
  addUnionImports,
  ensureExnTag,
  localGlobalIdx,
  resolveWasmType,
} from "../index.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { compileExpression, coerceType, valTypesMatch } from "../shared.js";
import type { InnerResult } from "../shared.js";
import { ensureLateImport, flushLateImportShifts, shiftLateImportIndices } from "./late-imports.js";
import { emitFuncRefAsClosure } from "../closures.js";
import { emitNullGuardedStructGet } from "../property-access.js";
import { emitTdzCheck } from "../statements.js";

export function emitLocalTdzCheck(ctx: CodegenContext, fctx: FunctionContext, _name: string, flagIdx: number): void {
  const tagIdx = ensureExnTag(ctx);
  fctx.body.push({ op: "local.get", index: flagIdx });
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "ref.null.extern" } as Instr, { op: "throw", tagIdx }],
    else: [],
  } as unknown as Instr);
}

/**
 * Static TDZ analysis: determine at compile time whether a let/const variable
 * access is guaranteed to be after initialization (safe) or before (TDZ violation).
 *
 * Returns:
 * - 'skip': access is after declaration in straight-line code — no check needed
 * - 'throw': access is before declaration in straight-line code — guaranteed TDZ error
 * - 'check': can't determine statically — keep runtime flag check
 */
function analyzeTdzAccess(ctx: CodegenContext, id: ts.Identifier): "skip" | "throw" | "check" {
  const symbol = ctx.checker.getSymbolAtLocation(id);
  if (!symbol) return "check";
  const decl = symbol.valueDeclaration;
  if (!decl) return "check";

  const accessPos = id.getStart();
  const declEnd = decl.getEnd(); // use end of declaration (after initializer)

  // Find the containing function of the access and the declaration.
  const accessFunc = getContainingFunction(id);
  const declFunc = getContainingFunction(decl);

  if (accessFunc !== declFunc) {
    // Access is in a nested closure. We can still prove it safe if:
    // 1. The closure is an arrow function or function expression (not hoisted), AND
    // 2. The closure definition starts after the variable's declaration ends, AND
    // 3. No loop wraps both the declaration and the closure definition
    // In that case, the closure cannot exist until after the variable is initialized,
    // so any invocation of the closure is guaranteed to see the initialized value.
    if (accessFunc && !ts.isFunctionDeclaration(accessFunc) && !ts.isSourceFile(accessFunc)) {
      const closureStart = accessFunc.getStart();
      if (closureStart >= declEnd && !isInsideLoopContaining(accessFunc as ts.Node, decl)) {
        return "skip";
      }
    }
    return "check";
  }

  // Check if the access is inside a loop that contains the declaration
  // (back-edge could reach access before re-initialization)
  if (isInsideLoopContaining(id, decl)) return "check";

  if (accessPos >= declEnd) {
    // Access is after the full declaration (including initializer) — safe
    return "skip";
  } else {
    // Access is before declaration — guaranteed TDZ violation
    // But only if not in a loop that wraps both (already checked above)
    return "throw";
  }
}

/** Walk up to find the nearest containing function (or source file for top-level). */
function getContainingFunction(node: ts.Node): ts.Node | undefined {
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isSourceFile(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Check if the access node is inside a loop body that also contains (or is
 * an ancestor of) the declaration. In that case the access could run on a
 * subsequent iteration before the declaration re-initializes the variable.
 *
 * Exception: if the declaration is inside the loop body (not the for-initializer)
 * and the access is textually after the declaration, the back-edge is harmless
 * because let/const creates a fresh binding each iteration.
 */
function isInsideLoopContaining(access: ts.Node, decl: ts.Node): boolean {
  let current = access.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isSourceFile(current)
    ) {
      // Reached function boundary without finding a loop
      return false;
    }
    if (isLoopStatement(current)) {
      // Check if the declaration is also inside this loop
      if (isDescendantOf(decl, current)) {
        // Both are inside this loop. If the decl is in the loop body
        // (not the for-initializer/condition/incrementor) and the access
        // is textually after the decl, the per-iteration fresh binding
        // guarantees initialization before access on every iteration.
        const body = getLoopBody(current);
        if (body && isDescendantOf(decl, body) && access.getStart() >= decl.getEnd()) {
          // Safe: loop-local let/const, access after declaration in same iteration
          return false;
        }
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

/** Get the body statement/block of a loop node. */
function getLoopBody(loop: ts.Node): ts.Node | undefined {
  if (ts.isForStatement(loop)) return loop.statement;
  if (ts.isForInStatement(loop)) return loop.statement;
  if (ts.isForOfStatement(loop)) return loop.statement;
  if (ts.isWhileStatement(loop)) return loop.statement;
  if (ts.isDoStatement(loop)) return loop.statement;
  return undefined;
}

function isLoopStatement(node: ts.Node): boolean {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

function isDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Position-based TDZ analysis for call-site capture checks.
 * Used when we know the variable name and the call expression position,
 * but don't have an identifier with a resolved symbol (e.g., pushing
 * closure captures at a nested function call site).
 */
function analyzeTdzAccessByPos(ctx: CodegenContext, varName: string, callNode: ts.Node): "skip" | "throw" | "check" {
  // Look up the variable's symbol via the checker
  // We need to find the declaration to get its end position
  const sourceFile = callNode.getSourceFile();
  if (!sourceFile) return "check";

  // Find the declaration by looking up the local symbol in scope
  const sym = ctx.checker.getSymbolsInScope(callNode, ts.SymbolFlags.Variable).find((s) => s.name === varName);
  if (!sym) return "check";
  const decl = sym.valueDeclaration;
  if (!decl) return "check";

  const callPos = callNode.getStart();
  const declEnd = decl.getEnd();

  // Both must be in the same function scope (call site is in the declaring function)
  const callFunc = getContainingFunction(callNode);
  const declFunc = getContainingFunction(decl);
  if (callFunc !== declFunc) return "check";

  if (isInsideLoopContaining(callNode, decl)) return "check";

  if (callPos >= declEnd) {
    return "skip";
  } else {
    return "throw";
  }
}

/** Emit a static TDZ throw (guaranteed violation — no flag check needed). */
export function emitStaticTdzThrow(ctx: CodegenContext, fctx: FunctionContext, name: string): void {
  const tagIdx = ensureExnTag(ctx);
  fctx.body.push({ op: "ref.null.extern" } as Instr);
  fctx.body.push({ op: "throw", tagIdx });
}

function compileIdentifier(ctx: CodegenContext, fctx: FunctionContext, id: ts.Identifier): ValType | null {
  const name = id.text;
  const localIdx = fctx.localMap.get(name);
  if (localIdx !== undefined) {
    // TDZ check for function-local let/const variables
    const tdzFlagIdx = fctx.tdzFlagLocals?.get(name);
    if (tdzFlagIdx !== undefined) {
      const tdzResult = analyzeTdzAccess(ctx, id);
      if (tdzResult === "check") {
        emitLocalTdzCheck(ctx, fctx, name, tdzFlagIdx);
      } else if (tdzResult === "throw") {
        emitStaticTdzThrow(ctx, fctx, id.text);
      }
      // tdzResult === "skip" — no check needed, variable is guaranteed initialized
    }

    // Check if this is a boxed (ref cell) mutable capture
    const boxed = fctx.boxedCaptures?.get(name);
    if (boxed) {
      // Read through ref cell: local.get → null guard → struct.get $ref_cell 0
      // The ref cell local is ref_null — if the closure capture is uninitialized,
      // the local is null and struct.get would trap (#702).
      fctx.body.push({ op: "local.get", index: localIdx });
      emitNullGuardedStructGet(
        ctx,
        fctx,
        { kind: "ref_null", typeIdx: boxed.refCellTypeIdx },
        boxed.valType,
        boxed.refCellTypeIdx,
        0,
        undefined /* propName */,
        false /* throwOnNull — ref cells use default for uninitialized captures */,
      );
      return boxed.valType;
    }

    fctx.body.push({ op: "local.get", index: localIdx });
    // Determine declared type from params or locals
    let declaredType: ValType;
    if (localIdx < fctx.params.length) {
      declaredType = fctx.params[localIdx]!.type;
    } else {
      const localDef = fctx.locals[localIdx - fctx.params.length];
      declaredType = localDef?.type ?? { kind: "f64" };
    }

    // Narrowing: if the declared type is externref (boxed union) but the
    // checker narrows it to a concrete type, emit an unbox call.
    if (declaredType.kind === "externref") {
      const narrowedType = ctx.checker.getTypeAtLocation(id);
      const narrowed = narrowTypeToUnbox(ctx, fctx, narrowedType);
      if (narrowed) return narrowed;
    }

    // Null narrowing: if this variable is known non-null (e.g. inside `if (x !== null)`),
    // emit ref.as_non_null and return ref instead of ref_null to skip downstream null guards.
    if (declaredType.kind === "ref_null" && fctx.narrowedNonNull?.has(name)) {
      fctx.body.push({ op: "ref.as_non_null" });
      return { kind: "ref", typeIdx: (declaredType as any).typeIdx };
    }

    return declaredType;
  }

  // Check captured globals (variables promoted from enclosing scope for callbacks)
  const capturedIdx = ctx.capturedGlobals.get(name);
  if (capturedIdx !== undefined) {
    // TDZ check: throw ReferenceError if let/const variable accessed before initialization
    // Apply static analysis — captured globals are often accessed from closures,
    // but analyzeTdzAccess handles the cross-function case correctly (returns "check")
    const tdzResult = ctx.tdzGlobals.has(name) ? analyzeTdzAccess(ctx, id) : "skip";
    if (tdzResult === "check") {
      emitTdzCheck(ctx, fctx, name);
    } else if (tdzResult === "throw") {
      emitStaticTdzThrow(ctx, fctx, id.text);
    }
    fctx.body.push({ op: "global.get", index: capturedIdx });
    const globalDef = ctx.mod.globals[localGlobalIdx(ctx, capturedIdx)];
    const gType = globalDef?.type ?? { kind: "f64" };
    // Globals widened from ref to ref_null for null init — narrow back
    if (gType.kind === "ref_null" && (ctx.capturedGlobalsWidened.has(name) || fctx.narrowedNonNull?.has(name))) {
      fctx.body.push({ op: "ref.as_non_null" });
      return { kind: "ref", typeIdx: gType.typeIdx };
    }
    return gType;
  }

  // Check module-level globals (top-level let/const declarations)
  const moduleIdx = ctx.moduleGlobals.get(name);
  if (moduleIdx !== undefined) {
    // TDZ check: throw ReferenceError if let/const variable accessed before initialization
    // Apply static analysis for module-level globals
    const tdzResult = ctx.tdzGlobals.has(name) ? analyzeTdzAccess(ctx, id) : "skip";
    if (tdzResult === "check") {
      emitTdzCheck(ctx, fctx, name);
    } else if (tdzResult === "throw") {
      emitStaticTdzThrow(ctx, fctx, id.text);
    }
    fctx.body.push({ op: "global.get", index: moduleIdx });
    const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleIdx)];
    const mType = globalDef?.type ?? { kind: "f64" };
    // Null narrowing for module globals
    if (mType.kind === "ref_null" && fctx.narrowedNonNull?.has(name)) {
      fctx.body.push({ op: "ref.as_non_null" });
      return { kind: "ref", typeIdx: (mType as any).typeIdx };
    }
    return mType;
  }

  // Check declared globals (e.g. document, window)
  const globalInfo = ctx.declaredGlobals.get(name);
  if (globalInfo) {
    fctx.body.push({ op: "call", funcIdx: globalInfo.funcIdx });
    return globalInfo.type;
  }

  // globalThis — return the JS global object via host import
  if (name === "globalThis") {
    let funcIdx = ctx.funcMap.get("__get_globalThis");
    if (funcIdx === undefined) {
      const importsBefore = ctx.numImportFuncs;
      const typeIdx = addFuncType(ctx, [], [{ kind: "externref" }]);
      addImport(ctx, "env", "__get_globalThis", { kind: "func", typeIdx });
      shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
      funcIdx = ctx.funcMap.get("__get_globalThis")!;
    }
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "externref" };
  }

  // Built-in numeric constants: NaN, Infinity
  if (name === "NaN") {
    fctx.body.push({ op: "f64.const", value: NaN });
    return { kind: "f64" };
  }
  if (name === "Infinity") {
    fctx.body.push({ op: "f64.const", value: Infinity });
    return { kind: "f64" };
  }

  // Function reference as value: when a known function name is used as an
  // expression (not called), wrap it in a closure struct so it can be stored
  // in a variable and later called via call_ref.
  // Only wrap user-defined functions (skip internal helpers and class constructors).
  const funcRefIdx = ctx.funcMap.get(name);
  if (funcRefIdx !== undefined && !name.startsWith("__") && !ctx.classSet.has(name)) {
    // Check if there's already a closure registered (e.g. from closureMap)
    const existingClosure = ctx.closureMap.get(name);
    if (existingClosure) {
      // Already a closure — check if there's a module-level global for it
      const closureModGlobal = ctx.moduleGlobals.get(name);
      if (closureModGlobal !== undefined) {
        fctx.body.push({ op: "global.get", index: closureModGlobal });
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, closureModGlobal)];
        return (
          globalDef?.type ?? {
            kind: "ref",
            typeIdx: existingClosure.structTypeIdx,
          }
        );
      }
    }
    // Wrap the plain function in a closure struct
    const refType = emitFuncRefAsClosure(ctx, fctx, name, funcRefIdx);
    if (refType) return refType;
  }

  // Check if this is a truly undeclared variable (no TS symbol).
  // Accessing an undeclared variable should throw ReferenceError per JS strict mode.
  // However, known globals (Symbol, Object, Reflect, etc.) have TS symbols from
  // lib.d.ts and should use the fallback default instead.
  const sym = ctx.checker.getSymbolAtLocation(id);
  if (!sym) {
    // Truly undeclared variable — throw ReferenceError at runtime
    const tagIdx = ensureExnTag(ctx);
    fctx.body.push({ op: "ref.null.extern" } as Instr);
    fctx.body.push({ op: "throw", tagIdx } as unknown as Instr);
    return { kind: "externref" };
  }

  // Graceful fallback for known but unimplemented globals (Symbol, Object,
  // Reflect, etc.) — emit a type-appropriate default so compilation continues.
  const tsType = ctx.checker.getTypeAtLocation(id);
  const wasmType = resolveWasmType(ctx, tsType);
  if (wasmType.kind === "f64") {
    fctx.body.push({ op: "f64.const", value: 0 });
    return { kind: "f64" };
  }
  if (wasmType.kind === "i32") {
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }
  if (wasmType.kind === "i64") {
    fctx.body.push({ op: "i64.const", value: 0n });
    return { kind: "i64" };
  }
  // For known JS global objects (Math, Object, Date, etc.), use globalThis[name]
  // instead of null so that host-delegated APIs (Object.getOwnPropertyDescriptor,
  // Object.getPrototypeOf, etc.) receive the actual runtime object.
  const GLOBAL_OBJECTS = new Set([
    "Math",
    "Object",
    "Array",
    "Date",
    "JSON",
    "Error",
    "Number",
    "String",
    "Boolean",
    "RegExp",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "Promise",
    "Symbol",
    "Proxy",
    "Reflect",
    "Function",
    "ArrayBuffer",
    "DataView",
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
    "AggregateError",
    "SuppressedError",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "ReferenceError",
    "URIError",
    "EvalError",
    "Iterator",
  ]);
  if (GLOBAL_OBJECTS.has(name)) {
    const gtIdx = ensureLateImport(ctx, "__get_globalThis", [], [{ kind: "externref" }]);
    const getIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (gtIdx !== undefined && getIdx !== undefined) {
      addStringConstantGlobal(ctx, name);
      const strGlobalIdx = ctx.stringGlobalMap.get(name);
      if (strGlobalIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: gtIdx });
        fctx.body.push({ op: "global.get", index: strGlobalIdx });
        fctx.body.push({ op: "call", funcIdx: getIdx });
        return { kind: "externref" };
      }
    }
  }
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}

/**
 * If the narrowed TS type indicates a concrete primitive, emit an unbox call
 * and return the unboxed ValType. The externref value must already be on stack.
 * Returns null if no unboxing is needed (type is still a union or externref).
 */
function narrowTypeToUnbox(ctx: CodegenContext, fctx: FunctionContext, narrowedType: ts.Type): ValType | null {
  // Don't unbox if the narrowed type is still a heterogeneous union
  if (isHeterogeneousUnion(narrowedType, ctx.checker)) return null;
  // Don't unbox if still a union with null/undefined (stays externref)
  if (narrowedType.isUnion()) return null;

  if (isNumberType(narrowedType)) {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__unbox_number");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "f64" };
    }
  }
  if (isBooleanType(narrowedType)) {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__unbox_boolean");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "i32" };
    }
  }
  // String stays as externref — no unboxing needed
  if (isStringType(narrowedType)) return null;

  return null;
}

// ── instanceof (extracted to ./typeof-delete.ts) ──

/**
 * Try to resolve the right-hand side of an instanceof expression to a known
 * class in our struct system. Returns the class name if found, undefined otherwise.
 * This mirrors resolveInstanceOfClassName in typeof-delete.ts but is used to
 * decide whether to use the host fallback.
 */
function resolveInstanceOfRHS(ctx: CodegenContext, rightExpr: ts.Expression): string | undefined {
  if (ts.isIdentifier(rightExpr)) {
    const name = rightExpr.text;
    if (ctx.classTagMap.has(name)) return name;
    const mapped = ctx.classExprNameMap.get(name);
    if (mapped && ctx.classTagMap.has(mapped)) return mapped;
  }
  const tsType = ctx.checker.getTypeAtLocation(rightExpr);
  const constructSigs = tsType.getConstructSignatures?.();
  if (constructSigs && constructSigs.length > 0) {
    const instanceType = constructSigs[0]!.getReturnType();
    const symbolName = instanceType.getSymbol()?.name;
    if (symbolName) {
      if (ctx.classTagMap.has(symbolName)) return symbolName;
      const mapped = ctx.classExprNameMap.get(symbolName);
      if (mapped && ctx.classTagMap.has(mapped)) return mapped;
    }
  }
  const symbolName = tsType.getSymbol()?.name;
  if (symbolName) {
    if (ctx.classTagMap.has(symbolName)) return symbolName;
    const mapped = ctx.classExprNameMap.get(symbolName);
    if (mapped && ctx.classTagMap.has(mapped)) return mapped;
  }
  return undefined;
}

/**
 * Compile `expr instanceof RHS` using a host import when the RHS class is not
 * in our struct system (e.g., TypeError, Array, Function, Promise). (#738)
 * Passes the value as externref and the constructor name as a string constant,
 * delegating to `__instanceof(value, ctorName) -> i32` host import which
 * looks up the constructor on the global object.
 */
function compileHostInstanceOf(ctx: CodegenContext, fctx: FunctionContext, expr: ts.BinaryExpression): ValType {
  // Resolve constructor name from the RHS expression (simple identifiers only)
  let ctorName: string | undefined;
  if (ts.isIdentifier(expr.right)) {
    ctorName = expr.right.text;
  }

  if (!ctorName) {
    // Cannot resolve constructor name — compile both sides, emit false
    const leftType = compileExpression(ctx, fctx, expr.left);
    if (leftType) fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Ensure the __instanceof host import exists
  const instanceofIdx = ensureLateImport(
    ctx,
    "__instanceof",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  flushLateImportShifts(ctx, fctx);

  if (instanceofIdx === undefined) {
    const leftType = compileExpression(ctx, fctx, expr.left);
    if (leftType) fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Compile left operand (the value to test)
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (leftType.kind !== "externref") {
    coerceType(ctx, fctx, leftType, { kind: "externref" });
  }

  // Push constructor name as a string constant
  addStringConstantGlobal(ctx, ctorName);
  const strGlobalIdx = ctx.stringGlobalMap.get(ctorName);
  if (strGlobalIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: strGlobalIdx });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  // Call __instanceof(value, ctorName) -> i32
  fctx.body.push({ op: "call", funcIdx: instanceofIdx });
  return { kind: "i32" };
}

export { compileIdentifier, narrowTypeToUnbox, resolveInstanceOfRHS, compileHostInstanceOf, analyzeTdzAccessByPos };
