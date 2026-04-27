---
id: 1179-followup
title: "i32 fast path for `*` is not spec-faithful when true product exceeds 2^53"
sprint: 45
status: review
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: correctness
area: codegen
language_feature: bitwise-coercion
goal: spec-conformance
parent: 1179
created: 2026-04-27
created_by: senior-dev-1179
implemented_by: senior-dev-1179
implemented_at: 2026-04-27
---

## Implementation (2026-04-27)

Implemented Option B from the recommendation list. Changes in `src/codegen/binary-ops.ts`:

- Factored a `peel(e)` helper for stripping parens / `as` / `!` / type-assertion wrappers (replaces an inlined while-loop the original predicate carried).
- New `isSmallIntLit(e)` — true iff `e` peels to a numeric literal of magnitude `< 2^21` (= 2,097,152). Bound chosen so that `2^21 × 2^31 = 2^52 < 2^53` — the product is exactly representable in f64, so f64.mul of an i32 literal × an i32 local equals the true integer product, and ToInt32 of the f64 result equals i32.mul of the inputs bit-for-bit.
- New `isI32MulSafe(l, r)` — true iff at least one operand is a small int literal.
- `isI32PureExpr` split its `+ | - | *` arm: `+` and `-` keep the original "both operands i32-pure" rule (provably safe — f64 add/sub of two i32 values is exact); `*` adds the `isI32MulSafe(l, r)` guard.
- The top-level `arithI32WithToInt32Wrap` calculation also picks up an `outerMulI32Safe` guard when the OUTER op being compiled is `*` — same rationale, applied at the outermost level so that e.g. `(a * b) | 0` with both operands bare locals correctly falls back to the f64 path.

### Test coverage

`tests/issue-1179-followup.test.ts` — 6 tests, all passing locally:
1. `(0x7FFFFFFF * 0x7FFFFFFF) | 0` returns the spec value `0`, not `Math.imul`'s `1`.
2. LCG-style `(seed * 1103515245 + 12345) | 0` matches the spec for seeds spanning the i32 range (including `0x40000000`, `0x7fffffff`, `-0x80000000`).
3. `(0x7FFFFFFF * 17) | 0` returns the spec value via the i32 path (small-literal multiplier guard fires).
4. WAT-shape: array-sum hot loop still emits `i32.mul / i32.xor / i32.and` and does NOT contain the `f64.const 4294967296` ToInt32 dance for the bitwise body — proves the original #1179 optimization still fires.
5. WAT-shape: bare-local `(a * b) | 0` DOES emit `f64.mul` and the ToInt32 dance — proves the safety fallback works.
6. Nested chain `((a*b) ^ (i*17)) & 0xFFFF` — when ANY sub-tree contains an unsafe `*`, the whole chain falls back to f64. Behavioural test against JS oracle for several large-input cases.

### Performance check

V8 WasmGC, 1M-element array-sum, 5 runs after warm: 15-42 ms range, identical distribution to post-#1179 baseline. The i32 fast path still fires for the common `i * 17` shape.

### What's NOT covered (deferred)

- **Range-tracking-based `*` widening**: Option C from the recommendation. With per-SSA-value min/max tracking, we could fire i32.mul whenever `bounds × bounds ≤ 2^53` — covering shapes like `(loopCounter * smallVar) | 0` where the bound is dynamic but provably small. Not needed for any current benchmark; file as a separate optimization issue if test262 surfaces a pattern.
- **`-literal` (PrefixUnary minus on numeric literal) recognition**: `(a * -17) | 0` doesn't trigger the small-literal guard because the AST is `UnaryMinus(NumericLiteral(17))`, not a numeric literal. Trivial extension if it matters; the existing predicate has the same limitation for bare i32-range literals.

---

# Follow-up to #1179 — i32-multiplication fast path is not spec-faithful

## Problem

PR #62 (#1179) generalised the i32 fast path in `src/codegen/binary-ops.ts` so that any arithmetic op nested inside a bitwise / `| 0` context stays in i32. The predicate accepts `+`, `-`, AND `*`:

```ts
if (k === ts.SyntaxKind.PlusToken || k === ts.SyntaxKind.MinusToken || k === ts.SyntaxKind.AsteriskToken) {
  return isI32PureExpr(inner.left) && isI32PureExpr(inner.right);
}
```

For `+` and `-`, the i32 path is provably safe: |a±b| ≤ 2^32 < 2^53, so f64.add/sub of two i32-representable values is exact, and ToInt32 of the exact f64 equals i32.add/sub mod 2^32.

For `*`, the optimization can deviate from JS spec when the **true integer product exceeds 2^53**. ECMA-262 specifies multiplication via f64; if the product loses precision in f64, ToInt32 of the rounded f64 differs from i32.mul (which keeps the low 32 bits of the true product).

## Reproducer

```js
const a = 0x7FFFFFFF;  // 2^31 − 1
const b = 0x7FFFFFFF;
const r = (a * b) | 0;
// Spec: f64.mul(a,b) — true value 2^62 − 2^32 + 1 needs 62 bits.
//       f64 (53-bit mantissa) rounds to 2^62 − 2^32 = 4611686014132420608.
//       ToInt32(4611686014132420608) = 0  (value is multiple of 2^32).
//       JS:  r === 0
// My fix:  i32.mul(0x7FFFFFFF, 0x7FFFFFFF) = low 32 bits of true product = 1.
//       Wasm: r === 1
```

Same answer V8's `Math.imul(a, b)` gives — i.e. the optimization compiles `(a*b)|0` to `Math.imul`-equivalent semantics, which is **not what the spec says**.

## Why didn't CI catch this?

The PR #62 test (`tests/issue-1179.test.ts`) uses an inline JS oracle that exercises only `i ∈ [0, 1M)` — all intermediates stay well under 2^53, so spec and i32.mul agree. The 124 test262 regressions on PR #62 were noise/drift (cross-check vs PR #58 showed zero in the diff area). It's possible a test in `built-ins/Math/imul/` or `language/expressions/multiplication/` exercises this corner; if so, it was lost in the drift.

## Affected workloads

- Hash mixing with large multipliers: `(x * 0x9E3779B1) | 0` (common in MurmurHash, FNV, splitmix variants). Two such products may diverge when their product crosses 2^53.
- Big-integer simulation in JS: `(hi * 65536 + lo) | 0` patterns where inputs aren't bounded.
- Random-number generators: `(seed * 1103515245 + 12345) | 0` (LCG) — when seed gets close to i32 max.

For the array-sum benchmark and most loop-counter arithmetic, the divergence is invisible. But it's a real spec-conformance bug.

## Recommended fix

Option A (most conservative, simplest): **drop `*` from the predicate entirely.** Keep `+`, `-`, and the bitwise paths. Lose the multiplication optimization; for the array-sum benchmark, the `i * 17` step would f64-roundtrip but the `^` / `&` / `>>>` chain would still be i32 (most of the win).

Option B (preferred — preserves array-sum perf): **accept `*` only when at least one operand is an integer literal of magnitude ≤ 2^21.** Provably safe: 2^21 × 2^31 = 2^52 < 2^53. Covers the common `i * 17`, `i * 8`, `i * 256`, etc. patterns. Implementation:

```ts
if (k === ts.SyntaxKind.AsteriskToken) {
  const isSmallIntLit = (e: ts.Expression): boolean => {
    let inner = e;
    while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
    if (!ts.isNumericLiteral(inner)) return false;
    const n = Number(inner.text.replace(/_/g, ""));
    return Number.isInteger(n) && Math.abs(n) < (1 << 21);
  };
  // Both operands must be i32-pure AND at least one must be a small int literal.
  return isI32PureExpr(inner.left) && isI32PureExpr(inner.right)
    && (isSmallIntLit(inner.left) || isSmallIntLit(inner.right));
}
```

Option C (broader, more work): add range tracking — track i32 SSA values' min/max bounds across binary ops, allow `*` when both bounds × bounds ≤ 2^53. Out of scope for a follow-up.

## Acceptance criteria

1. New test `tests/issue-1179-followup.test.ts` covering at least:
   - `(0x7FFFFFFF * 0x7FFFFFFF) | 0` — verify spec value (0), not i32.mul (1)
   - `((x * 17) ^ (x >>> 3)) & 1023` for x = 999999 — verify i32 fast path still fires (WAT shape assertion)
   - LCG-style: `(seed * 1103515245 + 12345) | 0` for various seeds — verify spec values
2. The array-sum perf budget in `tests/issue-1179.test.ts` remains under 250 ms (proves we didn't lose the optimization on the original workload).
3. Implementation chooses Option A or B (architect's call); if B, the small-literal guard is documented in `binary-ops.ts`.

## Key files

- `src/codegen/binary-ops.ts` — `isI32PureExpr` predicate (around line 1016 post-#1179)
- `tests/issue-1179.test.ts` — existing tests; add corner-case coverage here or in new file
- `tests/issue-1179-followup.test.ts` — new (this issue)

## Notes

- The same caveat technically applies to **nested arithmetic where any subtree contains an unbounded `*`** — e.g. `((a*b) + c) | 0` would route through the i32 path with i32.mul wrapping at the inner step, then i32.add. Option B (literal guard on `*`) prevents this transitively because the predicate only fires when the multiplication is safe.
- This issue was identified post-merge during a correctness review, not by CI. The optimization shipped in PR #62 (commit `19ccc720f`) on 2026-04-27.

## Refs

- Parent: #1179 (PR #62)
- ECMA-262 §6.1.6.1.4 Number::multiply, §7.1.6 ToInt32
- V8 has TurboFan range analysis that may already use i32.mul-like semantics here, so observable divergence may be V8 version-dependent.
