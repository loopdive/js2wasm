// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1126 Stage 2 — Inference rules for the integer-domain lattice.
//
// Tests the producer/preserve/widen rules at the `inferExpr` level —
// i.e. directly on the lattice-operation arithmetic, without the
// function-level seed-preservation interfering. We do this because:
//
//   • `seedReturnType` reads the TS-checker-inferred return type for
//     functions without an explicit annotation. The checker infers
//     `number` for any bitwise expression body (`x | 0` is `number`),
//     which seeds the function's return as F64.
//   • The body inference walk then *joins* into the seed. For an
//     i32-producing body, F64 ⊔ I32 = F64 per Stage 1's numeric
//     collapse — so the function's reported return type is F64
//     regardless of whether the body produced i32.
//   • The asymmetric-join rule preserves the seed when the body
//     produces DYNAMIC, so flag-off bodies also report F64.
//
// Both behaviours are correct: the function's caller-visible type
// IS f64. The integer-domain fact lives at the *expression* level
// (i.e. the `(x|0)` sub-expression itself), not at the function
// signature. Stage 3's emitter consults expression-level facts to
// pick i32-fast-path emit when both operands are i32; the function's
// param/return types narrow only via Stage 4's cross-fn worklist.
//
// So Stage 2's tests assert against `inferExpr(expr)` results
// directly. We parse a wrapping function via `ts.createSourceFile`
// and pull the expression of interest out of the AST.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as ts from "typescript";

import { _internals, type LatticeType } from "../src/ir/propagate.js";

const { inferExpr, F64, I32, U32, BOOL, STRING, UNKNOWN, DYNAMIC } = _internals;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse `function _wrap(${paramList}) { return ${expr}; }` and return
 * the inferred type of the return expression. The wrapping is needed
 * because `ts.createSourceFile` parses statements, not expressions
 * standalone, and we want a return statement so we can pull the
 * expression cleanly.
 *
 * `paramScope` is the lattice for the wrapped params, simulating
 * what the body-walk would see.
 */
function inferOf(
  exprSrc: string,
  params: ReadonlyArray<{ name: string; type: LatticeType }> = [
    { name: "x", type: F64 },
    { name: "y", type: F64 },
  ],
): LatticeType {
  const paramList = params.map((p) => `${p.name}: number`).join(", ");
  const sourceText = `function _wrap(${paramList}) { return ${exprSrc}; }`;
  const sf = ts.createSourceFile("_wrap.ts", sourceText, ts.ScriptTarget.Latest, true);
  const fn = sf.statements[0];
  if (!ts.isFunctionDeclaration(fn) || !fn.body) throw new Error("test setup: bad source");
  const stmt = fn.body.statements[0];
  if (!stmt || !ts.isReturnStatement(stmt) || !stmt.expression) throw new Error("test setup: no return");
  const scope = new Map<string, LatticeType>();
  for (const p of params) scope.set(p.name, p.type);
  return inferExpr(stmt.expression, scope, new Map());
}

function setFlag(value: "1" | "0" | undefined): void {
  // biome lint disallows `delete process.env.X`; assigning undefined
  // achieves the same observable effect (env reads return undefined).
  if (value === undefined) process.env.JS2WASM_IR_I32_DOMAIN = undefined;
  else process.env.JS2WASM_IR_I32_DOMAIN = value;
}

// ---------------------------------------------------------------------------
// Producer rules — flag ON
// ---------------------------------------------------------------------------

describe("#1126 Stage 2 — numeric literal classification (flag ON)", () => {
  beforeEach(() => setFlag("1"));
  afterEach(() => setFlag(undefined));

  it("integer literal in [0, 2^31) infers as i32", () => {
    expect(inferOf("42")).toEqual(I32);
  });

  it("integer literal 0 (boundary, infers as i32)", () => {
    expect(inferOf("0")).toEqual(I32);
  });

  it("integer literal 2^31 - 1 (i32.MAX) infers as i32", () => {
    expect(inferOf("2147483647")).toEqual(I32);
  });

  it("integer literal in [2^31, 2^32) infers as u32", () => {
    expect(inferOf("0xFFFFFFFF")).toEqual(U32);
  });

  it("integer literal 2^31 (just above i32.MAX) infers as u32", () => {
    expect(inferOf("2147483648")).toEqual(U32);
  });

  it("integer literal beyond u32 widens to f64", () => {
    expect(inferOf("8589934592")).toEqual(F64); // 2^33
  });

  it("non-integer literal stays f64", () => {
    expect(inferOf("3.14")).toEqual(F64);
  });

  it("unary minus on integer literal widens to f64 (overflow safety)", () => {
    // `-2147483648` is unary-minus on `2147483648` (which is u32).
    // Unary minus widens to f64 because `-(-2^31) = 2^31` (the i32
    // analogue) overflows i32. Stage 2 conservatively widens.
    expect(inferOf("-2147483648")).toEqual(F64);
  });
});

describe("#1126 Stage 2 — bitwise operators produce i32 (flag ON)", () => {
  beforeEach(() => setFlag("1"));
  afterEach(() => setFlag(undefined));

  it("e | 0 produces i32", () => expect(inferOf("x | 0")).toEqual(I32));
  it("e & N produces i32", () => expect(inferOf("x & 0xFF")).toEqual(I32));
  it("e ^ N produces i32", () => expect(inferOf("x ^ 0x55")).toEqual(I32));
  it("e << N produces i32", () => expect(inferOf("x << 2")).toEqual(I32));
  it("e >> N produces i32 (signed shift)", () => expect(inferOf("x >> 2")).toEqual(I32));
  it("e >>> N produces u32 (unsigned shift)", () => expect(inferOf("x >>> 2")).toEqual(U32));
  it("e >>> 0 (the JS uint32 idiom) produces u32", () => expect(inferOf("x >>> 0")).toEqual(U32));
  it("~e (bitwise NOT) produces i32", () => expect(inferOf("~x")).toEqual(I32));
});

describe("#1126 Stage 2 — Math.imul / Math.clz32 (flag ON)", () => {
  beforeEach(() => setFlag("1"));
  afterEach(() => setFlag(undefined));

  it("Math.imul(a, b) produces i32", () => {
    expect(inferOf("Math.imul(x, y)")).toEqual(I32);
  });

  it("Math.clz32(x) produces u32", () => {
    expect(inferOf("Math.clz32(x)")).toEqual(U32);
  });

  it("Math.floor (not a 32-bit-domain producer) stays dynamic", () => {
    // Math.floor returns a JS number that may be outside i32 range;
    // Stage 2 deliberately doesn't narrow it. Stays dynamic.
    expect(inferOf("Math.floor(x)")).toEqual(DYNAMIC);
  });

  it("Math.abs / Math.sqrt etc. stay dynamic (not in producer list)", () => {
    expect(inferOf("Math.abs(x)")).toEqual(DYNAMIC);
    expect(inferOf("Math.sqrt(x)")).toEqual(DYNAMIC);
  });
});

// ---------------------------------------------------------------------------
// Preserve / widen rules — the central #1236 fix (flag ON)
// ---------------------------------------------------------------------------

describe("#1126 Stage 2 — arithmetic widens i32+i32 to f64 (#1236 structural fix)", () => {
  beforeEach(() => setFlag("1"));
  afterEach(() => setFlag(undefined));

  it("(x|0) + (y|0) widens to f64 — JS + does not wrap", () => {
    expect(inferOf("(x|0) + (y|0)")).toEqual(F64);
  });

  it("(x|0) - (y|0) widens to f64", () => {
    expect(inferOf("(x|0) - (y|0)")).toEqual(F64);
  });

  it("(x|0) * (y|0) widens to f64", () => {
    expect(inferOf("(x|0) * (y|0)")).toEqual(F64);
  });

  it("(x|0) % (y|0) widens to f64", () => {
    expect(inferOf("(x|0) % (y|0)")).toEqual(F64);
  });

  it("(x|0) / (y|0) widens to f64 — division always fractional-possible", () => {
    expect(inferOf("(x|0) / (y|0)")).toEqual(F64);
  });

  it("Math.imul(x, y) + 1 widens (i32 + i32 = f64)", () => {
    expect(inferOf("Math.imul(x, y) + 1")).toEqual(F64);
  });

  it("(x >>> 0) + (y >>> 0) widens to f64 (u32+u32 also widens)", () => {
    expect(inferOf("(x >>> 0) + (y >>> 0)")).toEqual(F64);
  });

  it("i32 + u32 widens to f64 (sign mismatch already widens at join)", () => {
    expect(inferOf("(x|0) + (y >>> 0)")).toEqual(F64);
  });
});

describe("#1126 Stage 2 — composite expressions preserve narrowing", () => {
  beforeEach(() => setFlag("1"));
  afterEach(() => setFlag(undefined));

  it("((x|0) + 1) | 0 — outer | re-narrows arithmetic-widened f64 to i32", () => {
    expect(inferOf("((x|0) + 1) | 0")).toEqual(I32);
  });

  it("(x & 0xFF) << 8 — chained bitwise stays i32", () => {
    expect(inferOf("(x & 0xFF) << 8")).toEqual(I32);
  });

  it("((x >>> 0) + 1) >>> 0 — outer >>> 0 re-narrows to u32", () => {
    expect(inferOf("((x >>> 0) + 1) >>> 0")).toEqual(U32);
  });

  it("~(x | 0) preserves i32 across unary NOT", () => {
    expect(inferOf("~(x | 0)")).toEqual(I32);
  });
});

describe("#1126 Stage 2 — comparisons of i32 produce bool", () => {
  beforeEach(() => setFlag("1"));
  afterEach(() => setFlag(undefined));

  it("(x|0) < (y|0) → bool", () => expect(inferOf("(x|0) < (y|0)")).toEqual(BOOL));
  it("(x|0) <= (y|0) → bool", () => expect(inferOf("(x|0) <= (y|0)")).toEqual(BOOL));
  it("(x|0) > (y|0) → bool", () => expect(inferOf("(x|0) > (y|0)")).toEqual(BOOL));
  it("(x|0) >= (y|0) → bool", () => expect(inferOf("(x|0) >= (y|0)")).toEqual(BOOL));
  it("(x>>>0) === (y>>>0) → bool", () => expect(inferOf("(x >>> 0) === (y >>> 0)")).toEqual(BOOL));
  it("(x|0) === (y|0) → bool", () => expect(inferOf("(x|0) === (y|0)")).toEqual(BOOL));
});

// ---------------------------------------------------------------------------
// Flag OFF — behaviour neutral (regression sentinel)
// ---------------------------------------------------------------------------

describe("#1126 Stage 2 — flag OFF preserves pre-#1126 behaviour", () => {
  beforeEach(() => setFlag(undefined));
  afterEach(() => setFlag(undefined));

  it("integer literal still classifies as f64 (no producer)", () => {
    expect(inferOf("42")).toEqual(F64);
  });

  it("e | 0 stays dynamic (pre-#1126 default)", () => {
    expect(inferOf("x | 0")).toEqual(DYNAMIC);
  });

  it("e >>> 0 stays dynamic (pre-#1126 default)", () => {
    expect(inferOf("x >>> 0")).toEqual(DYNAMIC);
  });

  it("e << N stays dynamic", () => {
    expect(inferOf("x << 2")).toEqual(DYNAMIC);
  });

  it("e >> N stays dynamic", () => {
    expect(inferOf("x >> 2")).toEqual(DYNAMIC);
  });

  it("~e stays dynamic", () => {
    expect(inferOf("~x")).toEqual(DYNAMIC);
  });

  it("Math.imul stays dynamic", () => {
    expect(inferOf("Math.imul(x, y)")).toEqual(DYNAMIC);
  });

  it("Math.clz32 stays dynamic", () => {
    expect(inferOf("Math.clz32(x)")).toEqual(DYNAMIC);
  });

  it("arithmetic on f64 still produces f64", () => {
    expect(inferOf("x + y")).toEqual(F64);
    expect(inferOf("x - y")).toEqual(F64);
    expect(inferOf("x * y")).toEqual(F64);
    expect(inferOf("x / y")).toEqual(F64);
  });

  it("comparison on f64 still produces bool", () => {
    expect(inferOf("x < y")).toEqual(BOOL);
    expect(inferOf("x === y")).toEqual(BOOL);
  });

  it("unary minus / plus / not still produce f64 / bool", () => {
    expect(inferOf("-x")).toEqual(F64);
    expect(inferOf("+x")).toEqual(F64);
    expect(inferOf("!x", [{ name: "x", type: BOOL }])).toEqual(BOOL);
  });
});

// ---------------------------------------------------------------------------
// % (PercentToken) addition — was missing pre-#1126, now covered
// ---------------------------------------------------------------------------

describe("#1126 Stage 2 — PercentToken added to arithmetic arm (was DYNAMIC)", () => {
  // No flag dependency — the PercentToken addition is unconditional.
  // Pre-PR, `function f(x: number, y: number) { return x % y; }`
  // returned DYNAMIC because `%` wasn't in the f64 arm. Adding it
  // closes a small gap unrelated to i32/u32 (matters once Stage 2's
  // i32-domain rules kick in: `i32 % i32` must widen to f64 cleanly).
  it("x % y on f64 inputs produces f64 (was DYNAMIC pre-PR)", () => {
    setFlag(undefined);
    expect(inferOf("x % y")).toEqual(F64);
  });

  it("x % y is consistent across flag states", () => {
    setFlag("1");
    expect(inferOf("x % y")).toEqual(F64);
    setFlag(undefined);
    expect(inferOf("x % y")).toEqual(F64);
  });
});

// ---------------------------------------------------------------------------
// Sanity — sentinel that the seed-preservation rule (which the function-
// level inference relies on) is unchanged. This is to defend against
// future PRs accidentally over-narrowing function returns.
// ---------------------------------------------------------------------------

describe("#1126 Stage 2 — narrowed expressions don't leak to function signature", () => {
  beforeEach(() => setFlag("1"));
  afterEach(() => setFlag(undefined));

  it("i32 expression doesn't shadow scope's f64 param", () => {
    // Within the body, `x` is f64 (from param scope). Producing an
    // i32 sub-expression `x | 0` doesn't change the param type.
    const r = inferOf("x | 0", [{ name: "x", type: F64 }]);
    expect(r).toEqual(I32);
  });

  it("u32 sub-expression composed with f64 param widens correctly in arithmetic", () => {
    // `(x | 0) + x` — i32 + f64 → f64 (per join rule).
    const r = inferOf("(x | 0) + x", [{ name: "x", type: F64 }]);
    expect(r).toEqual(F64);
  });

  it("UNKNOWN scope param flowing through bitwise produces i32", () => {
    // Scope has `x: UNKNOWN`. Bitwise still narrows to i32 because
    // `f64Compatible(UNKNOWN)` is true.
    const r = inferOf("x | 0", [{ name: "x", type: UNKNOWN }]);
    expect(r).toEqual(I32);
  });

  it("STRING-typed param fed through bitwise widens to dynamic", () => {
    // `f64Compatible(STRING)` is false, so the bitwise rule rejects.
    const r = inferOf("x | 0", [{ name: "x", type: STRING }]);
    expect(r).toEqual(DYNAMIC);
  });
});
