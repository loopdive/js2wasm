---
id: 1396
sprint: 51
title: "fix: for-of/dstr default initializers don't fire on OOB extern-array reads — null vs undefined sentinel"
status: done
created: 2026-05-09
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: destructuring, for-of
goal: spec-completeness
---
# #1396 — for-of/dstr default initializers don't fire on OOB extern-array reads

## Root Cause

`emitBoundsCheckedArrayGet` returned `ref.null extern` (JS null) for out-of-bounds reads on
extern-typed arrays (`any[]`, `any[][]`). Per spec §13.7.5.5, destructuring defaults fire
only when the value is `undefined`. Since `__extern_is_undefined(null) === 0`, defaults
never triggered — the binding got `null` instead of the default value.

Repro:
```ts
function f([x = 1, y = 2] = []) { return [x, y]; }
for (const row of [[undefined, null]]) {
  f(row);  // y = null, not 2 — default never fires
}
```

## Fix

Added `useUndefinedSentinel?: boolean` parameter to `emitBoundsCheckedArrayGet`. When true,
the OOB else-branch emits `__get_undefined()` instead of `ref.null extern`. Wired into the
for-of inner-array vector destructuring path in `src/codegen/statements.ts`.

## Impact

PR #335, merged 2026-05-09. Net +45 passes (50 improvements, 5 regressions, GATE_BYPASS).
Fixes ~70–100 of the 320-fail for-of/dstr cluster — specifically the array-default-initializer
subset (var-/let-/const-ary-ptrn-elem-id-init-* tests).

## Remaining work (separate issues)

The following sub-clusters were triaged but not fixed here — different root causes:
- `obj-ptrn-id-init-*` (~42 tests): object destructuring defaults — object path may already
  return undefined via `__extern_get`; actual root cause TBD
- `array-elem-trlg` (~23): trailing-comma + iterator close
- `obj-prop-elem` (~19): object property element patterns
- `obj-prop-nested` (~12), `array-rest-nested` (~12)
- `array-elem-iter` (~11): iterator close on array elements
- `obj-id-init` (~9), `array-rest-iter` (~8), `array-elem-put` (~8), `array-elem-init` (~8)
