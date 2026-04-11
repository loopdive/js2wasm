/**
 * Function body compilation — compileFunctionBody and call-site inlining helpers.
 *
 * Extracted from codegen/index.ts (#1013).
 */
import ts from "typescript";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import { isVoidType, unwrapPromiseType } from "../checker/type-mapper.js";
import { allocLocal, deduplicateLocals } from "./context/locals.js";
import { popBody, pushBody } from "./context/bodies.js";
import { reportError } from "./context/errors.js";
import { attachSourcePos, getSourcePos } from "./context/source-pos.js";
import { ensureExnTag } from "./registry/imports.js";
import { getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import {
  coerceType,
  compileExpression,
  compileStatement,
  ensureLateImport,
  flushLateImportShifts,
  hoistFunctionDeclarations,
  valTypesMatch,
} from "./shared.js";
import { destructureParamArray, destructureParamObject } from "./destructuring-params.js";
import { emitArgumentsVecBody } from "./statements/nested-declarations.js";
import {
  hoistVarDeclarations,
  hoistLetConstWithTdz,
  cacheStringLiterals,
  resolveWasmType,
  hasAsyncModifier,
} from "./index.js";

export function bodyUsesArguments(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === "arguments") {
    // Skip binding-name positions: `let arguments`, `function f(arguments)`,
    // `{ arguments } = obj`, etc. Only treat read references as uses.
    const parent = node.parent as ts.Node | undefined;
    if (parent) {
      if (
        (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) &&
        parent.name === node
      ) {
        return false;
      }
    }
    return true;
  }
  // Don't recurse into nested functions/function expressions — they have their own `arguments`
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
    return false;
  }
  // Arrow functions do NOT have their own `arguments` — they inherit
  // the enclosing function's, so we must traverse into them.
  return ts.forEachChild(node, bodyUsesArguments) ?? false;
}

/** Maximum number of instructions for a function body to be considered inlinable */
export const INLINE_MAX_INSTRS = 10;

/** Set of instruction ops that disqualify a function body from inlining */
export const INLINE_DISALLOWED_OPS = new Set([
  "block",
  "loop",
  "if",
  "br",
  "br_if",
  "try",
  "throw",
  "rethrow",
  "unreachable",
  "call",
  "call_ref",
  "call_indirect",
  "return_call",
  "return_call_ref",
  "local.set",
  "local.tee",
]);

/**
 * After compiling a function, check if it is eligible for call-site inlining.
 * Criteria:
 * - Body has <= INLINE_MAX_INSTRS instructions
 * - No control flow, calls, or local mutations
 * - No extra locals beyond parameters
 * - Not a rest-param or capture function
 */
export function registerInlinableFunction(ctx: CodegenContext, funcName: string, func: WasmFunction): void {
  // Skip functions with rest params or captures
  if (ctx.funcRestParams.has(funcName)) return;
  if (ctx.nestedFuncCaptures.has(funcName)) return;

  const body = func.body;
  if (body.length === 0 || body.length > INLINE_MAX_INSTRS) return;

  // Filter out nop instructions (source position markers)
  const realBody = body.filter((instr) => instr.op !== "nop");
  if (realBody.length === 0 || realBody.length > INLINE_MAX_INSTRS) return;

  // Allow expression-shaped functions to end in a single trailing return.
  const normalizedBody =
    realBody.length > 0 && realBody[realBody.length - 1]?.op === "return" ? realBody.slice(0, -1) : realBody;
  if (normalizedBody.length === 0 || normalizedBody.length > INLINE_MAX_INSTRS) return;

  // Get param count from type definition
  const funcType = ctx.mod.types[func.typeIdx];
  if (!funcType || funcType.kind !== "func") return;
  const paramCount = funcType.params.length;

  // No extra locals beyond params
  if (func.locals.length > 0) return;

  // Check all instructions are safe to inline
  for (const instr of normalizedBody) {
    if (INLINE_DISALLOWED_OPS.has(instr.op)) return;

    // local.get must reference params only (index < paramCount)
    if (instr.op === "local.get") {
      if ((instr as any).index >= paramCount) return;
    }
  }

  // Determine return type from function type
  const returnType = funcType.results.length > 0 ? funcType.results[0]! : null;

  ctx.inlinableFunctions.set(funcName, {
    body: normalizedBody,
    paramCount,
    paramTypes: funcType.params.slice(),
    returnType,
  });
}
export function compileFunctionBody(ctx: CodegenContext, decl: ts.FunctionDeclaration, func: WasmFunction): void {
  const sig = ctx.checker.getSignatureFromDeclaration(decl);
  if (!sig) {
    reportError(ctx, decl, `Cannot resolve signature for function '${func.name}'`);
    return;
  }
  const retType = ctx.checker.getReturnTypeOfSignature(sig);

  // For async functions, unwrap Promise<T> to get T
  const isAsync = ctx.asyncFunctions.has(func.name);
  const isGenerator = ctx.generatorFunctions.has(func.name);
  const effectiveRetType = isAsync ? unwrapPromiseType(retType, ctx.checker) : retType;

  // Use call-site resolved types for generic functions
  const resolved = ctx.genericResolved.get(func.name);

  const restInfo = ctx.funcRestParams.get(func.name);
  const params: { name: string; type: ValType }[] = [];
  for (let i = 0; i < decl.parameters.length; i++) {
    const param = decl.parameters[i]!;
    const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${i}`;
    if (restInfo && i === restInfo.restIndex) {
      // Rest parameter — use the vec struct ref type from the function signature
      params.push({
        name: paramName,
        type: { kind: "ref_null", typeIdx: restInfo.vecTypeIdx },
      });
    } else {
      // Prefer the type already established in the function signature (which
      // may have been inferred from call sites for untyped params).
      const funcType = ctx.mod.types[func.typeIdx];
      const sigParamType = funcType?.kind === "func" ? funcType.params[i] : undefined;
      const paramType =
        resolved?.params[i] ?? sigParamType ?? resolveWasmType(ctx, ctx.checker.getTypeAtLocation(param));
      params.push({ name: paramName, type: paramType });
    }
  }

  let returnType: ValType | null;
  if (isGenerator) {
    // Generator functions return externref (JS Generator object)
    returnType = { kind: "externref" };
  } else if (resolved) {
    returnType = resolved.results.length > 0 ? (resolved.results[0] ?? null) : null;
  } else {
    returnType = isVoidType(effectiveRetType) ? null : resolveWasmType(ctx, effectiveRetType);
  }

  const fctx: FunctionContext = {
    name: func.name,
    params,
    locals: [],
    localMap: new Map(),
    returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
    isGenerator,
  };

  // Register params as locals
  for (let i = 0; i < params.length; i++) {
    fctx.localMap.set(params[i]!.name, i);
  }

  ctx.currentFunc = fctx;

  // Mark function entry with source position
  const funcPos = getSourcePos(ctx, decl);
  if (funcPos) {
    const nop: Instr = { op: "nop" };
    attachSourcePos(nop, funcPos);
    fctx.body.push(nop);
  }

  // Emit default-value initialization for parameters with initializers.
  // For params with constant defaults (#869), the caller already inlined the value,
  // so we skip the check. For expression defaults, check if the caller sent a sentinel.
  const funcOptInfo = ctx.funcOptionalParams.get(func.name);
  for (let i = 0; i < decl.parameters.length; i++) {
    const param = decl.parameters[i]!;
    if (!param.initializer) continue;

    // Skip callee-side check for constant defaults — caller inlined the value (#869)
    const optEntry = funcOptInfo?.find((o) => o.index === i);
    if (optEntry?.constantDefault) continue;

    const paramIdx = i;
    const paramType = params[i]!.type;

    // Build the "then" block: compile default expression, local.set
    const savedBody = pushBody(fctx);
    const defaultResultType = compileExpression(ctx, fctx, param.initializer, paramType);
    // Coerce if the default expression produced a different type than the param
    if (defaultResultType && !valTypesMatch(defaultResultType, paramType)) {
      coerceType(ctx, fctx, defaultResultType, paramType);
    }
    fctx.body.push({ op: "local.set", index: paramIdx });
    const thenInstrs = fctx.body;
    popBody(fctx, savedBody);

    // Emit the null/zero check + conditional assignment
    if (paramType.kind === "externref") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: thenInstrs,
      });
    } else if (paramType.kind === "ref_null" || paramType.kind === "ref") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: thenInstrs,
      });
    } else if (paramType.kind === "i32") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "i32.eqz" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: thenInstrs,
      });
    } else if (paramType.kind === "f64") {
      // Check if the f64 param holds the sentinel sNaN bit pattern (#866).
      // This distinguishes missing args from explicit NaN/0/any other value.
      // Sentinel: 0x7FF00000DEADC0DE (emitted by pushParamSentinel).
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "i64.reinterpret_f64" } as unknown as Instr);
      fctx.body.push({ op: "i64.const", value: 0x7ff00000deadc0den } as unknown as Instr);
      fctx.body.push({ op: "i64.eq" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: thenInstrs,
      });
    }
  }

  // Destructure parameters with binding patterns.
  // When a parameter is declared as e.g. function([x, y, z]) or function({a, b}),
  // the parameter is received as a single value (vec struct or struct ref) and
  // we need to extract the individual bindings into separate locals.
  for (let i = 0; i < decl.parameters.length; i++) {
    const param = decl.parameters[i]!;
    if (ts.isObjectBindingPattern(param.name)) {
      destructureParamObject(ctx, fctx, i, param.name, params[i]!.type);
    } else if (ts.isArrayBindingPattern(param.name)) {
      destructureParamArray(ctx, fctx, i, param.name, params[i]!.type);
    }
  }

  // Set up `arguments` object if the function body references it.
  // We create a vec struct (same as Array) populated from all function parameters.
  // Use externref elements so that all parameter types (numbers, strings, objects)
  // are preserved — matching the closure version in closures.ts (#771).
  if (decl.body && bodyUsesArguments(decl.body)) {
    // Ensure __box_number and __unbox_number are available for mapped arguments sync
    const hasNumericParam = params.some((p) => p.type.kind === "f64" || p.type.kind === "i32");
    if (hasNumericParam) {
      ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
      flushLateImportShifts(ctx, fctx);
    }

    const elemType: ValType = { kind: "externref" };
    const vecTypeIdx = getOrRegisterVecType(ctx, "externref", elemType);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    const vecRef: ValType = { kind: "ref", typeIdx: vecTypeIdx };

    const argsLocal = allocLocal(fctx, "arguments", vecRef);
    const arrTmp = allocLocal(fctx, "__args_arr_tmp", { kind: "ref", typeIdx: arrTypeIdx });

    // Check if all params are simple identifiers (not destructuring patterns).
    // Mapped arguments only applies to simple parameter lists in non-strict mode.
    const allSimpleParams = decl.parameters.every((p) => ts.isIdentifier(p.name) && !p.dotDotDotToken);

    // Set up mapped arguments info for param ↔ arguments sync (#849)
    if (allSimpleParams && params.length > 0) {
      fctx.mappedArgsInfo = {
        argsLocalIdx: argsLocal,
        arrTypeIdx,
        vecTypeIdx,
        paramCount: params.length,
        paramOffset: 0,
        paramTypes: params.map((p) => p.type),
      };
    }

    // Build the arguments vec by concatenating formal params with
    // extras delivered via the __extras_argv global (#1053).
    emitArgumentsVecBody(
      ctx,
      fctx,
      params.map((p) => p.type),
      0,
      { vecTypeIdx, arrTypeIdx, argsLocalIdx: argsLocal, arrTmpIdx: arrTmp },
    );
  }

  if (isGenerator) {
    // Generator function: eagerly evaluate body, collect yields into a JS array,
    // then wrap it with __create_generator to return a Generator-like object.
    // Body is wrapped in try/catch to defer thrown exceptions to first next() (#928).
    const bufferLocal = allocLocal(fctx, "__gen_buffer", { kind: "externref" });
    const pendingThrowLocal = allocLocal(fctx, "__gen_pending_throw", { kind: "externref" });

    // Create buffer: __gen_buffer = __gen_create_buffer()
    const createBufIdx = ctx.funcMap.get("__gen_create_buffer")!;
    fctx.body.push({ op: "call", funcIdx: createBufIdx });
    fctx.body.push({ op: "local.set", index: bufferLocal });
    fctx.body.push({ op: "ref.null.extern" } as unknown as Instr);
    fctx.body.push({ op: "local.set", index: pendingThrowLocal });

    // Wrap the generator body in a block so that `return` statements inside
    // the body can `br` out to the generator creation code instead of
    // using the wasm `return` opcode (which would skip __create_generator).
    // Use pushBody/popBody so the outer body stays reachable for global-index
    // fixups when new string-constant imports are added during body compilation.
    const savedGenBody = pushBody(fctx);

    // Set generator return depth for correct `br` depth in nested contexts
    fctx.generatorReturnDepth = 0;

    // Push a block label level so return can break out
    fctx.blockDepth++;
    for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
    for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;

    if (decl.body) {
      hoistVarDeclarations(ctx, fctx, decl.body.statements);
      hoistLetConstWithTdz(ctx, fctx, decl.body.statements);
      hoistFunctionDeclarations(ctx, fctx, decl.body.statements);
      for (const stmt of decl.body.statements) {
        compileStatement(ctx, fctx, stmt);
      }
    }

    fctx.blockDepth--;
    for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
    for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
    fctx.generatorReturnDepth = undefined;

    // Restore outer body and wrap compiled body in a try/catch(block)
    const bodyInstrs = fctx.body;
    popBody(fctx, savedGenBody);

    // Wrap generator body block in try/catch to capture exceptions as pending throw
    const tagIdx = ensureExnTag(ctx);
    const getCaughtIdx = ctx.funcMap.get("__get_caught_exception");
    const catchBody: Instr[] = [{ op: "local.set", index: pendingThrowLocal } as unknown as Instr];
    const catchAllBody: Instr[] =
      getCaughtIdx !== undefined
        ? [
            { op: "call", funcIdx: getCaughtIdx } as Instr,
            { op: "local.set", index: pendingThrowLocal } as unknown as Instr,
          ]
        : [];
    fctx.body.push({
      op: "try",
      blockType: { kind: "empty" },
      body: [{ op: "block", blockType: { kind: "empty" }, body: bodyInstrs }],
      catches: [{ tagIdx, body: catchBody }],
      catchAll: catchAllBody.length > 0 ? catchAllBody : undefined,
    } as unknown as Instr);

    // Return __create_generator or __create_async_generator depending on async flag.
    // Note: ctx.asyncFunctions excludes async generators (by design), so we check
    // the AST node directly to detect async function* declarations.
    const isAsyncGenerator = hasAsyncModifier(decl);
    const createGenName = isAsyncGenerator ? "__create_async_generator" : "__create_generator";
    const createGenIdx = ctx.funcMap.get(createGenName)!;
    fctx.body.push({ op: "local.get", index: bufferLocal });
    fctx.body.push({ op: "local.get", index: pendingThrowLocal });
    fctx.body.push({ op: "call", funcIdx: createGenIdx });
    // The externref Generator object is now on the stack as the return value
  } else {
    // Compile body statements
    if (decl.body) {
      // Hoist `var` declarations: pre-allocate locals so variables are accessible
      // even before their declaration site (JS var hoisting semantics).
      hoistVarDeclarations(ctx, fctx, decl.body.statements);
      // Hoist `let`/`const` declarations with TDZ flags so nested functions can
      // capture them. The TDZ flag ensures ReferenceError if accessed before init.
      hoistLetConstWithTdz(ctx, fctx, decl.body.statements);
      // Hoist function declarations: JS semantics require function declarations
      // to be available before their textual position in the enclosing scope.
      hoistFunctionDeclarations(ctx, fctx, decl.body.statements);
      for (const stmt of decl.body.statements) {
        compileStatement(ctx, fctx, stmt);
      }
    }

    // Ensure there's always a valid return value at the end for non-void functions
    if (fctx.returnType) {
      // Check if the last instruction is already a return
      const lastInstr = fctx.body[fctx.body.length - 1];
      if (!lastInstr || lastInstr.op !== "return") {
        // Add a default return value
        if (fctx.returnType.kind === "f64") {
          fctx.body.push({ op: "f64.const", value: 0 });
        } else if (fctx.returnType.kind === "i32") {
          fctx.body.push({ op: "i32.const", value: 0 });
        } else if (fctx.returnType.kind === "externref") {
          fctx.body.push({ op: "ref.null.extern" });
        } else if (fctx.returnType.kind === "ref" || fctx.returnType.kind === "ref_null") {
          fctx.body.push({ op: "ref.null", typeIdx: fctx.returnType.typeIdx });
        }
      }
    }
  }

  cacheStringLiterals(ctx, fctx);
  deduplicateLocals(fctx);
  func.locals = fctx.locals;
  func.body = fctx.body;

  ctx.currentFunc = null;
}

/**
 * Build throw instructions for TypeError when destructuring null/undefined.
 * Per JS spec, destructuring null/undefined must throw TypeError.
 */
