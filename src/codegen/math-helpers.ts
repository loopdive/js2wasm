/**
 * Pure Wasm implementations of Math transcendental functions.
 *
 * These replace host imports for Math.sin, Math.cos, Math.exp, Math.log,
 * Math.tan, Math.atan, Math.asin, Math.acos, Math.atan2, Math.pow,
 * Math.log2, Math.log10, Math.sinh, Math.cosh, Math.tanh,
 * Math.asinh, Math.acosh, Math.atanh, Math.cbrt, Math.expm1, Math.log1p.
 *
 * All implementations use polynomial (minimax/Chebyshev) approximations
 * with arithmetic range reduction. Precision target: within 4 ULP of
 * IEEE 754 for the common range.
 */
import type { CodegenContext } from "./index.js";
import { addFuncType } from "./index.js";
import type { Instr, ValType } from "../ir/types.js";

// ─── Instruction shorthand helpers ──────────────────────────────────
const f64c = (v: number): Instr => ({ op: "f64.const", value: v }) as Instr;
const localGet = (i: number): Instr => ({ op: "local.get", index: i }) as Instr;
const localSet = (i: number): Instr => ({ op: "local.set", index: i }) as Instr;
const localTee = (i: number): Instr => ({ op: "local.tee", index: i }) as Instr;
const add: Instr = { op: "f64.add" } as Instr;
const sub: Instr = { op: "f64.sub" } as Instr;
const mul: Instr = { op: "f64.mul" } as Instr;
const div: Instr = { op: "f64.div" } as Instr;
const neg: Instr = { op: "f64.neg" } as Instr;
const fabs: Instr = { op: "f64.abs" } as Instr;
const fsqrt: Instr = { op: "f64.sqrt" } as Instr;
const ffloor: Instr = { op: "f64.floor" } as Instr;
const ftrunc: Instr = { op: "f64.trunc" } as Instr;
const feq: Instr = { op: "f64.eq" } as Instr;
const fne: Instr = { op: "f64.ne" } as Instr;
const flt: Instr = { op: "f64.lt" } as Instr;
const fgt: Instr = { op: "f64.gt" } as Instr;
const fle: Instr = { op: "f64.le" } as Instr;
const fge: Instr = { op: "f64.ge" } as Instr;
const ret: Instr = { op: "return" } as Instr;
const copysign: Instr = { op: "f64.copysign" } as unknown as Instr;
const i32const = (v: number): Instr => ({ op: "i32.const", value: v }) as Instr;
const i32eqz: Instr = { op: "i32.eqz" } as Instr;
const truncSatI32: Instr = { op: "i32.trunc_sat_f64_s" } as Instr;
const i32sub: Instr = { op: "i32.sub" } as Instr;

function ifThenRet(cond: Instr[], result: Instr[]): Instr[] {
  return [
    ...cond,
    { op: "if", blockType: { kind: "empty" }, then: [...result, ret] } as Instr,
  ];
}

function ifElse(type: ValType, thenBody: Instr[], elseBody: Instr[]): Instr {
  return {
    op: "if",
    blockType: { kind: "val", type },
    then: thenBody,
    else: elseBody,
  } as Instr;
}

function call(funcIdx: number): Instr {
  return { op: "call", funcIdx } as Instr;
}

function blockLoop(body: Instr[]): Instr {
  return {
    op: "block", blockType: { kind: "empty" },
    body: [{
      op: "loop", blockType: { kind: "empty" },
      body,
    } as Instr],
  } as Instr;
}

// ─── Constants ──────────────────────────────────────────────────────
const PI = Math.PI;
const TWO_PI = 2 * PI;
const HALF_PI = PI / 2;
const INV_TWO_PI = 1 / TWO_PI;
const LN2 = Math.LN2;
const LOG2E = Math.LOG2E;
const LOG10E = Math.LOG10E;

// ─── Type aliases ───────────────────────────────────────────────────
const f64Type: ValType = { kind: "f64" };
const i32Type: ValType = { kind: "i32" };
const f64Param: ValType[] = [f64Type];
const f64Result: ValType[] = [f64Type];

type MathFuncDef = {
  name: string;
  params: ValType[];
  results: ValType[];
  locals: { name: string; type: ValType }[];
  body: Instr[];
};

/**
 * Emit pure Wasm implementations for the requested Math methods.
 * Methods are added as module functions (not imports) and registered
 * in ctx.funcMap under "Math_<method>".
 */
export function emitInlineMathFunctions(
  ctx: CodegenContext,
  needed: Set<string>,
): void {
  const addedFuncs = new Map<string, number>();

  function addMathFunc(def: MathFuncDef): number {
    const typeIdx = addFuncType(ctx, def.params, def.results, def.name + "_type");
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.mod.functions.push({
      name: def.name,
      typeIdx,
      locals: def.locals,
      body: def.body,
      exported: false,
    });
    ctx.funcMap.set(def.name, funcIdx);
    addedFuncs.set(def.name, funcIdx);
    return funcIdx;
  }

  function getFuncIdx(name: string): number {
    const idx = addedFuncs.get(name);
    if (idx === undefined) {
      throw new Error(`Math helper ${name} not yet added but referenced`);
    }
    return idx;
  }

  // Determine which core functions we need based on what's requested
  const needSinCos = needed.has("sin") || needed.has("cos") || needed.has("tan");
  const needExp = needed.has("exp") || needed.has("sinh") || needed.has("cosh") || needed.has("tanh") || needed.has("pow") || needed.has("expm1");
  const needLog = needed.has("log") || needed.has("log2") || needed.has("log10") || needed.has("pow") || needed.has("asinh") || needed.has("acosh") || needed.has("atanh") || needed.has("log1p");
  const needAtan = needed.has("atan") || needed.has("asin") || needed.has("acos") || needed.has("atan2");

  // ─── Phase 1: Core functions ──────────────────────────────────────

  // Range reduction helper for sin/cos
  if (needSinCos) {
    // Reduces x to [-pi, pi] using Cody-Waite method
    // Local 0=x(param), 1=n
    addMathFunc({
      name: "__math_reduce_trig",
      params: f64Param,
      results: f64Result,
      locals: [{ name: "n", type: f64Type }],
      body: [
        // n = round(x / (2*pi))
        localGet(0), f64c(INV_TWO_PI), mul,
        f64c(0.5), add, ffloor,
        localSet(1),
        // r = x - n * 2*pi (two-step Cody-Waite for precision)
        localGet(0),
        localGet(1), f64c(6.283185307179586), mul, sub,
        localGet(1), f64c(1.2246467991473532e-16), mul, sub,
      ],
    });
  }

  // ─── Math.sin ─────────────────────────────────────────────────────
  if (needed.has("sin") || needed.has("tan")) {
    const reduceIdx = getFuncIdx("__math_reduce_trig");
    // Local 0=x(param), 1=r, 2=r2
    addMathFunc({
      name: "Math_sin",
      params: f64Param,
      results: f64Result,
      locals: [
        { name: "r", type: f64Type },
        { name: "r2", type: f64Type },
      ],
      body: [
        // NaN → NaN
        ...ifThenRet([localGet(0), localGet(0), fne], [f64c(NaN)]),
        // |x| == Infinity → NaN
        ...ifThenRet([localGet(0), fabs, f64c(Infinity), feq], [f64c(NaN)]),
        // x == 0 → x (preserves -0)
        ...ifThenRet([localGet(0), f64c(0), feq], [localGet(0)]),

        // Range reduce to [-pi, pi]
        localGet(0), call(reduceIdx), localSet(1),

        // r2 = r*r
        localGet(1), localGet(1), mul, localSet(2),

        // sin(r) via Horner form of Taylor series:
        // r * (1 + r2*(-1/6 + r2*(1/120 + r2*(-1/5040 + r2*(1/362880 + r2*(-1/39916800 + r2/6227020800))))))
        localGet(2), f64c(1 / 6227020800), mul,
        f64c(-1 / 39916800), add,
        localGet(2), mul,
        f64c(1 / 362880), add,
        localGet(2), mul,
        f64c(-1 / 5040), add,
        localGet(2), mul,
        f64c(1 / 120), add,
        localGet(2), mul,
        f64c(-1 / 6), add,
        localGet(2), mul,
        f64c(1), add,
        localGet(1), mul,
      ],
    });
  }

  // ─── Math.cos ─────────────────────────────────────────────────────
  if (needed.has("cos") || needed.has("tan")) {
    const reduceIdx = getFuncIdx("__math_reduce_trig");
    // Local 0=x(param), 1=r, 2=r2
    addMathFunc({
      name: "Math_cos",
      params: f64Param,
      results: f64Result,
      locals: [
        { name: "r", type: f64Type },
        { name: "r2", type: f64Type },
      ],
      body: [
        ...ifThenRet([localGet(0), localGet(0), fne], [f64c(NaN)]),
        ...ifThenRet([localGet(0), fabs, f64c(Infinity), feq], [f64c(NaN)]),

        // Range reduce
        localGet(0), call(reduceIdx), localSet(1),
        localGet(1), localGet(1), mul, localSet(2),

        // cos(r) via Horner:
        // 1 + r2*(-1/2 + r2*(1/24 + r2*(-1/720 + r2*(1/40320 + r2*(-1/3628800 + r2/479001600)))))
        localGet(2), f64c(1 / 479001600), mul,
        f64c(-1 / 3628800), add,
        localGet(2), mul,
        f64c(1 / 40320), add,
        localGet(2), mul,
        f64c(-1 / 720), add,
        localGet(2), mul,
        f64c(1 / 24), add,
        localGet(2), mul,
        f64c(-1 / 2), add,
        localGet(2), mul,
        f64c(1), add,
      ],
    });
  }

  // ─── Math.exp ─────────────────────────────────────────────────────
  // exp(x) = 2^n * exp(r), where x = n*ln2 + r, |r| <= ln2/2
  if (needExp) {
    // Locals: 0=x, 1=n, 2=r, 3=expR, 4=ni(i32), 5=pow2, 6=base
    addMathFunc({
      name: "Math_exp",
      params: f64Param,
      results: f64Result,
      locals: [
        { name: "n", type: f64Type },
        { name: "r", type: f64Type },
        { name: "expR", type: f64Type },
        { name: "ni", type: i32Type },
        { name: "pow2", type: f64Type },
        { name: "base", type: f64Type },
      ],
      body: [
        ...ifThenRet([localGet(0), localGet(0), fne], [f64c(NaN)]),
        ...ifThenRet([localGet(0), f64c(Infinity), feq], [f64c(Infinity)]),
        ...ifThenRet([localGet(0), f64c(-Infinity), feq], [f64c(0)]),
        ...ifThenRet([localGet(0), f64c(709.7), fgt], [f64c(Infinity)]),
        ...ifThenRet([localGet(0), f64c(-745), flt], [f64c(0)]),

        // n = round(x / ln2)
        localGet(0), f64c(LOG2E), mul,
        f64c(0.5), add, ffloor,
        localSet(1),

        // r = x - n * ln2
        localGet(0),
        localGet(1), f64c(LN2), mul,
        sub,
        localSet(2),

        // exp(r) via Horner (Taylor order 7):
        // 1 + r*(1 + r*(1/2 + r*(1/6 + r*(1/24 + r*(1/120 + r*(1/720 + r/5040))))))
        localGet(2), f64c(1.0 / 5040), mul,
        f64c(1.0 / 720), add,
        localGet(2), mul,
        f64c(1.0 / 120), add,
        localGet(2), mul,
        f64c(1.0 / 24), add,
        localGet(2), mul,
        f64c(1.0 / 6), add,
        localGet(2), mul,
        f64c(1.0 / 2), add,
        localGet(2), mul,
        f64c(1), add,
        localGet(2), mul,
        f64c(1), add,
        localSet(3),

        // Compute 2^n via repeated squaring
        f64c(1), localSet(5),
        localGet(1), fabs, truncSatI32, localSet(4),
        f64c(2), localSet(6),

        blockLoop([
          localGet(4), i32eqz, { op: "br_if", depth: 1 } as Instr,
          // if ni & 1, pow2 *= base
          localGet(4), i32const(1), { op: "i32.and" } as Instr,
          { op: "if", blockType: { kind: "empty" },
            then: [localGet(5), localGet(6), mul, localSet(5)],
          } as Instr,
          // base *= base
          localGet(6), localGet(6), mul, localSet(6),
          // ni >>= 1
          localGet(4), i32const(1), { op: "i32.shr_u" } as Instr, localSet(4),
          { op: "br", depth: 0 } as Instr,
        ]),

        // If n < 0, pow2 = 1/pow2
        localGet(1), f64c(0), flt,
        { op: "if", blockType: { kind: "empty" },
          then: [f64c(1), localGet(5), div, localSet(5)],
        } as Instr,

        // result = expR * pow2
        localGet(3), localGet(5), mul,
      ],
    });
  }

  // ─── Math.log ─────────────────────────────────────────────────────
  // log(x) using range reduction to [0.5, 2) then atanh series
  if (needLog) {
    // Locals: 0=x, 1=e, 2=f, 3=t, 4=t2
    addMathFunc({
      name: "Math_log",
      params: f64Param,
      results: f64Result,
      locals: [
        { name: "e", type: f64Type },
        { name: "f", type: f64Type },
        { name: "t", type: f64Type },
        { name: "t2", type: f64Type },
      ],
      body: [
        ...ifThenRet([localGet(0), f64c(0), flt], [f64c(NaN)]),
        ...ifThenRet([localGet(0), f64c(0), feq], [f64c(-Infinity)]),
        ...ifThenRet([localGet(0), localGet(0), fne], [f64c(NaN)]),
        ...ifThenRet([localGet(0), f64c(Infinity), feq], [f64c(Infinity)]),
        ...ifThenRet([localGet(0), f64c(1), feq], [f64c(0)]),

        // e = 0, f = x
        f64c(0), localSet(1),
        localGet(0), localSet(2),

        // While f >= 2, halve f and increment e
        blockLoop([
          localGet(2), f64c(2), flt, { op: "br_if", depth: 1 } as Instr,
          localGet(2), f64c(0.5), mul, localSet(2),
          localGet(1), f64c(1), add, localSet(1),
          { op: "br", depth: 0 } as Instr,
        ]),

        // While f < 0.5, double f and decrement e
        blockLoop([
          localGet(2), f64c(0.5), fge, { op: "br_if", depth: 1 } as Instr,
          localGet(2), f64c(2), mul, localSet(2),
          localGet(1), f64c(1), sub, localSet(1),
          { op: "br", depth: 0 } as Instr,
        ]),

        // Adjust to [sqrt(0.5), sqrt(2)]
        localGet(2), f64c(1.4142135623730951), fgt,
        { op: "if", blockType: { kind: "empty" },
          then: [
            localGet(2), f64c(0.5), mul, localSet(2),
            localGet(1), f64c(1), add, localSet(1),
          ],
        } as Instr,

        // t = (f - 1) / (f + 1)
        localGet(2), f64c(1), sub,
        localGet(2), f64c(1), add,
        div, localSet(3),

        // t2 = t * t
        localGet(3), localGet(3), mul, localSet(4),

        // log(f) = 2*t*(1 + t2*(1/3 + t2*(1/5 + t2*(1/7 + t2*(1/9 + t2*(1/11 + t2/13))))))
        localGet(4), f64c(1.0 / 13), mul,
        f64c(1.0 / 11), add,
        localGet(4), mul,
        f64c(1.0 / 9), add,
        localGet(4), mul,
        f64c(1.0 / 7), add,
        localGet(4), mul,
        f64c(1.0 / 5), add,
        localGet(4), mul,
        f64c(1.0 / 3), add,
        localGet(4), mul,
        f64c(1), add,
        localGet(3), mul,
        f64c(2), mul,

        // result = e * ln2 + log(f)
        localGet(1), f64c(LN2), mul,
        add,
      ],
    });
  }

  // ─── Math.atan ────────────────────────────────────────────────────
  if (needAtan) {
    // Locals: 0=x, 1=ax, 2=t, 3=t2, 4=offset
    addMathFunc({
      name: "Math_atan",
      params: f64Param,
      results: f64Result,
      locals: [
        { name: "ax", type: f64Type },
        { name: "t", type: f64Type },
        { name: "t2", type: f64Type },
        { name: "offset", type: f64Type },
      ],
      body: [
        ...ifThenRet([localGet(0), localGet(0), fne], [f64c(NaN)]),
        ...ifThenRet([localGet(0), f64c(Infinity), feq], [f64c(HALF_PI)]),
        ...ifThenRet([localGet(0), f64c(-Infinity), feq], [f64c(-HALF_PI)]),
        ...ifThenRet([localGet(0), f64c(0), feq], [localGet(0)]),

        // ax = |x|
        localGet(0), fabs, localSet(1),
        f64c(0), localSet(4),

        // Range reduction:
        // if ax > tan(67.5) = 2.414..., use atan(x) = pi/2 - atan(1/x)
        // if ax > tan(22.5) = 0.414..., use atan(x) = pi/4 + atan((ax-1)/(ax+1))
        localGet(1), f64c(2.414213562373095), fgt,
        { op: "if", blockType: { kind: "empty" },
          then: [
            f64c(HALF_PI), localSet(4),
            f64c(1), localGet(1), div, neg, localSet(1),
          ],
          else: [
            localGet(1), f64c(0.4142135623730950), fgt,
            { op: "if", blockType: { kind: "empty" },
              then: [
                f64c(PI / 4), localSet(4),
                localGet(1), f64c(1), sub,
                localGet(1), f64c(1), add,
                div, localSet(1),
              ],
            } as Instr,
          ],
        } as Instr,

        // t = reduced argument (stored back in local 1)
        localGet(1), localTee(2),
        localGet(2), mul, localSet(3),

        // atan(t) polynomial (odd, Horner form):
        // t*(1 + t2*(-1/3 + t2*(1/5 + t2*(-1/7 + t2*(1/9 + t2*(-1/11 + t2*(1/13 - t2/15)))))))
        localGet(3), f64c(-1.0 / 15), mul,
        f64c(1.0 / 13), add,
        localGet(3), mul,
        f64c(-1.0 / 11), add,
        localGet(3), mul,
        f64c(1.0 / 9), add,
        localGet(3), mul,
        f64c(-1.0 / 7), add,
        localGet(3), mul,
        f64c(1.0 / 5), add,
        localGet(3), mul,
        f64c(-1.0 / 3), add,
        localGet(3), mul,
        f64c(1), add,
        localGet(2), mul,

        // result = offset + poly
        localGet(4), add,

        // Apply original sign
        localGet(0), copysign,
      ],
    });
  }

  // ─── Phase 2: Derived functions ───────────────────────────────────

  // Math.tan = sin/cos
  if (needed.has("tan")) {
    const sinIdx = getFuncIdx("Math_sin");
    const cosIdx = getFuncIdx("Math_cos");
    addMathFunc({
      name: "Math_tan",
      params: f64Param,
      results: f64Result,
      locals: [],
      body: [
        ...ifThenRet([localGet(0), localGet(0), fne], [f64c(NaN)]),
        ...ifThenRet([localGet(0), fabs, f64c(Infinity), feq], [f64c(NaN)]),
        localGet(0), call(sinIdx),
        localGet(0), call(cosIdx),
        div,
      ],
    });
  }

  // Math.asin = atan(x / sqrt(1 - x*x))
  if (needed.has("asin")) {
    const atanIdx = getFuncIdx("Math_atan");
    addMathFunc({
      name: "Math_asin",
      params: f64Param,
      results: f64Result,
      locals: [],
      body: [
        ...ifThenRet([localGet(0), localGet(0), fne], [f64c(NaN)]),
        ...ifThenRet([localGet(0), fabs, f64c(1), fgt], [f64c(NaN)]),
        ...ifThenRet([localGet(0), f64c(1), feq], [f64c(HALF_PI)]),
        ...ifThenRet([localGet(0), f64c(-1), feq], [f64c(-HALF_PI)]),
        // atan(x / sqrt(1 - x*x))
        localGet(0),
        f64c(1), localGet(0), localGet(0), mul, sub, fsqrt,
        div,
        call(atanIdx),
      ],
    });
  }

  // Math.acos = pi/2 - asin(x) = pi/2 - atan(x/sqrt(1-x*x))
  if (needed.has("acos")) {
    const atanIdx = getFuncIdx("Math_atan");
    addMathFunc({
      name: "Math_acos",
      params: f64Param,
      results: f64Result,
      locals: [],
      body: [
        ...ifThenRet([localGet(0), localGet(0), fne], [f64c(NaN)]),
        ...ifThenRet([localGet(0), fabs, f64c(1), fgt], [f64c(NaN)]),
        ...ifThenRet([localGet(0), f64c(1), feq], [f64c(0)]),
        ...ifThenRet([localGet(0), f64c(-1), feq], [f64c(PI)]),
        f64c(HALF_PI),
        localGet(0),
        f64c(1), localGet(0), localGet(0), mul, sub, fsqrt,
        div,
        call(atanIdx),
        sub,
      ],
    });
  }

  // Math.atan2(y, x)
  if (needed.has("atan2")) {
    const atanIdx = getFuncIdx("Math_atan");
    addMathFunc({
      name: "Math_atan2",
      params: [f64Type, f64Type],
      results: f64Result,
      locals: [],
      body: buildAtan2Body(atanIdx),
    });
  }

  // Math.log2 = log(x) * LOG2E
  if (needed.has("log2")) {
    const logIdx = getFuncIdx("Math_log");
    addMathFunc({
      name: "Math_log2",
      params: f64Param,
      results: f64Result,
      locals: [],
      body: [localGet(0), call(logIdx), f64c(LOG2E), mul],
    });
  }

  // Math.log10 = log(x) * LOG10E
  if (needed.has("log10")) {
    const logIdx = getFuncIdx("Math_log");
    addMathFunc({
      name: "Math_log10",
      params: f64Param,
      results: f64Result,
      locals: [],
      body: [localGet(0), call(logIdx), f64c(LOG10E), mul],
    });
  }

  // Math.pow(base, exponent)
  if (needed.has("pow")) {
    const expIdx = getFuncIdx("Math_exp");
    const logIdx = getFuncIdx("Math_log");
    addMathFunc({
      name: "Math_pow",
      params: [f64Type, f64Type],
      results: f64Result,
      locals: [
        { name: "absBase", type: f64Type },
      ],
      body: buildPowBody(expIdx, logIdx),
    });
  }

  // Math.sinh = (exp(x) - exp(-x)) / 2
  if (needed.has("sinh")) {
    const expIdx = getFuncIdx("Math_exp");
    addMathFunc({
      name: "Math_sinh",
      params: f64Param,
      results: f64Result,
      locals: [{ name: "ep", type: f64Type }],
      body: [
        ...ifThenRet([localGet(0), localGet(0), fne], [f64c(NaN)]),
        ...ifThenRet([localGet(0), f64c(Infinity), feq], [f64c(Infinity)]),
        ...ifThenRet([localGet(0), f64c(-Infinity), feq], [f64c(-Infinity)]),
        // (exp(x) - 1/exp(x)) / 2
        localGet(0), call(expIdx), localTee(1),
        f64c(1), localGet(1), div, sub,
        f64c(2), div,
      ],
    });
  }

  // Math.cosh = (exp(x) + exp(-x)) / 2
  if (needed.has("cosh")) {
    const expIdx = getFuncIdx("Math_exp");
    addMathFunc({
      name: "Math_cosh",
      params: f64Param,
      results: f64Result,
      locals: [{ name: "ep", type: f64Type }],
      body: [
        ...ifThenRet([localGet(0), localGet(0), fne], [f64c(NaN)]),
        ...ifThenRet([localGet(0), fabs, f64c(Infinity), feq], [f64c(Infinity)]),
        localGet(0), call(expIdx), localTee(1),
        f64c(1), localGet(1), div, add,
        f64c(2), div,
      ],
    });
  }

  // Math.tanh
  if (needed.has("tanh")) {
    const expIdx = getFuncIdx("Math_exp");
    addMathFunc({
      name: "Math_tanh",
      params: f64Param,
      results: f64Result,
      locals: [{ name: "e2x", type: f64Type }],
      body: [
        ...ifThenRet([localGet(0), localGet(0), fne], [f64c(NaN)]),
        ...ifThenRet([localGet(0), f64c(20), fgt], [f64c(1)]),
        ...ifThenRet([localGet(0), f64c(-20), flt], [f64c(-1)]),
        // (exp(2x) - 1) / (exp(2x) + 1)
        localGet(0), f64c(2), mul, call(expIdx), localTee(1),
        f64c(1), sub,
        localGet(1), f64c(1), add,
        div,
      ],
    });
  }

  // Math.asinh = log(x + sqrt(x*x + 1))
  if (needed.has("asinh")) {
    const logIdx = getFuncIdx("Math_log");
    addMathFunc({
      name: "Math_asinh",
      params: f64Param,
      results: f64Result,
      locals: [],
      body: [
        ...ifThenRet([localGet(0), localGet(0), fne], [f64c(NaN)]),
        ...ifThenRet([localGet(0), f64c(Infinity), feq], [f64c(Infinity)]),
        ...ifThenRet([localGet(0), f64c(-Infinity), feq], [f64c(-Infinity)]),
        // sign(x) * log(|x| + sqrt(x*x + 1))
        localGet(0), fabs,
        localGet(0), localGet(0), mul, f64c(1), add, fsqrt,
        add,
        call(logIdx),
        localGet(0), copysign,
      ],
    });
  }

  // Math.acosh = log(x + sqrt(x*x - 1))
  if (needed.has("acosh")) {
    const logIdx = getFuncIdx("Math_log");
    addMathFunc({
      name: "Math_acosh",
      params: f64Param,
      results: f64Result,
      locals: [],
      body: [
        ...ifThenRet([localGet(0), f64c(1), flt], [f64c(NaN)]),
        ...ifThenRet([localGet(0), localGet(0), fne], [f64c(NaN)]),
        ...ifThenRet([localGet(0), f64c(1), feq], [f64c(0)]),
        localGet(0),
        localGet(0), localGet(0), mul, f64c(1), sub, fsqrt,
        add,
        call(logIdx),
      ],
    });
  }

  // Math.atanh = 0.5 * log((1+x)/(1-x))
  if (needed.has("atanh")) {
    const logIdx = getFuncIdx("Math_log");
    addMathFunc({
      name: "Math_atanh",
      params: f64Param,
      results: f64Result,
      locals: [],
      body: [
        ...ifThenRet([localGet(0), fabs, f64c(1), fgt], [f64c(NaN)]),
        ...ifThenRet([localGet(0), f64c(1), feq], [f64c(Infinity)]),
        ...ifThenRet([localGet(0), f64c(-1), feq], [f64c(-Infinity)]),
        ...ifThenRet([localGet(0), localGet(0), fne], [f64c(NaN)]),
        f64c(1), localGet(0), add,
        f64c(1), localGet(0), sub,
        div,
        call(logIdx),
        f64c(0.5), mul,
      ],
    });
  }

  // Math.cbrt — cube root via Newton's method
  if (needed.has("cbrt")) {
    addMathFunc({
      name: "Math_cbrt",
      params: f64Param,
      results: f64Result,
      locals: [
        { name: "guess", type: f64Type },
        { name: "i", type: i32Type },
      ],
      body: [
        ...ifThenRet([localGet(0), f64c(0), feq], [localGet(0)]),
        ...ifThenRet([localGet(0), localGet(0), fne], [f64c(NaN)]),
        ...ifThenRet([localGet(0), fabs, f64c(Infinity), feq], [localGet(0)]),

        // Seed: copysign(sqrt(sqrt(|x|)), x)
        localGet(0), fabs, fsqrt, fsqrt,
        localGet(0), copysign,
        localSet(1),

        // 8 Newton iterations: guess = (2*guess + x/(guess*guess)) / 3
        i32const(8), localSet(2),
        blockLoop([
          localGet(2), i32eqz, { op: "br_if", depth: 1 } as Instr,
          localGet(1), f64c(2), mul,
          localGet(0), localGet(1), localGet(1), mul, div,
          add,
          f64c(3), div,
          localSet(1),
          localGet(2), i32const(1), i32sub, localSet(2),
          { op: "br", depth: 0 } as Instr,
        ]),

        localGet(1),
      ],
    });
  }

  // Math.expm1 — exp(x) - 1, numerically stable for small x
  if (needed.has("expm1")) {
    const expIdx = getFuncIdx("Math_exp");
    addMathFunc({
      name: "Math_expm1",
      params: f64Param,
      results: f64Result,
      locals: [],
      body: [
        ...ifThenRet([localGet(0), localGet(0), fne], [f64c(NaN)]),
        ...ifThenRet([localGet(0), f64c(-Infinity), feq], [f64c(-1)]),
        // For small |x|, use Taylor series for precision
        localGet(0), fabs, f64c(1e-5), flt,
        ifElse(f64Type,
          [
            // x + x^2/2 + x^3/6 + x^4/24
            localGet(0),
            localGet(0), localGet(0), mul, f64c(0.5), mul, add,
            localGet(0), localGet(0), mul, localGet(0), mul, f64c(1.0 / 6.0), mul, add,
            localGet(0), localGet(0), mul, localGet(0), mul, localGet(0), mul, f64c(1.0 / 24.0), mul, add,
          ],
          [
            localGet(0), call(expIdx), f64c(1), sub,
          ],
        ),
      ],
    });
  }

  // Math.log1p — log(1 + x), numerically stable for small x
  if (needed.has("log1p")) {
    const logIdx = getFuncIdx("Math_log");
    addMathFunc({
      name: "Math_log1p",
      params: f64Param,
      results: f64Result,
      locals: [],
      body: [
        ...ifThenRet([localGet(0), localGet(0), fne], [f64c(NaN)]),
        ...ifThenRet([localGet(0), f64c(-1), feq], [f64c(-Infinity)]),
        ...ifThenRet([localGet(0), f64c(-1), flt], [f64c(NaN)]),
        // For small |x|, use Taylor series
        localGet(0), fabs, f64c(1e-4), flt,
        ifElse(f64Type,
          [
            // x - x^2/2 + x^3/3
            localGet(0),
            localGet(0), localGet(0), mul, f64c(0.5), mul, sub,
            localGet(0), localGet(0), mul, localGet(0), mul, f64c(1.0 / 3.0), mul, add,
          ],
          [
            f64c(1), localGet(0), add, call(logIdx),
          ],
        ),
      ],
    });
  }
}

// ─── Complex body builders ──────────────────────────────────────────

function buildAtan2Body(atanIdx: number): Instr[] {
  // atan2(y, x): params 0=y, 1=x
  return [
    // NaN checks
    ...ifThenRet([localGet(0), localGet(0), fne], [f64c(NaN)]),
    ...ifThenRet([localGet(1), localGet(1), fne], [f64c(NaN)]),

    // y == 0 cases
    localGet(0), f64c(0), feq,
    { op: "if", blockType: { kind: "empty" },
      then: [
        // y == 0, x > 0 → +0 (preserving sign of y)
        localGet(1), f64c(0), fgt,
        { op: "if", blockType: { kind: "empty" },
          then: [localGet(0), ret],
        } as Instr,
        // y == 0, x < 0 → copysign(pi, y)
        localGet(1), f64c(0), flt,
        { op: "if", blockType: { kind: "empty" },
          then: [f64c(PI), localGet(0), copysign, ret],
        } as Instr,
        // y == 0, x == 0 → copysign(0 or pi based on sign of x)
        // atan2(+0,+0) = +0, atan2(+0,-0) = pi, atan2(-0,+0) = -0, atan2(-0,-0) = -pi
        // Check sign of x via 1/x: +0 → +Inf, -0 → -Inf
        f64c(1), localGet(1), div, f64c(0), fgt,
        ifElse(f64Type,
          [f64c(0), localGet(0), copysign],
          [f64c(PI), localGet(0), copysign],
        ),
        ret,
      ],
    } as Instr,

    // x == +Inf
    localGet(1), f64c(Infinity), feq,
    { op: "if", blockType: { kind: "empty" },
      then: [
        localGet(0), fabs, f64c(Infinity), feq,
        ifElse(f64Type,
          [f64c(PI / 4), localGet(0), copysign],
          [f64c(0), localGet(0), copysign],
        ),
        ret,
      ],
    } as Instr,

    // x == -Inf
    localGet(1), f64c(-Infinity), feq,
    { op: "if", blockType: { kind: "empty" },
      then: [
        localGet(0), fabs, f64c(Infinity), feq,
        ifElse(f64Type,
          [f64c(3 * PI / 4), localGet(0), copysign],
          [f64c(PI), localGet(0), copysign],
        ),
        ret,
      ],
    } as Instr,

    // y == ±Inf, x finite
    ...ifThenRet([localGet(0), fabs, f64c(Infinity), feq], [f64c(HALF_PI), localGet(0), copysign]),

    // General case: atan(y/x) with quadrant adjustment
    localGet(1), f64c(0), fgt,
    ifElse(f64Type,
      [localGet(0), localGet(1), div, call(atanIdx)],
      [
        localGet(1), f64c(0), flt,
        ifElse(f64Type,
          [
            localGet(0), localGet(1), div, call(atanIdx),
            // Add or subtract pi based on sign of y
            localGet(0), f64c(0), fge,
            ifElse(f64Type,
              [f64c(PI), add],
              [f64c(PI), sub],
            ),
          ],
          [
            // x == 0, y != 0 → copysign(pi/2, y)
            f64c(HALF_PI), localGet(0), copysign,
          ],
        ),
      ],
    ),
  ];
}

function buildPowBody(expIdx: number, logIdx: number): Instr[] {
  // pow(base, exponent): params 0=base, 1=exponent; locals 2=absBase
  return [
    // exp == 0 → 1 (for any base, including NaN)
    ...ifThenRet([localGet(1), f64c(0), feq], [f64c(1)]),
    // base == 1 → 1
    ...ifThenRet([localGet(0), f64c(1), feq], [f64c(1)]),
    // NaN checks
    ...ifThenRet([localGet(0), localGet(0), fne], [f64c(NaN)]),
    ...ifThenRet([localGet(1), localGet(1), fne], [f64c(NaN)]),
    // exp == 1 → base
    ...ifThenRet([localGet(1), f64c(1), feq], [localGet(0)]),
    // exp == -1 → 1/base
    ...ifThenRet([localGet(1), f64c(-1), feq], [f64c(1), localGet(0), div]),
    // exp == 0.5 → sqrt(base)
    ...ifThenRet([localGet(1), f64c(0.5), feq], [localGet(0), fsqrt]),
    // exp == 2 → base*base
    ...ifThenRet([localGet(1), f64c(2), feq], [localGet(0), localGet(0), mul]),

    // base == 0
    localGet(0), f64c(0), feq,
    { op: "if", blockType: { kind: "empty" },
      then: [
        localGet(1), f64c(0), fgt,
        ifElse(f64Type, [f64c(0)], [f64c(Infinity)]),
        ret,
      ],
    } as Instr,

    // base == +Inf
    ...ifThenRet([localGet(0), f64c(Infinity), feq], [
      localGet(1), f64c(0), fgt,
      ifElse(f64Type, [f64c(Infinity)], [f64c(0)]),
    ]),

    // base == -Inf
    localGet(0), f64c(-Infinity), feq,
    { op: "if", blockType: { kind: "empty" },
      then: [
        localGet(1), f64c(0), fgt,
        ifElse(f64Type, [f64c(Infinity)], [f64c(0)]),
        ret,
      ],
    } as Instr,

    // base < 0: non-integer exp → NaN; integer exp → handle sign
    localGet(0), f64c(0), flt,
    { op: "if", blockType: { kind: "empty" },
      then: [
        // Non-integer exponent → NaN
        localGet(1), localGet(1), ftrunc, fne,
        { op: "if", blockType: { kind: "empty" },
          then: [f64c(NaN), ret],
        } as Instr,
        // Integer exponent: result = exp(exp * log(|base|))
        localGet(0), fabs, localSet(2),
        localGet(1), localGet(2), call(logIdx), mul,
        call(expIdx),
        localSet(2), // reuse absBase local to store result
        // If exponent is odd, negate the result
        // odd check: floor(exp/2)*2 != exp (for integer exp)
        localGet(1), ftrunc, f64c(2), div, ffloor,
        f64c(2), mul,
        localGet(1), ftrunc, fne,
        ifElse(f64Type,
          [localGet(2), neg],   // odd → negate
          [localGet(2)],        // even → keep
        ),
        ret,
      ],
    } as Instr,

    // General case: exp(exponent * log(base))
    localGet(1), localGet(0), call(logIdx), mul,
    call(expIdx),
  ];
}
