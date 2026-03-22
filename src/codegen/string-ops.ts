/**
 * String operations extracted from expressions.ts.
 * Handles string literals, templates, tagged templates, string binary ops,
 * and native string method calls.
 */
import ts from "typescript";
import type { CodegenContext, FunctionContext, ClosureInfo } from "./index.js";
import { allocLocal, resolveWasmType, getOrRegisterVecType, getArrTypeIdxFromVec, addUnionImports, nativeStringType, flatStringType, addStringImports, addStringConstantGlobal, nextModuleGlobalIdx, getOrRegisterTemplateVecType, pushBody } from "./index.js";
import { isBooleanType, isVoidType } from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import { compileExpression, VOID_RESULT, getLine, getCol } from "./shared.js";
import { compileNumericBinaryOp, getFuncParamTypes, emitNullCheckThrow } from "./expressions.js";
import { pushDefaultValue, emitGuardedRefCast } from "./type-coercion.js";

// ── String operations ─────────────────────────────────────────────────

export function compileStringLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  value: string,
  node?: ts.Node,
): ValType | null {
  // Fast mode: materialize as NativeString GC struct inline
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
    return compileNativeStringLiteral(ctx, fctx, value);
  }

  // Use importedStringConstants: string literals are global imports
  const globalIdx = ctx.stringGlobalMap.get(value);
  if (globalIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: globalIdx });
    return { kind: "externref" };
  }

  // Fallback for legacy stringLiteralMap (should not be reached)
  ctx.errors.push({
    message: `String literal not registered: "${value}"`,
    line: node ? getLine(node) : 0,
    column: node ? getCol(node) : 0,
  });
  return null;
}

/**
 * Materialize a string literal as a NativeString GC struct in fast mode.
 * Emits array.new_fixed with the WTF-16 code units, then struct.new.
 */
export function compileNativeStringLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  value: string,
): ValType {
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx;

  // Push len (i32) — field 0
  fctx.body.push({ op: "i32.const", value: value.length });

  // Push off (i32) = 0 — field 1
  fctx.body.push({ op: "i32.const", value: 0 });

  // Push each code unit (i16) and create array with array.new_fixed
  for (let i = 0; i < value.length; i++) {
    fctx.body.push({ op: "i32.const", value: value.charCodeAt(i) });
  }
  fctx.body.push({ op: "array.new_fixed", typeIdx: strDataTypeIdx, length: value.length });

  // struct.new $NativeString(len, off, data)
  fctx.body.push({ op: "struct.new", typeIdx: strTypeIdx });

  return nativeStringType(ctx);
}

export function compileTemplateExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.TemplateExpression,
): ValType | null {
  // Fast mode: use native string concat
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
    return compileNativeTemplateExpression(ctx, fctx, expr);
  }

  // Ensure string imports (concat, etc.) are available — template literals need concat
  addStringImports(ctx);

  const concatIdx = ctx.funcMap.get("concat");
  const toStrIdx = ctx.funcMap.get("number_toString");
  if (concatIdx === undefined) return null;

  // Start with the head text (may be empty string "")
  if (expr.head.text) {
    compileStringLiteral(ctx, fctx, expr.head.text, expr.head);
  } else {
    // Empty head — we'll start from the first span's expression
  }

  for (let i = 0; i < expr.templateSpans.length; i++) {
    const span = expr.templateSpans[i]!;

    // Compile the substitution expression and coerce to string if needed
    const spanType = compileExpression(ctx, fctx, span.expression);
    if (spanType && spanType.kind === "f64" && toStrIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
    } else if (spanType && spanType.kind === "i32" && toStrIdx !== undefined) {
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
    } else if (spanType && spanType.kind === "i64" && toStrIdx !== undefined) {
      // BigInt → f64 → string
      fctx.body.push({ op: "f64.convert_i64_s" });
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
    } else if (spanType && (spanType.kind === "ref" || spanType.kind === "ref_null")) {
      // Struct ref → externref via extern.convert_any, then toString
      fctx.body.push({ op: "extern.convert_any" });
    }
    // externref assumed to be string already

    // If we had a head (or previous spans), concat with accumulated string
    if (i === 0 && !expr.head.text) {
      // No head — the expression result IS the accumulated string so far
    } else {
      fctx.body.push({ op: "call", funcIdx: concatIdx });
    }

    // Append the span's literal text (the part after ${...} up to next ${ or backtick)
    if (span.literal.text) {
      compileStringLiteral(ctx, fctx, span.literal.text, span.literal);
      fctx.body.push({ op: "call", funcIdx: concatIdx });
    }
  }

  return { kind: "externref" };
}

/**
 * Compile a template expression in fast mode, using native string concat.
 * Number substitutions are converted via number_toString (returns externref)
 * then marshaled to native string.
 */
export function compileNativeTemplateExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.TemplateExpression,
): ValType | null {
  const concatIdx = ctx.nativeStrHelpers.get("__str_concat");
  const toStrIdx = ctx.funcMap.get("number_toString");
  const fromExternIdx = ctx.nativeStrHelpers.get("__str_from_extern");
  if (concatIdx === undefined) return null;

  if (expr.head.text) {
    compileStringLiteral(ctx, fctx, expr.head.text, expr.head);
  }

  for (let i = 0; i < expr.templateSpans.length; i++) {
    const span = expr.templateSpans[i]!;

    const spanType = compileExpression(ctx, fctx, span.expression);
    if (spanType && spanType.kind === "f64" && toStrIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
      // number_toString returns externref, marshal to native string
      if (fromExternIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: fromExternIdx });
      }
    } else if (spanType && spanType.kind === "i32" && toStrIdx !== undefined) {
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
      if (fromExternIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: fromExternIdx });
      }
    } else if (spanType && spanType.kind === "i64" && toStrIdx !== undefined) {
      fctx.body.push({ op: "f64.convert_i64_s" });
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
      if (fromExternIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: fromExternIdx });
      }
    } else if (spanType && (spanType.kind === "ref" || spanType.kind === "ref_null") && toStrIdx !== undefined) {
      // Struct ref → externref → string coercion
      fctx.body.push({ op: "extern.convert_any" });
      if (fromExternIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: fromExternIdx });
      }
    }
    // ref $NativeString is already the right type

    if (i === 0 && !expr.head.text) {
      // No head — expression result is accumulated string
    } else {
      fctx.body.push({ op: "call", funcIdx: concatIdx });
    }

    if (span.literal.text) {
      compileStringLiteral(ctx, fctx, span.literal.text, span.literal);
      fctx.body.push({ op: "call", funcIdx: concatIdx });
    }
  }

  return nativeStringType(ctx);
}


// ── Tagged template expressions ──────────────────────────────────────

/**
 * Compile a tagged template expression: tag`hello ${x} world`
 * Desugars to: tag(["hello ", " world"], x)
 *
 * Implementation: build a WasmGC externref array (vec struct) of string parts,
 * then call the tag function with the array as first arg and substitutions
 * as remaining args. NO host imports needed.
 */
export function compileTaggedTemplateExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.TaggedTemplateExpression,
): ValType | null {
  // Extract string parts (cooked + raw) and substitution expressions from the template
  const stringParts: string[] = [];
  const rawParts: string[] = [];
  const substitutions: ts.Expression[] = [];

  if (ts.isNoSubstitutionTemplateLiteral(expr.template)) {
    // tag`just a string` — one string part, no substitutions
    stringParts.push(expr.template.text);
    rawParts.push((expr.template as any).rawText ?? expr.template.text);
  } else {
    // TemplateExpression: head + spans
    const tmpl = expr.template as ts.TemplateExpression;
    stringParts.push(tmpl.head.text);
    rawParts.push((tmpl.head as any).rawText ?? tmpl.head.text);
    for (const span of tmpl.templateSpans) {
      substitutions.push(span.expression);
      stringParts.push(span.literal.text);
      rawParts.push((span.literal as any).rawText ?? span.literal.text);
    }
  }

  // Build the strings array as a WasmGC template vec (vec + raw field)
  // Per spec, template objects are cached per call site — the same source location
  // must yield the same template object on every call. We use a module global
  // (initialized to ref.null) per call site; on first call we create the array
  // and store it in the global, on subsequent calls we load the cached value.
  const elemKind = "externref";
  const elemWasm: ValType = { kind: "externref" };
  const baseVecTypeIdx = getOrRegisterVecType(ctx, elemKind, elemWasm);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, baseVecTypeIdx);
  if (arrTypeIdx < 0) {
    ctx.errors.push({ message: "Tagged template: invalid vec type for strings array", line: getLine(expr), column: getCol(expr) });
    return null;
  }

  // Register the template vec type (vec struct + raw field)
  const templateVecTypeIdx = getOrRegisterTemplateVecType(ctx);

  // Allocate a module global to cache this call site's template object
  const cacheId = ctx.templateCacheCounter++;
  const cacheGlobalType: ValType = { kind: "ref_null", typeIdx: templateVecTypeIdx };
  const cacheGlobalIdx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: `__tt_cache_${cacheId}`,
    type: cacheGlobalType,
    mutable: true,
    init: [{ op: "ref.null", typeIdx: templateVecTypeIdx }],
  });

  // Store the strings vec in a local so we can push it as an argument later
  const stringsVecType: ValType = { kind: "ref_null", typeIdx: templateVecTypeIdx };
  const stringsLocal = allocLocal(fctx, `__tt_strings_${fctx.locals.length}`, stringsVecType);

  // Build the "then" body (cache miss: create and store the template array)
  // Use savedBody pattern so compileStringLiteral pushes into a separate array
  const savedBody = pushBody(fctx);

  // First: build the raw strings array as a regular vec
  for (const raw of rawParts) {
    compileStringLiteral(ctx, fctx, raw, expr);
  }
  fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: rawParts.length });
  const tmpRawData = allocLocal(fctx, `__tt_raw_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: tmpRawData });
  fctx.body.push({ op: "i32.const", value: rawParts.length });
  fctx.body.push({ op: "local.get", index: tmpRawData });
  fctx.body.push({ op: "struct.new", typeIdx: baseVecTypeIdx });
  const tmpRawVec = allocLocal(fctx, `__tt_raw_vec_${fctx.locals.length}`, { kind: "ref", typeIdx: baseVecTypeIdx });
  fctx.body.push({ op: "local.set", index: tmpRawVec });

  // Second: build the cooked strings array
  for (const str of stringParts) {
    compileStringLiteral(ctx, fctx, str, expr);
  }
  fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: stringParts.length });
  const tmpData = allocLocal(fctx, `__tt_arr_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: tmpData });

  // Create the template vec struct: { length, data, raw }
  fctx.body.push({ op: "i32.const", value: stringParts.length });
  fctx.body.push({ op: "local.get", index: tmpData });
  fctx.body.push({ op: "local.get", index: tmpRawVec });
  fctx.body.push({ op: "struct.new", typeIdx: templateVecTypeIdx });
  fctx.body.push({ op: "global.set", index: cacheGlobalIdx });
  const thenBody = fctx.body;
  fctx.body = savedBody;

  // Check if cache global is null (first call at this site)
  fctx.body.push({ op: "global.get", index: cacheGlobalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: thenBody,
  } as Instr);

  // Load cached template object into the local
  fctx.body.push({ op: "global.get", index: cacheGlobalIdx });
  fctx.body.push({ op: "local.set", index: stringsLocal });

  // Now compile the call to the tag function.
  // The tag function receives (stringsArray, ...substitutions).
  // We handle three cases: known function, closure, or fallback.

  if (ts.isIdentifier(expr.tag)) {
    const tagName = expr.tag.text;

    // Case 1: tag is a closure variable
    const closureInfo = ctx.closureMap.get(tagName);
    if (closureInfo) {
      const localIdx = fctx.localMap.get(tagName);
      if (localIdx === undefined) {
        ctx.errors.push({ message: `Tagged template: closure variable '${tagName}' not found`, line: getLine(expr), column: getCol(expr) });
        return null;
      }

      // Push closure ref as self param
      fctx.body.push({ op: "local.get", index: localIdx });

      // Push strings array as first argument (coerce to expected param type)
      const paramType0 = closureInfo.paramTypes[0];
      fctx.body.push({ op: "local.get", index: stringsLocal });
      if (paramType0 && paramType0.kind === "externref") {
        // Need to convert GC ref to externref
        fctx.body.push({ op: "extern.convert_any" });
      }

      // Push substitution expressions as remaining arguments
      // Only push up to the number of declared params (minus 1 for self, minus 1 for strings)
      const closureMaxSubs = Math.min(substitutions.length, closureInfo.paramTypes.length - 1);
      for (let i = 0; i < closureMaxSubs; i++) {
        const expectedParamType = closureInfo.paramTypes[i + 1];
        compileExpression(ctx, fctx, substitutions[i]!, expectedParamType);
      }

      // Push funcref from closure struct field 0 and call_ref
      fctx.body.push({ op: "local.get", index: localIdx });
      fctx.body.push({ op: "struct.get", typeIdx: closureInfo.structTypeIdx, fieldIdx: 0 });
      fctx.body.push({ op: "ref.cast", typeIdx: closureInfo.funcTypeIdx });
      fctx.body.push({ op: "ref.as_non_null" });
      fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });

      return closureInfo.returnType ?? VOID_RESULT;
    }

    // Case 2: tag is a known function
    const funcIdx = ctx.funcMap.get(tagName);
    if (funcIdx !== undefined) {
      // Prepend captured values for nested functions with captures
      const nestedCaptures = ctx.nestedFuncCaptures.get(tagName);
      if (nestedCaptures) {
        for (const cap of nestedCaptures) {
          fctx.body.push({ op: "local.get", index: cap.outerLocalIdx });
        }
      }

      const restInfo = ctx.funcRestParams.get(tagName);
      const paramTypes = getFuncParamTypes(ctx, funcIdx);

      // Push the strings array as argument 0
      fctx.body.push({ op: "local.get", index: stringsLocal });
      // Coerce if needed (e.g. ref_null vec → externref)
      if (paramTypes?.[0] && paramTypes[0].kind === "externref") {
        fctx.body.push({ op: "extern.convert_any" });
      }

      if (restInfo) {
        // Tag function has rest param: push positional args before rest, then pack rest
        const captureCount = nestedCaptures ? nestedCaptures.length : 0;
        const restIdx = restInfo.restIndex - captureCount; // restIndex in user params (0-based after captures)
        // Push positional substitutions before the rest param
        for (let i = 0; i < Math.min(substitutions.length, restIdx - 1); i++) {
          compileExpression(ctx, fctx, substitutions[i]!, paramTypes?.[i + 1 + captureCount]);
        }
        // Pack remaining substitutions into a vec for the rest param
        const restStart = Math.max(0, restIdx - 1);
        const restSubs = substitutions.slice(restStart);
        const restArgCount = restSubs.length;
        fctx.body.push({ op: "i32.const", value: restArgCount });
        for (const sub of restSubs) {
          compileExpression(ctx, fctx, sub, restInfo.elemType);
        }
        fctx.body.push({ op: "array.new_fixed", typeIdx: restInfo.arrayTypeIdx, length: restArgCount });
        fctx.body.push({ op: "struct.new", typeIdx: restInfo.vecTypeIdx });
      } else {
        // No rest param — push substitutions as positional args
        // Only push up to the number of declared params (excluding captures and strings array)
        const captureCount = nestedCaptures ? nestedCaptures.length : 0;
        const maxSubs = paramTypes ? Math.min(substitutions.length, paramTypes.length - 1 - captureCount) : substitutions.length;
        for (let i = 0; i < maxSubs; i++) {
          compileExpression(ctx, fctx, substitutions[i]!, paramTypes?.[i + 1 + captureCount]);
        }

        // Supply defaults for missing optional params
        const optInfo = ctx.funcOptionalParams.get(tagName);
        if (optInfo) {
          const numProvided = maxSubs + 1 + captureCount; // +1 for strings array + captures
          for (const opt of optInfo) {
            if (opt.index >= numProvided) {
              pushDefaultValue(fctx, opt.type);
            }
          }
        }
      }

      // Re-lookup funcIdx in case imports shifted during compilation
      const finalFuncIdx = ctx.funcMap.get(tagName) ?? funcIdx;
      fctx.body.push({ op: "call", funcIdx: finalFuncIdx });

      // Determine return type
      const sig = ctx.checker.getResolvedSignature(expr);
      if (sig) {
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        if (isVoidType(retType)) return null;
        return resolveWasmType(ctx, retType);
      }
      return { kind: "externref" };
    }
  }

  // Fallback: general expression tag (call expressions, IIFE, parenthesized, etc.)
  // Use the TypeScript type checker to resolve the tag expression's callable type,
  // then find a matching registered closure by signature. This handles cases like
  // getTag()`hello`, (function(s){ return s; })`hello`, etc.
  {
    // First, try to resolve the tag expression's type and find a matching closure
    const tagTsType = ctx.checker.getTypeAtLocation(expr.tag);
    const callSigs = tagTsType.getCallSignatures?.();

    let matchedClosureInfo: ClosureInfo | undefined;
    let matchedStructTypeIdx: number | undefined;

    if (callSigs && callSigs.length > 0) {
      const sig = callSigs[0]!;
      const sigParamCount = sig.parameters.length;
      const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
      const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
      const sigParamWasmTypes: ValType[] = [];
      for (let i = 0; i < sigParamCount; i++) {
        const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
        sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
      }

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
          matchedClosureInfo = info;
          matchedStructTypeIdx = typeIdx;
          break;
        }
      }
    }

    if (matchedClosureInfo && matchedStructTypeIdx !== undefined) {
      // Compile the tag expression to get the closure on the stack
      const tagResult = compileExpression(ctx, fctx, expr.tag);

      // Save closure ref to a local
      let closureLocal: number;
      if (tagResult?.kind === "externref") {
        // Need to convert externref back to the closure struct ref (guarded)
        const closureRefType: ValType = { kind: "ref_null", typeIdx: matchedStructTypeIdx };
        closureLocal = allocLocal(fctx, `__tt_tag_${fctx.locals.length}`, closureRefType);
        fctx.body.push({ op: "any.convert_extern" });
        emitGuardedRefCast(fctx, matchedStructTypeIdx);
        fctx.body.push({ op: "local.set", index: closureLocal });
      } else {
        const closureRefType: ValType = tagResult ?? { kind: "ref", typeIdx: matchedStructTypeIdx };
        closureLocal = allocLocal(fctx, `__tt_tag_${fctx.locals.length}`, closureRefType);
        fctx.body.push({ op: "local.set", index: closureLocal });
      }

      // Push closure ref as self param (first arg of lifted function)
      fctx.body.push({ op: "local.get", index: closureLocal });
      fctx.body.push({ op: "ref.as_non_null" } as Instr);

      // Push strings array as first argument
      fctx.body.push({ op: "local.get", index: stringsLocal });
      // Coerce if the closure expects externref for the first param
      if (matchedClosureInfo.paramTypes[0] && matchedClosureInfo.paramTypes[0].kind === "externref") {
        fctx.body.push({ op: "extern.convert_any" });
      }

      // Push substitution expressions as remaining arguments
      const closureMaxSubs = Math.min(substitutions.length, matchedClosureInfo.paramTypes.length - 1);
      for (let i = 0; i < closureMaxSubs; i++) {
        const expectedParamType = matchedClosureInfo.paramTypes[i + 1];
        compileExpression(ctx, fctx, substitutions[i]!, expectedParamType);
      }

      // Pad missing arguments with defaults
      for (let i = substitutions.length + 1; i < matchedClosureInfo.paramTypes.length; i++) {
        pushDefaultValue(fctx, matchedClosureInfo.paramTypes[i]!);
      }

      // Push funcref from closure struct field 0 and call_ref
      fctx.body.push({ op: "local.get", index: closureLocal });
      fctx.body.push({ op: "ref.as_non_null" } as Instr);
      fctx.body.push({ op: "struct.get", typeIdx: matchedStructTypeIdx, fieldIdx: 0 });
      fctx.body.push({ op: "ref.cast", typeIdx: matchedClosureInfo.funcTypeIdx });
      fctx.body.push({ op: "ref.as_non_null" });
      fctx.body.push({ op: "call_ref", typeIdx: matchedClosureInfo.funcTypeIdx });

      return matchedClosureInfo.returnType ?? VOID_RESULT;
    }

    // No matching closure found — try compiling the tag as a general expression
    // and checking if the result is a recognizable closure ref type
    {
      const tagResult = compileExpression(ctx, fctx, expr.tag);
      if (tagResult && (tagResult.kind === "ref" || tagResult.kind === "ref_null")) {
        const closureTypeIdx = (tagResult as { typeIdx: number }).typeIdx;
        const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
        if (closureInfo) {
          const closureLocal = allocLocal(fctx, `__tt_tag_${fctx.locals.length}`, tagResult);
          fctx.body.push({ op: "local.set", index: closureLocal });

          fctx.body.push({ op: "local.get", index: closureLocal });

          fctx.body.push({ op: "local.get", index: stringsLocal });
          if (closureInfo.paramTypes[0] && closureInfo.paramTypes[0].kind === "externref") {
            fctx.body.push({ op: "extern.convert_any" });
          }

          const closureMaxSubs = Math.min(substitutions.length, closureInfo.paramTypes.length - 1);
          for (let i = 0; i < closureMaxSubs; i++) {
            const expectedParamType = closureInfo.paramTypes[i + 1];
            compileExpression(ctx, fctx, substitutions[i]!, expectedParamType);
          }

          for (let i = substitutions.length + 1; i < closureInfo.paramTypes.length; i++) {
            pushDefaultValue(fctx, closureInfo.paramTypes[i]!);
          }

          fctx.body.push({ op: "local.get", index: closureLocal });
          fctx.body.push({ op: "struct.get", typeIdx: closureInfo.structTypeIdx, fieldIdx: 0 });
          fctx.body.push({ op: "ref.cast", typeIdx: closureInfo.funcTypeIdx });
          fctx.body.push({ op: "ref.as_non_null" });
          fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });

          return closureInfo.returnType ?? VOID_RESULT;
        }
      }

      // If the tag expression compiled but didn't return a recognizable closure,
      // drop it and emit null as fallback
      if (tagResult && tagResult !== VOID_RESULT) {
        fctx.body.push({ op: "drop" });
      }
    }
  }

  ctx.errors.push({
    message: `Tagged template: unsupported tag expression kind ${ts.SyntaxKind[expr.tag.kind]}`,
    line: getLine(expr),
    column: getCol(expr),
  });
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}
/**
 * Emit wasm code to convert a boolean (i32) on the stack to a string.
 * Produces "true" or "false" string constant (externref) via if/else.
 */
export function emitBoolToString(ctx: CodegenContext, fctx: FunctionContext): void {
  // Ensure "true" and "false" string constants are registered
  addStringConstantGlobal(ctx, "true");
  addStringConstantGlobal(ctx, "false");

  const trueIdx = ctx.stringGlobalMap.get("true")!;
  const falseIdx = ctx.stringGlobalMap.get("false")!;

  // i32 boolean value is on the stack → select "true" or "false" string constant
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: [{ op: "global.get", index: trueIdx }],
    else: [{ op: "global.get", index: falseIdx }],
  } as any);
}

export function compileStringBinaryOp(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
): ValType | null {
  // Fast mode: native string operations
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
    const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;

    switch (op) {
      case ts.SyntaxKind.PlusToken: {
        // concat accepts ref $AnyString — no flatten needed
        compileExpression(ctx, fctx, expr.left);
        compileExpression(ctx, fctx, expr.right);
        const funcIdx = ctx.nativeStrHelpers.get("__str_concat");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return nativeStringType(ctx);
        }
        break;
      }
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken: {
        // equals needs flat strings — flatten both operands
        compileExpression(ctx, fctx, expr.left);
        fctx.body.push({ op: "call", funcIdx: strFlattenIdx });
        compileExpression(ctx, fctx, expr.right);
        fctx.body.push({ op: "call", funcIdx: strFlattenIdx });
        const funcIdx = ctx.nativeStrHelpers.get("__str_equals");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "i32" };
        }
        break;
      }
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken: {
        compileExpression(ctx, fctx, expr.left);
        fctx.body.push({ op: "call", funcIdx: strFlattenIdx });
        compileExpression(ctx, fctx, expr.right);
        fctx.body.push({ op: "call", funcIdx: strFlattenIdx });
        const funcIdx = ctx.nativeStrHelpers.get("__str_equals");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          fctx.body.push({ op: "i32.eqz" });
          return { kind: "i32" };
        }
        break;
      }
      case ts.SyntaxKind.LessThanToken:
      case ts.SyntaxKind.LessThanEqualsToken:
      case ts.SyntaxKind.GreaterThanToken:
      case ts.SyntaxKind.GreaterThanEqualsToken: {
        // Lexicographic comparison via __str_compare (returns -1, 0, 1)
        compileExpression(ctx, fctx, expr.left);
        compileExpression(ctx, fctx, expr.right);
        const funcIdx = ctx.nativeStrHelpers.get("__str_compare");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          fctx.body.push({ op: "i32.const", value: 0 });
          const cmpOp = op === ts.SyntaxKind.LessThanToken ? "i32.lt_s"
            : op === ts.SyntaxKind.LessThanEqualsToken ? "i32.le_s"
            : op === ts.SyntaxKind.GreaterThanToken ? "i32.gt_s"
            : "i32.ge_s";
          fctx.body.push({ op: cmpOp as any });
          return { kind: "i32" };
        }
        break;
      }
      default: {
        // Arithmetic/bitwise operators on strings: coerce both operands to f64 via ToNumber
        // This matches JS semantics: "5" - "2" === 3, "6" * "7" === 42
        const leftType = compileExpression(ctx, fctx, expr.left);
        // Convert to f64 based on actual result type
        if (leftType && leftType.kind === "f64") {
          // Already f64 — no conversion needed
        } else if (leftType && leftType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
        } else if (leftType && (leftType.kind === "ref" || leftType.kind === "ref_null")) {
          // Native string ref → externref → f64
          fctx.body.push({ op: "extern.convert_any" });
          const pfIdx1 = ctx.funcMap.get("parseFloat");
          if (pfIdx1 !== undefined) {
            fctx.body.push({ op: "call", funcIdx: pfIdx1 });
          } else {
            addUnionImports(ctx);
            fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__unbox_number")! });
          }
        } else {
          // externref or other — parseFloat/unbox
          const pfIdx1 = ctx.funcMap.get("parseFloat");
          if (pfIdx1 !== undefined) {
            fctx.body.push({ op: "call", funcIdx: pfIdx1 });
          } else {
            addUnionImports(ctx);
            fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__unbox_number")! });
          }
        }
        const rightType = compileExpression(ctx, fctx, expr.right);
        // Convert to f64 based on actual result type
        if (rightType && rightType.kind === "f64") {
          // Already f64 — no conversion needed
        } else if (rightType && rightType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
        } else if (rightType && (rightType.kind === "ref" || rightType.kind === "ref_null")) {
          fctx.body.push({ op: "extern.convert_any" });
          const pfIdx2 = ctx.funcMap.get("parseFloat");
          if (pfIdx2 !== undefined) {
            fctx.body.push({ op: "call", funcIdx: pfIdx2 });
          } else {
            addUnionImports(ctx);
            fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__unbox_number")! });
          }
        } else {
          const pfIdx2 = ctx.funcMap.get("parseFloat");
          if (pfIdx2 !== undefined) {
            fctx.body.push({ op: "call", funcIdx: pfIdx2 });
          } else {
            addUnionImports(ctx);
            fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__unbox_number")! });
          }
        }
        return compileNumericBinaryOp(ctx, fctx, op, expr);
      }
    }

    ctx.errors.push({
      message: `Unsupported string operator: ${ts.SyntaxKind[op]}`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Ensure string imports are registered (may not be if no string literals in source)
  addStringImports(ctx);

  // Arithmetic/bitwise operators on strings: coerce both operands to f64 via ToNumber
  // This matches JS semantics: "5" - "2" === 3, "6" * "7" === 42
  const isArithmeticOrBitwise =
    op === ts.SyntaxKind.MinusToken ||
    op === ts.SyntaxKind.AsteriskToken ||
    op === ts.SyntaxKind.AsteriskAsteriskToken ||
    op === ts.SyntaxKind.SlashToken ||
    op === ts.SyntaxKind.PercentToken ||
    op === ts.SyntaxKind.AmpersandToken ||
    op === ts.SyntaxKind.BarToken ||
    op === ts.SyntaxKind.CaretToken ||
    op === ts.SyntaxKind.LessThanLessThanToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken;
  if (isArithmeticOrBitwise) {
    // Compile left operand and convert to f64
    const leftArithType = compileExpression(ctx, fctx, expr.left);
    if (leftArithType && leftArithType.kind === "f64") {
      // Already f64 — no conversion needed
    } else if (leftArithType && leftArithType.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
    } else {
      // externref (string) — convert to number via parseFloat
      const pfIdx = ctx.funcMap.get("parseFloat");
      if (pfIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: pfIdx });
      } else {
        addUnionImports(ctx);
        fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__unbox_number")! });
      }
    }
    // Compile right operand and convert to f64
    const rightArithType = compileExpression(ctx, fctx, expr.right);
    if (rightArithType && rightArithType.kind === "f64") {
      // Already f64 — no conversion needed
    } else if (rightArithType && rightArithType.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
    } else {
      // externref (string) — convert to number via parseFloat
      const pfIdx2 = ctx.funcMap.get("parseFloat");
      if (pfIdx2 !== undefined) {
        fctx.body.push({ op: "call", funcIdx: pfIdx2 });
      } else {
        addUnionImports(ctx);
        fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__unbox_number")! });
      }
    }
    return compileNumericBinaryOp(ctx, fctx, op, expr);
  }

  // Compile operands with coercion: if one side is a number/bool in a string
  // context, inject appropriate toString conversion.
  // Booleans → "true"/"false" string constants (not number_toString which gives "1"/"0")
  // Numbers → number_toString
  const leftTsType = ctx.checker.getTypeAtLocation(expr.left);
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (op === ts.SyntaxKind.PlusToken && !leftType) {
    // Void function return used in string concat → push "undefined"
    addStringConstantGlobal(ctx, "undefined");
    const undefGIdx = ctx.stringGlobalMap.get("undefined")!;
    fctx.body.push({ op: "global.get", index: undefGIdx });
  } else if (op === ts.SyntaxKind.PlusToken && leftType && (leftType.kind === "f64" || leftType.kind === "i32" || leftType.kind === "i64")) {
    if (isBooleanType(leftTsType) && leftType.kind === "i32") {
      // Boolean → "true"/"false" via conditional select of string constants
      emitBoolToString(ctx, fctx);
    } else {
      if (leftType.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
      else if (leftType.kind === "i64") fctx.body.push({ op: "f64.convert_i64_s" });
      const toStr = ctx.funcMap.get("number_toString");
      if (toStr !== undefined) fctx.body.push({ op: "call", funcIdx: toStr });
    }
  } else if (op === ts.SyntaxKind.PlusToken && leftType && leftType.kind === "externref") {
    // null/undefined externref in string concat → coerce to "null"/"undefined" string
    const leftIsNull = (leftTsType.flags & ts.TypeFlags.Null) !== 0;
    const leftIsUndef = (leftTsType.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;
    if (leftIsNull) {
      fctx.body.push({ op: "drop" });
      addStringConstantGlobal(ctx, "null");
      fctx.body.push({ op: "global.get", index: ctx.stringGlobalMap.get("null")! });
    } else if (leftIsUndef) {
      fctx.body.push({ op: "drop" });
      addStringConstantGlobal(ctx, "undefined");
      fctx.body.push({ op: "global.get", index: ctx.stringGlobalMap.get("undefined")! });
    }
  } else if (op === ts.SyntaxKind.PlusToken && leftType && (leftType.kind === "ref" || leftType.kind === "ref_null")) {
    // Struct ref → externref for concat (e.g. object toString → "[object Object]")
    fctx.body.push({ op: "extern.convert_any" });
  }
  const rightTsType = ctx.checker.getTypeAtLocation(expr.right);
  const rightType = compileExpression(ctx, fctx, expr.right);
  if (op === ts.SyntaxKind.PlusToken && !rightType) {
    // Void function return used in string concat → push "undefined"
    addStringConstantGlobal(ctx, "undefined");
    const undefGIdx = ctx.stringGlobalMap.get("undefined")!;
    fctx.body.push({ op: "global.get", index: undefGIdx });
  } else if (op === ts.SyntaxKind.PlusToken && rightType && (rightType.kind === "f64" || rightType.kind === "i32" || rightType.kind === "i64")) {
    if (isBooleanType(rightTsType) && rightType.kind === "i32") {
      emitBoolToString(ctx, fctx);
    } else {
      if (rightType.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
      else if (rightType.kind === "i64") fctx.body.push({ op: "f64.convert_i64_s" });
      const toStr = ctx.funcMap.get("number_toString");
      if (toStr !== undefined) fctx.body.push({ op: "call", funcIdx: toStr });
    }
  } else if (op === ts.SyntaxKind.PlusToken && rightType && rightType.kind === "externref") {
    // null/undefined externref in string concat → coerce to "null"/"undefined" string
    const rightIsNull = (rightTsType.flags & ts.TypeFlags.Null) !== 0;
    const rightIsUndef = (rightTsType.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;
    if (rightIsNull) {
      fctx.body.push({ op: "drop" });
      addStringConstantGlobal(ctx, "null");
      fctx.body.push({ op: "global.get", index: ctx.stringGlobalMap.get("null")! });
    } else if (rightIsUndef) {
      fctx.body.push({ op: "drop" });
      addStringConstantGlobal(ctx, "undefined");
      fctx.body.push({ op: "global.get", index: ctx.stringGlobalMap.get("undefined")! });
    }
  } else if (op === ts.SyntaxKind.PlusToken && rightType && (rightType.kind === "ref" || rightType.kind === "ref_null")) {
    // Struct ref → externref for concat
    fctx.body.push({ op: "extern.convert_any" });
  }

  switch (op) {
    case ts.SyntaxKind.PlusToken: {
      // String concatenation
      const funcIdx = ctx.funcMap.get("concat");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
      break;
    }
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken: {
      const funcIdx = ctx.funcMap.get("equals");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "i32" };
      }
      break;
    }
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken: {
      const funcIdx = ctx.funcMap.get("equals");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        fctx.body.push({ op: "i32.eqz" }); // negate
        return { kind: "i32" };
      }
      break;
    }
    case ts.SyntaxKind.LessThanToken:
    case ts.SyntaxKind.LessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanToken:
    case ts.SyntaxKind.GreaterThanEqualsToken: {
      const funcIdx = ctx.funcMap.get("string_compare");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        fctx.body.push({ op: "i32.const", value: 0 });
        const cmpOp = op === ts.SyntaxKind.LessThanToken ? "i32.lt_s"
          : op === ts.SyntaxKind.LessThanEqualsToken ? "i32.le_s"
          : op === ts.SyntaxKind.GreaterThanToken ? "i32.gt_s"
          : "i32.ge_s";
        fctx.body.push({ op: cmpOp as any });
        return { kind: "i32" };
      }
      break;
    }
  }

  ctx.errors.push({
    message: `Unsupported string operator: ${ts.SyntaxKind[op]}`,
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}

// ── Native string method calls (fast mode) ──────────────────────────

/**
 * Compile a method call on a native string in fast mode.
 * Handles: charCodeAt (inline), charAt, substring, slice (native helpers),
 * and delegates other methods to host via marshal.
 */
export function compileNativeStringMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  method: string,
): ValType | null {
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;

  // Helper: emit a flatten call to convert ref $AnyString → ref $NativeString
  const emitFlatten = () => fctx.body.push({ op: "call", funcIdx: flattenIdx });

  // charCodeAt: inline array.get_u with offset (must flatten first)
  if (method === "charCodeAt") {
    compileExpression(ctx, fctx, propAccess.expression);
    // Flatten to FlatString (handles ConsString → FlatString)
    const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
    fctx.body.push({ op: "call", funcIdx: flattenIdx });
    // Store flat string ref in a temp local to access both data and off
    const tmpLocal = allocLocal(fctx, "__charCodeAt_tmp", flatStringType(ctx));
    fctx.body.push({ op: "local.set", index: tmpLocal });
    // Push data ref (field 2)
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }); // .data
    // Compute off + idx (off is field 1)
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }); // .off
    if (expr.arguments.length > 0) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
      if (!argType || argType === VOID_RESULT) {
        fctx.body.push({ op: "i32.const", value: 0 });
      } else if (argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    fctx.body.push({ op: "i32.add" }); // off + idx
    fctx.body.push({ op: "array.get_u", typeIdx: strDataTypeIdx });
    return { kind: "i32" };
  }

  // charAt: native helper
  if (method === "charAt") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    if (expr.arguments.length > 0) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
      if (!argType || argType === VOID_RESULT) {
        fctx.body.push({ op: "i32.const", value: 0 });
      } else if (argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_charAt")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // at: like charAt but supports negative indices
  if (method === "at") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    const strTmp = allocLocal(fctx, `__str_at_tmp_${fctx.locals.length}`, flatStringType(ctx));
    fctx.body.push({ op: "local.tee", index: strTmp });
    // Get string length for negative index support (len is field 0)
    fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }); // .len
    const lenTmp = allocLocal(fctx, `__str_at_len_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.set", index: lenTmp });
    // Compile index
    const idxTmp = allocLocal(fctx, `__str_at_idx_${fctx.locals.length}`, { kind: "i32" });
    if (expr.arguments.length > 0) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
      if (!argType || argType === VOID_RESULT) {
        fctx.body.push({ op: "i32.const", value: 0 });
      } else if (argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    fctx.body.push({ op: "local.set", index: idxTmp });
    // If index < 0, add length
    fctx.body.push({ op: "local.get", index: idxTmp });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.lt_s" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: idxTmp },
        { op: "local.get", index: lenTmp },
        { op: "i32.add" },
        { op: "local.set", index: idxTmp },
      ],
    } as Instr);
    // Call charAt helper with adjusted index
    fctx.body.push({ op: "local.get", index: strTmp });
    fctx.body.push({ op: "local.get", index: idxTmp });
    const funcIdx = ctx.nativeStrHelpers.get("__str_charAt")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // substring: native helper
  if (method === "substring") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    // start
    if (expr.arguments.length > 0) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
      if (!argType || argType === VOID_RESULT) {
        // void/null result — push default 0
        fctx.body.push({ op: "i32.const", value: 0 });
      } else if (argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    // end
    if (expr.arguments.length > 1) {
      const argType = compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "f64" });
      if (!argType || argType === VOID_RESULT) {
        fctx.body.push({ op: "i32.const", value: 0x7FFFFFFF });
      } else if (argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
    } else {
      // Default end = string length
      // We need to get the receiver again — use a temp local
      // Actually, push len from the string on stack — but receiver is consumed.
      // Simpler: push i32.const MAX_INT as sentinel and let helper clamp
      fctx.body.push({ op: "i32.const", value: 0x7FFFFFFF });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_substring")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // slice: native helper (handles negative indices)
  if (method === "slice") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    // start
    if (expr.arguments.length > 0) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
      if (!argType || argType === VOID_RESULT) {
        fctx.body.push({ op: "i32.const", value: 0 });
      } else if (argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    // end
    if (expr.arguments.length > 1) {
      const argType = compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "f64" });
      if (!argType || argType === VOID_RESULT) {
        fctx.body.push({ op: "i32.const", value: 0x7FFFFFFF });
      } else if (argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0x7FFFFFFF });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_slice")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // indexOf: native helper
  if (method === "indexOf") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    // search string arg
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]!);
      emitFlatten();
    } else {
      fctx.body.push({ op: "ref.null", typeIdx: strTypeIdx });
    }
    // fromIndex arg
    if (expr.arguments.length > 1) {
      const argType = compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "f64" });
      if (!argType || argType === VOID_RESULT) {
        fctx.body.push({ op: "i32.const", value: 0 });
      } else if (argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_indexOf")!;
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "i32" };
  }

  // lastIndexOf: native helper
  if (method === "lastIndexOf") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]!);
      emitFlatten();
    } else {
      fctx.body.push({ op: "ref.null", typeIdx: strTypeIdx });
    }
    if (expr.arguments.length > 1) {
      const argType = compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "f64" });
      if (!argType || argType === VOID_RESULT) {
        fctx.body.push({ op: "i32.const", value: 0x7FFFFFFF });
      } else if (argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0x7FFFFFFF });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_lastIndexOf")!;
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "i32" };
  }

  // includes: native helper
  if (method === "includes") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]!);
      emitFlatten();
    } else {
      fctx.body.push({ op: "ref.null", typeIdx: strTypeIdx });
    }
    if (expr.arguments.length > 1) {
      const argType = compileExpression(ctx, fctx, expr.arguments[1]!);
      if (argType && argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_includes")!;
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "i32" };
  }

  // startsWith: native helper
  if (method === "startsWith") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]!);
      emitFlatten();
    } else {
      fctx.body.push({ op: "ref.null", typeIdx: strTypeIdx });
    }
    if (expr.arguments.length > 1) {
      const argType = compileExpression(ctx, fctx, expr.arguments[1]!);
      if (argType && argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_startsWith")!;
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "i32" };
  }

  // endsWith: native helper
  if (method === "endsWith") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    // suffix arg
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]!);
      emitFlatten();
    } else {
      fctx.body.push({ op: "ref.null", typeIdx: strTypeIdx });
    }
    // endPosition arg — default to string length
    if (expr.arguments.length > 1) {
      const argType = compileExpression(ctx, fctx, expr.arguments[1]!);
      if (argType && argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0x7FFFFFFF });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_endsWith")!;
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "i32" };
  }

  // trim, trimStart, trimEnd: native helpers
  if (method === "trim" || method === "trimStart" || method === "trimEnd") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    const helperName = `__str_${method}`;
    const funcIdx = ctx.nativeStrHelpers.get(helperName)!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // repeat: native helper
  if (method === "repeat") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    if (expr.arguments.length > 0) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argType && argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_repeat")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // padStart: native helper
  if (method === "padStart") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    // targetLength
    if (expr.arguments.length > 0) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argType && argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    // padString (default: " ")
    if (expr.arguments.length > 1) {
      compileExpression(ctx, fctx, expr.arguments[1]!);
      emitFlatten();
    } else {
      // Create a single-space native string (len=1, off=0, [32])
      fctx.body.push({ op: "i32.const", value: 1 });  // len
      fctx.body.push({ op: "i32.const", value: 0 });  // off
      fctx.body.push({ op: "i32.const", value: 32 }); // space
      fctx.body.push({ op: "array.new_fixed", typeIdx: ctx.nativeStrDataTypeIdx, length: 1 });
      fctx.body.push({ op: "struct.new", typeIdx: ctx.nativeStrTypeIdx });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_padStart")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // padEnd: native helper
  if (method === "padEnd") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    // targetLength
    if (expr.arguments.length > 0) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argType && argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    // padString (default: " ")
    if (expr.arguments.length > 1) {
      compileExpression(ctx, fctx, expr.arguments[1]!);
      emitFlatten();
    } else {
      fctx.body.push({ op: "i32.const", value: 1 });  // len
      fctx.body.push({ op: "i32.const", value: 0 });  // off
      fctx.body.push({ op: "i32.const", value: 32 });
      fctx.body.push({ op: "array.new_fixed", typeIdx: ctx.nativeStrDataTypeIdx, length: 1 });
      fctx.body.push({ op: "struct.new", typeIdx: ctx.nativeStrTypeIdx });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_padEnd")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // toLowerCase, toUpperCase: native helpers
  if (method === "toLowerCase" || method === "toUpperCase") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    const helperName = `__str_${method}`;
    const funcIdx = ctx.nativeStrHelpers.get(helperName)!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // replace(search, replacement): native helper
  if (method === "replace") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    // search arg
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]!);
      emitFlatten();
    } else {
      fctx.body.push({ op: "ref.null", typeIdx: ctx.nativeStrTypeIdx });
    }
    // replacement arg
    if (expr.arguments.length > 1) {
      compileExpression(ctx, fctx, expr.arguments[1]!);
      emitFlatten();
    } else {
      // default: empty string (len=0, off=0, [])
      fctx.body.push({ op: "i32.const", value: 0 });  // len
      fctx.body.push({ op: "i32.const", value: 0 });  // off
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "array.new_default", typeIdx: ctx.nativeStrDataTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: ctx.nativeStrTypeIdx });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_replace")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // replaceAll(search, replacement): native helper
  if (method === "replaceAll") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    // search arg
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]!);
      emitFlatten();
    } else {
      fctx.body.push({ op: "ref.null", typeIdx: ctx.nativeStrTypeIdx });
    }
    // replacement arg
    if (expr.arguments.length > 1) {
      compileExpression(ctx, fctx, expr.arguments[1]!);
      emitFlatten();
    } else {
      // default: empty string (len=0, off=0, [])
      fctx.body.push({ op: "i32.const", value: 0 });  // len
      fctx.body.push({ op: "i32.const", value: 0 });  // off
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "array.new_default", typeIdx: ctx.nativeStrDataTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: ctx.nativeStrTypeIdx });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_replaceAll")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // split: native helper, returns native string array
  if (method === "split") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    // separator arg
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]!);
      emitFlatten();
    } else {
      // default: empty string separator (split each char) (len=0, off=0, [])
      fctx.body.push({ op: "i32.const", value: 0 });  // len
      fctx.body.push({ op: "i32.const", value: 0 });  // off
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "array.new_default", typeIdx: ctx.nativeStrDataTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: ctx.nativeStrTypeIdx });
    }
    const splitIdx = ctx.nativeStrHelpers.get("__str_split")!;
    fctx.body.push({ op: "call", funcIdx: splitIdx });
    // Return type is ref $vec_nstr — use same key as resolveWasmType for string[]
    const nstrVecTypeIdx = ctx.vecTypeMap.get(`ref_${ctx.anyStrTypeIdx}`)!;
    return { kind: "ref", typeIdx: nstrVecTypeIdx };
  }

  // codePointAt: like charCodeAt but returns f64 (code point value)
  // For BMP characters (most common), codePoint === charCode.
  // Full surrogate pair handling would be more complex, but this covers most test262 cases.
  if (method === "codePointAt") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    const tmpLocal = allocLocal(fctx, "__codePointAt_tmp", flatStringType(ctx));
    fctx.body.push({ op: "local.set", index: tmpLocal });
    // Push data ref (field 2)
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }); // .data
    // Compute off + idx
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }); // .off
    if (expr.arguments.length > 0) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
      if (!argType || argType === VOID_RESULT) {
        fctx.body.push({ op: "i32.const", value: 0 });
      } else if (argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    fctx.body.push({ op: "i32.add" }); // off + idx
    fctx.body.push({ op: "array.get_u", typeIdx: strDataTypeIdx });
    // Convert i32 code unit to f64
    fctx.body.push({ op: "f64.convert_i32_u" });
    return { kind: "f64" };
  }

  // normalize: return string unchanged (identity — correct for already-normalized strings)
  if (method === "normalize") {
    const result = compileExpression(ctx, fctx, propAccess.expression);
    // Consume the form argument if present (ignored)
    if (expr.arguments.length > 0) {
      const bodyLen = fctx.body.length;
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argType && argType !== VOID_RESULT) {
        fctx.body.push({ op: "drop" });
      }
    }
    return result;
  }

  // Other methods: marshal native->extern, call host, marshal extern->native
  const importName = `string_${method}`;
  const funcIdx = ctx.funcMap.get(importName);
  if (funcIdx !== undefined) {
    // Marshal receiver: flatten + native string -> externref
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    const toExternIdx = ctx.nativeStrHelpers.get("__str_to_extern")!;
    fctx.body.push({ op: "call", funcIdx: toExternIdx });

    // Compile arguments — string args need flattening + marshaling
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType && argType.kind === "ref" && (argType.typeIdx === strTypeIdx || argType.typeIdx === ctx.anyStrTypeIdx)) {
        // String arg → flatten + marshal to externref
        emitFlatten();
        fctx.body.push({ op: "call", funcIdx: toExternIdx });
      }
    }

    fctx.body.push({ op: "call", funcIdx });

    // Determine return type and marshal back if needed
    const returnsBool = method === "includes" || method === "startsWith" || method === "endsWith";
    const returnsNum = method === "indexOf" || method === "lastIndexOf";
    if (returnsBool) {
      return { kind: "i32" };
    } else if (returnsNum) {
      return { kind: "f64" };
    } else {
      // Returns externref string → marshal to native
      const fromExternIdx = ctx.nativeStrHelpers.get("__str_from_extern")!;
      fctx.body.push({ op: "call", funcIdx: fromExternIdx });
      return nativeStringType(ctx);
    }
  }

  ctx.errors.push({
    message: `Unknown string method: ${method}`,
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}

