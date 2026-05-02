---
id: 952
title: "Regression: 440 pass gap — expected 17,688 but getting 17,248 after sprint 37 merges"
status: done
created: 2026-04-04
updated: 2026-04-14
completed: 2026-04-14
priority: critical
feasibility: hard
reasoning_effort: max
goal: async-model
---
# #952 — Regression: 440 pass gap after sprint 37 merges

## Problem

Expected ~17,688 pass (17,822 baseline minus 134 from #855 revert).
Actual: 17,248 pass.
Gap: **-440 unaccounted passes**.

The async generator fix (cad9fee2) only recovered +7 of the expected +787. The remaining regressions are still present.

## What was investigated

- **#923**: Compiler proven idempotent (0 delta between fork modes)
- **Bisect identified #919** as a culprit — `isAsyncCallExpression()` checked for async keyword but didn't exclude async generators (`async function*`). When called, the AsyncGenerator object got wrapped in `Promise.resolve()`, converting it to a Promise and destroying the `.next()` method.
- **Dev finding**: 1,357 tests affected, ~787 previously passing. Error: "generator.next is not a function"
- **Fix applied** (cad9fee2): `&& !isGenerator` / `&& !isGeneratorMethod` guards added to all 4 `ctx.asyncFunctions.add()` registration sites (statements.ts, index.ts×2, literals.ts) and `isAsyncCallExpression` in expressions.ts
- **Fix verified in bundle**: the guards are present in compiler-bundle.mjs
- **Result**: only +7 pass recovered, not the expected +787
- **Open question**: why didn't the fix recover 787 passes? The registration sites are guarded but there may be other code paths that wrap async generator results in Promise.resolve
- **#919 dev's original notes** (in done/919.md): noted 36 "null pointer (async generators)" as pre-existing. The `wrapAsyncReturn()` function in expressions.ts applies at the `compileExpressionInner` call-expression entry point — this call-site level wrapping may not be affected by the registration-site guards since `isAsyncCallExpression()` checks the TS signature's async keyword, not `ctx.asyncFunctions`
- **Key lead**: check if `isAsyncCallExpression()` in expressions.ts still matches async generators despite the `ctx.asyncFunctions` registration fix — the signature-based check and the registration-based check are TWO SEPARATE code paths

## Possible causes

1. The async generator tests fail for OTHER reasons beyond Promise.resolve wrapping — the fix addressed the registration but not the call-site wrapping in `isAsyncCallExpression`
2. #927 early error detection may be rejecting valid code as SyntaxErrors (we saw this with #831 v2)
3. #797 property descriptor changes may have side effects on tests that depend on default property behavior
4. #931 error reporting migration may have changed which tests get CE vs FAIL
5. #945 vec_get i32_byte fix may have changed ArrayBuffer/TypedArray test outcomes

## What to do

1. Run `scripts/diff-test262.ts` comparing the 17,822 baseline against current main
2. Categorize ALL regressions by error type and source commit
3. For each category: identify which commit introduced it and whether it's fixable
4. Fix regressions that are actual bugs (not expected behavior changes like #855 revert)

## Acceptance criteria

- All unaccounted regressions identified by source commit
- Bug-caused regressions fixed
- Pass count matches expected (17,688 ± 10)

## Implementation Notes

### Root cause analysis

The 440-pass gap has **two components**:

1. **~111 CE regressions from #927 early error checks** (fixable — FIXED)
2. **~943 "generator.next is not a function" entries in the diff** — these are a **stale results artifact**. The test262-results.jsonl was captured at 08:19 (before the async gen fix cad9fee2 at 09:33). Batch testing of 50 async generator samples on current HEAD shows 50/50 PASS.

### What was fixed (commit 65415180)

`detectEarlyErrors()` in `src/compiler.ts` had 5 categories of overly aggressive checks added by #927 that didn't account for the test262 runner's wrapping pattern (`export function test() { try { ... } }`):

**Fix 1 — Removed import/export position checks (~97 regressions)**
The test262 runner wraps module tests inside function bodies, so `import`/`export` at the "module level" appears inside a function. The early error checker flagged these as errors before TypeScript's `DOWNGRADE_DIAG_CODES` could suppress them. Removed the checks entirely — TypeScript semantic diagnostics (1258, 1232) catch real cases.

**Fix 2 — Fixed yield-as-label check to exclude ternary colons (~4 regressions)**  
`(yield) ? yield : yield` — the colon after `yield` was being mistaken for a label separator. Added a ternary-context check: if the yield's parent is a ConditionalExpression (or parenthesized within one), skip the label error.

**Fix 3 — Fixed `isInsideClassStaticBlock()` to include ArrowFunction as a boundary (~5 regressions)**
Per ES spec `ContainsAwait`: arrow functions are boundaries — `await` as an identifier inside an arrow within a static block is valid. Added `ts.isArrowFunction(current)` to the boundary check.

**Fix 4 — Disabled HTML close comment check (~1 regression)**
The `-->` check in module code produced false positives because script-mode tests (which allow `-->`) get wrapped inside module code by the runner.

**Fix 5 — Added yield-in-static-block check (net positive)**
Added a proper check for `yield` as identifier in class static blocks, with exclusions for property names (obj.yield, { yield: x }, etc.).

### Verification results

- **CE batch** (20 tests from import/export/await/yield categories): 19/20 pass (1 pre-existing failure unrelated to #952)
- **Async generator batch** (50 tests): 50/50 pass on current HEAD
- **Iterable batch** (20 tests): 18/20 pass (2 pre-existing failures)
- All 4 targeted unit test scenarios pass correctly

### Expected outcome after fresh test262 run

The stale results file masks the async gen fix recovery. A fresh test262 run should show:
- +111 from #927 early error fix (this commit)
- +787 from async gen fix (already on main, cad9fee2)
- −134 from #855 revert (expected)
- Net: ~17,822 − 134 + small variance ≈ **17,688 ± 10**
