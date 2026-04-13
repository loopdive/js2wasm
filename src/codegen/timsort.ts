// Copyright (c) 2026 Loopdive GmbH. Licensed under AGPL-3.0.
/**
 * Timsort implementation for WasmGC native arrays.
 *
 * Emits 4 module-level wasm helper functions per element type (i32 / f64):
 *   1. __isort_{type}(data, lo, hi)        — insertion sort a range
 *   2. __merge_{type}(data, tmp, lo, mid, hi) — merge two sorted halves
 *   3. __merge_run_{type}(data, tmp, sBase, sLen, stackSize, idx) -> i32
 *   4. __timsort_{type}(vec)               — main Timsort driver
 *
 * Features: natural run detection, descending run reversal, minRun computation,
 * insertion sort for short runs, stable merge, stack-based merge policy.
 * Galloping mode is omitted (optimization, not required for correctness).
 */

import type { Instr, LocalDef, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType, getOrRegisterArrayType } from "./registry/types.js";

// ---------------------------------------------------------------------------
// IR builder helpers (terse names to keep instruction arrays readable)
// ---------------------------------------------------------------------------
const L = (i: number): Instr => ({ op: "local.get", index: i });
const LS = (i: number): Instr => ({ op: "local.set", index: i });
const LT = (i: number): Instr => ({ op: "local.tee", index: i });
const I = (v: number): Instr => ({ op: "i32.const", value: v });

const ADD: Instr = { op: "i32.add" };
const SUB: Instr = { op: "i32.sub" };
const MUL: Instr = { op: "i32.mul" };
const LT_S: Instr = { op: "i32.lt_s" };
const LE_S: Instr = { op: "i32.le_s" };
const GT_S: Instr = { op: "i32.gt_s" };
const GE_S: Instr = { op: "i32.ge_s" };
const EQZ: Instr = { op: "i32.eqz" };
const I_AND: Instr = { op: "i32.and" };
const I_OR: Instr = { op: "i32.or" };
const SHR_U: Instr = { op: "i32.shr_u" };

const RET: Instr = { op: "return" };

const AG = (t: number): Instr => ({ op: "array.get", typeIdx: t });
const AS = (t: number): Instr => ({ op: "array.set", typeIdx: t });
const AC = (d: number, s: number): Instr => ({ op: "array.copy", dstTypeIdx: d, srcTypeIdx: s });
const AND = (t: number): Instr => ({ op: "array.new_default", typeIdx: t });

function BLOCK(body: Instr[]): Instr {
  return { op: "block", blockType: { kind: "empty" }, body };
}
function LOOP(body: Instr[]): Instr {
  return { op: "loop", blockType: { kind: "empty" }, body };
}
function BR(d: number): Instr {
  return { op: "br", depth: d };
}
function BR_IF(d: number): Instr {
  return { op: "br_if", depth: d };
}
function IF(then: Instr[], els?: Instr[]): Instr {
  const r: any = { op: "if", blockType: { kind: "empty" }, then };
  if (els) r.else = els;
  return r;
}
function CALL(idx: number): Instr {
  return { op: "call", funcIdx: idx };
}

// ---------------------------------------------------------------------------
// Function emitter
// ---------------------------------------------------------------------------
function emitFunc(
  ctx: CodegenContext,
  name: string,
  params: ValType[],
  results: ValType[],
  locals: LocalDef[],
  body: Instr[],
): number {
  const typeIdx = addFuncType(ctx, params, results, `${name}_type`);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(name, funcIdx);
  ctx.mod.functions.push({ name, typeIdx, locals, body, exported: false });
  return funcIdx;
}

// ---------------------------------------------------------------------------
// 1. Insertion sort: __isort_{type}(data, lo, hi)
// ---------------------------------------------------------------------------
function emitInsertionSort(ctx: CodegenContext, arrTypeIdx: number, elemKind: "i32" | "f64"): number {
  const name = `__isort_${elemKind}`;
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  const elemType: ValType = { kind: elemKind };
  const arrRef: ValType = { kind: "ref_null", typeIdx: arrTypeIdx };
  const gtOp: Instr = elemKind === "i32" ? { op: "i32.gt_s" } : { op: "f64.gt" };

  // Params: 0=data, 1=lo, 2=hi   Locals: 3=i, 4=j, 5=key
  const DATA = 0,
    LO = 1,
    HI = 2,
    II = 3,
    JJ = 4,
    KEY = 5;

  const body: Instr[] = [
    // i = lo + 1
    L(LO),
    I(1),
    ADD,
    LS(II),

    BLOCK([
      LOOP([
        // if i >= hi: break
        L(II),
        L(HI),
        GE_S,
        BR_IF(1),

        // key = data[i]
        L(DATA),
        L(II),
        AG(arrTypeIdx),
        LS(KEY),

        // j = i - 1
        L(II),
        I(1),
        SUB,
        LS(JJ),

        // Inner: while j >= lo && data[j] > key
        BLOCK([
          LOOP([
            L(JJ),
            L(LO),
            LT_S,
            BR_IF(1),
            L(DATA),
            L(JJ),
            AG(arrTypeIdx),
            L(KEY),
            gtOp,
            EQZ,
            BR_IF(1),
            // data[j+1] = data[j]
            L(DATA),
            L(JJ),
            I(1),
            ADD,
            L(DATA),
            L(JJ),
            AG(arrTypeIdx),
            AS(arrTypeIdx),
            // j--
            L(JJ),
            I(1),
            SUB,
            LS(JJ),
            BR(0),
          ]),
        ]),

        // data[j+1] = key
        L(DATA),
        L(JJ),
        I(1),
        ADD,
        L(KEY),
        AS(arrTypeIdx),

        // i++
        L(II),
        I(1),
        ADD,
        LS(II),
        BR(0),
      ]),
    ]),
  ];

  return emitFunc(
    ctx,
    name,
    [arrRef, { kind: "i32" }, { kind: "i32" }],
    [],
    [
      { name: "i", type: { kind: "i32" } },
      { name: "j", type: { kind: "i32" } },
      { name: "key", type: elemType },
    ],
    body,
  );
}

// ---------------------------------------------------------------------------
// 2. Merge: __merge_{type}(data, tmp, lo, mid, hi)
// ---------------------------------------------------------------------------
function emitMerge(ctx: CodegenContext, arrTypeIdx: number, elemKind: "i32" | "f64"): number {
  const name = `__merge_${elemKind}`;
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  const arrRef: ValType = { kind: "ref_null", typeIdx: arrTypeIdx };
  const leOp: Instr = elemKind === "i32" ? { op: "i32.le_s" } : { op: "f64.le" };

  // Params: 0=data, 1=tmp, 2=lo, 3=mid, 4=hi
  // Locals: 5=leftLen, 6=i, 7=j, 8=k
  const DATA = 0,
    TMP = 1,
    LO = 2,
    MID = 3,
    HI = 4;
  const LEFT = 5,
    II = 6,
    JJ = 7,
    KK = 8;

  const body: Instr[] = [
    // leftLen = mid - lo
    L(MID),
    L(LO),
    SUB,
    LS(LEFT),
    // if leftLen <= 0: return
    L(LEFT),
    I(0),
    LE_S,
    IF([RET]),

    // Copy left half to tmp[0..leftLen)
    L(TMP),
    I(0),
    L(DATA),
    L(LO),
    L(LEFT),
    AC(arrTypeIdx, arrTypeIdx),

    // i=0, j=mid, k=lo
    I(0),
    LS(II),
    L(MID),
    LS(JJ),
    L(LO),
    LS(KK),

    // Merge loop
    BLOCK([
      LOOP([
        L(II),
        L(LEFT),
        GE_S,
        BR_IF(1), // left exhausted
        L(JJ),
        L(HI),
        GE_S,
        BR_IF(1), // right exhausted

        // if tmp[i] <= data[j]: take from left, else from right
        L(TMP),
        L(II),
        AG(arrTypeIdx),
        L(DATA),
        L(JJ),
        AG(arrTypeIdx),
        leOp,
        IF(
          [L(DATA), L(KK), L(TMP), L(II), AG(arrTypeIdx), AS(arrTypeIdx), L(II), I(1), ADD, LS(II)],
          [L(DATA), L(KK), L(DATA), L(JJ), AG(arrTypeIdx), AS(arrTypeIdx), L(JJ), I(1), ADD, LS(JJ)],
        ),

        L(KK),
        I(1),
        ADD,
        LS(KK),
        BR(0),
      ]),
    ]),

    // Copy remaining left elements (right are already in place)
    L(II),
    L(LEFT),
    LT_S,
    IF([L(DATA), L(KK), L(TMP), L(II), L(LEFT), L(II), SUB, AC(arrTypeIdx, arrTypeIdx)]),
  ];

  return emitFunc(
    ctx,
    name,
    [arrRef, arrRef, { kind: "i32" }, { kind: "i32" }, { kind: "i32" }],
    [],
    [
      { name: "leftLen", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
      { name: "j", type: { kind: "i32" } },
      { name: "k", type: { kind: "i32" } },
    ],
    body,
  );
}

// ---------------------------------------------------------------------------
// 3. Merge-at: __merge_run_{type}(data, tmp, sBase, sLen, stackSize, idx) -> i32
//    Merges runs at stack[idx] and stack[idx+1], shifts stack, returns new size.
// ---------------------------------------------------------------------------
function emitMergeRun(
  ctx: CodegenContext,
  arrTypeIdx: number,
  i32ArrTypeIdx: number,
  elemKind: "i32" | "f64",
  mergeFuncIdx: number,
): number {
  const name = `__merge_run_${elemKind}`;
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  const arrRef: ValType = { kind: "ref_null", typeIdx: arrTypeIdx };
  const i32ArrRef: ValType = { kind: "ref_null", typeIdx: i32ArrTypeIdx };

  // Params: 0=data, 1=tmp, 2=sBase, 3=sLen, 4=stackSize, 5=idx
  // Locals: 6=base1, 7=len1, 8=len2
  const DATA = 0,
    TMP = 1,
    SBASE = 2,
    SLEN = 3,
    SSIZE = 4,
    IDX = 5;
  const BASE1 = 6,
    LEN1 = 7,
    LEN2 = 8;

  const body: Instr[] = [
    // base1 = sBase[idx]
    L(SBASE),
    L(IDX),
    AG(i32ArrTypeIdx),
    LS(BASE1),
    // len1 = sLen[idx]
    L(SLEN),
    L(IDX),
    AG(i32ArrTypeIdx),
    LS(LEN1),
    // len2 = sLen[idx + 1]
    L(SLEN),
    L(IDX),
    I(1),
    ADD,
    AG(i32ArrTypeIdx),
    LS(LEN2),

    // call __merge(data, tmp, base1, base1+len1, base1+len1+len2)
    L(DATA),
    L(TMP),
    L(BASE1),
    L(BASE1),
    L(LEN1),
    ADD,
    L(BASE1),
    L(LEN1),
    ADD,
    L(LEN2),
    ADD,
    CALL(mergeFuncIdx),

    // sLen[idx] = len1 + len2
    L(SLEN),
    L(IDX),
    L(LEN1),
    L(LEN2),
    ADD,
    AS(i32ArrTypeIdx),

    // Shift stack entries: copy from idx+2.. to idx+1..
    // length = stackSize - idx - 2 (always >= 0)
    L(SBASE),
    L(IDX),
    I(1),
    ADD,
    L(SBASE),
    L(IDX),
    I(2),
    ADD,
    L(SSIZE),
    L(IDX),
    SUB,
    I(2),
    SUB,
    AC(i32ArrTypeIdx, i32ArrTypeIdx),

    L(SLEN),
    L(IDX),
    I(1),
    ADD,
    L(SLEN),
    L(IDX),
    I(2),
    ADD,
    L(SSIZE),
    L(IDX),
    SUB,
    I(2),
    SUB,
    AC(i32ArrTypeIdx, i32ArrTypeIdx),

    // return stackSize - 1
    L(SSIZE),
    I(1),
    SUB,
  ];

  return emitFunc(
    ctx,
    name,
    [arrRef, arrRef, i32ArrRef, i32ArrRef, { kind: "i32" }, { kind: "i32" }],
    [{ kind: "i32" }],
    [
      { name: "base1", type: { kind: "i32" } },
      { name: "len1", type: { kind: "i32" } },
      { name: "len2", type: { kind: "i32" } },
    ],
    body,
  );
}

// ---------------------------------------------------------------------------
// 4. Main Timsort driver: __timsort_{type}(vec)
// ---------------------------------------------------------------------------
function emitTimsortMain(
  ctx: CodegenContext,
  vecTypeIdx: number,
  arrTypeIdx: number,
  i32ArrTypeIdx: number,
  elemKind: "i32" | "f64",
  isortIdx: number,
  mergeRunIdx: number,
): number {
  const name = `__timsort_${elemKind}`;
  const elemType: ValType = { kind: elemKind };
  const vecRef: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };
  const ltOp: Instr = elemKind === "i32" ? { op: "i32.lt_s" } : { op: "f64.lt" };

  // Param 0: vec
  const VEC = 0;
  // Locals 1..19
  const DATA = 1,
    LEN = 2,
    TMP = 3,
    MIN_RUN = 4;
  const NMR = 5,
    RMR = 6;
  const LO = 7,
    RUN_END = 8,
    RUN_LEN = 9,
    FORCE = 10;
  const SB = 11,
    SL = 12,
    SS = 13;
  const SN = 14,
    MIDX = 15;
  const I_REV = 16,
    J_REV = 17,
    T_SWAP = 18,
    SHOULD = 19;

  const locals: LocalDef[] = [
    { name: "data", type: { kind: "ref_null", typeIdx: arrTypeIdx } },
    { name: "len", type: { kind: "i32" } },
    { name: "tmp", type: { kind: "ref_null", typeIdx: arrTypeIdx } },
    { name: "minRun", type: { kind: "i32" } },
    { name: "nmr", type: { kind: "i32" } },
    { name: "rmr", type: { kind: "i32" } },
    { name: "lo", type: { kind: "i32" } },
    { name: "runEnd", type: { kind: "i32" } },
    { name: "runLen", type: { kind: "i32" } },
    { name: "force", type: { kind: "i32" } },
    { name: "sBase", type: { kind: "ref_null", typeIdx: i32ArrTypeIdx } },
    { name: "sLen", type: { kind: "ref_null", typeIdx: i32ArrTypeIdx } },
    { name: "stackSize", type: { kind: "i32" } },
    { name: "sn", type: { kind: "i32" } },
    { name: "mergeIdx", type: { kind: "i32" } },
    { name: "iRev", type: { kind: "i32" } },
    { name: "jRev", type: { kind: "i32" } },
    { name: "tSwap", type: elemType },
    { name: "should", type: { kind: "i32" } },
  ];

  // -- Section 1: extract data & len, early return --
  const sec1: Instr[] = [
    L(VEC),
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
    LS(DATA),
    L(VEC),
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
    LS(LEN),
    // if len < 2: return
    L(LEN),
    I(2),
    LT_S,
    IF([RET]),
  ];

  // -- Section 2: small array → insertion sort --
  const sec2: Instr[] = [L(LEN), I(64), LT_S, IF([L(DATA), I(0), L(LEN), CALL(isortIdx), RET])];

  // -- Section 3: compute minRun --
  const sec3: Instr[] = [
    L(LEN),
    LS(NMR),
    I(0),
    LS(RMR),
    BLOCK([
      LOOP([
        L(NMR),
        I(64),
        LT_S,
        BR_IF(1),
        // rmr |= (nmr & 1)
        L(RMR),
        L(NMR),
        I(1),
        I_AND,
        I_OR,
        LS(RMR),
        // nmr >>= 1
        L(NMR),
        I(1),
        SHR_U,
        LS(NMR),
        BR(0),
      ]),
    ]),
    L(NMR),
    L(RMR),
    ADD,
    LS(MIN_RUN),
  ];

  // -- Section 4: allocate buffers --
  const sec4: Instr[] = [
    L(LEN),
    AND(arrTypeIdx),
    LS(TMP),
    I(85),
    AND(i32ArrTypeIdx),
    LS(SB),
    I(85),
    AND(i32ArrTypeIdx),
    LS(SL),
    I(0),
    LS(SS),
    I(0),
    LS(LO),
  ];

  // -- Section 5: main loop body (run detection + extend + push + collapse) --

  // 5a: detect run
  const detectRun: Instr[] = [
    // runEnd = lo + 1
    L(LO),
    I(1),
    ADD,
    LS(RUN_END),

    L(RUN_END),
    L(LEN),
    GE_S,
    IF(
      // Single element remaining
      [I(1), LS(RUN_LEN)],
      [
        // Check if descending: data[lo+1] < data[lo]
        L(DATA),
        L(RUN_END),
        AG(arrTypeIdx),
        L(DATA),
        L(LO),
        AG(arrTypeIdx),
        ltOp,
        IF(
          // Descending run
          [
            L(RUN_END),
            I(1),
            ADD,
            LS(RUN_END),
            BLOCK([
              LOOP([
                L(RUN_END),
                L(LEN),
                GE_S,
                BR_IF(1),
                // if data[runEnd] >= data[runEnd-1]: stop
                L(DATA),
                L(RUN_END),
                AG(arrTypeIdx),
                L(DATA),
                L(RUN_END),
                I(1),
                SUB,
                AG(arrTypeIdx),
                ltOp,
                EQZ,
                BR_IF(1),
                L(RUN_END),
                I(1),
                ADD,
                LS(RUN_END),
                BR(0),
              ]),
            ]),
            // Reverse [lo, runEnd)
            L(LO),
            LS(I_REV),
            L(RUN_END),
            I(1),
            SUB,
            LS(J_REV),
            BLOCK([
              LOOP([
                L(I_REV),
                L(J_REV),
                GE_S,
                BR_IF(1),
                // swap data[iRev] <-> data[jRev]
                L(DATA),
                L(I_REV),
                AG(arrTypeIdx),
                LS(T_SWAP),
                L(DATA),
                L(I_REV),
                L(DATA),
                L(J_REV),
                AG(arrTypeIdx),
                AS(arrTypeIdx),
                L(DATA),
                L(J_REV),
                L(T_SWAP),
                AS(arrTypeIdx),
                L(I_REV),
                I(1),
                ADD,
                LS(I_REV),
                L(J_REV),
                I(1),
                SUB,
                LS(J_REV),
                BR(0),
              ]),
            ]),
          ],
          // Ascending run
          [
            L(RUN_END),
            I(1),
            ADD,
            LS(RUN_END),
            BLOCK([
              LOOP([
                L(RUN_END),
                L(LEN),
                GE_S,
                BR_IF(1),
                // if data[runEnd] < data[runEnd-1]: stop
                L(DATA),
                L(RUN_END),
                AG(arrTypeIdx),
                L(DATA),
                L(RUN_END),
                I(1),
                SUB,
                AG(arrTypeIdx),
                ltOp,
                BR_IF(1),
                L(RUN_END),
                I(1),
                ADD,
                LS(RUN_END),
                BR(0),
              ]),
            ]),
          ],
        ),
        // runLen = runEnd - lo
        L(RUN_END),
        L(LO),
        SUB,
        LS(RUN_LEN),
      ],
    ),
  ];

  // 5b: extend short run with insertion sort
  const extendRun: Instr[] = [
    // force = min(minRun, len - lo)
    L(MIN_RUN),
    L(LEN),
    L(LO),
    SUB,
    // select: if minRun <= len-lo then minRun else len-lo
    L(MIN_RUN),
    L(LEN),
    L(LO),
    SUB,
    LE_S,
    { op: "select" },
    LS(FORCE),

    L(RUN_LEN),
    L(FORCE),
    LT_S,
    IF([L(DATA), L(LO), L(LO), L(FORCE), ADD, CALL(isortIdx), L(FORCE), LS(RUN_LEN)]),
  ];

  // 5c: push run to stack
  const pushRun: Instr[] = [
    L(SB),
    L(SS),
    L(LO),
    AS(i32ArrTypeIdx),
    L(SL),
    L(SS),
    L(RUN_LEN),
    AS(i32ArrTypeIdx),
    L(SS),
    I(1),
    ADD,
    LS(SS),
  ];

  // 5d: merge collapse — maintain Timsort stack invariants
  const mergeCollapse: Instr[] = [
    BLOCK([
      LOOP([
        L(SS),
        I(2),
        LT_S,
        BR_IF(1), // stackSize < 2: done

        L(SS),
        I(2),
        SUB,
        LS(SN), // sn = stackSize - 2
        I(0),
        LS(SHOULD),
        L(SN),
        LS(MIDX), // default mergeIdx = sn

        L(SN),
        I(0),
        GT_S,
        IF(
          // 3+ entries: check invariant 1
          [
            // runLen[sn-1] <= runLen[sn] + runLen[sn+1]?
            L(SL),
            L(SN),
            I(1),
            SUB,
            AG(i32ArrTypeIdx), // runLen[sn-1]
            L(SL),
            L(SN),
            AG(i32ArrTypeIdx), // runLen[sn]
            L(SL),
            L(SN),
            I(1),
            ADD,
            AG(i32ArrTypeIdx), // runLen[sn+1]
            ADD, // runLen[sn] + runLen[sn+1]
            LE_S,
            IF(
              [
                I(1),
                LS(SHOULD),
                // if runLen[sn-1] < runLen[sn+1]: mergeIdx = sn-1
                L(SL),
                L(SN),
                I(1),
                SUB,
                AG(i32ArrTypeIdx),
                L(SL),
                L(SN),
                I(1),
                ADD,
                AG(i32ArrTypeIdx),
                LT_S,
                IF([L(SN), I(1), SUB, LS(MIDX)]),
              ],
              // Invariant 1 OK, check invariant 2: runLen[sn] <= runLen[sn+1]
              [
                L(SL),
                L(SN),
                AG(i32ArrTypeIdx),
                L(SL),
                L(SN),
                I(1),
                ADD,
                AG(i32ArrTypeIdx),
                LE_S,
                IF([I(1), LS(SHOULD)]),
              ],
            ),
          ],
          // 2 entries: only check invariant 2
          [L(SL), L(SN), AG(i32ArrTypeIdx), L(SL), L(SN), I(1), ADD, AG(i32ArrTypeIdx), LE_S, IF([I(1), LS(SHOULD)])],
        ),

        L(SHOULD),
        EQZ,
        BR_IF(1), // no merge needed: done

        // call __merge_run(data, tmp, sBase, sLen, stackSize, mergeIdx)
        L(DATA),
        L(TMP),
        L(SB),
        L(SL),
        L(SS),
        L(MIDX),
        CALL(mergeRunIdx),
        LS(SS),

        BR(0),
      ]),
    ]),
  ];

  // 5e: advance lo
  const advanceLo: Instr[] = [L(LO), L(RUN_LEN), ADD, LS(LO)];

  // Assemble main loop
  const mainLoop: Instr[] = [
    BLOCK([
      LOOP([
        L(LO),
        L(LEN),
        GE_S,
        BR_IF(1),
        ...detectRun,
        ...extendRun,
        ...pushRun,
        ...mergeCollapse,
        ...advanceLo,
        BR(0),
      ]),
    ]),
  ];

  // -- Section 6: force collapse all remaining runs --
  const forceCollapse: Instr[] = [
    BLOCK([
      LOOP([
        L(SS),
        I(2),
        LT_S,
        BR_IF(1),
        L(SS),
        I(2),
        SUB,
        LS(SN),
        L(SN),
        LS(MIDX),

        // if sn > 0 and sLen[sn-1] < sLen[sn+1]: mergeIdx = sn-1
        L(SN),
        I(0),
        GT_S,
        IF([
          L(SL),
          L(SN),
          I(1),
          SUB,
          AG(i32ArrTypeIdx),
          L(SL),
          L(SN),
          I(1),
          ADD,
          AG(i32ArrTypeIdx),
          LT_S,
          IF([L(SN), I(1), SUB, LS(MIDX)]),
        ]),

        L(DATA),
        L(TMP),
        L(SB),
        L(SL),
        L(SS),
        L(MIDX),
        CALL(mergeRunIdx),
        LS(SS),

        BR(0),
      ]),
    ]),
  ];

  const body: Instr[] = [...sec1, ...sec2, ...sec3, ...sec4, ...mainLoop, ...forceCollapse];

  return emitFunc(ctx, name, [vecRef], [], locals, body);
}

// ---------------------------------------------------------------------------
// Public API: ensure Timsort helpers are emitted, return funcIdx of __timsort
// ---------------------------------------------------------------------------
export function ensureTimsortHelper(
  ctx: CodegenContext,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemKind: "i32" | "f64",
): number {
  const name = `__timsort_${elemKind}`;
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  // We need an i32 array type for the run stack (start positions + lengths)
  const i32ArrTypeIdx = getOrRegisterArrayType(ctx, "i32");

  const isortIdx = emitInsertionSort(ctx, arrTypeIdx, elemKind);
  const mergeIdx = emitMerge(ctx, arrTypeIdx, elemKind);
  const mergeRunIdx = emitMergeRun(ctx, arrTypeIdx, i32ArrTypeIdx, elemKind, mergeIdx);
  return emitTimsortMain(ctx, vecTypeIdx, arrTypeIdx, i32ArrTypeIdx, elemKind, isortIdx, mergeRunIdx);
}
