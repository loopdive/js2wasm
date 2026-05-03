---
id: 1252
sprint: 47
title: "SameValue for DefineProperty f64 comparison uses f64.ne — wrong for NaN and ±0"
status: done
created: 2026-04-17
updated: 2026-05-03
completed: 2026-05-03
priority: medium
feasibility: easy
task_type: bugfix
language_feature: object-model
goal: error-model
es_edition: es5
found_by: "#1093 Phase 1 audit"
---
# #1252 — SameValue for DefineProperty f64 comparison uses f64.ne — wrong for NaN and ±0

## Problem

In `src/codegen/object-ops.ts:879-881`, the DefineProperty "is value unchanged?" check uses
`f64.ne` to compare old and new values. Per ECMA-262 §9.1.6.3 step 7, the comparison must
use **SameValue** (§7.2.10), which differs from `f64.ne` in two ways:

1. **NaN**: `SameValue(NaN, NaN)` is **true** (values are the same), but `f64.ne(NaN, NaN)` returns 1
   (not equal). So redefining a frozen property that already holds NaN with NaN will incorrectly
   throw TypeError.

2. **±0**: `SameValue(+0, -0)` is **false** (different values), but `f64.ne(+0, -0)` returns 0
   (equal). So redefining a frozen property from +0 to -0 will silently succeed instead of throwing.

The code has a comment acknowledging this: "Note: f64.ne treats NaN != NaN (not SameValue),
but sufficient for typical test262 cases"

## Fix sketch

Replace `f64.ne` with a proper SameValue comparison for f64:

```
;; SameValue(a, b) for f64:
;; (a == b && copysign(1,a) == copysign(1,b)) || (a != a && b != b)
local.get $old
local.get $new
f64.eq           ;; a == b (handles most cases, but +0 == -0)
local.get $old
f64.const 1.0
f64.copysign     ;; copysign(1, old) — gives sign
local.get $new
f64.const 1.0
f64.copysign     ;; copysign(1, new) — gives sign
f64.eq           ;; same sign?
i32.and          ;; a==b AND same sign (distinguishes +0/-0)
local.get $old
local.get $old
f64.ne           ;; isNaN(old)
local.get $new
local.get $new
f64.ne           ;; isNaN(new)
i32.and          ;; both NaN
i32.or           ;; SameValue result
```

Then the throw condition is: `if (!sameValue) throw TypeError`.

## Acceptance criteria

- [x] `Object.defineProperty` on a frozen object with NaN value accepts NaN reassignment
- [x] `Object.defineProperty` on a frozen object with +0 rejects -0 reassignment
- [x] Symmetric: -0 → +0 also rejected
- [x] Sanity: same value → no throw; different values → throw
- [x] Same fix applies to non-writable non-configurable property redefine (not just `Object.freeze`)
- [ ] test262 tests for `Object.defineProperty` SameValue semantics pass (CI will validate)

## Resolution (2026-05-03)

The SameValue f64 formula in `src/codegen/object-ops.ts` was added under #1127
months ago. The intended algorithm:

```
SameValue(x, y) =
  (x == y && copysign(1, x) == copysign(1, y))   ;; distinguishes ±0
  || (x != x && y != y)                          ;; both NaN
```

The implementation pushed `f64.copysign` operands in the wrong order. Wasm
`f64.copysign(z1, z2)` = z1 with sign of z2 (stack order: ..., z1, z2). To
get "1 with the sign of value" the magnitude (1) must be pushed FIRST, then
the value. The original code did the opposite, producing
`copysign(value, 1)` = `|value|` — always positive — so SameValue(+0, -0)
silently returned true and the frozen-object guarantee was broken for ±0.

Fix: extracted the SameValue formula into a single helper
`emitSameValueF64(fctx, oldValLocal, newValLocal)` and called it from all
three sites in `object-ops.ts` (defineProperty path, defineProperties
guarded path, defineProperties non-guarded path). The previous two
defineProperties sites were also using a plain `f64.ne` (no SameValue at
all), so they got upgraded as a side effect.

Regression test: `tests/issue-1252.test.ts` (6 cases — NaN/NaN, +0/-0,
-0/+0, same, different, non-writable-non-configurable redefine).

## Follow-up (separate issue)

`Object.defineProperties` on a frozen object skips the SameValue check
entirely — `needsValueCompare` in the `compileObjectDefineProperties` code
path doesn't consult `frozenVars` (only `priorExistingFlags`). This is a
distinct bug from #1252 (it's about *whether* the check runs at all, not
*how* the f64 comparison is performed). The `emitSameValueF64` helper this
fix introduces is wired into the right call sites, so when the frozen-vars
gate is added to defineProperties, the ±0/NaN semantics will already be
correct. Filing this as a follow-up.
