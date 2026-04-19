// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Host built-in compilation: console, Date, Math, and WASI output.
 */
import ts from "typescript";
import { isBooleanType, isNumberType, isStringType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { flushLateImportShifts } from "../expressions/late-imports.js";
import { addFuncType } from "../index.js";
import { ensureNativeStringExternBridge } from "../native-strings.js";
import type { InnerResult } from "../shared.js";
import { compileExpression, VOID_RESULT } from "../shared.js";
import { compileStringLiteral } from "../string-ops.js";
import { isStaticNaN, tryStaticToNumber } from "./misc.js";

// ── Builtins ─────────────────────────────────────────────────────────

function compileConsoleCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  method: string,
): InnerResult {
  // WASI mode: emit fd_write to stdout instead of JS host imports
  if (ctx.wasi) {
    return compileConsoleCallWasi(ctx, fctx, expr, method);
  }

  for (const arg of expr.arguments) {
    const argType = ctx.checker.getTypeAtLocation(arg);
    compileExpression(ctx, fctx, arg);

    if (isStringType(argType)) {
      // Fast mode: flatten + marshal native string to externref before passing to host
      if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
        ensureNativeStringExternBridge(ctx);
        flushLateImportShifts(ctx, fctx);
        const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
        if (strFlattenIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: strFlattenIdx });
        }
        const toExternIdx = ctx.nativeStrHelpers.get("__str_to_extern");
        if (toExternIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: toExternIdx });
        }
      }
      const funcIdx = ctx.funcMap.get(`console_${method}_string`);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
    } else if (isBooleanType(argType)) {
      const funcIdx = ctx.funcMap.get(`console_${method}_bool`);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
    } else if (isNumberType(argType)) {
      const funcIdx = ctx.funcMap.get(`console_${method}_number`);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
    } else {
      // externref: DOM objects, class instances, anything else
      const funcIdx = ctx.funcMap.get(`console_${method}_externref`);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
    }
  }
  return VOID_RESULT;
}

// ─── Date support ───────────────────────────────────────────────────────────
// Date is represented as a WasmGC struct with a single mutable i64 field
// (milliseconds since Unix epoch, UTC).  All getters decompose the timestamp
// using Howard Hinnant's civil_from_days algorithm, implemented purely in
// i64 arithmetic — no host imports needed.

/** Ensure the $__Date struct type exists, return its type index. */
export function ensureDateStruct(ctx: CodegenContext): number {
  const existing = ctx.structMap.get("__Date");
  if (existing !== undefined) return existing;

  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "__Date",
    fields: [{ name: "timestamp", type: { kind: "i64" }, mutable: true }],
  });
  ctx.structMap.set("__Date", typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, "__Date");
  ctx.structFields.set("__Date", [{ name: "timestamp", type: { kind: "i64" }, mutable: true }]);
  return typeIdx;
}

/**
 * Ensure the __date_civil_from_days helper function exists.
 * Signature: (i64 days_since_epoch) -> (i64 packed)
 *   packed = year * 10000 + month * 100 + day
 *   (month 1-12, day 1-31)
 *
 * Uses Hinnant's algorithm: http://howardhinnant.github.io/date_algorithms.html#civil_from_days
 */
function ensureDateCivilHelper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__date_civil_from_days");
  if (existing !== undefined) return existing;

  // func (param $z i64) (result i64)
  // locals: $z(0), $era(1), $doe(2), $yoe(3), $doy(4), $mp(5), $y(6), $m(7), $d(8)
  const funcTypeIdx = addFuncType(ctx, [{ kind: "i64" }], [{ kind: "i64" }]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__date_civil_from_days", funcIdx);

  const body: Instr[] = [];

  // z += 719468  (shift epoch from 1970-01-01 to 0000-03-01)
  body.push(
    { op: "local.get", index: 0 } as Instr,
    { op: "i64.const", value: 719468n } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.set", index: 0 } as Instr,
  );

  // era = (z >= 0 ? z : z - 146096) / 146097
  // We use i64.div_s which floors toward zero, so we need the adjustment
  body.push(
    { op: "local.get", index: 0 } as Instr,
    { op: "i64.const", value: 0n } as Instr,
    { op: "i64.ge_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i64" } },
      then: [{ op: "local.get", index: 0 } as Instr],
      else: [
        { op: "local.get", index: 0 } as Instr,
        { op: "i64.const", value: 146096n } as Instr,
        { op: "i64.sub" } as Instr,
      ],
    } as unknown as Instr,
    { op: "i64.const", value: 146097n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "local.set", index: 1 } as Instr, // era
  );

  // doe = z - era * 146097  (day of era, [0, 146096])
  body.push(
    { op: "local.get", index: 0 } as Instr,
    { op: "local.get", index: 1 } as Instr,
    { op: "i64.const", value: 146097n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.set", index: 2 } as Instr, // doe
  );

  // yoe = (doe - doe/1460 + doe/36524 - doe/146096) / 365
  body.push(
    { op: "local.get", index: 2 } as Instr, // doe
    { op: "local.get", index: 2 } as Instr,
    { op: "i64.const", value: 1460n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.get", index: 2 } as Instr,
    { op: "i64.const", value: 36524n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.get", index: 2 } as Instr,
    { op: "i64.const", value: 146096n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "i64.const", value: 365n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "local.set", index: 3 } as Instr, // yoe
  );

  // y = yoe + era * 400
  body.push(
    { op: "local.get", index: 3 } as Instr,
    { op: "local.get", index: 1 } as Instr,
    { op: "i64.const", value: 400n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.set", index: 6 } as Instr, // y (still March-based)
  );

  // doy = doe - (365*yoe + yoe/4 - yoe/100)
  body.push(
    { op: "local.get", index: 2 } as Instr, // doe
    { op: "i64.const", value: 365n } as Instr,
    { op: "local.get", index: 3 } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "local.get", index: 3 } as Instr,
    { op: "i64.const", value: 4n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.get", index: 3 } as Instr,
    { op: "i64.const", value: 100n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.set", index: 4 } as Instr, // doy
  );

  // mp = (5*doy + 2) / 153
  body.push(
    { op: "i64.const", value: 5n } as Instr,
    { op: "local.get", index: 4 } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.add" } as Instr,
    { op: "i64.const", value: 153n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "local.set", index: 5 } as Instr, // mp
  );

  // d = doy - (153*mp + 2)/5 + 1
  body.push(
    { op: "local.get", index: 4 } as Instr,
    { op: "i64.const", value: 153n } as Instr,
    { op: "local.get", index: 5 } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.add" } as Instr,
    { op: "i64.const", value: 5n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "i64.const", value: 1n } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.set", index: 8 } as Instr, // d
  );

  // m = mp < 10 ? mp + 3 : mp - 9
  body.push(
    { op: "local.get", index: 5 } as Instr,
    { op: "i64.const", value: 10n } as Instr,
    { op: "i64.lt_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i64" } },
      then: [
        { op: "local.get", index: 5 } as Instr,
        { op: "i64.const", value: 3n } as Instr,
        { op: "i64.add" } as Instr,
      ],
      else: [
        { op: "local.get", index: 5 } as Instr,
        { op: "i64.const", value: 9n } as Instr,
        { op: "i64.sub" } as Instr,
      ],
    } as unknown as Instr,
    { op: "local.set", index: 7 } as Instr, // m (1-12)
  );

  // y += (m <= 2) ? 1 : 0
  body.push(
    { op: "local.get", index: 6 } as Instr,
    { op: "local.get", index: 7 } as Instr,
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.le_s" } as Instr,
    { op: "i64.extend_i32_s" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.set", index: 6 } as Instr, // y (adjusted)
  );

  // return y * 10000 + m * 100 + d
  body.push(
    { op: "local.get", index: 6 } as Instr,
    { op: "i64.const", value: 10000n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "local.get", index: 7 } as Instr,
    { op: "i64.const", value: 100n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.get", index: 8 } as Instr,
    { op: "i64.add" } as Instr,
  );

  ctx.mod.functions.push({
    name: "__date_civil_from_days",
    typeIdx: funcTypeIdx,
    locals: [
      // 0: z (param), 1: era, 2: doe, 3: yoe, 4: doy, 5: mp, 6: y, 7: m, 8: d
      { name: "$era", type: { kind: "i64" } },
      { name: "$doe", type: { kind: "i64" } },
      { name: "$yoe", type: { kind: "i64" } },
      { name: "$doy", type: { kind: "i64" } },
      { name: "$mp", type: { kind: "i64" } },
      { name: "$y", type: { kind: "i64" } },
      { name: "$m", type: { kind: "i64" } },
      { name: "$d", type: { kind: "i64" } },
    ],
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * Ensure the __date_days_from_civil helper function exists.
 * Signature: (i64 year, i64 month, i64 day) -> i64 days_since_epoch
 *
 * Implements Hinnant's days_from_civil algorithm (inverse of civil_from_days).
 */
export function ensureDateDaysFromCivilHelper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__date_days_from_civil");
  if (existing !== undefined) return existing;

  // func (param $y i64) (param $m i64) (param $d i64) (result i64)
  // locals: $y(0), $m(1), $d(2), $era(3), $yoe(4), $doy(5), $doe(6)
  const funcTypeIdx = addFuncType(ctx, [{ kind: "i64" }, { kind: "i64" }, { kind: "i64" }], [{ kind: "i64" }]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__date_days_from_civil", funcIdx);

  const body: Instr[] = [];

  // y -= (m <= 2) ? 1 : 0
  body.push(
    { op: "local.get", index: 0 } as Instr, // y
    { op: "local.get", index: 1 } as Instr, // m
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.le_s" } as Instr,
    { op: "i64.extend_i32_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.set", index: 0 } as Instr, // y adjusted
  );

  // era = (y >= 0 ? y : y - 399) / 400
  body.push(
    { op: "local.get", index: 0 } as Instr,
    { op: "i64.const", value: 0n } as Instr,
    { op: "i64.ge_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i64" } },
      then: [{ op: "local.get", index: 0 } as Instr],
      else: [
        { op: "local.get", index: 0 } as Instr,
        { op: "i64.const", value: 399n } as Instr,
        { op: "i64.sub" } as Instr,
      ],
    } as unknown as Instr,
    { op: "i64.const", value: 400n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "local.set", index: 3 } as Instr, // era
  );

  // yoe = y - era * 400
  body.push(
    { op: "local.get", index: 0 } as Instr,
    { op: "local.get", index: 3 } as Instr,
    { op: "i64.const", value: 400n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.set", index: 4 } as Instr, // yoe
  );

  // doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1
  body.push(
    { op: "i64.const", value: 153n } as Instr,
    { op: "local.get", index: 1 } as Instr, // m
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.gt_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i64" } },
      then: [
        { op: "local.get", index: 1 } as Instr,
        { op: "i64.const", value: 3n } as Instr,
        { op: "i64.sub" } as Instr,
      ],
      else: [
        { op: "local.get", index: 1 } as Instr,
        { op: "i64.const", value: 9n } as Instr,
        { op: "i64.add" } as Instr,
      ],
    } as unknown as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.add" } as Instr,
    { op: "i64.const", value: 5n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "local.get", index: 2 } as Instr, // d
    { op: "i64.add" } as Instr,
    { op: "i64.const", value: 1n } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.set", index: 5 } as Instr, // doy
  );

  // doe = yoe * 365 + yoe/4 - yoe/100 + doy
  body.push(
    { op: "local.get", index: 4 } as Instr, // yoe
    { op: "i64.const", value: 365n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "local.get", index: 4 } as Instr,
    { op: "i64.const", value: 4n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.get", index: 4 } as Instr,
    { op: "i64.const", value: 100n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.get", index: 5 } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.set", index: 6 } as Instr, // doe
  );

  // return era * 146097 + doe - 719468
  body.push(
    { op: "local.get", index: 3 } as Instr, // era
    { op: "i64.const", value: 146097n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "local.get", index: 6 } as Instr, // doe
    { op: "i64.add" } as Instr,
    { op: "i64.const", value: 719468n } as Instr,
    { op: "i64.sub" } as Instr,
  );

  ctx.mod.functions.push({
    name: "__date_days_from_civil",
    typeIdx: funcTypeIdx,
    locals: [
      // 3: era, 4: yoe, 5: doy, 6: doe
      { name: "$era", type: { kind: "i64" } },
      { name: "$yoe", type: { kind: "i64" } },
      { name: "$doy", type: { kind: "i64" } },
      { name: "$doe", type: { kind: "i64" } },
    ],
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * Compile a Date method call on a Date struct receiver.
 * Returns undefined if this is not a Date method (caller should continue).
 */
function compileDateMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  receiverType: ts.Type,
): InnerResult | undefined {
  const methodName = propAccess.name.text;
  const symName = receiverType.getSymbol()?.name;
  if (symName !== "Date") return undefined;

  const DATE_METHODS = new Set([
    "getTime",
    "valueOf",
    "getFullYear",
    "getMonth",
    "getDate",
    "getHours",
    "getMinutes",
    "getSeconds",
    "getMilliseconds",
    "getDay",
    "setTime",
    "getTimezoneOffset",
    "getUTCFullYear",
    "getUTCMonth",
    "getUTCDate",
    "getUTCHours",
    "getUTCMinutes",
    "getUTCSeconds",
    "getUTCMilliseconds",
    "getUTCDay",
    "toISOString",
    "toJSON",
    "toString",
    "toDateString",
    "toTimeString",
    "toLocaleDateString",
    "toLocaleTimeString",
    "toLocaleString",
    "toUTCString",
    "toGMTString",
  ]);
  if (!DATE_METHODS.has(methodName)) return undefined;

  const dateTypeIdx = ensureDateStruct(ctx);
  const dateRefType: ValType = { kind: "ref", typeIdx: dateTypeIdx };

  // Compile receiver — the Date struct
  const recvResult = compileExpression(ctx, fctx, propAccess.expression, dateRefType);
  if (!recvResult) return null;

  // getTime / valueOf: read i64 timestamp, convert to f64
  if (methodName === "getTime" || methodName === "valueOf") {
    fctx.body.push({
      op: "struct.get",
      typeIdx: dateTypeIdx,
      fieldIdx: 0,
    } as unknown as Instr);
    fctx.body.push({ op: "f64.convert_i64_s" } as Instr);
    return { kind: "f64" };
  }

  // getTimezoneOffset: always 0 (we operate in UTC)
  if (methodName === "getTimezoneOffset") {
    fctx.body.push({ op: "drop" } as Instr);
    fctx.body.push({ op: "f64.const", value: 0 } as Instr);
    return { kind: "f64" };
  }

  // setTime(ms): update the timestamp field
  if (methodName === "setTime") {
    // We need the ref on stack, but also need the new value
    // Stack: [dateRef]
    // Compile the argument
    const tempLocal = allocTempLocal(fctx, dateRefType);
    fctx.body.push({ op: "local.set", index: tempLocal } as Instr);
    // Get the new timestamp
    if (callExpr.arguments.length >= 1) {
      fctx.body.push({ op: "local.get", index: tempLocal } as Instr);
      compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
      fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      fctx.body.push({
        op: "struct.set",
        typeIdx: dateTypeIdx,
        fieldIdx: 0,
      } as unknown as Instr);
      // Return the new timestamp as f64
      fctx.body.push({ op: "local.get", index: tempLocal } as Instr);
      fctx.body.push({
        op: "struct.get",
        typeIdx: dateTypeIdx,
        fieldIdx: 0,
      } as unknown as Instr);
      fctx.body.push({ op: "f64.convert_i64_s" } as Instr);
    } else {
      fctx.body.push({ op: "f64.const", value: NaN } as Instr);
    }
    releaseTempLocal(fctx, tempLocal);
    return { kind: "f64" };
  }

  // For all time-component getters, we need the i64 timestamp
  // Stack: [dateRef]
  fctx.body.push({
    op: "struct.get",
    typeIdx: dateTypeIdx,
    fieldIdx: 0,
  } as unknown as Instr);
  // Stack: [i64 timestamp]

  // Time-of-day getters (no civil calendar needed)
  const MS_PER_DAY = 86400000n;
  const MS_PER_HOUR = 3600000n;
  const MS_PER_MINUTE = 60000n;
  const MS_PER_SECOND = 1000n;

  if (methodName === "getHours" || methodName === "getUTCHours") {
    // hours = ((timestamp % 86400000) + 86400000) % 86400000 / 3600000
    fctx.body.push(
      { op: "i64.const", value: MS_PER_DAY } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: MS_PER_DAY } as Instr,
      { op: "i64.add" } as Instr,
      { op: "i64.const", value: MS_PER_DAY } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: MS_PER_HOUR } as Instr,
      { op: "i64.div_s" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  if (methodName === "getMinutes" || methodName === "getUTCMinutes") {
    // minutes = ((timestamp % 3600000) + 3600000) % 3600000 / 60000
    fctx.body.push(
      { op: "i64.const", value: MS_PER_HOUR } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: MS_PER_HOUR } as Instr,
      { op: "i64.add" } as Instr,
      { op: "i64.const", value: MS_PER_HOUR } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: MS_PER_MINUTE } as Instr,
      { op: "i64.div_s" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  if (methodName === "getSeconds" || methodName === "getUTCSeconds") {
    // seconds = ((timestamp % 60000) + 60000) % 60000 / 1000
    fctx.body.push(
      { op: "i64.const", value: MS_PER_MINUTE } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: MS_PER_MINUTE } as Instr,
      { op: "i64.add" } as Instr,
      { op: "i64.const", value: MS_PER_MINUTE } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: MS_PER_SECOND } as Instr,
      { op: "i64.div_s" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  if (methodName === "getMilliseconds" || methodName === "getUTCMilliseconds") {
    // ms = ((timestamp % 1000) + 1000) % 1000
    fctx.body.push(
      { op: "i64.const", value: MS_PER_SECOND } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: MS_PER_SECOND } as Instr,
      { op: "i64.add" } as Instr,
      { op: "i64.const", value: MS_PER_SECOND } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  // getDay / getUTCDay: day of week (0=Sunday)
  // (floor(timestamp / 86400000) + 4) % 7  (1970-01-01 was Thursday = 4)
  if (methodName === "getDay" || methodName === "getUTCDay") {
    // We need to handle negative timestamps correctly:
    // days = floor(ts / 86400000) — for negative, use (ts - 86399999) / 86400000
    fctx.body.push(
      { op: "i64.const", value: MS_PER_DAY } as Instr,
      { op: "i64.div_s" } as Instr,
      // For negative timestamps, i64.div_s truncates toward zero, but we want floor division
      // This is fine because we handle the modular arithmetic with the +7 % 7 below
      { op: "i64.const", value: 4n } as Instr,
      { op: "i64.add" } as Instr,
      { op: "i64.const", value: 7n } as Instr,
      { op: "i64.rem_s" } as Instr,
      // Handle negative remainder: ((result % 7) + 7) % 7
      { op: "i64.const", value: 7n } as Instr,
      { op: "i64.add" } as Instr,
      { op: "i64.const", value: 7n } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  // Calendar getters need civil_from_days
  // Stack: [i64 timestamp]
  // First compute days: floor(timestamp / 86400000)
  // For negative timestamps we need floor division, not truncation.
  // floor_div(a, b) for positive b: (a >= 0) ? a/b : (a - b + 1) / b
  const civilIdx = ensureDateCivilHelper(ctx);

  // Compute floor division of timestamp by MS_PER_DAY
  // Since i64.div_s truncates toward zero, we need to adjust for negative values
  {
    const tempTs = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.set", index: tempTs } as Instr);

    // if (ts >= 0) ts / 86400000 else (ts - 86399999) / 86400000
    fctx.body.push(
      { op: "local.get", index: tempTs } as Instr,
      { op: "i64.const", value: 0n } as Instr,
      { op: "i64.ge_s" } as Instr,
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i64" } },
        then: [
          { op: "local.get", index: tempTs } as Instr,
          { op: "i64.const", value: MS_PER_DAY } as Instr,
          { op: "i64.div_s" } as Instr,
        ],
        else: [
          { op: "local.get", index: tempTs } as Instr,
          { op: "i64.const", value: MS_PER_DAY - 1n } as Instr,
          { op: "i64.sub" } as Instr,
          { op: "i64.const", value: MS_PER_DAY } as Instr,
          { op: "i64.div_s" } as Instr,
        ],
      } as unknown as Instr,
    );
    releaseTempLocal(fctx, tempTs);
  }

  // Stack: [i64 days_since_epoch]
  fctx.body.push({ op: "call", funcIdx: civilIdx } as Instr);
  // Stack: [i64 packed = year*10000 + month*100 + day]

  if (methodName === "getFullYear" || methodName === "getUTCFullYear") {
    // year = packed / 10000
    fctx.body.push(
      { op: "i64.const", value: 10000n } as Instr,
      { op: "i64.div_s" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  if (methodName === "getMonth" || methodName === "getUTCMonth") {
    // month = (packed / 100) % 100 - 1  (JS months are 0-indexed)
    fctx.body.push(
      { op: "i64.const", value: 100n } as Instr,
      { op: "i64.div_s" } as Instr,
      { op: "i64.const", value: 100n } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: 1n } as Instr,
      { op: "i64.sub" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  if (methodName === "getDate" || methodName === "getUTCDate") {
    // day = packed % 100
    fctx.body.push(
      { op: "i64.const", value: 100n } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  // toISOString / toJSON: emit a formatted string
  if (methodName === "toISOString" || methodName === "toJSON") {
    // For now, drop the packed civil date and return a placeholder
    // A full implementation would format as "YYYY-MM-DDTHH:MM:SS.sssZ"
    // but that requires string building which is complex. Return the timestamp as a string.
    fctx.body.push({ op: "drop" } as Instr);
    return compileStringLiteral(ctx, fctx, "1970-01-01T00:00:00.000Z");
  }

  // toString / toDateString / toTimeString / toLocale* / toUTCString / toGMTString:
  // Stub implementations — return a placeholder string representation.
  // Full formatting would require complex string building; for now return a fixed string.
  const STRING_DATE_METHODS = new Set([
    "toString",
    "toDateString",
    "toTimeString",
    "toLocaleDateString",
    "toLocaleTimeString",
    "toLocaleString",
    "toUTCString",
    "toGMTString",
  ]);
  if (STRING_DATE_METHODS.has(methodName)) {
    fctx.body.push({ op: "drop" } as Instr);
    return compileStringLiteral(ctx, fctx, "Thu Jan 01 1970 00:00:00 GMT+0000");
  }

  // Shouldn't reach here
  fctx.body.push({ op: "drop" } as Instr);
  fctx.body.push({ op: "f64.const", value: 0 } as Instr);
  return { kind: "f64" };
}

/** WASI mode: compile console.log/warn/error by writing UTF-8 to stdout via fd_write */
function compileConsoleCallWasi(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  _method: string,
): InnerResult {
  const writeStringIdx = ctx.funcMap.get("__wasi_write_string");
  if (writeStringIdx === undefined) return VOID_RESULT;

  let first = true;
  for (const arg of expr.arguments) {
    // Add space separator between arguments (like console.log does)
    if (!first) {
      const spaceData = wasiAllocStringData(ctx, " ");
      fctx.body.push({ op: "i32.const", value: spaceData.offset } as Instr);
      fctx.body.push({ op: "i32.const", value: spaceData.length } as Instr);
      fctx.body.push({ op: "call", funcIdx: writeStringIdx });
    }
    first = false;

    // Check if this is a string literal we can embed directly
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      const strValue = arg.text;
      const data = wasiAllocStringData(ctx, strValue);
      fctx.body.push({ op: "i32.const", value: data.offset } as Instr);
      fctx.body.push({ op: "i32.const", value: data.length } as Instr);
      fctx.body.push({ op: "call", funcIdx: writeStringIdx });
    } else if (ts.isTemplateExpression(arg)) {
      // Template literal: handle head + spans
      if (arg.head.text) {
        const headData = wasiAllocStringData(ctx, arg.head.text);
        fctx.body.push({ op: "i32.const", value: headData.offset } as Instr);
        fctx.body.push({ op: "i32.const", value: headData.length } as Instr);
        fctx.body.push({ op: "call", funcIdx: writeStringIdx });
      }
      for (const span of arg.templateSpans) {
        // Compile the expression and convert to string output
        const exprType = compileExpression(ctx, fctx, span.expression);
        emitWasiValueToStdout(ctx, fctx, exprType, span.expression);
        if (span.literal.text) {
          const litData = wasiAllocStringData(ctx, span.literal.text);
          fctx.body.push({ op: "i32.const", value: litData.offset } as Instr);
          fctx.body.push({ op: "i32.const", value: litData.length } as Instr);
          fctx.body.push({ op: "call", funcIdx: writeStringIdx });
        }
      }
    } else {
      // For non-literal arguments, compile the expression and handle by type
      const argType = ctx.checker.getTypeAtLocation(arg);
      const exprType = compileExpression(ctx, fctx, arg);
      emitWasiValueToStdout(ctx, fctx, exprType, arg);
    }
  }

  // Emit newline at the end
  const newlineData = wasiAllocStringData(ctx, "\n");
  fctx.body.push({ op: "i32.const", value: newlineData.offset } as Instr);
  fctx.body.push({ op: "i32.const", value: newlineData.length } as Instr);
  fctx.body.push({ op: "call", funcIdx: writeStringIdx });

  return VOID_RESULT;
}

/** Allocate a UTF-8 string in a data segment and return its offset/length */
function wasiAllocStringData(ctx: CodegenContext, str: string): { offset: number; length: number } {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);

  // Find the next available offset in data segments
  // Data segments start after the scratch area (offset 1024)
  let offset = 1024;
  for (const seg of ctx.mod.dataSegments) {
    const segEnd = seg.offset + seg.bytes.length;
    if (segEnd > offset) offset = segEnd;
  }

  ctx.mod.dataSegments.push({ offset, bytes });
  return { offset, length: bytes.length };
}

/** Emit code to write a compiled value to stdout in WASI mode */
function emitWasiValueToStdout(
  ctx: CodegenContext,
  fctx: FunctionContext,
  exprType: InnerResult,
  _node: ts.Node,
): void {
  const writeStringIdx = ctx.funcMap.get("__wasi_write_string");
  if (writeStringIdx === undefined) return;

  if (exprType === VOID_RESULT || exprType === null) {
    // void expression, nothing to write — drop already handled
    return;
  }

  if (exprType.kind === "f64") {
    // Number: use __wasi_write_f64 helper (emit inline if not yet registered)
    const writeF64Idx = ensureWasiWriteF64Helper(ctx);
    if (writeF64Idx >= 0) {
      fctx.body.push({ op: "call", funcIdx: writeF64Idx });
    } else {
      fctx.body.push({ op: "drop" } as Instr);
    }
  } else if (exprType.kind === "i32") {
    // Boolean or i32: write "true"/"false" or the integer
    const writeI32Idx = ensureWasiWriteI32Helper(ctx);
    if (writeI32Idx >= 0) {
      fctx.body.push({ op: "call", funcIdx: writeI32Idx });
    } else {
      fctx.body.push({ op: "drop" } as Instr);
    }
  } else {
    // For other types (externref, ref, etc.), just drop and write a placeholder
    fctx.body.push({ op: "drop" } as Instr);
    const placeholder = wasiAllocStringData(ctx, "[object]");
    fctx.body.push({ op: "i32.const", value: placeholder.offset } as Instr);
    fctx.body.push({ op: "i32.const", value: placeholder.length } as Instr);
    fctx.body.push({ op: "call", funcIdx: writeStringIdx });
  }
}

/** Ensure the __wasi_write_i32 helper exists and return its function index */
function ensureWasiWriteI32Helper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__wasi_write_i32");
  if (existing !== undefined) return existing;

  const writeStringIdx = ctx.funcMap.get("__wasi_write_string");
  if (writeStringIdx === undefined) return -1;

  // Simple i32 to decimal string conversion
  // Uses bump allocator to write digits to linear memory
  const funcTypeIdx = addFuncType(ctx, [{ kind: "i32" }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__wasi_write_i32", funcIdx);

  // Algorithm: handle negative, then extract digits in reverse, then write forward
  // Locals: 0=value, 1=buf_start, 2=buf_pos, 3=is_neg, 4=digit
  const body: Instr[] = [];

  // For simplicity, handle 0 specially, negatives, and positive integers
  // We allocate a 12-byte buffer on the bump allocator for the digit string
  const bufStartLocal = 1; // local index
  const bufPosLocal = 2;
  const isNegLocal = 3;
  const absValLocal = 4;
  const tmpLocal = 5;

  body.push(
    // buf_start = bump_ptr
    { op: "global.get", index: ctx.wasiBumpPtrGlobalIdx } as Instr,
    { op: "local.set", index: bufStartLocal } as Instr,
    // buf_pos = buf_start + 11 (write digits right-to-left, max 11 digits + sign)
    { op: "local.get", index: bufStartLocal } as Instr,
    { op: "i32.const", value: 11 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: bufPosLocal } as Instr,

    // Check if value == 0
    { op: "local.get", index: 0 } as Instr,
    { op: "i32.eqz" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // Write "0" directly
        { op: "local.get", index: bufPosLocal } as Instr,
        { op: "i32.const", value: 48 } as Instr, // '0'
        { op: "i32.store8", align: 0, offset: 0 } as Instr,
        { op: "local.get", index: bufPosLocal } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "call", funcIdx: writeStringIdx } as Instr,
        { op: "return" } as Instr,
      ],
    },

    // Check if negative
    { op: "local.get", index: 0 } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "i32.lt_s" } as Instr,
    { op: "local.set", index: isNegLocal } as Instr,

    // absVal = is_neg ? -value : value
    { op: "local.get", index: isNegLocal } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "i32.const", value: 0 } as Instr,
        { op: "local.get", index: 0 } as Instr,
        { op: "i32.sub" } as Instr,
      ],
      else: [{ op: "local.get", index: 0 } as Instr],
    },
    { op: "local.set", index: absValLocal } as Instr,

    // Loop: extract digits right to left
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if absVal == 0, break
            { op: "local.get", index: absValLocal } as Instr,
            { op: "i32.eqz" } as Instr,
            { op: "br_if", depth: 1 } as Instr,

            // digit = absVal % 10
            { op: "local.get", index: absValLocal } as Instr,
            { op: "i32.const", value: 10 } as Instr,
            { op: "i32.rem_u" } as Instr,
            { op: "local.set", index: tmpLocal } as Instr,

            // absVal = absVal / 10
            { op: "local.get", index: absValLocal } as Instr,
            { op: "i32.const", value: 10 } as Instr,
            { op: "i32.div_u" } as Instr,
            { op: "local.set", index: absValLocal } as Instr,

            // buf_pos--
            { op: "local.get", index: bufPosLocal } as Instr,
            { op: "i32.const", value: 1 } as Instr,
            { op: "i32.sub" } as Instr,
            { op: "local.set", index: bufPosLocal } as Instr,

            // memory[buf_pos] = digit + '0'
            { op: "local.get", index: bufPosLocal } as Instr,
            { op: "local.get", index: tmpLocal } as Instr,
            { op: "i32.const", value: 48 } as Instr,
            { op: "i32.add" } as Instr,
            { op: "i32.store8", align: 0, offset: 0 } as Instr,

            // continue loop
            { op: "br", depth: 0 } as Instr,
          ],
        },
      ],
    },

    // If negative, prepend '-'
    { op: "local.get", index: isNegLocal } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: bufPosLocal } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.sub" } as Instr,
        { op: "local.set", index: bufPosLocal } as Instr,
        { op: "local.get", index: bufPosLocal } as Instr,
        { op: "i32.const", value: 45 } as Instr, // '-'
        { op: "i32.store8", align: 0, offset: 0 } as Instr,
      ],
    },

    // Call __wasi_write_string(buf_pos, buf_start + 12 - buf_pos)
    { op: "local.get", index: bufPosLocal } as Instr,
    { op: "local.get", index: bufStartLocal } as Instr,
    { op: "i32.const", value: 12 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.get", index: bufPosLocal } as Instr,
    { op: "i32.sub" } as Instr,
    { op: "call", funcIdx: writeStringIdx } as Instr,
  );

  ctx.mod.functions.push({
    name: "__wasi_write_i32",
    typeIdx: funcTypeIdx,
    locals: [
      { name: "buf_start", type: { kind: "i32" } },
      { name: "buf_pos", type: { kind: "i32" } },
      { name: "is_neg", type: { kind: "i32" } },
      { name: "abs_val", type: { kind: "i32" } },
      { name: "tmp", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });

  return funcIdx;
}

/** Ensure the __wasi_write_f64 helper exists and return its function index */
function ensureWasiWriteF64Helper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__wasi_write_f64");
  if (existing !== undefined) return existing;

  const writeI32Idx = ensureWasiWriteI32Helper(ctx);
  const writeStringIdx = ctx.funcMap.get("__wasi_write_string");
  if (writeStringIdx === undefined || writeI32Idx < 0) return -1;

  // Simple f64 output: truncate to i32 and print as integer
  // For NaN, Infinity, -Infinity, handle specially
  const funcTypeIdx = addFuncType(ctx, [{ kind: "f64" }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__wasi_write_f64", funcIdx);

  // Allocate data segments for special values
  const nanData = wasiAllocStringData(ctx, "NaN");
  const infData = wasiAllocStringData(ctx, "Infinity");
  const negInfData = wasiAllocStringData(ctx, "-Infinity");

  const body: Instr[] = [
    // Check NaN: value != value
    { op: "local.get", index: 0 } as Instr,
    { op: "local.get", index: 0 } as Instr,
    { op: "f64.ne" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: nanData.offset } as Instr,
        { op: "i32.const", value: nanData.length } as Instr,
        { op: "call", funcIdx: writeStringIdx } as Instr,
        { op: "return" } as Instr,
      ],
    },

    // Check positive infinity
    { op: "local.get", index: 0 } as Instr,
    { op: "f64.const", value: Infinity } as Instr,
    { op: "f64.eq" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: infData.offset } as Instr,
        { op: "i32.const", value: infData.length } as Instr,
        { op: "call", funcIdx: writeStringIdx } as Instr,
        { op: "return" } as Instr,
      ],
    },

    // Check negative infinity
    { op: "local.get", index: 0 } as Instr,
    { op: "f64.const", value: -Infinity } as Instr,
    { op: "f64.eq" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: negInfData.offset } as Instr,
        { op: "i32.const", value: negInfData.length } as Instr,
        { op: "call", funcIdx: writeStringIdx } as Instr,
        { op: "return" } as Instr,
      ],
    },

    // Normal number: truncate to i32 and print
    { op: "local.get", index: 0 } as Instr,
    { op: "i32.trunc_sat_f64_s" } as Instr,
    { op: "call", funcIdx: writeI32Idx } as Instr,
  ];

  ctx.mod.functions.push({
    name: "__wasi_write_f64",
    typeIdx: funcTypeIdx,
    locals: [],
    body,
    exported: false,
  });

  return funcIdx;
}

function compileMathCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: string,
  expr: ts.CallExpression,
): ValType | null | undefined {
  // Native Wasm unary opcodes
  const nativeUnary: Record<string, string> = {
    sqrt: "f64.sqrt",
    abs: "f64.abs",
    floor: "f64.floor",
    ceil: "f64.ceil",
    trunc: "f64.trunc",
    nearest: "f64.nearest",
  };

  const f64Hint: ValType = { kind: "f64" };

  if (method === "round" && expr.arguments.length >= 1) {
    // JS Math.round: compare frac = x - floor(x) to 0.5.
    // If frac >= 0.5 use ceil(x), else floor(x). Preserves -0 via copysign.
    // This avoids precision loss from floor(x + 0.5) with large odd integers near 2^52.
    const xLocal = allocLocal(fctx, `__round_x_${fctx.locals.length}`, {
      kind: "f64",
    });
    const floorLocal = allocLocal(fctx, `__round_fl_${fctx.locals.length}`, {
      kind: "f64",
    });
    const rLocal = allocLocal(fctx, `__round_r_${fctx.locals.length}`, {
      kind: "f64",
    });
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    fctx.body.push({ op: "local.tee", index: xLocal } as Instr);
    fctx.body.push({ op: "f64.floor" } as Instr);
    fctx.body.push({ op: "local.set", index: floorLocal } as Instr);
    // frac = x - floor(x)
    fctx.body.push({ op: "local.get", index: xLocal } as Instr);
    fctx.body.push({ op: "local.get", index: floorLocal } as Instr);
    fctx.body.push({ op: "f64.sub" } as Instr);
    // frac >= 0.5 ? ceil(x) : floor(x)
    fctx.body.push({ op: "f64.const", value: 0.5 } as Instr);
    fctx.body.push({ op: "f64.ge" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "local.get", index: xLocal } as Instr, { op: "f64.ceil" } as Instr],
      else: [{ op: "local.get", index: floorLocal } as Instr],
    } as Instr);
    fctx.body.push({ op: "local.tee", index: rLocal } as Instr);
    // If result == 0, use copysign(0, x) to preserve -0
    fctx.body.push({ op: "f64.const", value: 0 } as Instr);
    fctx.body.push({ op: "f64.eq" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [
        { op: "f64.const", value: 0 } as Instr,
        { op: "local.get", index: xLocal } as Instr,
        { op: "f64.copysign" },
      ],
      else: [{ op: "local.get", index: rLocal } as Instr],
    } as Instr);
    return { kind: "f64" };
  }

  if (method in nativeUnary && expr.arguments.length >= 1) {
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    fctx.body.push({ op: nativeUnary[method]! } as Instr);
    return { kind: "f64" };
  }

  // Math.clz32(n) → ToUint32(n) then i32.clz
  // ToUint32: NaN/±Infinity → 0; otherwise truncate then modulo 2^32.
  // We use the host-imported __toUint32 for correct edge-case handling.
  if (method === "clz32" && expr.arguments.length >= 1) {
    const toU32Idx = ctx.funcMap.get("__toUint32");
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    if (toU32Idx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toU32Idx });
    } else {
      fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
    }
    fctx.body.push({ op: "i32.clz" } as Instr);
    fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
    return { kind: "f64" };
  }

  // Math.imul(a, b) → ToUint32(a) * ToUint32(b), result as signed i32
  if (method === "imul" && expr.arguments.length >= 2) {
    const toU32Idx = ctx.funcMap.get("__toUint32");
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    if (toU32Idx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toU32Idx });
    } else {
      fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
    }
    compileExpression(ctx, fctx, expr.arguments[1]!, f64Hint);
    if (toU32Idx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toU32Idx });
    } else {
      fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
    }
    fctx.body.push({ op: "i32.mul" } as Instr);
    fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
    return { kind: "f64" };
  }

  if (method === "sign" && expr.arguments.length >= 1) {
    // sign(x): NaN→NaN, -0→-0, 0→0, x>0→1, x<0→-1
    // Use f64.copysign to preserve -0 and NaN passthrough:
    //   if (x !== x) return NaN  (NaN check)
    //   if (x == 0) return x     (preserves -0/+0)
    //   return x > 0 ? 1 : -1
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    const tmp = allocLocal(fctx, `__sign_${fctx.locals.length}`, {
      kind: "f64",
    });
    fctx.body.push({ op: "local.tee", index: tmp });
    // NaN check: x !== x
    fctx.body.push({ op: "local.get", index: tmp });
    fctx.body.push({ op: "f64.ne" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [
        // return NaN
        { op: "f64.const", value: NaN },
      ],
      else: [
        // x == 0 check (true for both +0 and -0)
        { op: "local.get", index: tmp },
        { op: "f64.abs" } as Instr,
        { op: "f64.const", value: 0 },
        { op: "f64.eq" } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "f64" } },
          then: [
            // return x (preserves -0)
            { op: "local.get", index: tmp },
          ],
          else: [
            // return copysign(1.0, x) — gives 1 or -1 based on sign of x
            { op: "f64.const", value: 1 },
            { op: "local.get", index: tmp },
            { op: "f64.copysign" },
          ],
        },
      ],
    });
    return { kind: "f64" };
  }

  // Math.fround(x) → f64.promote_f32(f32.demote_f64(x))
  if (method === "fround" && expr.arguments.length >= 1) {
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    fctx.body.push({ op: "f32.demote_f64" } as Instr);
    fctx.body.push({ op: "f64.promote_f32" } as Instr);
    return { kind: "f64" };
  }

  // Math.hypot(a, b) → sqrt(a*a + b*b) — inline for the common 2-arg case
  if (method === "hypot") {
    if (expr.arguments.length === 0) {
      fctx.body.push({ op: "f64.const", value: 0 });
      return { kind: "f64" };
    }
    if (expr.arguments.length === 1) {
      compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
      fctx.body.push({ op: "f64.abs" } as Instr);
      return { kind: "f64" };
    }
    // 2+ args: spec says if any arg is +-Infinity → +Infinity, else sqrt(sum of squares)
    const hypotLocals: number[] = [];
    for (let ai = 0; ai < expr.arguments.length; ai++) {
      const loc = allocLocal(fctx, `__hypot_${fctx.locals.length}`, {
        kind: "f64",
      });
      compileExpression(ctx, fctx, expr.arguments[ai]!, f64Hint);
      fctx.body.push({ op: "local.set", index: loc });
      hypotLocals.push(loc);
    }
    // Check if any arg is +-Infinity: abs(x) == +Inf
    // Build: abs(a0)==Inf || abs(a1)==Inf || ...
    for (let i = 0; i < hypotLocals.length; i++) {
      fctx.body.push({ op: "local.get", index: hypotLocals[i]! } as Instr);
      fctx.body.push({ op: "f64.abs" } as Instr);
      fctx.body.push({ op: "f64.const", value: Infinity });
      fctx.body.push({ op: "f64.eq" } as Instr);
      if (i > 0) {
        fctx.body.push({ op: "i32.or" } as Instr);
      }
    }
    // if any is Inf, return +Infinity, else sqrt(sum of squares)
    const thenBlock: Instr[] = [{ op: "f64.const", value: Infinity }];
    const elseBlock: Instr[] = [];
    for (let i = 0; i < hypotLocals.length; i++) {
      elseBlock.push({ op: "local.get", index: hypotLocals[i]! } as Instr);
      elseBlock.push({ op: "local.get", index: hypotLocals[i]! } as Instr);
      elseBlock.push({ op: "f64.mul" } as Instr);
    }
    for (let i = 1; i < hypotLocals.length; i++) {
      elseBlock.push({ op: "f64.add" } as Instr);
    }
    elseBlock.push({ op: "f64.sqrt" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: thenBlock,
      else: elseBlock,
    });
    return { kind: "f64" };
  }

  // Host-imported Math methods (1-arg): sin, cos, tan, exp, log, etc.
  const hostUnary = new Set([
    "exp",
    "log",
    "log2",
    "log10",
    "sin",
    "cos",
    "tan",
    "asin",
    "acos",
    "atan",
    "acosh",
    "asinh",
    "atanh",
    "cosh",
    "sinh",
    "tanh",
    "cbrt",
    "expm1",
    "log1p",
  ]);
  if (hostUnary.has(method) && expr.arguments.length >= 1) {
    const funcIdx = ctx.funcMap.get(`Math_${method}`);
    if (funcIdx !== undefined) {
      compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "f64" };
    }
  }

  // Host-imported Math methods (2-arg): pow, atan2
  if ((method === "pow" || method === "atan2") && expr.arguments.length >= 2) {
    const funcIdx = ctx.funcMap.get(`Math_${method}`);
    if (funcIdx !== undefined) {
      compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
      compileExpression(ctx, fctx, expr.arguments[1]!, f64Hint);
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "f64" };
    }
  }

  // Math.random() — 0-arg host import
  if (method === "random") {
    const funcIdx = ctx.funcMap.get("Math_random");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "f64" };
    }
  }

  // Math.min(...args) / Math.max(...args) — variadic with NaN propagation
  // Wasm f64.min/f64.max don't propagate NaN from the first operand in all
  // engines, so we guard each argument: if any arg is NaN, return NaN.
  // Compile-time optimization: if an arg is statically NaN, emit NaN directly.
  if ((method === "min" || method === "max") && expr.arguments) {
    const wasmOp = method === "min" ? "f64.min" : "f64.max";
    if (expr.arguments.length === 0) {
      fctx.body.push({
        op: "f64.const",
        value: method === "min" ? Infinity : -Infinity,
      } as Instr);
      return { kind: "f64" };
    }

    // Check if any argument is statically NaN → evaluate all args for side effects, then return NaN
    if (expr.arguments.some((a) => isStaticNaN(ctx, a))) {
      // Must still evaluate all arguments (ToNumber coercion / side effects)
      for (const arg of expr.arguments) {
        if (!isStaticNaN(ctx, arg)) {
          compileExpression(ctx, fctx, arg, f64Hint);
          fctx.body.push({ op: "drop" } as Instr);
        }
      }
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
    }

    // Try static valueOf resolution for each argument.
    // For object-typed arguments, tryStaticToNumber resolves {} → NaN,
    // { valueOf: () => 42 } → 42, { valueOf: () => void } → NaN, etc.
    const staticValues: (number | undefined)[] = expr.arguments.map((a) => {
      const tsType = ctx.checker.getTypeAtLocation(a);
      // Only apply static valueOf to non-number types (objects)
      if (tsType.flags & ts.TypeFlags.Object) {
        return tryStaticToNumber(ctx, a);
      }
      return undefined;
    });

    // If ALL arguments resolved statically, compute the result at compile time
    if (staticValues.every((v) => v !== undefined)) {
      const nums = staticValues as number[];
      const result = method === "min" ? nums.reduce((a, b) => Math.min(a, b)) : nums.reduce((a, b) => Math.max(a, b));
      fctx.body.push({ op: "f64.const", value: result });
      return { kind: "f64" };
    }

    // 1 arg: no f64.min needed, just return the value (or its static resolution)
    if (expr.arguments.length === 1) {
      if (staticValues[0] !== undefined) {
        fctx.body.push({ op: "f64.const", value: staticValues[0] });
      } else {
        compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
      }
      return { kind: "f64" };
    }

    // 2+ args: compile into locals, check each for NaN at runtime, then chain f64.min/max
    const argLocals: number[] = [];
    for (let ai = 0; ai < expr.arguments.length; ai++) {
      const local = allocLocal(fctx, `__minmax_${fctx.locals.length}`, {
        kind: "f64",
      });
      if (staticValues[ai] !== undefined) {
        fctx.body.push({ op: "f64.const", value: staticValues[ai]! });
      } else {
        compileExpression(ctx, fctx, expr.arguments[ai]!, f64Hint);
      }
      fctx.body.push({ op: "local.set", index: local });
      argLocals.push(local);
    }

    // Build nested if chain: for each arg, check isNaN → return it, else continue
    // Result type is f64 for each if block
    const f64Block = { kind: "val" as const, type: { kind: "f64" as const } };

    // Build from inside out: innermost is the actual f64.min/max chain
    let innerBody: Instr[] = [{ op: "local.get", index: argLocals[0]! }];
    for (let i = 1; i < argLocals.length; i++) {
      innerBody.push({ op: "local.get", index: argLocals[i]! });
      innerBody.push({ op: wasmOp });
    }

    // Wrap with NaN checks from last arg to first
    for (let i = argLocals.length - 1; i >= 0; i--) {
      innerBody = [
        // isNaN check: local.get, local.get, f64.ne (x !== x)
        { op: "local.get", index: argLocals[i]! },
        { op: "local.get", index: argLocals[i]! },
        { op: "f64.ne" } as Instr,
        {
          op: "if",
          blockType: f64Block,
          then: [{ op: "local.get", index: argLocals[i]! }],
          else: innerBody,
        } as Instr,
      ];
    }

    for (const instr of innerBody) {
      fctx.body.push(instr);
    }
    return { kind: "f64" };
  }

  // Unknown method — return undefined to let the caller fall through
  // to generic call handling. This avoids false positives when e.g.
  // Array.prototype.every.call(Math, ...) gets rewritten to Math.every(...).
  return undefined;
}

export { compileConsoleCall, compileDateMethodCall, compileMathCall };
